// Per MYT-52 T12 / design §3.6 + §D5. Stage 7 non-streaming handler.
//
// Data-layer-repo-unification: the handler now takes a pool-bound `Repo`
// (NOT a mid-tx PoolClient) and runs cost-cap reads + inventory load + the
// generateObject LLM call OUTSIDE any transaction, applying patches inside a
// single `repo.transaction`. This test is therefore a REAL-Postgres
// integration test: it seeds a world inventory (entities + prose + facts +
// relationships) via the repo binders, mocks ONLY `generateObject`, runs the
// handler, and asserts (a) the returned finalizedEvents and (b) the actual DB
// effects (renamed entity, updated fact content, inserted/deleted
// relationship rows). The prior mock-client SQL-string assertions are replaced
// by real DB queries that assert the SAME behavior at the binder/repo level —
// which is also what exercises the new entities.updateName / relationships.
// insertOne / facts.insertOne binder SQL through the coherence path.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import pino from 'pino'
import { generateObject } from '../../../ai.js'
import { runCoherencePassStage } from '../coherence-pass.js'
import type { PipelineEvent } from '../../../../contract/pipeline-events.js'
import type { VocabularyRegistry } from '../../../schemas/vocabulary-registry.js'
import { guardTestDatabase } from '../../../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../../../repo/uuidv7.js'
import { createRepo, type Repo } from '../../../../repo/index.js'
import { entities } from '../../../../repo/entities.js'
import { relationships } from '../../../../repo/relationships.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../../../repo/__tests__/_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const EMPTY_REGISTRY: VocabularyRegistry = { entries: [], adjacent_franchises: [] }

// Mock ONLY the LLM. Everything else is real Postgres through the repo.
vi.mock('../../../ai.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../ai.js')>()
  return { ...actual, generateObject: vi.fn() }
})
const mockGenerateObject = vi.mocked(generateObject)

type AccessLevel = 'known' | 'discoverable' | 'secret'

interface SeedResult {
  worldId: string
  entityA: string // location, 'Old Eredil', known
  entityB: string // npc, 'Mara', known (overridable)
  entityC: string // location, 'The Wharf', known (overridable)
  factX: string // entityA / topic 'history' / known
  relR: string // A→B rivalry, synth_key entity_relationships/relationships/0
  relS: string // B→C employed_by, synth_key entity_relationships/relationships/1
}

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' })
}

// generateObject mock returns { output, usage }. usage tokens drive cost.
function mockPatches(
  patches: unknown[],
  usage: { inputTokens: number; outputTokens: number } = { inputTokens: 14000, outputTokens: 2000 },
): void {
  mockGenerateObject.mockResolvedValueOnce({
    output: { patches },
    usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens },
    repairAttempted: false,
  } as unknown as Awaited<ReturnType<typeof generateObject>>)
}

function eventsOfType<T extends PipelineEvent['type']>(
  events: readonly PipelineEvent[],
  type: T,
): Extract<PipelineEvent, { type: T }>[] {
  return events.filter((e): e is Extract<PipelineEvent, { type: T }> => e.type === type)
}

describe('runCoherencePassStage', () => {
  let pool: Pool
  let repo: Repo
  let scope: TestScope
  let userIndex = 0

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    scope = makeTestScope('coherence-pass')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    mockGenerateObject.mockReset()
    await cleanupTestScope(pool, scope)
    // Seed the world-gen cost cap row used by the pre-stage cap check. The
    // value is well above the per-test completed cost so the happy paths never
    // trip the cap-fire exception (the cap-fire test seeds a high prior cost).
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('world_gen_cost_cap_usd', '100.0')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    )
  })

  // Seed the canonical 3-entity / 1-fact / 2-relationship fixture the old mock
  // returned. `accessLevels` overrides per-entity tier for the tier-gating tests.
  async function seedWorld(
    accessLevels: Readonly<Record<'A' | 'B' | 'C', AccessLevel>> = { A: 'known', B: 'known', C: 'known' },
  ): Promise<SeedResult> {
    const idx = userIndex++
    const userId = uuidv7()
    const worldId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(idx), scope.displayName(idx), scope.username(idx)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, userId, scope.worldName(idx)],
    )
    const entityA = uuidv7()
    const entityB = uuidv7()
    const entityC = uuidv7()
    const factX = uuidv7()
    await entities.insert(pool, {
      id: entityA, worldId, entityType: 'location', name: 'Old Eredil', accessLevel: accessLevels.A, createdIn: 'stage:test',
    })
    await entities.insert(pool, {
      id: entityB, worldId, entityType: 'npc', name: 'Mara', accessLevel: accessLevels.B, createdIn: 'stage:test',
    })
    await entities.insert(pool, {
      id: entityC, worldId, entityType: 'location', name: 'The Wharf', accessLevel: accessLevels.C, createdIn: 'stage:test',
    })
    await pool.query(`INSERT INTO prose_kernels (id, entity_id, content) VALUES ($1, $2, 'A weathered fishing village.')`, [uuidv7(), entityA])
    await pool.query(`INSERT INTO prose_kernels (id, entity_id, content) VALUES ($1, $2, 'A guarded harbormaster.')`, [uuidv7(), entityB])
    await pool.query(`INSERT INTO prose_kernels (id, entity_id, content) VALUES ($1, $2, 'The salt-eaten wharf.')`, [uuidv7(), entityC])
    await pool.query(
      `INSERT INTO facts (id, entity_id, topic, access_level, narrative_status, content)
       VALUES ($1, $2, 'history', 'known', 'undelivered', 'The village burned down in the great fire.')`,
      [factX, entityA],
    )
    const [relR] = await relationships.insertMany(pool, [{
      sourceEntityId: entityA, targetEntityId: entityB, relationshipType: 'rivalry',
      description: 'Mara distrusts the village elders.', accessLevel: 'known', synthKey: 'entity_relationships/relationships/0',
    }])
    const [relS] = await relationships.insertMany(pool, [{
      sourceEntityId: entityB, targetEntityId: entityC, relationshipType: 'employed_by',
      description: 'Mara works the wharf.', accessLevel: 'known', synthKey: 'entity_relationships/relationships/1',
    }])
    return { worldId, entityA, entityB, entityC, factX, relR: relR ?? '', relS: relS ?? '' }
  }

  // Run the handler with the per-entity synthKey map keyed on the seeded UUIDs.
  async function run(
    seed: SeedResult,
    opts: { bypassAccessFilter?: boolean; vocabularyRegistry?: VocabularyRegistry } = {},
  ): Promise<{ result: Awaited<ReturnType<typeof runCoherencePassStage>>; logger: pino.Logger }> {
    const logger = silentLogger()
    const result = await runCoherencePassStage(repo, {
      logger,
      worldId: seed.worldId,
      vocabularyRegistry: opts.vocabularyRegistry ?? EMPTY_REGISTRY,
      // The per-entity synthKey map mirrors the synthKeys minted by stages 2/3.
      synthKeyByEntityId: {
        [seed.entityA]: 'world_and_factions/regions/0',
        [seed.entityB]: 'locations_and_npcs/npcs/0',
        [seed.entityC]: 'locations_and_npcs/locations/0',
      },
      bypassAccessFilter: opts.bypassAccessFilter ?? false,
    })
    return { result, logger }
  }

  async function countRelationships(worldId: string): Promise<number> {
    const r = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM relationships rel
         JOIN entities e ON e.id = rel.source_entity_id WHERE e.world_id = $1`,
      [worldId],
    )
    return Number(r.rows[0]?.n ?? 0)
  }

  it('applies one of each patch kind + returns finalizedEvents; DB reflects the writes', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'fix_prose_by_name', entity_name: 'Old Eredil', new_prose: 'A weathered fishing village half-rebuilt after the fire.', rationale: 'Prose said burned-down but a fact references active bakery.' },
      { kind: 'fix_fact_by_name', entity_name: 'Old Eredil', fact_topic: 'history', new_content: 'The village burned a generation ago; only the harbor remains.', rationale: 'Original wording contradicted the rebuild timeline elsewhere.' },
      { kind: 'rename_entity_by_name', old_name: 'Mara', new_name: 'Mara Salt-Hand', rationale: 'Other entities reference Mara Salt-Hand; full name unifies.' },
      { kind: 'fix_relationship_by_name', source_name: 'Old Eredil', target_name: 'Mara', current_type: 'rivalry', newType: 'distrusts', newDescription: 'Mara distrusts the village elders and avoids the upper square.', rationale: 'Type rivalry was too strong for the prose; softened to distrust.' },
      { kind: 'delete_relationship_by_name', source_name: 'Mara', target_name: 'The Wharf', current_type: 'employed_by', rationale: 'Duplicate relationship; redundant with REL_R after fix.' },
    ])

    const { result } = await run(seed)

    // Sonnet pricing: 14000/1M * 3 + 2000/1M * 15 = 0.072
    expect(result.costUsd).toBeCloseTo(0.072, 4)
    expect(result.inputTokens).toBe(14000)
    expect(result.outputTokens).toBe(2000)
    expect(result.capExhausted).toBe(false)
    expect(result.finalizedEvents).toHaveLength(6)

    // DB effects — the binder SQL actually ran.
    const prose = await pool.query<{ content: string }>(`SELECT content FROM prose_kernels WHERE entity_id = $1`, [seed.entityA])
    expect(prose.rows[0]?.content).toBe('A weathered fishing village half-rebuilt after the fire.')
    const fact = await pool.query<{ content: string }>(`SELECT content FROM facts WHERE id = $1`, [seed.factX])
    expect(fact.rows[0]?.content).toBe('The village burned a generation ago; only the harbor remains.')
    const renamed = await pool.query<{ name: string }>(`SELECT name FROM entities WHERE id = $1`, [seed.entityB])
    expect(renamed.rows[0]?.name).toBe('Mara Salt-Hand')
    // fix_relationship deletes REL_R + inserts a new edge; delete_relationship
    // drops REL_S → net 2 deletes + 1 insert = 1 relationship remaining.
    expect(await countRelationships(seed.worldId)).toBe(1)

    const updates = eventsOfType(result.finalizedEvents, 'entity-updated')
    expect(updates.find((p) => p.synthKey === 'world_and_factions/regions/0')?.patch).toMatchObject({ prose: 'A weathered fishing village half-rebuilt after the fire.' })
    expect(updates.find((p) => p.synthKey === 'locations_and_npcs/npcs/0')?.patch).toMatchObject({ name: 'Mara Salt-Hand' })
    expect(eventsOfType(result.finalizedEvents, 'fact-updated')).toHaveLength(1)
    const removed = eventsOfType(result.finalizedEvents, 'edge-removed')
    expect(removed.find((p) => p.synthKey === 'entity_relationships/relationships/0')?.reason).toBe('coherence_deleted')
    expect(removed.find((p) => p.synthKey === 'entity_relationships/relationships/1')?.reason).toBe('coherence_deleted')
    const added = eventsOfType(result.finalizedEvents, 'edge-added')
    expect(added.find((p) => p.relationship === 'distrusts')?.from).toBe(seed.entityA)
  })

  it('skips patches that reference unknown names and logs WARN, but applies the rest', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'fix_prose_by_name', entity_name: 'Old Eredil', new_prose: 'A weathered fishing village that has slowly rebuilt itself.', rationale: 'Prose said burned-down but a fact references active bakery.' },
      { kind: 'fix_prose_by_name', entity_name: 'Phantom Village', new_prose: 'Some prose that should never be persisted to the DB.', rationale: 'LLM hallucinated this entity name.' },
      { kind: 'fix_fact_by_name', entity_name: 'Old Eredil', fact_topic: 'imaginary-topic', new_content: 'New content that should never land.', rationale: 'LLM hallucinated this fact topic.' },
      { kind: 'delete_relationship_by_name', source_name: 'Mara', target_name: 'Phantom Tower', current_type: 'guards', rationale: 'LLM hallucinated this relationship.' },
      { kind: 'rename_entity_by_name', old_name: 'Phantom Village', new_name: 'Phantom Name', rationale: 'LLM hallucinated this entity name.' },
      { kind: 'fix_relationship_by_name', source_name: 'Old Eredil', target_name: 'Mara', current_type: 'phantom_type', newType: 'phantom_link', rationale: 'LLM hallucinated this relationship triple.' },
    ])

    const logger = silentLogger()
    const warnSpy = vi.spyOn(logger, 'warn')
    const result = await runCoherencePassStage(repo, {
      logger, worldId: seed.worldId, vocabularyRegistry: EMPTY_REGISTRY,
      synthKeyByEntityId: { [seed.entityA]: 'world_and_factions/regions/0' }, bypassAccessFilter: false,
    })

    expect(result.finalizedEvents).toHaveLength(1)
    expect(result.finalizedEvents[0]?.type).toBe('entity-updated')
    // Five unknown-id WARN logs (one per skipped patch).
    expect(warnSpy).toHaveBeenCalledTimes(5)
    // The good fix_prose actually landed; the phantom one did not.
    const prose = await pool.query<{ content: string }>(`SELECT content FROM prose_kernels WHERE entity_id = $1`, [seed.entityA])
    expect(prose.rows[0]?.content).toBe('A weathered fishing village that has slowly rebuilt itself.')
  })

  it('rename patches apply LAST so other patches resolve against pre-rename names (myth-2ob3 §4.1)', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'rename_entity_by_name', old_name: 'Mara', new_name: 'Mara Salt-Hand', rationale: 'Other entities reference Mara Salt-Hand; full name unifies.' },
      { kind: 'fix_prose_by_name', entity_name: 'Mara', new_prose: 'A guarded harbormaster who knows every name on the tide log.', rationale: 'Sharpening prose with sensory detail and craft.' },
    ], { inputTokens: 1000, outputTokens: 100 })

    const { result } = await run(seed, { bypassAccessFilter: true })

    // Both patches applied against ENTITY_B (resolved pre-rename).
    const updates = eventsOfType(result.finalizedEvents, 'entity-updated')
    expect(updates).toHaveLength(2)
    for (const u of updates) expect(u.synthKey).toBe('locations_and_npcs/npcs/0')
    // DB: prose updated AND name renamed (both landed).
    const row = await pool.query<{ name: string }>(`SELECT name FROM entities WHERE id = $1`, [seed.entityB])
    expect(row.rows[0]?.name).toBe('Mara Salt-Hand')
    const prose = await pool.query<{ content: string }>(`SELECT content FROM prose_kernels WHERE entity_id = $1`, [seed.entityB])
    expect(prose.rows[0]?.content).toContain('every name on the tide log')
  })

  it('completes successfully when LLM emits zero patches (no-op coherence)', async () => {
    const seed = await seedWorld()
    mockPatches([], { inputTokens: 14000, outputTokens: 50 })
    const { result } = await run(seed)
    expect(result.costUsd).toBeGreaterThan(0)
    expect(result.inputTokens).toBe(14000)
    expect(result.outputTokens).toBe(50)
    expect(result.capExhausted).toBe(false)
    expect(result.finalizedEvents).toEqual([])
  })

  it('cap-fire exception: cap exhausted pre-stage signals capExhausted + phase:complete via finalizedEvents (per §D5)', async () => {
    const seed = await seedWorld()
    // Lower the cap below the prior completed cost. Seed a completed stage row
    // so sumCostForWorld returns > cap.
    await pool.query(`UPDATE settings SET value = '3.0' WHERE key = 'world_gen_cost_cap_usd'`)
    await pool.query(
      `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, cost_usd, user_id)
       VALUES ($1, $2, 'starting_situation', 'completed', now(), 3.05, NULL)`,
      [uuidv7(), seed.worldId],
    )
    const logger = silentLogger()
    const warnSpy = vi.spyOn(logger, 'warn')
    const result = await runCoherencePassStage(repo, {
      logger, worldId: seed.worldId, vocabularyRegistry: EMPTY_REGISTRY,
      synthKeyByEntityId: {}, bypassAccessFilter: false,
    })

    expect(mockGenerateObject).not.toHaveBeenCalled()
    expect(result.costUsd).toBe(0)
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
    expect(result.capExhausted).toBe(true)
    expect(result.finalizedEvents).toEqual([{ type: 'phase', phase: 'complete' }])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warnSpy.mock.calls[0])).toContain('coherence_pass')
  })

  it('fix_relationship preserves existing fields when newType / newDescription are omitted', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'fix_relationship_by_name', source_name: 'Old Eredil', target_name: 'Mara', current_type: 'rivalry', newType: 'allies_with', rationale: 'Rivalry is too strong; allies fits the prose better.' },
      { kind: 'fix_relationship_by_name', source_name: 'Mara', target_name: 'The Wharf', current_type: 'employed_by', newDescription: 'Mara now serves as the wharf master, hand-picked.', rationale: 'Description was too thin; sharpening with new detail.' },
    ])
    const { result } = await run(seed)
    const added = eventsOfType(result.finalizedEvents, 'edge-added')
    const addedR = added.find((p) => p.relationship === 'allies_with')
    expect(addedR?.from).toBe(seed.entityA)
    expect(addedR?.to).toBe(seed.entityB)
    const addedS = added.find((p) => p.relationship === 'employed_by')
    expect(addedS?.from).toBe(seed.entityB)
    expect(addedS?.to).toBe(seed.entityC)
    // DB: the second fix's new row carries the fallback type + new description.
    const newEdge = await pool.query<{ description: string }>(
      `SELECT description FROM relationships WHERE source_entity_id = $1 AND target_entity_id = $2 AND relationship_type = 'employed_by' AND synth_key LIKE 'coherence_pass/edges/%'`,
      [seed.entityB, seed.entityC],
    )
    expect(newEdge.rows[0]?.description).toBe('Mara now serves as the wharf master, hand-picked.')
  })

  // MYT-89 Phase A (A4): fix_relationship re-tiers only when newAccessLevel
  // is supplied; otherwise the delete+re-insert must PRESERVE the existing
  // tier (a fix that doesn't touch the tier must not blank it). The seed
  // relationship is 'known'.
  it('fix_relationship preserves the existing access_level when newAccessLevel is omitted', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'fix_relationship_by_name', source_name: 'Old Eredil', target_name: 'Mara', current_type: 'rivalry', newType: 'distrusts', rationale: 'Soften rivalry to distrust; tier is unchanged.' },
    ])
    await run(seed)
    const newEdge = await pool.query<{ access_level: string }>(
      `SELECT access_level FROM relationships WHERE source_entity_id = $1 AND target_entity_id = $2 AND relationship_type = 'distrusts' AND synth_key LIKE 'coherence_pass/edges/%'`,
      [seed.entityA, seed.entityB],
    )
    expect(newEdge.rows[0]?.access_level).toBe('known')
  })

  it('fix_relationship re-tiers the row when newAccessLevel is supplied', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'fix_relationship_by_name', source_name: 'Old Eredil', target_name: 'Mara', current_type: 'rivalry', newAccessLevel: 'secret', rationale: 'This connection is a hidden grudge; re-tier to secret.' },
    ])
    await run(seed, { bypassAccessFilter: true })
    const newEdge = await pool.query<{ access_level: string }>(
      `SELECT access_level FROM relationships WHERE source_entity_id = $1 AND target_entity_id = $2 AND relationship_type = 'rivalry' AND synth_key LIKE 'coherence_pass/edges/%'`,
      [seed.entityA, seed.entityB],
    )
    expect(newEdge.rows[0]?.access_level).toBe('secret')
  })

  it('renders the world dump into the {{worldDump}} placeholder of the prompt', async () => {
    const seed = await seedWorld()
    mockPatches([], { inputTokens: 14000, outputTokens: 50 })
    await run(seed)
    const firstArg = mockGenerateObject.mock.calls[0]?.[0] as { prompt: string } | undefined
    const prompt = firstArg?.prompt ?? ''
    expect(prompt).toContain(seed.entityA)
    expect(prompt).toContain('weathered fishing village')
    expect(prompt).toContain(seed.factX)
    expect(prompt).toContain('burned down in the great fire')
    expect(prompt).toContain(seed.relR)
    expect(prompt).toContain('rivalry')
    expect(prompt).not.toContain('{{worldDump}}')
  })

  // ── tier-aware SSE emission (myth-exac T16) ───────────────────────────────

  it('entity-updated fires for a patch targeting a known-tier entity', async () => {
    const seed = await seedWorld({ A: 'known', B: 'known', C: 'known' })
    mockPatches([
      { kind: 'fix_prose_by_name', entity_name: 'Old Eredil', new_prose: 'A rebuilt fishing village.', rationale: 'Sharpening prose to match world facts.' },
    ], { inputTokens: 1000, outputTokens: 100 })
    const { result } = await run(seed)
    const updates = eventsOfType(result.finalizedEvents, 'entity-updated')
    expect(updates).toHaveLength(1)
    expect(updates[0]?.synthKey).toBe('world_and_factions/regions/0')
  })

  it('entity-updated does NOT fire for a non-known entity, but the DB write still happens', async () => {
    const seed = await seedWorld({ A: 'known', B: 'discoverable', C: 'secret' })
    mockPatches([
      { kind: 'fix_prose_by_name', entity_name: 'Mara', new_prose: 'A guarded harbormaster who knows the tides.', rationale: 'Sharpening prose.' },
      { kind: 'rename_entity_by_name', old_name: 'The Wharf', new_name: 'The Old Wharf', rationale: 'Disambiguate from new wharf.' },
    ], { inputTokens: 1000, outputTokens: 100 })
    const { result } = await run(seed)
    expect(eventsOfType(result.finalizedEvents, 'entity-updated')).toHaveLength(0)
    // DB writes still happened.
    const prose = await pool.query<{ content: string }>(`SELECT content FROM prose_kernels WHERE entity_id = $1`, [seed.entityB])
    expect(prose.rows[0]?.content).toContain('knows the tides')
    const renamed = await pool.query<{ name: string }>(`SELECT name FROM entities WHERE id = $1`, [seed.entityC])
    expect(renamed.rows[0]?.name).toBe('The Old Wharf')
  })

  it('edge-added / edge-removed suppressed unless both endpoints are known-tier', async () => {
    const seed = await seedWorld({ A: 'known', B: 'discoverable', C: 'known' })
    mockPatches([
      { kind: 'fix_relationship_by_name', source_name: 'Old Eredil', target_name: 'Mara', current_type: 'rivalry', newType: 'distrusts', newDescription: 'Mara distrusts the elders.', rationale: 'Tone the rivalry down to distrust.' },
      { kind: 'delete_relationship_by_name', source_name: 'Mara', target_name: 'The Wharf', current_type: 'employed_by', rationale: 'Redundant edge.' },
    ], { inputTokens: 1000, outputTokens: 100 })
    const { result } = await run(seed)
    expect(eventsOfType(result.finalizedEvents, 'edge-added')).toHaveLength(0)
    expect(eventsOfType(result.finalizedEvents, 'edge-removed')).toHaveLength(0)
    // DB still mutated (REL_R replaced, REL_S deleted) → 1 row remains.
    expect(await countRelationships(seed.worldId)).toBe(1)
  })

  it('edge events fire when BOTH endpoints are known-tier', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'fix_relationship_by_name', source_name: 'Old Eredil', target_name: 'Mara', current_type: 'rivalry', newType: 'distrusts', newDescription: 'Mara distrusts the elders.', rationale: 'Tone down rivalry.' },
    ], { inputTokens: 1000, outputTokens: 100 })
    const { result } = await run(seed)
    expect(eventsOfType(result.finalizedEvents, 'edge-added')).toHaveLength(1)
    expect(eventsOfType(result.finalizedEvents, 'edge-removed')).toHaveLength(1)
  })

  it('with bypassAccessFilter=true, ALL coherence patches fire SSE deltas regardless of tier', async () => {
    const seed = await seedWorld({ A: 'known', B: 'discoverable', C: 'secret' })
    mockPatches([
      { kind: 'fix_prose_by_name', entity_name: 'Mara', new_prose: 'A guarded harbormaster.', rationale: 'Sharpen.' },
      { kind: 'rename_entity_by_name', old_name: 'The Wharf', new_name: 'The Old Wharf', rationale: 'Disambiguate.' },
      { kind: 'fix_relationship_by_name', source_name: 'Old Eredil', target_name: 'Mara', current_type: 'rivalry', newType: 'distrusts', newDescription: 'Mara distrusts the elders.', rationale: 'Tone down.' },
      { kind: 'delete_relationship_by_name', source_name: 'Mara', target_name: 'The Wharf', current_type: 'employed_by', rationale: 'Redundant.' },
    ], { inputTokens: 1000, outputTokens: 100 })
    const { result } = await run(seed, { bypassAccessFilter: true })
    expect(result.finalizedEvents).toHaveLength(5)
    expect(eventsOfType(result.finalizedEvents, 'entity-updated')).toHaveLength(2)
    expect(eventsOfType(result.finalizedEvents, 'edge-added')).toHaveLength(1)
    expect(eventsOfType(result.finalizedEvents, 'edge-removed')).toHaveLength(2)
  })

  it('substitutes {{vocabularyRegistry}} with the rendered registry prose', async () => {
    const seed = await seedWorld()
    mockPatches([], { inputTokens: 14000, outputTokens: 50 })
    const registry: VocabularyRegistry = {
      entries: [{ term: 'the unwitched', definition: "non-magical people; this world's term for those without arcane sight.", avoids: 'muggle', source: 'stage_1_5', access_level: 'known' }],
      adjacent_franchises: ['Harry Potter'],
    }
    await run(seed, { vocabularyRegistry: registry })
    const firstArg = mockGenerateObject.mock.calls[0]?.[0] as { prompt: string } | undefined
    const prompt = firstArg?.prompt ?? ''
    expect(prompt).toContain("This world's distinctive vocabulary:")
    expect(prompt).toContain('the unwitched')
    expect(prompt).not.toContain('{{vocabularyRegistry}}')
  })

  it('world dump includes [access_level: …] per entity', async () => {
    const seed = await seedWorld({ A: 'known', B: 'discoverable', C: 'secret' })
    mockPatches([], { inputTokens: 14000, outputTokens: 50 })
    await run(seed)
    const firstArg = mockGenerateObject.mock.calls[0]?.[0] as { prompt: string } | undefined
    const prompt = firstArg?.prompt ?? ''
    expect(prompt).toContain('[access_level: known]')
    expect(prompt).toContain('[access_level: discoverable]')
    expect(prompt).toContain('[access_level: secret]')
  })

  // ── fix_relationship endpoint rewriting (myth-imxg T16) ───────────────────

  it('fix_relationship with newSource rewrites the source endpoint', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'fix_relationship_by_name', source_name: 'Mara', target_name: 'The Wharf', current_type: 'employed_by', newSource: 'Old Eredil', rationale: 'Description correctly says the village employs the wharf, not Mara.' },
    ], { inputTokens: 100, outputTokens: 100 })
    const { result } = await run(seed, { bypassAccessFilter: true })
    const newEdge = await pool.query<{ source_entity_id: string; target_entity_id: string }>(
      `SELECT source_entity_id, target_entity_id FROM relationships WHERE synth_key LIKE 'coherence_pass/edges/%'`,
    )
    expect(newEdge.rows).toHaveLength(1)
    expect(newEdge.rows[0]?.source_entity_id).toBe(seed.entityA)
    expect(newEdge.rows[0]?.target_entity_id).toBe(seed.entityC)
    const added = eventsOfType(result.finalizedEvents, 'edge-added')
    expect(added).toHaveLength(1)
    expect(added[0]?.from).toBe(seed.entityA)
    expect(added[0]?.to).toBe(seed.entityC)
  })

  it('fix_relationship with newTarget rewrites the target endpoint', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'fix_relationship_by_name', source_name: 'Mara', target_name: 'The Wharf', current_type: 'employed_by', newTarget: 'Old Eredil', rationale: 'Wrong target — relationship should land on Old Eredil.' },
    ], { inputTokens: 100, outputTokens: 100 })
    const { result } = await run(seed, { bypassAccessFilter: true })
    const newEdge = await pool.query<{ source_entity_id: string; target_entity_id: string }>(
      `SELECT source_entity_id, target_entity_id FROM relationships WHERE synth_key LIKE 'coherence_pass/edges/%'`,
    )
    expect(newEdge.rows[0]?.source_entity_id).toBe(seed.entityB)
    expect(newEdge.rows[0]?.target_entity_id).toBe(seed.entityA)
    const added = eventsOfType(result.finalizedEvents, 'edge-added')
    expect(added[0]?.from).toBe(seed.entityB)
    expect(added[0]?.to).toBe(seed.entityA)
  })

  it('fix_relationship drops with WARN when newSource is unresolvable', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'fix_relationship_by_name', source_name: 'Mara', target_name: 'The Wharf', current_type: 'employed_by', newSource: 'Nobody Such', rationale: 'Trying to move the edge to an entity that does not exist.' },
    ], { inputTokens: 100, outputTokens: 100 })
    const logger = silentLogger()
    const warnSpy = vi.spyOn(logger, 'warn')
    const result = await runCoherencePassStage(repo, {
      logger, worldId: seed.worldId, vocabularyRegistry: EMPTY_REGISTRY, synthKeyByEntityId: {}, bypassAccessFilter: true,
    })
    expect(result.finalizedEvents.filter((e) => e.type === 'edge-removed' || e.type === 'edge-added')).toHaveLength(0)
    expect(await countRelationships(seed.worldId)).toBe(2) // no insert/delete
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'coherence_pass', kind: 'fix_relationship_by_name' }),
      expect.stringMatching(/newSource|new_source|unresolvable/i),
    )
  })

  it('fix_relationship drops with WARN when newTarget is unresolvable', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'fix_relationship_by_name', source_name: 'Mara', target_name: 'The Wharf', current_type: 'employed_by', newTarget: 'Nobody Such', rationale: 'Trying to move the edge target to an entity that does not exist.' },
    ], { inputTokens: 100, outputTokens: 100 })
    const logger = silentLogger()
    const warnSpy = vi.spyOn(logger, 'warn')
    const result = await runCoherencePassStage(repo, {
      logger, worldId: seed.worldId, vocabularyRegistry: EMPTY_REGISTRY, synthKeyByEntityId: {}, bypassAccessFilter: true,
    })
    expect(result.finalizedEvents.filter((e) => e.type === 'edge-removed' || e.type === 'edge-added')).toHaveLength(0)
    expect(await countRelationships(seed.worldId)).toBe(2)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'coherence_pass', kind: 'fix_relationship_by_name' }),
      expect.stringMatching(/newTarget|new_target|unresolvable/i),
    )
  })

  // ── add_relationship_by_name (myth-imxg T17) ──────────────────────────────

  it('add_relationship_by_name inserts a row + emits edge-added', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'add_relationship_by_name', source_name: 'Old Eredil', target_name: 'Mara', relationship: 'home_of', description: 'Mara was born and raised in Old Eredil.', access_level: 'known', rationale: 'Prose explicitly says Mara grew up here; relation was missed at stage 4.' },
    ], { inputTokens: 100, outputTokens: 100 })
    const { result } = await run(seed, { bypassAccessFilter: true })
    expect(await countRelationships(seed.worldId)).toBe(3) // 2 seeded + 1 added
    const newEdge = await pool.query<{ source_entity_id: string; target_entity_id: string }>(
      `SELECT source_entity_id, target_entity_id FROM relationships WHERE relationship_type = 'home_of'`,
    )
    expect(newEdge.rows[0]?.source_entity_id).toBe(seed.entityA)
    expect(newEdge.rows[0]?.target_entity_id).toBe(seed.entityB)
    const added = eventsOfType(result.finalizedEvents, 'edge-added')
    expect(added).toHaveLength(1)
    expect(added[0]?.relationship).toBe('home_of')
  })

  it('add_relationship_by_name drops with WARN when source name unresolvable', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'add_relationship_by_name', source_name: 'Nobody', target_name: 'Mara', relationship: 'home_of', description: 'This relationship cannot land; source does not exist.', access_level: 'known', rationale: 'The model thought Nobody existed but no entity by that name.' },
    ], { inputTokens: 100, outputTokens: 100 })
    const logger = silentLogger()
    const warnSpy = vi.spyOn(logger, 'warn')
    const result = await runCoherencePassStage(repo, {
      logger, worldId: seed.worldId, vocabularyRegistry: EMPTY_REGISTRY, synthKeyByEntityId: {}, bypassAccessFilter: false,
    })
    expect(await countRelationships(seed.worldId)).toBe(2)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'coherence_pass', kind: 'add_relationship_by_name' }),
      expect.any(String),
    )
    expect(result.finalizedEvents.filter((e) => e.type === 'edge-added')).toHaveLength(0)
  })

  it('add_relationship_by_name drops with WARN when (source, target, type) already exists', async () => {
    const seed = await seedWorld()
    // A→B rivalry is REL_R in the fixture.
    mockPatches([
      { kind: 'add_relationship_by_name', source_name: 'Old Eredil', target_name: 'Mara', relationship: 'rivalry', description: 'Duplicate of an existing relationship.', access_level: 'known', rationale: 'The model emitted an add for a triple that already exists.' },
    ], { inputTokens: 100, outputTokens: 100 })
    const logger = silentLogger()
    const warnSpy = vi.spyOn(logger, 'warn')
    await runCoherencePassStage(repo, {
      logger, worldId: seed.worldId, vocabularyRegistry: EMPTY_REGISTRY, synthKeyByEntityId: {}, bypassAccessFilter: false,
    })
    expect(await countRelationships(seed.worldId)).toBe(2) // no insert
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'would_be_duplicate' }),
      expect.any(String),
    )
  })

  it('add_relationship_by_name persists the row but suppresses edge-added when an endpoint is non-known', async () => {
    const seed = await seedWorld({ A: 'known', B: 'discoverable', C: 'known' })
    mockPatches([
      { kind: 'add_relationship_by_name', source_name: 'Old Eredil', target_name: 'Mara', relationship: 'home_of', description: 'Mara was born and raised in Old Eredil.', access_level: 'known', rationale: 'Prose says she grew up here; relation missed at stage 4.' },
    ], { inputTokens: 100, outputTokens: 100 })
    const { result } = await run(seed)
    expect(await countRelationships(seed.worldId)).toBe(3) // INSERT still lands
    expect(eventsOfType(result.finalizedEvents, 'edge-added')).toHaveLength(0)
  })

  // ── add_fact_by_name (myth-imxg T18) ──────────────────────────────────────

  it('add_fact_by_name inserts a fact (with narrative_status) + emits fact-added', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'add_fact_by_name', entity_name: 'Old Eredil', topic: 'governance', content: 'Old Eredil is administered by the harbor council.', access_level: 'known', rationale: 'Prose explicitly references the council; structured fact was missed.' },
    ], { inputTokens: 100, outputTokens: 100 })
    const { result } = await run(seed, { bypassAccessFilter: true })
    // The fact landed with the canonical 'undelivered' narrative_status (the
    // facts.insertOne binder bakes the literal in — NOT NULL with no DEFAULT).
    const fact = await pool.query<{ narrative_status: string; topic: string }>(
      `SELECT narrative_status, topic FROM facts WHERE entity_id = $1 AND topic = 'governance'`,
      [seed.entityA],
    )
    expect(fact.rows).toHaveLength(1)
    expect(fact.rows[0]?.narrative_status).toBe('undelivered')
    const added = eventsOfType(result.finalizedEvents, 'fact-added')
    expect(added).toHaveLength(1)
    expect(added[0]?.topic).toBe('governance')
    expect(added[0]?.accessLevel).toBe('known')
    expect(added[0]?.entitySynthKey).toBe('world_and_factions/regions/0')
  })

  it('add_fact_by_name drops with WARN when (entity, topic) already exists', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'add_fact_by_name', entity_name: 'Old Eredil', topic: 'history', content: 'A different angle on the village history.', access_level: 'known', rationale: 'The model emitted an add for a topic that already has a fact.' },
    ], { inputTokens: 100, outputTokens: 100 })
    const logger = silentLogger()
    const warnSpy = vi.spyOn(logger, 'warn')
    await runCoherencePassStage(repo, {
      logger, worldId: seed.worldId, vocabularyRegistry: EMPTY_REGISTRY, synthKeyByEntityId: {}, bypassAccessFilter: false,
    })
    const count = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM facts WHERE entity_id = $1 AND topic = 'history'`, [seed.entityA])
    expect(Number(count.rows[0]?.n)).toBe(1) // no second history fact
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'would_be_duplicate_topic' }),
      expect.any(String),
    )
  })

  it('add_fact_by_name persists the row but suppresses fact-added when entity is non-known', async () => {
    const seed = await seedWorld({ A: 'known', B: 'discoverable', C: 'known' })
    mockPatches([
      { kind: 'add_fact_by_name', entity_name: 'Mara', topic: 'role', content: 'Mara serves as the harbormaster of Old Eredil.', access_level: 'discoverable', rationale: 'Prose says she runs the harbor; structured fact was missed.' },
    ], { inputTokens: 100, outputTokens: 100 })
    const { result } = await run(seed)
    const count = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM facts WHERE entity_id = $1 AND topic = 'role'`, [seed.entityB])
    expect(Number(count.rows[0]?.n)).toBe(1) // INSERT still lands
    expect(eventsOfType(result.finalizedEvents, 'fact-added')).toHaveLength(0)
  })

  it('add_fact_by_name drops with WARN when entity name unresolvable', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'add_fact_by_name', entity_name: 'Nobody', topic: 'role', content: 'No entity by that name exists.', access_level: 'known', rationale: 'The model thought Nobody existed.' },
    ], { inputTokens: 100, outputTokens: 100 })
    const logger = silentLogger()
    const warnSpy = vi.spyOn(logger, 'warn')
    const result = await runCoherencePassStage(repo, {
      logger, worldId: seed.worldId, vocabularyRegistry: EMPTY_REGISTRY, synthKeyByEntityId: {}, bypassAccessFilter: false,
    })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'coherence_pass', kind: 'add_fact_by_name' }),
      expect.any(String),
    )
    expect(result.finalizedEvents.filter((e) => e.type === 'fact-added')).toHaveLength(0)
  })

  it('uses synthKeyByRelationshipId from inventory when emitting edge-removed (myth-p4sz)', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'delete_relationship_by_name', source_name: 'Mara', target_name: 'The Wharf', current_type: 'employed_by', rationale: 'Duplicate / unsupported by prose; remove this edge.' },
    ], { inputTokens: 100, outputTokens: 100 })
    // synthKeyByEntityId deliberately covers ONLY entities, not relationship
    // UUIDs — the handler must read the edge synthKey from the inventory's
    // relationships (the synth_key column), not from synthKeyByEntityId.
    const logger = silentLogger()
    const result = await runCoherencePassStage(repo, {
      logger, worldId: seed.worldId, vocabularyRegistry: EMPTY_REGISTRY,
      synthKeyByEntityId: {
        [seed.entityA]: 'world_and_factions/regions/0',
        [seed.entityB]: 'locations_and_npcs/npcs/0',
        [seed.entityC]: 'locations_and_npcs/locations/0',
      },
      bypassAccessFilter: true,
    })
    const removed = eventsOfType(result.finalizedEvents, 'edge-removed')
    expect(removed).toHaveLength(1)
    expect(removed[0]?.synthKey).toBe('entity_relationships/relationships/1')
  })

  // ── delete_fact_by_name (myth-imxg T19) ───────────────────────────────────

  it('delete_fact_by_name removes the fact + emits fact-removed', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'delete_fact_by_name', entity_name: 'Old Eredil', fact_topic: 'history', rationale: 'Prose explicitly says the village burned generations ago; the history fact is wrong AND no content edit could fix the contradiction.' },
    ], { inputTokens: 100, outputTokens: 100 })
    const { result } = await run(seed, { bypassAccessFilter: true })
    const fact = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM facts WHERE id = $1`, [seed.factX])
    expect(Number(fact.rows[0]?.n)).toBe(0) // deleted
    const removed = eventsOfType(result.finalizedEvents, 'fact-removed')
    expect(removed).toHaveLength(1)
    expect(removed[0]?.factId).toBe(seed.factX)
    expect(removed[0]?.entitySynthKey).toBe('world_and_factions/regions/0')
  })

  it('delete_fact_by_name drops with WARN when (entity, topic) unresolvable', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'delete_fact_by_name', entity_name: 'Nobody', fact_topic: 'history', rationale: 'Cannot resolve. This patch should drop with WARN at the resolver layer because no entity by that name exists.' },
    ], { inputTokens: 100, outputTokens: 100 })
    const logger = silentLogger()
    const warnSpy = vi.spyOn(logger, 'warn')
    const result = await runCoherencePassStage(repo, {
      logger, worldId: seed.worldId, vocabularyRegistry: EMPTY_REGISTRY, synthKeyByEntityId: {}, bypassAccessFilter: false,
    })
    const fact = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM facts WHERE id = $1`, [seed.factX])
    expect(Number(fact.rows[0]?.n)).toBe(1) // not deleted
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'coherence_pass', kind: 'delete_fact_by_name' }),
      expect.any(String),
    )
    expect(result.finalizedEvents.filter((e) => e.type === 'fact-removed')).toHaveLength(0)
  })

  it('delete_fact_by_name persists DB delete but suppresses SSE on non-known tier', async () => {
    const seed = await seedWorld({ A: 'secret', B: 'known', C: 'known' })
    mockPatches([
      { kind: 'delete_fact_by_name', entity_name: 'Old Eredil', fact_topic: 'history', rationale: 'Same as the happy-path test but with non-known tier — DB still deletes, SSE suppressed.' },
    ], { inputTokens: 100, outputTokens: 100 })
    const { result } = await run(seed)
    const fact = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM facts WHERE id = $1`, [seed.factX])
    expect(Number(fact.rows[0]?.n)).toBe(0) // DB delete still happens
    expect(result.finalizedEvents.filter((e) => e.type === 'fact-removed')).toHaveLength(0)
  })

  // ── fix_fact_by_name emits fact-updated (myth-imxg T20) ───────────────────

  it('fix_fact_by_name emits fact-updated (previously silent)', async () => {
    const seed = await seedWorld()
    mockPatches([
      { kind: 'fix_fact_by_name', entity_name: 'Old Eredil', fact_topic: 'history', new_content: 'The village survived the fire and rebuilt within a generation.', rationale: 'Existing fact contradicted prose; tighten the timeline.' },
    ], { inputTokens: 100, outputTokens: 100 })
    const { result } = await run(seed, { bypassAccessFilter: true })
    const updated = eventsOfType(result.finalizedEvents, 'fact-updated')
    expect(updated).toHaveLength(1)
    expect(updated[0]?.topic).toBe('history')
    expect(updated[0]?.content).toContain('rebuilt')
    expect(updated[0]?.factId).toBe(seed.factX)
    expect(updated[0]?.entitySynthKey).toBe('world_and_factions/regions/0')
    expect(updated[0]?.accessLevel).toBe('known')
    const fact = await pool.query<{ content: string }>(`SELECT content FROM facts WHERE id = $1`, [seed.factX])
    expect(fact.rows[0]?.content).toContain('rebuilt')
  })

  it('fix_fact_by_name persists DB update but suppresses SSE on non-known tier', async () => {
    const seed = await seedWorld({ A: 'secret', B: 'known', C: 'known' })
    mockPatches([
      { kind: 'fix_fact_by_name', entity_name: 'Old Eredil', fact_topic: 'history', new_content: 'The village survived the fire and rebuilt within a generation.', rationale: 'Same as the happy-path test but with non-known tier — DB still updates, SSE suppressed.' },
    ], { inputTokens: 100, outputTokens: 100 })
    const { result } = await run(seed)
    const fact = await pool.query<{ content: string }>(`SELECT content FROM facts WHERE id = $1`, [seed.factX])
    expect(fact.rows[0]?.content).toContain('rebuilt') // DB update still happens
    expect(result.finalizedEvents.filter((e) => e.type === 'fact-updated')).toHaveLength(0)
  })
})
