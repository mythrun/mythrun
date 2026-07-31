// backend/src/llm/prep/__tests__/world-gen-processor.test.ts
//
// MYT-51 T7. Integration tests for the world-gen BullMQ processor.
// Real Postgres (so the atomic claim / unique index / refund transaction
// genuinely fire) + ioredis-mock for the realtime publish surface +
// vi.mock('ai') for the Anthropic SDK (no real LLM calls).
//
// Tests cover the six scenarios from the plan:
//   1. Happy path — stages 1, 4, 5 succeed; 2, 3 fail with
//      stage_not_implemented; worlds.status stays 'generating'.
//   2. Idempotency — pre-completed concept_intake is NOT re-run.
//   3. Stuck-stage reset — a 'running' row > 5min old is reclaimed.
//   4. Cost-cap refund — exceeding cap marks world failed + writes
//      a +1 cost_cap_refund row + writes 'world_gen_cost_cap_exceeded'
//      into pipeline_runs.error.
//   5. Stage failure halts the loop — later stages never get rows.
//   6. Atomic claim — two concurrent worker runs result in exactly
//      one generator invocation total.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from 'bullmq'
import type { Pool } from 'pg'
import IoredisMock from 'ioredis-mock'
import pino from 'pino'
import * as ai from 'ai'

import { guardTestDatabase } from '../../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../../repo/__tests__/_helpers/test-pool.js'
import {
  atomicClaimStage,
  createWorldGenProcessor,
  sanitizeError,
  WORLD_GEN_STAGES,
  type WorldGenJobPayload,
} from '../world-gen-processor.js'
import { StageNotImplementedError } from '../stages/stage-not-implemented.js'
import * as worldColorModule from '../stages/world-color.js'
import * as vocabularyIntakeModule from '../stages/vocabulary-intake.js'
import * as worldAndFactionsModule from '../stages/world-and-factions.js'
import * as locationsAndNpcsModule from '../stages/locations-and-npcs.js'
import * as entityRelationshipsModule from '../stages/entity-relationships.js'
import * as worldIntroductionModule from '../stages/world-introduction.js'
// MYT-71 T10: the terminal embed_world stage calls embedWorld via the retrieval
// barrel. Mock it at the module boundary so the processor's embed stage runs
// (claims its pipeline_runs row, returns zero cost) without hitting real Voyage.
import * as retrievalModule from '../../../world/retrieval/index.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn(), streamObject: vi.fn() }
})

// myth-exac T18: per-stage module mocks let the new tests drive stages 2-4
// to succeed at the dispatcher boundary without bringing up the
// streamObject + repair-chain machinery. The legacy tests below leave the
// default mock (vi.mocked(streamObject) throws StageNotImplementedError)
// untouched, so the existing 6 scenarios still halt at stage 2.
// myth-pfke: vocabulary-intake (stage 1.5) gets the same per-module mock
// pattern so the legacy tests still halt at the first non-concept stage.
// MYT-87 T8: world_color (stage 2, right after concept_intake) gets the same
// per-module mock so the legacy tests flow past it to the first
// not-yet-implemented stage (world_and_factions) without hitting real Haiku.
vi.mock('../stages/world-color.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stages/world-color.js')>()
  return { ...actual, runWorldColorStage: vi.fn() }
})
vi.mock('../stages/vocabulary-intake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stages/vocabulary-intake.js')>()
  return { ...actual, runVocabularyIntakeStage: vi.fn() }
})
vi.mock('../stages/world-and-factions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stages/world-and-factions.js')>()
  return { ...actual, runWorldAndFactionsStage: vi.fn() }
})
vi.mock('../stages/locations-and-npcs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stages/locations-and-npcs.js')>()
  return { ...actual, runLocationsAndNpcsStage: vi.fn() }
})
vi.mock('../stages/entity-relationships.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stages/entity-relationships.js')>()
  return { ...actual, runEntityRelationshipsStage: vi.fn() }
})
vi.mock('../stages/world-introduction.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stages/world-introduction.js')>()
  return { ...actual, runWorldIntroductionStage: vi.fn() }
})
// MYT-71 T10: mock the retrieval barrel's embedWorld so the terminal
// embed_world stage runs through the loop without a real Voyage round-trip.
vi.mock('../../../world/retrieval/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../world/retrieval/index.js')>()
  return { ...actual, embedWorld: vi.fn() }
})

const databaseUrl = process.env.DATABASE_URL ?? ''

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' })
}

// -- AI SDK mock helpers ----------------------------------------------------

// concept_intake calls generateText TWICE per attempt (generator + judge).
// starting_situation + random_tables call once each.

const CONCEPT_DRAFT = {
  name: 'Aelmoor',
  tone: 'misted, melancholy, watchful',
  themes: 'guardianship, secrets, weather over still water',
  geography_summary: 'A windswept highland archipelago on the edge of an older, drowned power.',
  political_summary: 'Three rival lighthouse-houses, each binding storm-spirits into their lamps.',
  era: 'a lantern-age before steam',
  key_tensions: 'The spirits chafe in the lanterns. The drowned power below has begun to dream.',
  follow_up_questions:
    'Who lit the silent house? What watches from the cliffs at the spring tides?',
}

const CLEAN_JUDGE = {
  flagged: false,
  confidence: 0.95,
  mirroredWork: null,
  specificDriftAxes: [],
}

const SITUATIONS = {
  location_hooks: [
    { location_name: 'The Salt-Eaten Wharf', why_interesting: 'morning fog never lifts.' },
    { location_name: 'Lantern Hill', why_interesting: 'the silent house looms above the town.' },
    { location_name: 'The Drowned Causeway', why_interesting: 'exposed only at low tide.' },
  ],
}

function makeEntries(prefix: string): { roll_min: number; roll_max: number; content: string }[] {
  return Array.from({ length: 20 }, (_, i) => ({
    roll_min: i + 1,
    roll_max: i + 1,
    content: `${prefix} entry ${String(i + 1)}`,
  }))
}

const TABLES = {
  tables: [
    {
      name: 'Regional NPC Quirks of the Salted Reach',
      category: 'regional_npc_quirks',
      entries: makeEntries('quirk'),
    },
    {
      name: 'Travel Encounters in the Lantern Highlands',
      category: 'travel_encounters',
      entries: makeEntries('encounter'),
    },
  ],
}

interface MockUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

function pushConceptIntakeResponses(
  usage: MockUsage = { inputTokens: 800, outputTokens: 600 },
): void {
  // Generator response
  vi.mocked(ai.generateText).mockResolvedValueOnce({
    output: CONCEPT_DRAFT,
    finishReason: 'stop',
    usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens },
  } as never)
  // Judge response (clean)
  vi.mocked(ai.generateText).mockResolvedValueOnce({
    output: CLEAN_JUDGE,
    finishReason: 'stop',
    usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
  } as never)
}

// (helpers for stages 4 + 5 omitted — the 6 scenarios all stop at stage 2
// via stage_not_implemented or earlier via cost-cap / throw, so they never
// reach starting_situation or random_tables. Pre-staged here as reference
// if a future test needs to push past stage 2.)
void SITUATIONS
void TABLES

// -- Test fixture -----------------------------------------------------------

interface Seeded {
  readonly userId: string
  readonly worldId: string
  readonly campaignId: string
}

async function seedUserWorldCampaign(pool: Pool, scope: TestScope): Promise<Seeded> {
  const userId = uuidv7()
  const worldId = uuidv7()
  const campaignId = uuidv7()
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username)
     VALUES ($1, $2, $3, $4)`,
    [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
  )
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status)
     VALUES ($1, $2, $3, 'a concept for testing', 'generating')`,
    [worldId, userId, scope.worldName(0)],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name)
     VALUES ($1, $2, $3, $4)`,
    [campaignId, worldId, userId, scope.campaignName(0)],
  )
  // Match the create-campaign debit (the refund's polarity check is
  // satisfied because the refund row is amount=+1).
  await pool.query(
    `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type, source_id)
     VALUES ($1, $2, 'world_gen', -1, 'debit', $3)`,
    [uuidv7(), userId, worldId],
  )
  return { userId, worldId, campaignId }
}

// `token` + `moveToDelayed` mirror the live BullMQ Job the worker hands the
// processor: the Worker stamps `job.token` before invoking it, and the park
// path calls `job.moveToDelayed(ts, token)` (llm-outage-resilience §3.1).
// Legacy tests never reach either.
function makeJob(campaignId: string): Job<WorldGenJobPayload> & {
  moveToDelayed: ReturnType<typeof vi.fn>
} {
  return {
    data: { campaignId },
    token: 'job-lock-token',
    updateProgress: vi.fn().mockResolvedValue(undefined),
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<WorldGenJobPayload> & { moveToDelayed: ReturnType<typeof vi.fn> }
}

interface MakeDepsOverrides {
  readonly costCapUsd?: number
}

function makeDeps(
  pool: Pool,
  overrides: MakeDepsOverrides = {},
): {
  pool: Pool
  redisRealtime: InstanceType<typeof IoredisMock>
  redisKeyPrefix: string
  logger: ReturnType<typeof silentLogger>
  costCapUsd: number
  voyageApiKey: string
  publishSpy: ReturnType<typeof vi.fn>
} {
  const redisRealtime = new IoredisMock()
  const publishSpy = vi.fn().mockResolvedValue(1)
  // ioredis-mock implements publish, but doesn't fan out to subscribers across
  // independent mock instances. We override with a spy so the test can assert
  // event payloads without needing a real fan-out.
  ;(redisRealtime as unknown as { publish: typeof publishSpy }).publish = publishSpy
  return {
    pool,
    redisRealtime,
    redisKeyPrefix: 'test:wgp:',
    logger: silentLogger(),
    // Matches migration 010's seeded default ($10.00). Tests exercising the
    // cap-exceeded path override with a tight value (e.g. 0.0001).
    costCapUsd: overrides.costCapUsd ?? 10.0,
    // MYT-71 T10: consumed only by the terminal embed_world stage. The 6 legacy
    // scenarios halt at stage 2 (stage_not_implemented) so the embedder is
    // never built; the embed_world completion test mocks embedWorld so the key
    // is never sent to Voyage.
    voyageApiKey: 'pa-test-voyage-key',
    publishSpy,
  }
}

describe('world-gen-processor (MYT-51 T7)', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('world-gen-proc')
  })

  afterAll(async () => {
    // myth-5jdo: scoped cleanup before pool teardown.
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    // ioredis-mock instances share one keyspace per connection config — the
    // degraded-park test's llm-health state key must not leak into later
    // tests' health reads.
    await new IoredisMock().flushall()
    // myth-5jdo: scoped cleanup replaces the prior blanket DELETEs.
    // Entity/prose/fact/random_table rows live under the world we
    // create, so the worlds CASCADE in cleanupTestScope drops them.
    await cleanupTestScope(pool, scope)
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('world_gen_cost_cap_usd', '10.0')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    )
    // Default the new wave-4 LLM streamObject calls to throw
    // StageNotImplementedError. The existing tests halt the world-gen
    // loop at stage 2 (world_and_factions); the handler invokes
    // streamObject, which now throws a typed terminal-stop error that
    // handleStageError converts to a clean loop exit + world status='failed'.
    // Tests that want stage 2 to actually run can override via
    // mockReturnValueOnce. Same pattern for the stage-7 generateText path
    // (coherence_pass) — its default per-call generateText mock is set
    // alongside the stage-1 generator + judge in pushConceptIntakeResponses,
    // so no top-level default is needed here.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- design §4.1 mandates streamObject for streaming stages; mocking the call path
    vi.mocked(ai.streamObject).mockImplementation(() => {
      throw new StageNotImplementedError('world_and_factions')
    })
    // myth-exac T18: mirror the streamObject default at the per-stage
    // module boundary so the legacy 6 tests still halt at stage 2 with
    // stage_not_implemented. The new T18 tests override these via
    // mockImplementationOnce / mockResolvedValueOnce.
    // myth-pfke: vocabulary-intake (stage 1.5) defaults to a clean
    // succeed-with-zero-cost so concept_intake-only tests still flow to
    // the next not-yet-implemented stage (world_and_factions). Tests that
    // halt explicitly at stage 1.5 override via mockImplementationOnce.
    // MYT-87 T8: world_color (stage 2) defaults to a clean succeed-with-zero-
    // cost so the legacy concept_intake-only tests flow past it to the next
    // not-yet-implemented stage (world_and_factions), exactly like
    // vocabulary_intake below.
    vi.mocked(worldColorModule.runWorldColorStage).mockResolvedValue({
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    })
    vi.mocked(vocabularyIntakeModule.runVocabularyIntakeStage).mockResolvedValue({
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    })
    vi.mocked(worldAndFactionsModule.runWorldAndFactionsStage).mockImplementation(() => {
      throw new StageNotImplementedError('world_and_factions')
    })
    vi.mocked(locationsAndNpcsModule.runLocationsAndNpcsStage).mockImplementation(() => {
      throw new StageNotImplementedError('locations_and_npcs')
    })
    vi.mocked(entityRelationshipsModule.runEntityRelationshipsStage).mockImplementation(() => {
      throw new StageNotImplementedError('entity_relationships')
    })
    // MYT-71 T10: default embedWorld to a clean, all-NULL-left result. The
    // legacy 6 scenarios halt before embed_world, so this is inert for them;
    // the embed completion test overrides per-call where it asserts the tally.
    vi.mocked(retrievalModule.embedWorld).mockResolvedValue({
      embedded: 0,
      leftNull: 0,
      voyageErrors: 0,
    })
  })

  // ------------------------------------------------------------------
  // 1. Happy path — 3 stages succeed, 2 + 3 fail with stage_not_implemented
  // ------------------------------------------------------------------
  it("threads acceptedTitle: an 'Untitled' world prompts concept_intake to name itself (myth walk 2026-07-29)", async () => {
    // The processor derives acceptedTitle from the world row it already
    // loads: 'Untitled' is the freeform placeholder — no accepted title, the
    // model names the world.
    const { worldId, campaignId } = await seedUserWorldCampaign(pool, scope)
    await pool.query(`UPDATE worlds SET name = 'Untitled' WHERE id = $1`, [worldId])
    pushConceptIntakeResponses()
    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    await proc(makeJob(campaignId))
    const firstPrompt = (vi.mocked(ai.generateText).mock.calls[0]?.[0] as { prompt: string })
      .prompt
    expect(firstPrompt).toContain('none — name the world yourself')
  })

  it('threads acceptedTitle: a named world (the accepted preview title) reaches the intake prompt', async () => {
    // Anything but 'Untitled' is the title the player accepted at create
    // time; the intake prompt must carry it as canonical.
    const { worldId, campaignId } = await seedUserWorldCampaign(pool, scope)
    await pool.query(`UPDATE worlds SET name = 'The Delta of Three Turtles' WHERE id = $1`, [
      worldId,
    ])
    pushConceptIntakeResponses()
    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    await proc(makeJob(campaignId))
    const firstPrompt = (vi.mocked(ai.generateText).mock.calls[0]?.[0] as { prompt: string })
      .prompt
    expect(firstPrompt).toContain('The Delta of Three Turtles')
    expect(firstPrompt).toContain('already accepted')
  })

  it('runs implemented stages to completion, stops at stage_not_implemented', async () => {
    const { worldId, campaignId } = await seedUserWorldCampaign(pool, scope)
    pushConceptIntakeResponses()
    // Stages 1 + 1.5 succeed (vocabulary_intake's beforeEach default
    // resolves with zero cost); stage 2 fires next (world_and_factions) →
    // throws stage_not_implemented and the loop exits. Stages 3+ never
    // run; no further mocks needed.

    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    await proc(makeJob(campaignId))

    const runs = await pool.query<{ stage: string; status: string; error: string | null }>(
      `SELECT stage, status, error FROM pipeline_runs WHERE world_id = $1`,
      [worldId],
    )
    const byStage = new Map(runs.rows.map((r) => [r.stage, r]))
    expect(byStage.get('concept_intake')?.status).toBe('completed')
    expect(byStage.get('vocabulary_intake')?.status).toBe('completed')
    expect(byStage.get('world_and_factions')?.status).toBe('failed')
    expect(byStage.get('world_and_factions')?.error).toContain('stage_not_implemented')
    // The loop exits at stage 2, so stages 3-5 never get rows.
    expect(byStage.has('locations_and_npcs')).toBe(false)
    expect(byStage.has('starting_situation')).toBe(false)
    expect(byStage.has('random_tables')).toBe(false)

    // World status flips to 'failed' on terminal-stop. Without this, the
    // concurrent-gen guard (which refuses to enqueue while status='generating')
    // would lock the world out of any retry. Discovered via E2E smoke when
    // every retry after a StageNotImplementedError hit 409.
    const w = await pool.query<{ status: string }>(`SELECT status FROM worlds WHERE id = $1`, [
      worldId,
    ])
    expect(w.rows[0]?.status).toBe('failed')

    const phaseEvents = deps.publishSpy.mock.calls.filter(
      (c) => typeof c[1] === 'string' && c[1].includes('"phase"'),
    )
    const phaseStrings = phaseEvents.map((c) => String(c[1]))
    expect(phaseStrings.some((p) => p.includes('"world_gen"'))).toBe(true)
    expect(phaseStrings.some((p) => p.includes('"world_gen_failed"'))).toBe(true)
    expect(phaseStrings.some((p) => p.includes('"world_ready"'))).toBe(false)
  })

  // ------------------------------------------------------------------
  // 2. Idempotency — pre-completed stage is not re-run
  // ------------------------------------------------------------------
  it('skips an already-completed stage on retry', async () => {
    const { worldId, campaignId } = await seedUserWorldCampaign(pool, scope)
    // Seed concept_intake as completed; worker should NOT call its generator.
    await pool.query(
      `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at,
                                  completed_at, cost_usd, input_tokens, output_tokens, user_id)
       VALUES ($1, $2, 'concept_intake', 'completed', now(), now(),
               0.0135, 1000, 700, NULL)`,
      [uuidv7(), worldId],
    )
    // The world row already has concept_intake outputs applied; populate
    // so starting_situation has the inputs it needs.
    await pool.query(
      `UPDATE worlds SET name = 'Aelmoor', tone = 'misted', themes = 'guardianship',
                        era = 'a lantern-age', key_tensions = 'spirits chafe',
                        geography_summary = 'windswept highland archipelago'
        WHERE id = $1`,
      [worldId],
    )

    // Stage 2 will fire stage_not_implemented and stop the loop.
    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    await proc(makeJob(campaignId))

    expect(vi.mocked(ai.generateText)).not.toHaveBeenCalled()
    const ci = await pool.query<{ status: string; cost_usd: string }>(
      `SELECT status, cost_usd FROM pipeline_runs
        WHERE world_id = $1 AND stage = 'concept_intake'`,
      [worldId],
    )
    expect(ci.rows[0]?.status).toBe('completed')
    expect(Number(ci.rows[0]?.cost_usd)).toBeCloseTo(0.0135, 4)
  })

  // ------------------------------------------------------------------
  // 3. Stuck-stage reset — running for > 5min gets reclaimed
  // ------------------------------------------------------------------
  it('reclaims a stuck running stage and re-runs the handler', async () => {
    const { worldId, campaignId } = await seedUserWorldCampaign(pool, scope)
    await pool.query(
      `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, user_id)
       VALUES ($1, $2, 'concept_intake', 'running', now() - INTERVAL '6 minutes', NULL)`,
      [uuidv7(), worldId],
    )

    pushConceptIntakeResponses()
    // stage 2 throws stage_not_implemented → loop exits.

    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    await proc(makeJob(campaignId))

    // The generator + judge both fired (2 calls) → handler re-ran.
    expect(vi.mocked(ai.generateText)).toHaveBeenCalledTimes(2)
    const ci = await pool.query<{ status: string }>(
      `SELECT status FROM pipeline_runs
        WHERE world_id = $1 AND stage = 'concept_intake'`,
      [worldId],
    )
    expect(ci.rows[0]?.status).toBe('completed')
  })

  // ------------------------------------------------------------------
  // 4. Cost-cap refund — exceeding cap marks world failed + refund row
  // ------------------------------------------------------------------
  it('issues refund + marks world failed when the cost cap is exceeded', async () => {
    const { userId, worldId, campaignId } = await seedUserWorldCampaign(pool, scope)
    // Generator usage that produces a cost well above 0.0001: 1M input / 1M
    // output @ Sonnet ($3 + $15 = $18) — comfortably above the injected cap.
    pushConceptIntakeResponses({ inputTokens: 1_000_000, outputTokens: 1_000_000 })

    const deps = makeDeps(pool, { costCapUsd: 0.0001 })
    const proc = createWorldGenProcessor(deps)
    await proc(makeJob(campaignId))

    const w = await pool.query<{ status: string }>(`SELECT status FROM worlds WHERE id = $1`, [
      worldId,
    ])
    expect(w.rows[0]?.status).toBe('failed')

    const ledger = await pool.query<{ amount: string; source_type: string }>(
      `SELECT amount::float8 AS amount, source_type FROM credit_ledger
        WHERE user_id = $1 ORDER BY granted_at ASC`,
      [userId],
    )
    const refundRow = ledger.rows.find((r) => r.source_type === 'cost_cap_refund')
    expect(refundRow).toBeDefined()
    expect(Number(refundRow?.amount)).toBe(1)

    const ci = await pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM pipeline_runs
        WHERE world_id = $1 AND stage = 'concept_intake'`,
      [worldId],
    )
    expect(ci.rows[0]?.status).toBe('failed')
    expect(ci.rows[0]?.error).toContain('world_gen_cost_cap_exceeded')

    // No subsequent stages — loop exited.
    const others = await pool.query<{ stage: string }>(
      `SELECT stage FROM pipeline_runs WHERE world_id = $1 AND stage != 'concept_intake'`,
      [worldId],
    )
    expect(others.rows).toHaveLength(0)

    // phase=world_gen_failed published.
    const phaseStrings = deps.publishSpy.mock.calls.map((c) => String(c[1]))
    expect(phaseStrings.some((p) => p.includes('"world_gen_failed"'))).toBe(true)
  })

  // ------------------------------------------------------------------
  // 5. Stage failure halts the loop — generic thrown error
  // ------------------------------------------------------------------
  it('does not run subsequent stages after a thrown failure', async () => {
    const { worldId, campaignId } = await seedUserWorldCampaign(pool, scope)
    // First generateText call throws (concept-intake generator).
    vi.mocked(ai.generateText).mockRejectedValueOnce(new Error('boom from anthropic'))

    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    // Generic errors rethrow (BullMQ retry) — assert the throw.
    await expect(proc(makeJob(campaignId))).rejects.toThrow(/boom from anthropic/)

    const runs = await pool.query<{ stage: string; status: string }>(
      `SELECT stage, status FROM pipeline_runs WHERE world_id = $1`,
      [worldId],
    )
    expect(runs.rows.map((r) => r.stage)).toEqual(['concept_intake'])
    expect(runs.rows[0]?.status).toBe('failed')

    // World status flipped to 'failed' so the concurrent-generation guard
    // releases. Per myth-e5mn-followup: handleStageError now eagerly flips
    // worlds.status='failed' on EVERY stage error (was previously gated to
    // only StageNotImplementedError + cost-cap-refund), and processWorldGen's
    // top-of-function reset flips back to 'generating' for the BullMQ retry.
    const w = await pool.query<{ status: string }>(`SELECT status FROM worlds WHERE id = $1`, [
      worldId,
    ])
    expect(w.rows[0]?.status).toBe('failed')
  })

  // ------------------------------------------------------------------
  // myth-t1qz Phase 4: diagnostic propagates through pipeline_runs.error
  // and the stage-failed SSE event payload when an LLM call's wrapper
  // attaches `.diagnostic` to the rethrown error.
  // ------------------------------------------------------------------
  it('propagates wrapper diagnostic into pipeline_runs.error and stage-failed event', async () => {
    const { worldId, campaignId } = await seedUserWorldCampaign(pool, scope)
    const wrapperErr: Error & { diagnostic?: unknown } = new Error(
      'llm returned unparseable structured output',
    )
    wrapperErr.diagnostic = {
      callSite: 'concept-intake/generator',
      schemaName: 'ConceptIntakeSchema',
      modelId: 'claude-sonnet-5',
      repairStrategy: 'sonnet',
      repairAttempted: true,
      repairOutcome: 'sonnet_failed',
      rawTextSnippet: '{"partial":"output"}',
      zodIssues: [{ path: 'tone', message: 'Required' }],
    }
    vi.mocked(ai.generateText).mockRejectedValueOnce(wrapperErr)

    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    await expect(proc(makeJob(campaignId))).rejects.toBe(wrapperErr)

    const row = await pool.query<{ error: string | null }>(
      `SELECT error FROM pipeline_runs
        WHERE world_id = $1 AND stage = 'concept_intake'`,
      [worldId],
    )
    const errorJson = row.rows[0]?.error ?? ''
    expect(errorJson).toContain('diagnostic')
    expect(errorJson).toContain('concept-intake/generator')
    expect(errorJson).toContain('sonnet_failed')
    expect(errorJson.length).toBeLessThanOrEqual(2048)

    const stageFailedPayloads = deps.publishSpy.mock.calls
      .map((c) => String(c[1]))
      .filter((s) => s.includes('"stage-failed"'))
    expect(stageFailedPayloads).toHaveLength(1)
    const parsed = JSON.parse(stageFailedPayloads[0] ?? '{}') as {
      type: string
      diagnostic?: { callSite?: string; repairOutcome?: string }
    }
    expect(parsed.diagnostic).toBeDefined()
    expect(parsed.diagnostic?.callSite).toBe('concept-intake/generator')
    expect(parsed.diagnostic?.repairOutcome).toBe('sonnet_failed')
  })

  // ------------------------------------------------------------------
  // myth-uppw: terminal errors (paint-job-exhausted, content-filter,
  // structured-output, auth, etc.) stop the BullMQ retry — proc resolves
  // cleanly. Retryable errors (rate-limit, overload, timeout) rethrow so
  // BullMQ's retry policy fires.
  // ------------------------------------------------------------------
  it('terminal LlmStructuredOutputError stops the processor (no BullMQ rethrow)', async () => {
    const { campaignId, worldId } = await seedUserWorldCampaign(pool, scope)
    // The wrapper would normally produce this after the repair chain
    // exhausts. We synthesize it directly via the generator mock.
    const { LlmStructuredOutputError } = await import('../../errors.js')
    const terminalErr = new LlmStructuredOutputError('repair chain exhausted')
    vi.mocked(ai.generateText).mockRejectedValueOnce(terminalErr)

    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    // proc resolves (no rethrow) because terminal errors return 'stop'
    // from handleStageError.
    await expect(proc(makeJob(campaignId))).resolves.toBeUndefined()

    // stage-failed event payload: willRetry must be false.
    const stageFailed = deps.publishSpy.mock.calls
      .map((c) => String(c[1]))
      .filter((s) => s.includes('"stage-failed"'))
      .map((s) => JSON.parse(s) as { willRetry?: boolean; errorCode?: string })
    expect(stageFailed).toHaveLength(1)
    expect(stageFailed[0]?.willRetry).toBe(false)
    expect(stageFailed[0]?.errorCode).toBe('llm_structured_output_failed')

    // worlds.status flipped to 'failed' — concurrent-gen guard releases.
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM worlds WHERE id = $1`,
      [worldId],
    )
    expect(rows[0]?.status).toBe('failed')
  })

  it('terminal LlmContentFilteredError stops the processor', async () => {
    const { campaignId } = await seedUserWorldCampaign(pool, scope)
    const { LlmContentFilteredError } = await import('../../errors.js')
    vi.mocked(ai.generateText).mockRejectedValueOnce(
      new LlmContentFilteredError('content filter tripped'),
    )

    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    await expect(proc(makeJob(campaignId))).resolves.toBeUndefined()

    const stageFailed = deps.publishSpy.mock.calls
      .map((c) => String(c[1]))
      .filter((s) => s.includes('"stage-failed"'))
      .map((s) => JSON.parse(s) as { willRetry?: boolean; errorCode?: string })
    expect(stageFailed[0]?.willRetry).toBe(false)
    expect(stageFailed[0]?.errorCode).toBe('llm_content_filtered')
  })

  it('terminal PaintJobLoopExhaustedError stops the processor', async () => {
    const { campaignId } = await seedUserWorldCampaign(pool, scope)
    // Synthesize a paint-job-exhausted error directly via the duck-typed
    // shape that isTerminalError recognizes. We don't import the real
    // class to keep the test focused on the predicate boundary.
    const exhausted = Object.assign(new Error('paint-job exhausted'), {
      code: 'concept_intake_paint_job_loop_exhausted',
      terminal: true,
    })
    vi.mocked(ai.generateText).mockRejectedValueOnce(exhausted)

    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    await expect(proc(makeJob(campaignId))).resolves.toBeUndefined()

    const stageFailed = deps.publishSpy.mock.calls
      .map((c) => String(c[1]))
      .filter((s) => s.includes('"stage-failed"'))
      .map((s) => JSON.parse(s) as { willRetry?: boolean; errorCode?: string })
    expect(stageFailed[0]?.willRetry).toBe(false)
    expect(stageFailed[0]?.errorCode).toBe('concept_intake_paint_job_loop_exhausted')
  })

  it('retryable LlmRateLimitedError rethrows (BullMQ retries)', async () => {
    const { campaignId, worldId } = await seedUserWorldCampaign(pool, scope)
    const { LlmRateLimitedError } = await import('../../errors.js')
    const transientErr = new LlmRateLimitedError('429 backoff')
    vi.mocked(ai.generateText).mockRejectedValueOnce(transientErr)

    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    await expect(proc(makeJob(campaignId))).rejects.toBe(transientErr)

    const stageFailed = deps.publishSpy.mock.calls
      .map((c) => String(c[1]))
      .filter((s) => s.includes('"stage-failed"'))
      .map((s) => JSON.parse(s) as { willRetry?: boolean; errorCode?: string })
    expect(stageFailed[0]?.willRetry).toBe(true)
    expect(stageFailed[0]?.errorCode).toBe('llm_rate_limited')

    // Eager worlds.status='failed' still fires — BullMQ's retry path resets
    // back to 'generating' on the next attempt. See handleStageError comment.
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM worlds WHERE id = $1`,
      [worldId],
    )
    expect(rows[0]?.status).toBe('failed')
  })

  it('LlmOverloadedError (529 → connectivity class) now PARKS instead of the BullMQ rethrow', async () => {
    // llm-outage-resilience §3.1: the wrapper classifies llm_overloaded as
    // connectivity and attaches the class to the surfaced error; the
    // processor's containment path rides the park ladder instead of
    // rethrowing into BullMQ's own retry policy.
    const { DelayedError } = await import('bullmq')
    const { campaignId, worldId } = await seedUserWorldCampaign(pool, scope)
    const { LlmOverloadedError } = await import('../../errors.js')
    vi.mocked(ai.generateText).mockRejectedValueOnce(new LlmOverloadedError('529 overloaded'))

    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    await expect(proc(makeJob(campaignId))).rejects.toBeInstanceOf(DelayedError)

    const stageFailed = deps.publishSpy.mock.calls
      .map((c) => String(c[1]))
      .filter((s) => s.includes('"stage-failed"'))
      .map((s) => JSON.parse(s) as { willRetry?: boolean; failureClass?: string })
    expect(stageFailed[0]?.willRetry).toBe(true)
    expect(stageFailed[0]?.failureClass).toBe('connectivity')

    // A park never flips the entity (spec §3.3) — unlike the old rethrow path.
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM worlds WHERE id = $1`,
      [worldId],
    )
    expect(rows[0]?.status).toBe('generating')
  })

  // ------------------------------------------------------------------
  // 6. Atomic claim — two concurrent runs invoke the generator once total
  // ------------------------------------------------------------------
  it('atomic claim prevents two workers from running the same stage', async () => {
    const { campaignId } = await seedUserWorldCampaign(pool, scope)
    // Only push enough mock responses for ONE concept_intake run. If both
    // workers raced past the claim, the second would consume an undefined
    // mock and throw — the test catches the leak either way.
    pushConceptIntakeResponses()

    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    const results = await Promise.allSettled([proc(makeJob(campaignId)), proc(makeJob(campaignId))])
    // The winner resolves (falls through to stage 2's stage_not_implemented →
    // expected stop). The loser either resolves the same way (it arrived after
    // the winner completed concept_intake) or STOPS on the live in-flight
    // claim with a retryable rethrow (llm-outage-resilience §3.2 — it must
    // never continue past a stage another worker holds).
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true)
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(String((r as PromiseRejectedResult).reason)).toMatch(/in-flight/)
      }
    }

    // Exactly 2 generateText calls total — one for the generator, one for
    // the judge inside paint-job-validator. If both workers had raced past
    // the claim we'd see 4 calls.
    expect(vi.mocked(ai.generateText)).toHaveBeenCalledTimes(2)
  })

  // ------------------------------------------------------------------
  // myth-exac T18: world_snapshot_ready phase emit + bypass threading.
  // ------------------------------------------------------------------

  // Empty stage-dispatch result for the wave-4 module mocks. The dispatcher
  // returns this shape; finalizedEvents=[] avoids any post-COMMIT publish.
  const EMPTY_STAGE_RESULT = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    finalizedEvents: [],
    capExhausted: false,
  } as const

  it('publishes phase=world_snapshot_ready exactly once after world_introduction commits', async () => {
    const { worldId, campaignId } = await seedUserWorldCampaign(pool, scope)
    // myth-zaqxh: the reveal boundary is world_introduction. Pre-seed every
    // stage through entity_relationships as completed so the loop reaches
    // world_introduction fresh; that stage's commit is the snapshot-ready emit.
    for (const stage of [
      'concept_intake',
      'vocabulary_intake',
      'world_and_factions',
      'locations_and_npcs',
      'entity_relationships',
    ] as const) {
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at,
                                    completed_at, cost_usd, input_tokens, output_tokens, user_id)
         VALUES ($1, $2, $3, 'completed', now(), now(), 0, 0, 0, NULL)`,
        [uuidv7(), worldId, stage],
      )
    }
    // world_introduction succeeds (StageCostResult shape — wrapped by the
    // dispatcher); entity_consolidation then skips (no pending phantoms) and
    // starting_situation throws to halt the loop before the tail.
    vi.mocked(worldIntroductionModule.runWorldIntroductionStage).mockResolvedValueOnce({
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    })
    vi.mocked(ai.generateText).mockRejectedValueOnce(
      new StageNotImplementedError('starting_situation'),
    )

    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    await proc(makeJob(campaignId))

    // The world_introduction row should be completed (the mocked handler wrote
    // nothing but markStageCompleted ran on the success path).
    const introRow = await pool.query<{ status: string }>(
      `SELECT status FROM pipeline_runs
        WHERE world_id = $1 AND stage = 'world_introduction'`,
      [worldId],
    )
    expect(introRow.rows[0]?.status).toBe('completed')

    // The boundary handler was invoked exactly once (no idempotent re-entry in
    // this test) so the emit must fire from the fresh-commit branch.
    expect(
      vi.mocked(worldIntroductionModule.runWorldIntroductionStage),
    ).toHaveBeenCalledTimes(1)

    const phaseStrings = deps.publishSpy.mock.calls.map((c) => String(c[1]))
    const snapshotReadyEmits = phaseStrings.filter((p) =>
      p.includes('"world_snapshot_ready"'),
    )
    expect(snapshotReadyEmits).toHaveLength(1)
  })

  it('re-publishes phase=world_snapshot_ready on retry re-entry when world_introduction is already completed', async () => {
    const { worldId, campaignId } = await seedUserWorldCampaign(pool, scope)
    // Pre-stage everything through world_introduction (the reveal boundary) as
    // completed. The loop walks past each via the `claim !== 'claimed'` branch;
    // the world_introduction idempotent skip must emit world_snapshot_ready for
    // reconnecting SSE subscribers.
    for (const stage of [
      'concept_intake',
      'vocabulary_intake',
      'world_and_factions',
      'locations_and_npcs',
      'entity_relationships',
      'world_introduction',
      'entity_consolidation',
    ] as const) {
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at,
                                    completed_at, cost_usd, input_tokens, output_tokens, user_id)
         VALUES ($1, $2, $3, 'completed', now(), now(), 0, 0, 0, NULL)`,
        [uuidv7(), worldId, stage],
      )
    }
    // Stage 5 throws StageNotImplementedError to terminate the loop cleanly
    // without driving the remaining stages.
    vi.mocked(ai.generateText).mockRejectedValueOnce(
      new StageNotImplementedError('starting_situation'),
    )

    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    await proc(makeJob(campaignId))

    // The stage-4 handler must NOT have re-run.
    expect(
      vi.mocked(entityRelationshipsModule.runEntityRelationshipsStage),
    ).not.toHaveBeenCalled()

    const phaseStrings = deps.publishSpy.mock.calls.map((c) => String(c[1]))
    const snapshotReadyEmits = phaseStrings.filter((p) =>
      p.includes('"world_snapshot_ready"'),
    )
    expect(snapshotReadyEmits).toHaveLength(1)
  })

  it('threads worlds.dev_bypass_access_filter into every wave-4 stage RunArgs', async () => {
    const { worldId, campaignId } = await seedUserWorldCampaign(pool, scope)
    // Flip the world's dev-bypass column on. The processor reads this at job
    // entry and threads it into the dispatcher args for stages 2/3/4 (+ 7).
    await pool.query(`UPDATE worlds SET dev_bypass_access_filter = true WHERE id = $1`, [worldId])
    pushConceptIntakeResponses()

    // Wave-4 stage mocks: each succeeds and returns the empty result so the
    // dispatcher walks all the way through stage 4. We assert against the
    // captured RunArgs after the job completes.
    vi.mocked(worldAndFactionsModule.runWorldAndFactionsStage).mockResolvedValueOnce(
      EMPTY_STAGE_RESULT,
    )
    vi.mocked(locationsAndNpcsModule.runLocationsAndNpcsStage).mockResolvedValueOnce(
      EMPTY_STAGE_RESULT,
    )
    vi.mocked(entityRelationshipsModule.runEntityRelationshipsStage).mockResolvedValueOnce(
      EMPTY_STAGE_RESULT,
    )
    // Stage 5 throws to halt the loop after stage 4 commits.
    vi.mocked(ai.generateText).mockRejectedValueOnce(
      new StageNotImplementedError('starting_situation'),
    )

    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    await proc(makeJob(campaignId))

    // Each wave-4 dispatcher arm must have been called with
    // bypassAccessFilter=true threaded through from the world row.
    const wfCall = vi.mocked(worldAndFactionsModule.runWorldAndFactionsStage).mock.calls[0]
    expect(wfCall?.[1].bypassAccessFilter).toBe(true)
    const lnCall = vi.mocked(locationsAndNpcsModule.runLocationsAndNpcsStage).mock.calls[0]
    expect(lnCall?.[1].bypassAccessFilter).toBe(true)
    const erCall = vi.mocked(entityRelationshipsModule.runEntityRelationshipsStage).mock.calls[0]
    expect(erCall?.[1].bypassAccessFilter).toBe(true)
  })

  // ------------------------------------------------------------------
  // MYT-71 T10 — terminal embed_world stage
  // ------------------------------------------------------------------
  it('WORLD_GEN_STAGES ends with embed_world immediately after coherence_pass', () => {
    const last = WORLD_GEN_STAGES[WORLD_GEN_STAGES.length - 1]
    const penultimate = WORLD_GEN_STAGES[WORLD_GEN_STAGES.length - 2]
    expect(last).toBe('embed_world')
    expect(penultimate).toBe('coherence_pass')
  })

  it('routes embed_world to completion (world complete, $0 row) even when embed leaves rows NULL', async () => {
    const { worldId, campaignId } = await seedUserWorldCampaign(pool, scope)
    // Pre-stage every content stage (1 → coherence_pass) as completed so the
    // loop walks straight to the terminal embed_world stage via the claim
    // path. embed_world is the only stage actually dispatched here.
    for (const stage of [
      'concept_intake',
      'vocabulary_intake',
      'world_and_factions',
      'locations_and_npcs',
      'entity_relationships',
      'world_introduction',
      'entity_consolidation',
      'starting_situation',
      'random_tables',
      'coherence_pass',
    ] as const) {
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at,
                                    completed_at, cost_usd, input_tokens, output_tokens, user_id)
         VALUES ($1, $2, $3, 'completed', now(), now(), 0, 0, 0, NULL)`,
        [uuidv7(), worldId, stage],
      )
    }
    // embedWorld leaves rows NULL (a Voyage failure embedWorld caught
    // internally — voyageErrors>0, leftNull>0). The TOTAL stage must STILL
    // drive the world to completion.
    vi.mocked(retrievalModule.embedWorld).mockResolvedValueOnce({
      embedded: 0,
      leftNull: 7,
      voyageErrors: 2,
    })

    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    await proc(makeJob(campaignId))

    // embed_world dispatched against the right world (NULL-only, no force).
    expect(retrievalModule.embedWorld).toHaveBeenCalledTimes(1)
    const embedCall = vi.mocked(retrievalModule.embedWorld).mock.calls[0]
    expect(embedCall?.[1]).toBe(worldId)
    expect(embedCall?.[2]).toBeUndefined()

    // embed_world wrote a completed pipeline_runs row at $0 (Voyage spend is
    // off the Anthropic cap).
    const embedRun = await pool.query<{ status: string; cost_usd: string }>(
      `SELECT status, cost_usd FROM pipeline_runs WHERE world_id = $1 AND stage = 'embed_world'`,
      [worldId],
    )
    expect(embedRun.rows[0]?.status).toBe('completed')
    expect(Number(embedRun.rows[0]?.cost_usd)).toBe(0)

    // World reached completion.
    const world = await pool.query<{ status: string }>(
      `SELECT status FROM worlds WHERE id = $1`,
      [worldId],
    )
    expect(world.rows[0]?.status).toBe('complete')

    const phaseStrings = deps.publishSpy.mock.calls.map((c) => String(c[1]))
    expect(phaseStrings.some((p) => p.includes('"world_ready"'))).toBe(true)
  })

  // ------------------------------------------------------------------
  // llm-outage-resilience §3.1 — parking. A park-eligible (connectivity /
  // rate-limit via the ai.ts-attached llmFailureClass), non-terminal
  // failure with park budget remaining marks the stage row failed AS
  // TODAY (claimable on wake), stamps llm_resume_stamps, publishes the
  // generating-shaped phase event, then self-delays via
  // job.moveToDelayed + DelayedError. worlds.status NEVER flips on a
  // park — the stamp, not the row, distinguishes parked from failed.
  // ------------------------------------------------------------------
  describe('parking (llm-outage-resilience §3.1)', () => {
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000

    // The park predicate reads the `llmFailureClass` property ai.ts attaches
    // to every classified error it surfaces (Task 4 contract). These tests
    // throw from the module-mocked world_color handler — BYPASSING ai.ts —
    // so the hand-attached class survives; the attach itself is ai.test.ts's
    // job. (An error routed through the mocked SDK would be re-classified by
    // the wrapper and the hand-set class overwritten.) The end-to-end
    // wrapper-attached path is covered by the LlmOverloadedError park test
    // above and the tail-stage park below.
    function classedError(
      llmFailureClass: 'connectivity' | 'rate-limit' | 'abort' | 'other',
      opts: { terminal?: boolean } = {},
    ): Error {
      return Object.assign(new Error(`upstream failure (${llmFailureClass})`), {
        llmFailureClass,
        ...(opts.terminal === true ? { terminal: true } : {}),
      })
    }

    // Skip concept_intake (its generateText path would need queued mock
    // responses) so the run claims world_color directly, whose module mock
    // throws the classed error for these scenarios.
    async function seedConceptDone(worldId: string): Promise<void> {
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at,
                                    completed_at, cost_usd, input_tokens, output_tokens, user_id)
         VALUES ($1, $2, 'concept_intake', 'completed', now(), now(), 0, 0, 0, NULL)`,
        [uuidv7(), worldId],
      )
    }

    function worldColorThrows(err: Error): void {
      vi.mocked(worldColorModule.runWorldColorStage).mockImplementationOnce(() => {
        throw err
      })
    }

    async function readStamp(campaignId: string): Promise<{
      resume_attempt: number
      next_resume_at: Date | null
      park_consumed_ms: string
      last_error_class: string
    } | null> {
      const { rows } = await pool.query<{
        resume_attempt: number
        next_resume_at: Date | null
        park_consumed_ms: string
        last_error_class: string
      }>(
        `SELECT resume_attempt, next_resume_at, park_consumed_ms, last_error_class
           FROM llm_resume_stamps WHERE pipeline = 'world_gen' AND entity_id = $1`,
        [campaignId],
      )
      return rows[0] ?? null
    }

    async function seedStamp(
      campaignId: string,
      s: { attempt: number; consumedMs: number; nextResumeAt: Date | null },
    ): Promise<void> {
      await pool.query(
        `INSERT INTO llm_resume_stamps
           (pipeline, entity_id, resume_attempt, next_resume_at, park_consumed_ms, last_error_class)
         VALUES ('world_gen', $1, $2, $3, $4, 'connectivity')`,
        [campaignId, s.attempt, s.nextResumeAt, s.consumedMs],
      )
    }

    it('parks a connectivity failure: stamp + failed row + DelayedError, world stays generating', async () => {
      const { DelayedError } = await import('bullmq')
      const { worldId, campaignId } = await seedUserWorldCampaign(pool, scope)
      await seedConceptDone(worldId)
      // A wrapper-attached diagnostic (e.g. a repair-chain connectivity
      // failure surfaced to the loop) must ride the parked stage-failed
      // event exactly as it rides the ordinary failure publish.
      worldColorThrows(
        Object.assign(classedError('connectivity'), {
          diagnostic: {
            callSite: 'world_color',
            schemaName: 'WorldColorPair',
            modelId: 'test-model',
            repairStrategy: 'sonnet',
            repairAttempted: false,
            repairOutcome: 'none',
            rawTextSnippet: null,
            zodIssues: null,
          },
        }),
      )

      const deps = makeDeps(pool)
      const proc = createWorldGenProcessor(deps)
      const job = makeJob(campaignId)
      const before = Date.now()
      // Explicit worker token (the 2nd worker arg) takes precedence.
      await expect(proc(job, 'worker-token')).rejects.toBeInstanceOf(DelayedError)

      // First park: rung 1 armed 30s out, 30s of budget consumed.
      const stamp = await readStamp(campaignId)
      expect(stamp).not.toBeNull()
      expect(stamp?.resume_attempt).toBe(1)
      expect(stamp?.last_error_class).toBe('connectivity')
      expect(Number(stamp?.park_consumed_ms)).toBe(30_000)
      expect(stamp?.next_resume_at).not.toBeNull()

      // The stage row failed AS TODAY — claimable on wake (no stage skip).
      const run = await pool.query<{ status: string }>(
        `SELECT status FROM pipeline_runs WHERE world_id = $1 AND stage = 'world_color'`,
        [worldId],
      )
      expect(run.rows[0]?.status).toBe('failed')

      // NO worlds.markFailed on a park (spec §3.3: entity stays in-progress).
      const world = await pool.query<{ status: string }>(
        `SELECT status FROM worlds WHERE id = $1`,
        [worldId],
      )
      expect(world.rows[0]?.status).toBe('generating')

      // Self-delay: same job, ~30s out, under the worker's lock token.
      expect(job.moveToDelayed).toHaveBeenCalledTimes(1)
      const [ts, token] = job.moveToDelayed.mock.calls[0] as [number, string]
      expect(token).toBe('worker-token')
      expect(ts).toBeGreaterThanOrEqual(before + 30_000)
      expect(ts).toBeLessThan(before + 40_000)

      // stage-failed carries the class (additive); the phase event stays
      // generating-shaped — world_gen_failed is never published on a park.
      const events = deps.publishSpy.mock.calls.map((c) => String(c[1]))
      const stageFailed = events
        .filter((s) => s.includes('"stage-failed"'))
        .map(
          (s) =>
            JSON.parse(s) as {
              willRetry?: boolean
              failureClass?: string
              diagnostic?: { callSite?: string }
            },
        )
      expect(stageFailed[0]?.willRetry).toBe(true)
      expect(stageFailed[0]?.failureClass).toBe('connectivity')
      expect(stageFailed[0]?.diagnostic?.callSite).toBe('world_color')
      expect(events.some((s) => s.includes('"world_gen_failed"'))).toBe(false)

      // Publish precedes the self-delay (spec step 3 ordering).
      const lastPublishOrder = Math.max(...deps.publishSpy.mock.invocationCallOrder)
      const delayOrder = job.moveToDelayed.mock.invocationCallOrder[0] ?? 0
      expect(lastPublishOrder).toBeLessThan(delayOrder)
    })

    it('parks a rate-limit failure, falling back to job.token when no worker token is threaded', async () => {
      const { DelayedError } = await import('bullmq')
      const { campaignId, worldId } = await seedUserWorldCampaign(pool, scope)
      await seedConceptDone(worldId)
      worldColorThrows(classedError('rate-limit'))

      const deps = makeDeps(pool)
      const proc = createWorldGenProcessor(deps)
      const job = makeJob(campaignId)
      await expect(proc(job)).rejects.toBeInstanceOf(DelayedError)

      const stamp = await readStamp(campaignId)
      expect(stamp?.last_error_class).toBe('rate-limit')
      const [, token] = job.moveToDelayed.mock.calls[0] as [number, string | undefined]
      expect(token).toBe('job-lock-token')
    })

    it('degraded park consumes no budget (sitewide outage already known → consume:false)', async () => {
      const { DelayedError } = await import('bullmq')
      const { campaignId, worldId } = await seedUserWorldCampaign(pool, scope)
      await seedConceptDone(worldId)
      worldColorThrows(classedError('connectivity'))
      const deps = makeDeps(pool)
      // The tracker reads `${keyPrefix}llm-health:state` — present ⇔ degraded.
      await deps.redisRealtime.set(
        `${deps.redisKeyPrefix}llm-health:state`,
        JSON.stringify({ since: Date.now() }),
      )

      const proc = createWorldGenProcessor(deps)
      await expect(proc(makeJob(campaignId))).rejects.toBeInstanceOf(DelayedError)

      const stamp = await readStamp(campaignId)
      expect(stamp?.resume_attempt).toBe(1)
      expect(Number(stamp?.park_consumed_ms)).toBe(0)
      expect(stamp?.next_resume_at).not.toBeNull()
    })

    it('re-park climbs the ladder: attempt 1 → 2 delays 120s and accumulates the budget', async () => {
      const { DelayedError } = await import('bullmq')
      const { campaignId, worldId } = await seedUserWorldCampaign(pool, scope)
      await seedConceptDone(worldId)
      // A prior park whose wake claimed (next_resume_at cleared) then failed
      // connectivity again — the surviving rung/budget fields drive rung 2.
      await seedStamp(campaignId, { attempt: 1, consumedMs: 30_000, nextResumeAt: null })
      worldColorThrows(classedError('connectivity'))

      const deps = makeDeps(pool)
      const proc = createWorldGenProcessor(deps)
      const job = makeJob(campaignId)
      const before = Date.now()
      await expect(proc(job)).rejects.toBeInstanceOf(DelayedError)

      const stamp = await readStamp(campaignId)
      expect(stamp?.resume_attempt).toBe(2)
      expect(Number(stamp?.park_consumed_ms)).toBe(150_000)
      const [ts] = job.moveToDelayed.mock.calls[0] as [number]
      expect(ts).toBeGreaterThanOrEqual(before + 120_000)
      expect(ts).toBeLessThan(before + 130_000)
    })

    it("exhausted budget falls through to today's failed path exactly (retryable surface)", async () => {
      const { campaignId, worldId } = await seedUserWorldCampaign(pool, scope)
      await seedConceptDone(worldId)
      await seedStamp(campaignId, { attempt: 4, consumedMs: SIX_HOURS_MS, nextResumeAt: null })
      const err = classedError('connectivity')
      worldColorThrows(err)

      const deps = makeDeps(pool)
      const proc = createWorldGenProcessor(deps)
      const job = makeJob(campaignId)
      // Non-terminal → rethrow so BullMQ's own retry policy fires, as today.
      await expect(proc(job)).rejects.toBe(err)

      expect(job.moveToDelayed).not.toHaveBeenCalled()
      const world = await pool.query<{ status: string }>(
        `SELECT status FROM worlds WHERE id = $1`,
        [worldId],
      )
      expect(world.rows[0]?.status).toBe('failed')
      const events = deps.publishSpy.mock.calls.map((c) => String(c[1]))
      expect(events.some((s) => s.includes('"world_gen_failed"'))).toBe(true)
      // The spent stamp is untouched (clearStamp is completion's / the manual
      // retry route's job — the fresh-episode arm).
      const stamp = await readStamp(campaignId)
      expect(Number(stamp?.park_consumed_ms)).toBe(SIX_HOURS_MS)
      expect(stamp?.next_resume_at).toBeNull()
    })

    it("a non-park-eligible class ('abort') keeps today's behavior — no stamp, no delay", async () => {
      const { campaignId, worldId } = await seedUserWorldCampaign(pool, scope)
      await seedConceptDone(worldId)
      const err = classedError('abort')
      worldColorThrows(err)

      const deps = makeDeps(pool)
      const proc = createWorldGenProcessor(deps)
      const job = makeJob(campaignId)
      await expect(proc(job)).rejects.toBe(err)

      expect(job.moveToDelayed).not.toHaveBeenCalled()
      expect(await readStamp(campaignId)).toBeNull()
      const world = await pool.query<{ status: string }>(
        `SELECT status FROM worlds WHERE id = $1`,
        [worldId],
      )
      expect(world.rows[0]?.status).toBe('failed')
    })

    it('a TERMINAL error never parks even when park-eligible by class (re-entry rule stands)', async () => {
      const { campaignId, worldId } = await seedUserWorldCampaign(pool, scope)
      await seedConceptDone(worldId)
      worldColorThrows(classedError('connectivity', { terminal: true }))

      const deps = makeDeps(pool)
      const proc = createWorldGenProcessor(deps)
      const job = makeJob(campaignId)
      // Terminal → today's clean stop (no BullMQ rethrow).
      await expect(proc(job)).resolves.toBeUndefined()

      expect(job.moveToDelayed).not.toHaveBeenCalled()
      expect(await readStamp(campaignId)).toBeNull()
      const world = await pool.query<{ status: string }>(
        `SELECT status FROM worlds WHERE id = $1`,
        [worldId],
      )
      expect(world.rows[0]?.status).toBe('failed')
    })

    it('claim success clears next_resume_at; rung + budget fields SURVIVE the claim', async () => {
      const { campaignId, worldId } = await seedUserWorldCampaign(pool, scope)
      // Armed stamp from a prior park at world_and_factions…
      await seedStamp(campaignId, {
        attempt: 2,
        consumedMs: 150_000,
        nextResumeAt: new Date(Date.now() + 60_000),
      })
      // …with every earlier stage already completed, so the wake claims
      // world_and_factions directly and its default mock terminal-stops
      // (no stage completes → the stamp row itself survives).
      for (const stage of ['concept_intake', 'world_color', 'vocabulary_intake'] as const) {
        await pool.query(
          `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at,
                                      completed_at, cost_usd, input_tokens, output_tokens, user_id)
           VALUES ($1, $2, $3, 'completed', now(), now(), 0, 0, 0, NULL)`,
          [uuidv7(), worldId, stage],
        )
      }

      const deps = makeDeps(pool)
      const proc = createWorldGenProcessor(deps)
      await proc(makeJob(campaignId))

      const stamp = await readStamp(campaignId)
      expect(stamp).not.toBeNull()
      expect(stamp?.next_resume_at).toBeNull()
      expect(stamp?.resume_attempt).toBe(2)
      expect(Number(stamp?.park_consumed_ms)).toBe(150_000)
    })

    it('stage COMPLETION clears the stamp (fresh episode budget once the outage passes)', async () => {
      const { campaignId } = await seedUserWorldCampaign(pool, scope)
      await seedStamp(campaignId, {
        attempt: 3,
        consumedMs: 450_000,
        nextResumeAt: new Date(Date.now() + 60_000),
      })
      // concept_intake completes normally, then world_and_factions
      // terminal-stops via its default stage_not_implemented mock.
      pushConceptIntakeResponses()

      const deps = makeDeps(pool)
      const proc = createWorldGenProcessor(deps)
      await proc(makeJob(campaignId))

      expect(await readStamp(campaignId)).toBeNull()
    })

    it('a tail-stage park (behind the reveal) publishes the world_snapshot_ready shape, never world_gen', async () => {
      const { DelayedError } = await import('bullmq')
      const { campaignId, worldId } = await seedUserWorldCampaign(pool, scope)
      // Everything through entity_consolidation is done; the wake claims
      // starting_situation (behind the world_introduction reveal boundary)
      // and its single generateText call dies on connectivity.
      for (const stage of [
        'concept_intake',
        'world_color',
        'vocabulary_intake',
        'world_and_factions',
        'locations_and_npcs',
        'entity_relationships',
        'world_introduction',
        'entity_consolidation',
      ] as const) {
        await pool.query(
          `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at,
                                      completed_at, cost_usd, input_tokens, output_tokens, user_id)
           VALUES ($1, $2, $3, 'completed', now(), now(), 0, 0, 0, NULL)`,
          [uuidv7(), worldId, stage],
        )
      }
      // Routed through the REAL wrapper: llm_overloaded classifies as
      // connectivity and ai.ts attaches the class to the surfaced error —
      // the end-to-end Task 4 → park handoff.
      const { LlmOverloadedError } = await import('../../errors.js')
      vi.mocked(ai.generateText).mockRejectedValueOnce(new LlmOverloadedError('529 overloaded'))

      const deps = makeDeps(pool)
      const proc = createWorldGenProcessor(deps)
      const job = makeJob(campaignId)
      await expect(proc(job)).rejects.toBeInstanceOf(DelayedError)

      expect(job.moveToDelayed).toHaveBeenCalledTimes(1)
      const phases = deps.publishSpy.mock.calls
        .map((c) => String(c[1]))
        .filter((s) => s.includes('"phase"'))
        .map((s) => (JSON.parse(s) as { phase: string }).phase)
      // The parked phase event (the last publish) keeps the reveal shape — a
      // live viewer on the snapshot must not flip back to the pre-reveal view.
      expect(phases[phases.length - 1]).toBe('world_snapshot_ready')
      expect(phases).not.toContain('world_gen_failed')
    })

    it("the loop STOPS on an in-flight stage (retryable rethrow — never continues past it)", async () => {
      const { campaignId, worldId } = await seedUserWorldCampaign(pool, scope)
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at,
                                    completed_at, cost_usd, input_tokens, output_tokens, user_id)
         VALUES ($1, $2, 'concept_intake', 'completed', now(), now(), 0, 0, 0, NULL)`,
        [uuidv7(), worldId],
      )
      // A live (not-stuck) world_color row — e.g. BullMQ's stall handling
      // re-drove a dead worker's job while the stage is genuinely running.
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, user_id)
         VALUES ($1, $2, 'world_color', 'running', now(), NULL)`,
        [uuidv7(), worldId],
      )

      const deps = makeDeps(pool)
      const proc = createWorldGenProcessor(deps)
      await expect(proc(makeJob(campaignId))).rejects.toThrow(/in-flight/)

      // The loop stopped AT the live stage: nothing later got a row, no
      // failure surfaced, the world stays generating for the re-drive.
      const later = await pool.query(
        `SELECT stage FROM pipeline_runs WHERE world_id = $1
          AND stage NOT IN ('concept_intake', 'world_color')`,
        [worldId],
      )
      expect(later.rows).toEqual([])
      const world = await pool.query<{ status: string }>(
        `SELECT status FROM worlds WHERE id = $1`,
        [worldId],
      )
      expect(world.rows[0]?.status).toBe('generating')
      const events = deps.publishSpy.mock.calls.map((c) => String(c[1]))
      expect(events.some((s) => s.includes('"stage-failed"'))).toBe(false)
      expect(events.some((s) => s.includes('"world_gen_failed"'))).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// sanitizeError unit checks — separated from the integration block so they
// don't require the Postgres fixture.
// ---------------------------------------------------------------------------
describe('sanitizeError', () => {
  it('drops cause / stack and length-caps message', () => {
    const inner = new Error('inner cause with API_KEY=sk-secret')
    const outer = new Error('A'.repeat(500))
    ;(outer as { cause?: unknown }).cause = inner
    const out = sanitizeError(outer)
    expect(out.code).toBe('stage_failed')
    expect(out.message).toHaveLength(200)
    expect(JSON.stringify(out)).not.toContain('sk-secret')
    expect(JSON.stringify(out)).not.toContain('cause')
  })

  it('preserves a typed error code if present', () => {
    const err = new Error('oops') as Error & { code: string }
    err.code = 'llm_rate_limited'
    expect(sanitizeError(err).code).toBe('llm_rate_limited')
  })

  it('handles non-Error throwables', () => {
    expect(sanitizeError('a string')).toEqual({ code: 'stage_failed', message: 'unknown error' })
  })

  // myth-t1qz Phase 4: when the wrapper attaches a `.diagnostic` field to a
  // rethrown LlmStructuredOutputError, sanitizeError surfaces it onto the
  // SanitizedError payload so it propagates into pipeline_runs.error JSON
  // and the stage-failed SSE event.
  it('surfaces wrapper-attached .diagnostic onto the sanitized payload', () => {
    const err = new Error('llm returned unparseable structured output')
    ;(err as { diagnostic?: unknown }).diagnostic = {
      callSite: 'paint-job-validator/judge',
      schemaName: 'PaintJobJudgeSchema',
      modelId: 'claude-sonnet-5',
      repairStrategy: 'sonnet',
      repairAttempted: true,
      repairOutcome: 'sonnet_failed',
      rawTextSnippet: '{"flagged":"yes-but-wrong-type"}',
      zodIssues: [{ path: 'flagged', message: 'Expected boolean, received string' }],
    }
    const out = sanitizeError(err)
    expect(out.diagnostic).toBeDefined()
    expect(out.diagnostic?.callSite).toBe('paint-job-validator/judge')
    expect(out.diagnostic?.repairOutcome).toBe('sonnet_failed')
    expect(out.diagnostic?.zodIssues?.[0]).toEqual({
      path: 'flagged',
      message: 'Expected boolean, received string',
    })
  })

  it('rejects a malformed .diagnostic (drops the field entirely)', () => {
    const err = new Error('something')
    // Missing required fields — should NOT propagate.
    ;(err as { diagnostic?: unknown }).diagnostic = { callSite: 'x' }
    const out = sanitizeError(err)
    expect(out.diagnostic).toBeUndefined()
  })

  it('truncates rawTextSnippet to fit the 2KB error JSON cap', () => {
    const oversized = 'x'.repeat(4096)
    const err = new Error('boom')
    ;(err as { diagnostic?: unknown }).diagnostic = {
      callSite: 'huge/snippet',
      schemaName: 'BigSchema',
      modelId: 'claude-sonnet-5',
      repairStrategy: 'sonnet',
      repairAttempted: true,
      repairOutcome: 'sonnet_failed',
      rawTextSnippet: oversized,
      zodIssues: null,
    }
    const out = sanitizeError(err)
    const json = JSON.stringify(out)
    expect(json.length).toBeLessThanOrEqual(2048)
    expect(out.diagnostic?.rawTextSnippet).toBeDefined()
    expect((out.diagnostic?.rawTextSnippet ?? '').length).toBeLessThan(oversized.length)
  })
})

// ---------------------------------------------------------------------------
// myth-tuok T6: atomicClaimStage refactor — discriminated-union signature
// supports BOTH the world-level claim (existing behavior, user_id IS NULL)
// AND a new per-player claim keyed on (campaign_id, stage, user_id). The
// character-creation processor (T11) reuses this primitive for per-user
// stages on the same pipeline_runs table.
// ---------------------------------------------------------------------------
describe('atomicClaimStage with userId', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    // Schema is already migrated by the main describe block's beforeAll
    // (single shared DB). Running migrations again is idempotent but
    // unnecessary; just acquire a pool and a fresh scope.
    scope = makeTestScope('atomic-claim-userid')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  it('claims a per-player row keyed on (campaign_id, stage, user_id)', async () => {
    // Seed a user + a campaign (no world needed — the per-player row keys
    // on campaign_id directly per the unique index's
    // COALESCE(world_id, campaign_id) projection).
    const userId = uuidv7()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    // Worlds row required because campaigns.world_id is a NOT NULL FK.
    // The per-player claim itself does NOT touch worlds; this is purely
    // to satisfy the campaign FK.
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status)
       VALUES ($1, $2, $3, 'a concept for testing', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name)
       VALUES ($1, $2, $3, $4)`,
      [campaignId, worldId, userId, scope.campaignName(0)],
    )

    const first = await atomicClaimStage(pool, {
      kind: 'campaign-user',
      campaignId,
      userId,
      stage: 'character_concept',
    })
    expect(first).toBe('claimed')

    // Confirm the row landed under the expected key shape.
    const row = await pool.query<{
      world_id: string | null
      campaign_id: string
      user_id: string
      stage: string
      status: string
    }>(
      `SELECT world_id, campaign_id, user_id, stage, status FROM pipeline_runs
        WHERE campaign_id = $1 AND user_id = $2 AND stage = $3`,
      [campaignId, userId, 'character_concept'],
    )
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0]?.world_id).toBeNull()
    expect(row.rows[0]?.campaign_id).toBe(campaignId)
    expect(row.rows[0]?.user_id).toBe(userId)
    expect(row.rows[0]?.status).toBe('running')

    // A second claim with the same args immediately afterwards sees the
    // row in 'running' state with a fresh started_at → must NOT reclaim.
    const second = await atomicClaimStage(pool, {
      kind: 'campaign-user',
      campaignId,
      userId,
      stage: 'character_concept',
    })
    expect(second).toBe('lost-race')
  })

  it('still supports the world-level (user_id IS NULL) shape', async () => {
    const userId = uuidv7()
    const worldId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(1), scope.displayName(1), scope.username(1)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status)
       VALUES ($1, $2, $3, 'a concept for testing', 'generating')`,
      [worldId, userId, scope.worldName(1)],
    )

    const result = await atomicClaimStage(pool, {
      kind: 'world',
      worldId,
      stage: 'concept_intake',
    })
    expect(result).toBe('claimed')

    const row = await pool.query<{
      world_id: string
      campaign_id: string | null
      user_id: string | null
      status: string
    }>(
      `SELECT world_id, campaign_id, user_id, status FROM pipeline_runs
        WHERE world_id = $1 AND stage = $2`,
      [worldId, 'concept_intake'],
    )
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0]?.world_id).toBe(worldId)
    expect(row.rows[0]?.campaign_id).toBeNull()
    expect(row.rows[0]?.user_id).toBeNull()
    expect(row.rows[0]?.status).toBe('running')
  })
})
