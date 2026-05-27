// Per MYT-52 T12 / design §3.6 + §D5. Stage 7 non-streaming handler.
// Unified-dispatch contract: handler receives a mid-txn PoolClient and
// returns `StageDispatchResult` (finalizedEvents + capExhausted). Mocks
// `ai` + a single client; no Pool, no Redis (outer scope publishes
// finalizedEvents after COMMIT).

import type { PoolClient } from 'pg'
import type pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateText } from 'ai'
import { runCoherencePassStage } from '../coherence-pass.js'
import type { PipelineEvent } from '../../../../contract/pipeline-events.js'
import type { VocabularyRegistry } from '../../../schemas/vocabulary-registry.js'

const EMPTY_REGISTRY: VocabularyRegistry = { entries: [], adjacent_franchises: [] }

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateText: vi.fn(),
    Output: { object: vi.fn((opts: unknown) => opts) },
  }
})

const mockGenerateText = vi.mocked(generateText)

const WORLD_ID = '00000000-0000-0000-0000-00000000aaaa'

// UUIDs used in fixtures. Held as constants so the tests can assert
// exact SQL parameter strings without typos.
const ENTITY_A = '11111111-1111-1111-1111-111111111111'
const ENTITY_B = '22222222-2222-2222-2222-222222222222'
const ENTITY_C = '33333333-3333-3333-3333-333333333333'
const FACT_X = '44444444-4444-4444-4444-444444444444'
const REL_R = '55555555-5555-5555-5555-555555555555'
const REL_S = '66666666-6666-6666-6666-666666666666'
// SynthKeys minted by stages 2/3/4 for those entities/rels. Stage 7
// resolves entityId → synthKey via the supplied map.
const SYNTH = {
  [ENTITY_A]: 'world_and_factions/regions/0',
  [ENTITY_B]: 'locations_and_npcs/npcs/0',
  [ENTITY_C]: 'locations_and_npcs/locations/0',
  [REL_R]: 'entity_relationships/edges/0',
  [REL_S]: 'entity_relationships/edges/1',
}

interface ClientSpy {
  query: ReturnType<typeof vi.fn>
}
interface LoggerSpy {
  warn: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
}

// Adapter casts — spies are structurally compatible with the Pick<>
// surface the handler uses; cast at the call site to keep tests typed.
const asClient = (s: ClientSpy): PoolClient => s as unknown as PoolClient
const asLogger = (s: LoggerSpy): pino.Logger => s as unknown as pino.Logger

// SELECTs return canned world inventory + cost-cap rows; UPDATE/DELETE
// are spied. The single client handles BOTH the cost-cap reads (which
// used to go through `pool.query`) AND the inventory/apply queries —
// reflects the unified contract where the outer scope passes one
// already-BEGUN client.
type AccessLevelOverrides = Readonly<Record<string, 'known' | 'discoverable' | 'secret'>>;

function makeClient(
  opts: {
    capUsd?: number
    completedCostUsd?: number
    accessLevels?: AccessLevelOverrides
  } = {},
): ClientSpy {
  const capUsd = opts.capUsd ?? 3
  const completedCostUsd = opts.completedCostUsd ?? 0.5
  const accessLevels = opts.accessLevels ?? {}

  const entityRows = [
    {
      id: ENTITY_A,
      world_id: WORLD_ID,
      entity_type: 'location',
      name: 'Old Eredil',
      access_level: accessLevels[ENTITY_A] ?? 'known',
    },
    {
      id: ENTITY_B,
      world_id: WORLD_ID,
      entity_type: 'npc',
      name: 'Mara',
      access_level: accessLevels[ENTITY_B] ?? 'known',
    },
    {
      id: ENTITY_C,
      world_id: WORLD_ID,
      entity_type: 'location',
      name: 'The Wharf',
      access_level: accessLevels[ENTITY_C] ?? 'known',
    },
  ]
  const proseRows = [
    { entity_id: ENTITY_A, content: 'A weathered fishing village.' },
    { entity_id: ENTITY_B, content: 'A guarded harbormaster.' },
    { entity_id: ENTITY_C, content: 'The salt-eaten wharf.' },
  ]
  const factRows = [
    {
      id: FACT_X,
      entity_id: ENTITY_A,
      topic: 'history',
      access_level: 'known',
      content: 'The village burned down in the great fire.',
    },
  ]
  const relRows = [
    {
      id: REL_R,
      source_entity_id: ENTITY_A,
      target_entity_id: ENTITY_B,
      relationship_type: 'rivalry',
      description: 'Mara distrusts the village elders.',
      synth_key: 'entity_relationships/relationships/0',
    },
    {
      id: REL_S,
      source_entity_id: ENTITY_B,
      target_entity_id: ENTITY_C,
      relationship_type: 'employed_by',
      description: 'Mara works the wharf.',
      synth_key: 'entity_relationships/relationships/1',
    },
  ]
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('world_gen_cost_cap_usd')) {
        return { rows: [{ value: String(capUsd) }] }
      }
      if (sql.includes('COALESCE(SUM(cost_usd)')) {
        return { rows: [{ total: completedCostUsd }] }
      }
      if (sql.includes('FROM entities')) return { rows: entityRows }
      if (sql.includes('FROM prose_kernels')) return { rows: proseRows }
      if (sql.includes('FROM facts')) return { rows: factRows }
      if (sql.startsWith('SELECT r.id') || sql.includes('FROM relationships')) {
        return { rows: relRows }
      }
      return { rows: [], rowCount: 1 }
    }),
  }
}

function makeLogger(): LoggerSpy {
  return { warn: vi.fn(), info: vi.fn() }
}

interface TestRun {
  client: ClientSpy
  logger: LoggerSpy
}

async function runStage(
  poolOpts: {
    capUsd?: number
    completedCostUsd?: number
    accessLevels?: AccessLevelOverrides
    bypassAccessFilter?: boolean
    vocabularyRegistry?: VocabularyRegistry
  } = {},
): Promise<TestRun & { result: Awaited<ReturnType<typeof runCoherencePassStage>> }> {
  const client = makeClient(poolOpts)
  const logger = makeLogger()
  const result = await runCoherencePassStage(asClient(client), {
    logger: asLogger(logger),
    worldId: WORLD_ID,
    vocabularyRegistry: poolOpts.vocabularyRegistry ?? EMPTY_REGISTRY,
    synthKeyByEntityId: SYNTH,
    bypassAccessFilter: poolOpts.bypassAccessFilter ?? false,
  })
  return { client, logger, result }
}

// Helpers to read finalizedEvents by type narrowing without leaking the
// `any` cast across the test body.
function eventsOfType<T extends PipelineEvent['type']>(
  events: readonly PipelineEvent[],
  type: T,
): Extract<PipelineEvent, { type: T }>[] {
  return events.filter((e): e is Extract<PipelineEvent, { type: T }> => e.type === type)
}

describe('runCoherencePassStage', () => {
  beforeEach(() => {
    mockGenerateText.mockReset()
  })

  it('applies one of each patch kind + returns finalizedEvents for outer publish', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [
          {
            kind: 'fix_prose_by_name',
            entity_name: 'Old Eredil',
            new_prose: 'A weathered fishing village half-rebuilt after the fire.',
            rationale: 'Prose said burned-down but a fact references active bakery.',
          },
          {
            kind: 'fix_fact_by_name',
            entity_name: 'Old Eredil',
            fact_topic: 'history',
            new_content: 'The village burned a generation ago; only the harbor remains.',
            rationale: 'Original wording contradicted the rebuild timeline elsewhere.',
          },
          {
            kind: 'rename_entity_by_name',
            old_name: 'Mara',
            new_name: 'Mara Salt-Hand',
            rationale: 'Other entities reference Mara Salt-Hand; full name unifies.',
          },
          {
            kind: 'fix_relationship_by_name',
            source_name: 'Old Eredil',
            target_name: 'Mara',
            current_type: 'rivalry',
            newType: 'distrusts',
            newDescription: 'Mara distrusts the village elders and avoids the upper square.',
            rationale: 'Type rivalry was too strong for the prose; softened to distrust.',
          },
          {
            kind: 'delete_relationship_by_name',
            source_name: 'Mara',
            target_name: 'The Wharf',
            current_type: 'employed_by',
            rationale: 'Duplicate relationship; redundant with REL_R after fix.',
          },
        ],
      },
      usage: { inputTokens: 14000, outputTokens: 2000, totalTokens: 16000 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { result } = await runStage()

    // Sonnet pricing: 14000/1M * 3 + 2000/1M * 15 = 0.042 + 0.030 = 0.072
    expect(result.costUsd).toBeCloseTo(0.072, 4)
    expect(result.inputTokens).toBe(14000)
    expect(result.outputTokens).toBe(2000)
    expect(result.capExhausted).toBe(false)

    // 6 finalized events (per §3.6 / myth-imxg T20 — fix_fact now emits
    // fact-updated; fix_relationship emits both edge-removed AND edge-added).
    expect(result.finalizedEvents).toHaveLength(6)

    const updates = eventsOfType(result.finalizedEvents, 'entity-updated')
    const prose = updates.find((p) => p.synthKey === SYNTH[ENTITY_A])
    expect(prose?.patch).toMatchObject({
      prose: 'A weathered fishing village half-rebuilt after the fire.',
    })
    const rename = updates.find((p) => p.synthKey === SYNTH[ENTITY_B])
    expect(rename?.patch).toMatchObject({ name: 'Mara Salt-Hand' })

    // fix_fact_by_name targeting topic='history' surfaces as fact-updated.
    const factUpdates = eventsOfType(result.finalizedEvents, 'fact-updated')
    expect(factUpdates).toHaveLength(1)
    expect(factUpdates[0]?.topic).toBe('history')

    // edge-removed events read synthKey from inventory (the relationships
    // table's synth_key column), NOT from the per-entity SYNTH map.
    // Mirrors the fixture rows above (entity_relationships/relationships/N).
    const removed = eventsOfType(result.finalizedEvents, 'edge-removed')
    const edgeRemovedR = removed.find((p) => p.synthKey === 'entity_relationships/relationships/0')
    expect(edgeRemovedR?.reason).toBe('coherence_deleted')
    const edgeRemovedS = removed.find((p) => p.synthKey === 'entity_relationships/relationships/1')
    expect(edgeRemovedS?.reason).toBe('coherence_deleted')

    const added = eventsOfType(result.finalizedEvents, 'edge-added')
    const edgeAdded = added.find((p) => p.relationship === 'distrusts')
    expect(edgeAdded).toBeDefined()
    expect(edgeAdded?.from).toBe(ENTITY_A)
    expect(edgeAdded?.to).toBe(ENTITY_B)
  })

  it('skips patches that reference unknown names and logs WARN, but applies the rest', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [
          // One good patch + five hallucinated-name patches (skipped + warned).
          {
            kind: 'fix_prose_by_name',
            entity_name: 'Old Eredil',
            new_prose: 'A weathered fishing village that has slowly rebuilt itself.',
            rationale: 'Prose said burned-down but a fact references active bakery.',
          },
          {
            kind: 'fix_prose_by_name',
            entity_name: 'Phantom Village',
            new_prose: 'Some prose that should never be persisted to the DB.',
            rationale: 'LLM hallucinated this entity name.',
          },
          {
            kind: 'fix_fact_by_name',
            entity_name: 'Old Eredil',
            fact_topic: 'imaginary-topic',
            new_content: 'New content that should never land.',
            rationale: 'LLM hallucinated this fact topic.',
          },
          {
            kind: 'delete_relationship_by_name',
            source_name: 'Mara',
            target_name: 'Phantom Tower',
            current_type: 'guards',
            rationale: 'LLM hallucinated this relationship.',
          },
          {
            kind: 'rename_entity_by_name',
            old_name: 'Phantom Village',
            new_name: 'Phantom Name',
            rationale: 'LLM hallucinated this entity name.',
          },
          {
            kind: 'fix_relationship_by_name',
            source_name: 'Old Eredil',
            target_name: 'Mara',
            current_type: 'phantom_type',
            newType: 'phantom_link',
            rationale: 'LLM hallucinated this relationship triple.',
          },
        ],
      },
      usage: { inputTokens: 14000, outputTokens: 2000, totalTokens: 16000 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { logger, result } = await runStage()

    // Only the good fix_prose event should appear in finalizedEvents.
    expect(result.finalizedEvents).toHaveLength(1)
    const [payload] = result.finalizedEvents
    expect(payload?.type).toBe('entity-updated')
    if (payload?.type === 'entity-updated') {
      expect(payload.synthKey).toBe(SYNTH[ENTITY_A])
    }

    // Five unknown-id WARN logs (one per skipped patch).
    expect(logger.warn).toHaveBeenCalledTimes(5)
  })

  it('rename patches apply LAST so other patches resolve against pre-rename names (myth-2ob3 §4.1)', async () => {
    // Batch contains both a rename for Mara and a fix_prose targeting
    // Mara (by the original pre-rename name). The fix_prose patch must
    // resolve against the pre-rename inventory and update Mara's prose;
    // the rename then renames the entity. Both apply successfully on
    // the same entity — no "unknown name" drop.
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [
          {
            kind: 'rename_entity_by_name',
            old_name: 'Mara',
            new_name: 'Mara Salt-Hand',
            rationale: 'Other entities reference Mara Salt-Hand; full name unifies.',
          },
          {
            kind: 'fix_prose_by_name',
            entity_name: 'Mara',
            new_prose: 'A guarded harbormaster who knows every name on the tide log.',
            rationale: 'Sharpening prose with sensory detail and craft.',
          },
        ],
      },
      usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, logger, result } = await runStage()

    // No drops: both patches resolved against the pre-rename inventory.
    expect(logger.warn).not.toHaveBeenCalled()

    // Both patches applied: one entity-updated event for prose, one for
    // the rename — both keyed by ENTITY_B's synthKey.
    const updates = eventsOfType(result.finalizedEvents, 'entity-updated')
    expect(updates).toHaveLength(2)
    for (const u of updates) {
      expect(u.synthKey).toBe(SYNTH[ENTITY_B])
    }

    // Verify the actual SQL ordering — prose update happened BEFORE the
    // entity-name UPDATE (rename last).
    const sqlCalls = client.query.mock.calls.map((c: unknown[]) => c[0] as string)
    const proseIdx = sqlCalls.findIndex((sql) => sql.includes('prose_kernels'))
    const renameIdx = sqlCalls.findIndex((sql) => sql.includes('UPDATE entities SET name'))
    expect(proseIdx).toBeGreaterThanOrEqual(0)
    expect(renameIdx).toBeGreaterThanOrEqual(0)
    expect(proseIdx).toBeLessThan(renameIdx)
  })

  it('completes successfully when LLM emits zero patches (no-op coherence)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { patches: [] },
      usage: { inputTokens: 14000, outputTokens: 50, totalTokens: 14050 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { result } = await runStage()

    // Cost > 0 even with zero patches — the LLM still ran.
    expect(result.costUsd).toBeGreaterThan(0)
    expect(result.inputTokens).toBe(14000)
    expect(result.outputTokens).toBe(50)
    expect(result.capExhausted).toBe(false)
    expect(result.finalizedEvents).toEqual([])
  })

  it('cap-fire exception: cap exhausted pre-stage signals capExhausted + phase:complete via finalizedEvents (per §D5)', async () => {
    // Cumulative cost from stages 1-6 already at $3.05 against a $3.00 cap.
    // Stage 7 must NOT call the LLM, NOT refund. The outer scope reads
    // capExhausted=true + the phase:complete event from finalizedEvents
    // and decides what to do (flip worlds.status, publish phase).
    const { logger, result } = await runStage({
      capUsd: 3,
      completedCostUsd: 3.05,
    })

    // No LLM call.
    expect(mockGenerateText).not.toHaveBeenCalled()

    // No cost incurred.
    expect(result.costUsd).toBe(0)
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)

    // capExhausted signal set; finalizedEvents carries the phase:complete
    // event for the outer scope to publish (NOT world_gen_failed).
    expect(result.capExhausted).toBe(true)
    expect(result.finalizedEvents).toEqual([{ type: 'phase', phase: 'complete' }])

    // WARN log emitted.
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const warnArgs = logger.warn.mock.calls[0]
    expect(JSON.stringify(warnArgs)).toContain('coherence_pass')
  })

  it('fix_relationship preserves existing fields when newType / newDescription are omitted', async () => {
    // Exercises the `?? existing.relationshipType` + `?? existing.description`
    // fallback arms when the LLM emits a fix_relationship patch with only
    // one of the two optional fields populated.
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [
          {
            // Only newType supplied — description falls back to existing.
            kind: 'fix_relationship_by_name',
            source_name: 'Old Eredil',
            target_name: 'Mara',
            current_type: 'rivalry',
            newType: 'allies_with',
            rationale: 'Rivalry is too strong; allies fits the prose better.',
          },
          {
            // Only newDescription supplied — type falls back to existing.
            kind: 'fix_relationship_by_name',
            source_name: 'Mara',
            target_name: 'The Wharf',
            current_type: 'employed_by',
            newDescription: 'Mara now serves as the wharf master, hand-picked.',
            rationale: 'Description was too thin; sharpening with new detail.',
          },
        ],
      },
      usage: { inputTokens: 14000, outputTokens: 200, totalTokens: 14200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { result } = await runStage()
    const added = eventsOfType(result.finalizedEvents, 'edge-added')

    // First fix: relationship REL_R — newType='allies_with'. Endpoint
    // entities unchanged; assert the edge-added event surfaces the new
    // type with the original endpoints.
    const addedR = added.find((p) => p.relationship === 'allies_with')
    expect(addedR).toBeDefined()
    expect(addedR?.from).toBe(ENTITY_A)
    expect(addedR?.to).toBe(ENTITY_B)

    // Second fix: relationship REL_S — type falls back to 'employed_by'.
    const addedS = added.find((p) => p.relationship === 'employed_by')
    expect(addedS).toBeDefined()
    expect(addedS?.from).toBe(ENTITY_B)
    expect(addedS?.to).toBe(ENTITY_C)
  })

  it('renders the world dump into the {{worldDump}} placeholder of the prompt', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { patches: [] },
      usage: { inputTokens: 14000, outputTokens: 50, totalTokens: 14050 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    await runStage()
    const callArgs = mockGenerateText.mock.calls[0]
    expect(callArgs).toBeDefined()
    const firstArg = callArgs?.[0] as { prompt: string } | undefined
    const prompt = firstArg?.prompt ?? ''
    // Each entity UUID + its prose should appear in the dump.
    expect(prompt).toContain(ENTITY_A)
    expect(prompt).toContain('weathered fishing village')
    expect(prompt).toContain(FACT_X)
    expect(prompt).toContain('burned down in the great fire')
    expect(prompt).toContain(REL_R)
    expect(prompt).toContain('rivalry')
    expect(prompt).not.toContain('{{worldDump}}')
  })

  // myth-exac T16 — tier-aware SSE emission.
  //
  // The DB writes happen for every patch (so coherence still repairs
  // discoverable/secret entities), but the SSE events that surface in
  // finalizedEvents are gated to known-tier entities (or any tier when
  // bypassAccessFilter is true). The dev tool sets bypass=true to
  // observe everything; production runs leave it false so the FT
  // snapshot never receives an entity-updated for an entity it doesn't
  // know about.

  it('entity-updated fires for a patch targeting a known-tier entity', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [
          {
            kind: 'fix_prose_by_name',
            entity_name: 'Old Eredil',
            new_prose: 'A rebuilt fishing village.',
            rationale: 'Sharpening prose to match world facts.',
          },
        ],
      },
      usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { result } = await runStage({
      accessLevels: { [ENTITY_A]: 'known' },
    })

    const updates = eventsOfType(result.finalizedEvents, 'entity-updated')
    expect(updates).toHaveLength(1)
    expect(updates[0]?.synthKey).toBe(SYNTH[ENTITY_A])
  })

  it('entity-updated does NOT fire for a patch targeting a non-known entity, but the DB write still happens', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [
          {
            kind: 'fix_prose_by_name',
            entity_name: 'Mara',
            new_prose: 'A guarded harbormaster who knows the tides.',
            rationale: 'Sharpening prose.',
          },
          {
            kind: 'rename_entity_by_name',
            old_name: 'The Wharf',
            new_name: 'The Old Wharf',
            rationale: 'Disambiguate from new wharf.',
          },
        ],
      },
      usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, result } = await runStage({
      accessLevels: { [ENTITY_B]: 'discoverable', [ENTITY_C]: 'secret' },
    })

    // No SSE events emitted (both targets are non-known).
    const updates = eventsOfType(result.finalizedEvents, 'entity-updated')
    expect(updates).toHaveLength(0)

    // DB writes still happened. Verify by checking the queries the
    // handler made for the prose update + rename.
    const sqlCalls = client.query.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(sqlCalls.some((sql) => sql.includes('prose_kernels'))).toBe(true)
    expect(sqlCalls.some((sql) => sql.includes('UPDATE entities SET name'))).toBe(true)
  })

  it('edge-added / edge-removed fire only when both endpoints are known-tier', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [
          // REL_R links ENTITY_A (known) ↔ ENTITY_B (discoverable).
          // SSE must NOT fire for either edge-removed or edge-added.
          {
            kind: 'fix_relationship_by_name',
            source_name: 'Old Eredil',
            target_name: 'Mara',
            current_type: 'rivalry',
            newType: 'distrusts',
            newDescription: 'Mara distrusts the elders.',
            rationale: 'Tone the rivalry down to distrust.',
          },
          // REL_S links ENTITY_B (discoverable) ↔ ENTITY_C (known).
          // SSE must NOT fire here either.
          {
            kind: 'delete_relationship_by_name',
            source_name: 'Mara',
            target_name: 'The Wharf',
            current_type: 'employed_by',
            rationale: 'Redundant edge.',
          },
        ],
      },
      usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { result } = await runStage({
      accessLevels: { [ENTITY_B]: 'discoverable' },
    })

    expect(eventsOfType(result.finalizedEvents, 'edge-added')).toHaveLength(0)
    expect(eventsOfType(result.finalizedEvents, 'edge-removed')).toHaveLength(0)
  })

  it('edge events fire when BOTH endpoints are known-tier', async () => {
    // REL_R sources from ENTITY_A and targets ENTITY_B; with both known
    // (the default in makeClient), the edge events must surface.
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [
          {
            kind: 'fix_relationship_by_name',
            source_name: 'Old Eredil',
            target_name: 'Mara',
            current_type: 'rivalry',
            newType: 'distrusts',
            newDescription: 'Mara distrusts the elders.',
            rationale: 'Tone down rivalry.',
          },
        ],
      },
      usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { result } = await runStage()
    expect(eventsOfType(result.finalizedEvents, 'edge-added')).toHaveLength(1)
    expect(eventsOfType(result.finalizedEvents, 'edge-removed')).toHaveLength(1)
  })

  it('with bypassAccessFilter=true, ALL coherence patches fire SSE deltas regardless of tier', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [
          {
            kind: 'fix_prose_by_name',
            entity_name: 'Mara',
            new_prose: 'A guarded harbormaster.',
            rationale: 'Sharpen.',
          },
          {
            kind: 'rename_entity_by_name',
            old_name: 'The Wharf',
            new_name: 'The Old Wharf',
            rationale: 'Disambiguate.',
          },
          {
            kind: 'fix_relationship_by_name',
            source_name: 'Old Eredil',
            target_name: 'Mara',
            current_type: 'rivalry',
            newType: 'distrusts',
            newDescription: 'Mara distrusts the elders.',
            rationale: 'Tone down.',
          },
          {
            kind: 'delete_relationship_by_name',
            source_name: 'Mara',
            target_name: 'The Wharf',
            current_type: 'employed_by',
            rationale: 'Redundant.',
          },
        ],
      },
      usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { result } = await runStage({
      accessLevels: { [ENTITY_B]: 'discoverable', [ENTITY_C]: 'secret' },
      bypassAccessFilter: true,
    })

    // 5 events: 1 fix_prose + 1 rename + 1 fix_relationship (edge-removed
    // + edge-added) + 1 delete_relationship → 5 total.
    expect(result.finalizedEvents).toHaveLength(5)
    expect(eventsOfType(result.finalizedEvents, 'entity-updated')).toHaveLength(2)
    expect(eventsOfType(result.finalizedEvents, 'edge-added')).toHaveLength(1)
    expect(eventsOfType(result.finalizedEvents, 'edge-removed')).toHaveLength(2)
  })

  // myth-pfke task 9f: vocabulary registry placeholder substitution.
  it('substitutes {{vocabularyRegistry}} with the rendered registry prose', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { patches: [] },
      usage: { inputTokens: 14000, outputTokens: 50, totalTokens: 14050 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const registry: VocabularyRegistry = {
      entries: [
        {
          term: 'the unwitched',
          definition:
            "non-magical people; this world's term for those without arcane sight.",
          avoids: 'muggle',
          source: 'stage_1_5',
          access_level: 'known',
        },
      ],
      adjacent_franchises: ['Harry Potter'],
    }

    await runStage({ vocabularyRegistry: registry })
    const firstArg = mockGenerateText.mock.calls[0]?.[0] as
      | { prompt: string }
      | undefined
    const prompt = firstArg?.prompt ?? ''
    expect(prompt).toContain("This world's distinctive vocabulary:")
    expect(prompt).toContain('the unwitched')
    expect(prompt).not.toContain('{{vocabularyRegistry}}')
  })

  it('world dump includes [access_level: …] per entity', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { patches: [] },
      usage: { inputTokens: 14000, outputTokens: 50, totalTokens: 14050 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    await runStage({
      accessLevels: { [ENTITY_B]: 'discoverable', [ENTITY_C]: 'secret' },
    })
    const firstArg = mockGenerateText.mock.calls[0]?.[0] as
      | { prompt: string }
      | undefined
    const prompt = firstArg?.prompt ?? ''
    // Per-entity access-level annotation must be present in the dump.
    expect(prompt).toContain('[access_level: known]')
    expect(prompt).toContain('[access_level: discoverable]')
    expect(prompt).toContain('[access_level: secret]')
  })

  // myth-imxg T16 — fix_relationship_by_name endpoint rewriting.
  //
  // T7 extended the schema to accept newSource / newTarget (string entity
  // names) so the LLM can move an edge to different endpoints. T16 wires
  // the apply path: when newSource/newTarget are present, the dispatcher
  // resolves them and applyFixRelationship inserts the replacement edge
  // with the new endpoint(s). Unresolvable endpoints drop the patch
  // entirely (with WARN), since a fix that can't land on real entities
  // shouldn't fall back to the original endpoint silently.

  it('fix_relationship with newSource rewrites the source endpoint', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [{
          kind: 'fix_relationship_by_name',
          source_name: 'Mara',
          target_name: 'The Wharf',
          current_type: 'employed_by',
          newSource: 'Old Eredil',
          rationale: 'Description correctly says the village employs the wharf, not Mara.',
        }],
      },
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, result } = await runStage({ bypassAccessFilter: true })

    const inserts = client.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO relationships'),
    )
    expect(inserts).toHaveLength(1)
    const insertParams = inserts[0]?.[1] as unknown[]
    expect(insertParams[1]).toBe(ENTITY_A)  // source_entity_id is now ENTITY_A (Old Eredil)
    expect(insertParams[2]).toBe(ENTITY_C)  // target preserved (The Wharf)

    const removed = eventsOfType(result.finalizedEvents, 'edge-removed')
    const added = eventsOfType(result.finalizedEvents, 'edge-added')
    expect(removed).toHaveLength(1)
    expect(added).toHaveLength(1)
    expect(added[0]?.from).toBe(ENTITY_A)
    expect(added[0]?.to).toBe(ENTITY_C)
  })

  it('fix_relationship with newTarget rewrites the target endpoint', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [{
          kind: 'fix_relationship_by_name',
          source_name: 'Mara',
          target_name: 'The Wharf',
          current_type: 'employed_by',
          newTarget: 'Old Eredil',
          rationale: 'Wrong target — relationship should land on Old Eredil.',
        }],
      },
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, result } = await runStage({ bypassAccessFilter: true })

    const inserts = client.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO relationships'),
    )
    expect(inserts).toHaveLength(1)
    const insertParams = inserts[0]?.[1] as unknown[]
    expect(insertParams[1]).toBe(ENTITY_B)  // source preserved (Mara)
    expect(insertParams[2]).toBe(ENTITY_A)  // target is now ENTITY_A (Old Eredil)

    const added = eventsOfType(result.finalizedEvents, 'edge-added')
    expect(added).toHaveLength(1)
    expect(added[0]?.from).toBe(ENTITY_B)
    expect(added[0]?.to).toBe(ENTITY_A)
  })

  it('fix_relationship drops with WARN when newSource is unresolvable', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [{
          kind: 'fix_relationship_by_name',
          source_name: 'Mara',
          target_name: 'The Wharf',
          current_type: 'employed_by',
          newSource: 'Nobody Such',
          rationale: 'Trying to move the edge to an entity that does not exist.',
        }],
      },
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, logger, result } = await runStage({ bypassAccessFilter: true })

    expect(result.finalizedEvents.filter((e) => e.type === 'edge-removed' || e.type === 'edge-added')).toHaveLength(0)
    const inserts = client.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO relationships'),
    )
    expect(inserts).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'coherence_pass', kind: 'fix_relationship_by_name' }),
      expect.stringMatching(/newSource|new_source|unresolvable/i),
    )
  })

  it('fix_relationship drops with WARN when newTarget is unresolvable', async () => {
    // Symmetric coverage for the newTarget arm of the dispatcher — the
    // newSource test above only exercises the newSource branch; without
    // this one the newTarget warn+drop block is uncovered.
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [{
          kind: 'fix_relationship_by_name',
          source_name: 'Mara',
          target_name: 'The Wharf',
          current_type: 'employed_by',
          newTarget: 'Nobody Such',
          rationale: 'Trying to move the edge target to an entity that does not exist.',
        }],
      },
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, logger, result } = await runStage({ bypassAccessFilter: true })

    expect(result.finalizedEvents.filter((e) => e.type === 'edge-removed' || e.type === 'edge-added')).toHaveLength(0)
    const inserts = client.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO relationships'),
    )
    expect(inserts).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'coherence_pass', kind: 'fix_relationship_by_name' }),
      expect.stringMatching(/newTarget|new_target|unresolvable/i),
    )
  })

  // myth-imxg T17 — add_relationship_by_name apply path.
  //
  // T11 added resolveAddRelationship; T17 wires the dispatcher arm to insert
  // a new relationship row + emit edge-added. Duplicate-triple guard at the
  // apply layer prevents near-duplicates from over-emission.

  it('add_relationship_by_name inserts a row + emits edge-added', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [{
          kind: 'add_relationship_by_name',
          source_name: 'Old Eredil',
          target_name: 'Mara',
          relationship: 'home_of',
          description: 'Mara was born and raised in Old Eredil.',
          rationale: 'Prose explicitly says Mara grew up here; relation was missed at stage 4.',
        }],
      },
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, result } = await runStage({ bypassAccessFilter: true })

    const inserts = client.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO relationships'),
    )
    expect(inserts).toHaveLength(1)
    const insertParams = inserts[0]?.[1] as unknown[]
    expect(insertParams[1]).toBe(ENTITY_A)  // source
    expect(insertParams[2]).toBe(ENTITY_B)  // target

    const added = eventsOfType(result.finalizedEvents, 'edge-added')
    expect(added).toHaveLength(1)
    expect(added[0]?.relationship).toBe('home_of')
  })

  it('add_relationship_by_name drops with WARN when source name unresolvable', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [{
          kind: 'add_relationship_by_name',
          source_name: 'Nobody',
          target_name: 'Mara',
          relationship: 'home_of',
          description: 'This relationship cannot land; source does not exist.',
          rationale: 'The model thought Nobody existed but no entity by that name.',
        }],
      },
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, logger, result } = await runStage({})
    const inserts = client.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO relationships'),
    )
    expect(inserts).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'coherence_pass', kind: 'add_relationship_by_name' }),
      expect.any(String),
    )
    expect(result.finalizedEvents.filter((e) => e.type === 'edge-added')).toHaveLength(0)
  })

  it('add_relationship_by_name drops with WARN when (source, target, type) already exists', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        // ENTITY_A → ENTITY_B with type 'rivalry' is REL_R in the fixture.
        patches: [{
          kind: 'add_relationship_by_name',
          source_name: 'Old Eredil',
          target_name: 'Mara',
          relationship: 'rivalry',
          description: 'Duplicate of an existing relationship.',
          rationale: 'The model emitted an add for a triple that already exists.',
        }],
      },
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, logger } = await runStage({})
    const inserts = client.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO relationships'),
    )
    expect(inserts).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'would_be_duplicate' }),
      expect.any(String),
    )
  })

  it('add_relationship_by_name persists the DB row but suppresses edge-added when an endpoint is non-known', async () => {
    // ENTITY_B → 'discoverable' tier; without bypassAccessFilter the
    // SSE edge-added must be suppressed but the INSERT must still land.
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [{
          kind: 'add_relationship_by_name',
          source_name: 'Old Eredil',
          target_name: 'Mara',
          relationship: 'home_of',
          description: 'Mara was born and raised in Old Eredil.',
          rationale: 'Prose says she grew up here; relation missed at stage 4.',
        }],
      },
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, result } = await runStage({
      accessLevels: { [ENTITY_B]: 'discoverable' },
    })

    const inserts = client.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO relationships'),
    )
    expect(inserts).toHaveLength(1)
    expect(eventsOfType(result.finalizedEvents, 'edge-added')).toHaveLength(0)
  })

  // myth-imxg T18 — add_fact_by_name apply path.
  //
  // T7 added add_fact_by_name to the schema; T18 wires the dispatcher arm
  // to insert a new facts row + emit fact-added. Topic-collision guard at
  // the apply layer prevents creating ambiguous (entity, topic) pairs that
  // future fix_fact / delete_fact patches would drop with 'ambiguous_fact'.

  it('add_fact_by_name inserts a fact + emits fact-added', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [{
          kind: 'add_fact_by_name',
          entity_name: 'Old Eredil',
          topic: 'governance',
          content: 'Old Eredil is administered by the harbor council.',
          access_level: 'known',
          rationale: 'Prose explicitly references the council; structured fact was missed.',
        }],
      },
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, result } = await runStage({ bypassAccessFilter: true })

    const inserts = client.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO facts'),
    )
    expect(inserts).toHaveLength(1)

    // Schema-violation guard: facts.narrative_status is NOT NULL with no
    // DEFAULT, so the INSERT must name the column and supply the canonical
    // 'undelivered' literal. Mocked clients don't enforce schema; this
    // assertion is what catches a future refactor that drops the column.
    const insertCall = inserts[0]
    const sql = insertCall?.[0] as string
    expect(sql).toContain('narrative_status')
    // 'undelivered' is the canonical default per backend/src/repo/facts.ts:56-58
    expect(sql).toContain("'undelivered'")

    const added = eventsOfType(result.finalizedEvents, 'fact-added')
    expect(added).toHaveLength(1)
    expect(added[0]?.topic).toBe('governance')
    expect(added[0]?.accessLevel).toBe('known')
    expect(added[0]?.entitySynthKey).toBe(SYNTH[ENTITY_A])
  })

  it('add_fact_by_name drops with WARN when (entity, topic) already exists', async () => {
    // Fixture has Old Eredil / topic='history'. Try to add another with same topic.
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [{
          kind: 'add_fact_by_name',
          entity_name: 'Old Eredil',
          topic: 'history',
          content: 'A different angle on the village history.',
          access_level: 'known',
          rationale: 'The model emitted an add for a topic that already has a fact.',
        }],
      },
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, logger } = await runStage({})
    const inserts = client.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO facts'),
    )
    expect(inserts).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'would_be_duplicate_topic' }),
      expect.any(String),
    )
  })

  it('add_fact_by_name persists the DB row but suppresses fact-added when entity is non-known', async () => {
    // ENTITY_B → 'discoverable' tier; without bypassAccessFilter the
    // SSE fact-added must be suppressed but the INSERT must still land.
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [{
          kind: 'add_fact_by_name',
          entity_name: 'Mara',
          topic: 'role',
          content: 'Mara serves as the harbormaster of Old Eredil.',
          access_level: 'discoverable',
          rationale: 'Prose says she runs the harbor; structured fact was missed.',
        }],
      },
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, result } = await runStage({
      accessLevels: { [ENTITY_B]: 'discoverable' },
    })

    const inserts = client.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO facts'),
    )
    expect(inserts).toHaveLength(1)
    expect(eventsOfType(result.finalizedEvents, 'fact-added')).toHaveLength(0)
  })

  it('add_fact_by_name drops with WARN when entity name unresolvable', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [{
          kind: 'add_fact_by_name',
          entity_name: 'Nobody',
          topic: 'role',
          content: 'No entity by that name exists.',
          access_level: 'known',
          rationale: 'The model thought Nobody existed.',
        }],
      },
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, logger, result } = await runStage({})
    const inserts = client.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO facts'),
    )
    expect(inserts).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'coherence_pass', kind: 'add_fact_by_name' }),
      expect.any(String),
    )
    expect(result.finalizedEvents.filter((e) => e.type === 'fact-added')).toHaveLength(0)
  })

  it('uses synthKeyByRelationshipId from inventory when emitting edge-removed (myth-p4sz)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [{
          kind: 'delete_relationship_by_name',
          source_name: 'Mara',
          target_name: 'The Wharf',
          current_type: 'employed_by',
          rationale: 'Duplicate / unsupported by prose; remove this edge.',
        }],
      },
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    // CRITICAL: synthKeyByEntityId map deliberately does NOT contain entries
    // for relationship UUIDs. The handler should emit edge-removed by reading
    // the synthKey from the inventory load (via the new relationship column),
    // not from synthKeyByEntityId.
    const client = makeClient({})
    const logger = makeLogger()
    const result = await runCoherencePassStage(asClient(client), {
      logger: asLogger(logger),
      worldId: WORLD_ID,
      vocabularyRegistry: EMPTY_REGISTRY,
      synthKeyByEntityId: {
        [ENTITY_A]: SYNTH[ENTITY_A],
        [ENTITY_B]: SYNTH[ENTITY_B],
        [ENTITY_C]: SYNTH[ENTITY_C],
        // NOTE: deliberately NO REL_S / REL_R entries here — the entity
        // synthKey map should NOT cover relationships (that was the bug).
      },
      bypassAccessFilter: true,
    })

    const removed = eventsOfType(result.finalizedEvents, 'edge-removed')
    expect(removed).toHaveLength(1)
    expect(removed[0]?.synthKey).toBe('entity_relationships/relationships/1')  // from inventory
  })

  // myth-imxg T19 — delete_fact_by_name apply path.
  //
  // T10 added delete_fact_by_name to the schema; T19 wires the dispatcher arm
  // to DELETE the fact row + emit fact-removed. The 60-char rationale floor
  // is schema-enforced at Zod; the apply step doesn't need to re-check it.
  // Resolver checks (entity, topic) — covers ambiguous topic + unknown entity.

  it('delete_fact_by_name removes the fact + emits fact-removed', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [{
          kind: 'delete_fact_by_name',
          entity_name: 'Old Eredil',
          fact_topic: 'history',
          rationale: 'Prose explicitly says the village burned generations ago; the history fact is wrong AND no content edit could fix the contradiction.',
        }],
      },
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, result } = await runStage({ bypassAccessFilter: true })

    const deletes = client.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('DELETE FROM facts'),
    )
    expect(deletes).toHaveLength(1)
    const removed = eventsOfType(result.finalizedEvents, 'fact-removed')
    expect(removed).toHaveLength(1)
    expect(removed[0]?.factId).toBe(FACT_X)
    expect(removed[0]?.entitySynthKey).toBe(SYNTH[ENTITY_A])
  })

  it('delete_fact_by_name drops with WARN when (entity, topic) unresolvable', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [{
          kind: 'delete_fact_by_name',
          entity_name: 'Nobody',
          fact_topic: 'history',
          rationale: 'Cannot resolve. This patch should drop with WARN at the resolver layer because no entity by that name exists.',
        }],
      },
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, logger, result } = await runStage({})

    const deletes = client.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('DELETE FROM facts'),
    )
    expect(deletes).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'coherence_pass', kind: 'delete_fact_by_name' }),
      expect.any(String),
    )
    expect(result.finalizedEvents.filter((e) => e.type === 'fact-removed')).toHaveLength(0)
  })

  it('delete_fact_by_name persists DB delete but suppresses SSE on non-known tier', async () => {
    // For 100% branch coverage on the shouldEmitEntityEvent gate.
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [{
          kind: 'delete_fact_by_name',
          entity_name: 'Old Eredil',
          fact_topic: 'history',
          rationale: 'Same as the happy-path test but with non-known tier — DB still deletes, SSE suppressed.',
        }],
      },
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, result } = await runStage({
      accessLevels: { [ENTITY_A]: 'secret' },  // non-known tier
    })

    const deletes = client.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('DELETE FROM facts'),
    )
    expect(deletes).toHaveLength(1)  // DB DELETE still happens
    expect(result.finalizedEvents.filter((e) => e.type === 'fact-removed')).toHaveLength(0)  // SSE suppressed
  })

  // myth-imxg T20 — fix_fact_by_name now emits fact-updated.
  //
  // Pre-T20 fix_fact silently updated the DB and returned no events; the FE
  // had to re-query to observe the change. Per T12's schema change the FE
  // now handles fact events per-row, so fix_fact emits fact-updated with
  // the new content + the prior topic/accessLevel snapshot.

  it('fix_fact_by_name emits fact-updated (previously silent)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [{
          kind: 'fix_fact_by_name',
          entity_name: 'Old Eredil',
          fact_topic: 'history',
          new_content: 'The village survived the fire and rebuilt within a generation.',
          rationale: 'Existing fact contradicted prose; tighten the timeline.',
        }],
      },
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { result } = await runStage({ bypassAccessFilter: true })
    const updated = eventsOfType(result.finalizedEvents, 'fact-updated')
    expect(updated).toHaveLength(1)
    expect(updated[0]?.topic).toBe('history')
    expect(updated[0]?.content).toContain('rebuilt')
    expect(updated[0]?.factId).toBe(FACT_X)
    expect(updated[0]?.entitySynthKey).toBe(SYNTH[ENTITY_A])
    expect(updated[0]?.accessLevel).toBe('known')
  })

  it('fix_fact_by_name persists DB update but suppresses SSE on non-known tier', async () => {
    // For 100% branch coverage on the shouldEmitEntityEvent gate.
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [{
          kind: 'fix_fact_by_name',
          entity_name: 'Old Eredil',
          fact_topic: 'history',
          new_content: 'The village survived the fire and rebuilt within a generation.',
          rationale: 'Same as the happy-path test but with non-known tier — DB still updates, SSE suppressed.',
        }],
      },
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, result } = await runStage({
      accessLevels: { [ENTITY_A]: 'secret' },  // non-known tier
    })

    const updates = client.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('UPDATE facts'),
    )
    expect(updates).toHaveLength(1)  // DB UPDATE still happens
    expect(result.finalizedEvents.filter((e) => e.type === 'fact-updated')).toHaveLength(0)  // SSE suppressed
  })
})
