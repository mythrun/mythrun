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
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino from 'pino'
import * as ai from 'ai'

import { guardTestDatabase } from '../../../db/__tests__/guard-db.js'
import { createPgPool } from '../../../db/postgres.js'
import { runMigrations } from '../../../db/migrate.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import {
  createWorldGenProcessor,
  sanitizeError,
  type WorldGenJobPayload,
} from '../world-gen-processor.js'
import { StageNotImplementedError } from '../stages/stage-not-implemented.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn(), streamObject: vi.fn() }
})

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../../migrations')

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

async function seedUserWorldCampaign(pool: Pool): Promise<Seeded> {
  const userId = uuidv7()
  const worldId = uuidv7()
  const campaignId = uuidv7()
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username)
     VALUES ($1, $2, 'T', $3)`,
    [userId, `s-${userId}`, `u${userId.slice(-8)}`],
  )
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status)
     VALUES ($1, $2, 'pending-name', 'a concept for testing', 'generating')`,
    [worldId, userId],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name)
     VALUES ($1, $2, $3, 'Test Campaign')`,
    [campaignId, worldId, userId],
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

function makeJob(campaignId: string): Job<WorldGenJobPayload> {
  return {
    data: { campaignId },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<WorldGenJobPayload>
}

function makeDeps(pool: Pool): {
  pool: Pool
  redisRealtime: InstanceType<typeof IoredisMock>
  redisKeyPrefix: string
  logger: ReturnType<typeof silentLogger>
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
    publishSpy,
  }
}

describe('world-gen-processor (MYT-51 T7)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 4 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await pool.query('DELETE FROM facts')
    await pool.query('DELETE FROM relationships')
    await pool.query('DELETE FROM entity_hierarchy')
    await pool.query('DELETE FROM prose_kernels')
    await pool.query('DELETE FROM entities')
    await pool.query('DELETE FROM random_table_entries')
    await pool.query('DELETE FROM random_tables')
    await pool.query('DELETE FROM pipeline_runs')
    await pool.query('DELETE FROM credit_ledger')
    await pool.query('DELETE FROM campaign_members')
    await pool.query('DELETE FROM campaigns')
    await pool.query('DELETE FROM worlds')
    await pool.query("DELETE FROM users WHERE cognito_sub != 'system:mythrun'")
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
  })

  // ------------------------------------------------------------------
  // 1. Happy path — 3 stages succeed, 2 + 3 fail with stage_not_implemented
  // ------------------------------------------------------------------
  it('runs implemented stages to completion, stops at stage_not_implemented', async () => {
    const { worldId, campaignId } = await seedUserWorldCampaign(pool)
    pushConceptIntakeResponses()
    // stage 2 fires next (world_and_factions) → throws stage_not_implemented
    // and the loop exits. Stages 4 + 5 never run; no further mocks needed.

    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    await proc(makeJob(campaignId))

    const runs = await pool.query<{ stage: string; status: string; error: string | null }>(
      `SELECT stage, status, error FROM pipeline_runs WHERE world_id = $1`,
      [worldId],
    )
    const byStage = new Map(runs.rows.map((r) => [r.stage, r]))
    expect(byStage.get('concept_intake')?.status).toBe('completed')
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
    const { worldId, campaignId } = await seedUserWorldCampaign(pool)
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
    const { worldId, campaignId } = await seedUserWorldCampaign(pool)
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
    const { userId, worldId, campaignId } = await seedUserWorldCampaign(pool)
    await pool.query(`UPDATE settings SET value = '0.0001' WHERE key = 'world_gen_cost_cap_usd'`)
    // Generator usage that produces a cost well above 0.0001: 1M input / 1M
    // output @ Sonnet ($3 + $15 = $18) — comfortably above cap.
    pushConceptIntakeResponses({ inputTokens: 1_000_000, outputTokens: 1_000_000 })

    const deps = makeDeps(pool)
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
    const { worldId, campaignId } = await seedUserWorldCampaign(pool)
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
  // 6. Atomic claim — two concurrent runs invoke the generator once total
  // ------------------------------------------------------------------
  it('atomic claim prevents two workers from running the same stage', async () => {
    const { campaignId } = await seedUserWorldCampaign(pool)
    // Only push enough mock responses for ONE concept_intake run. If both
    // workers raced past the claim, the second would consume an undefined
    // mock and throw — the test catches the leak either way.
    pushConceptIntakeResponses()

    const deps = makeDeps(pool)
    const proc = createWorldGenProcessor(deps)
    const results = await Promise.allSettled([proc(makeJob(campaignId)), proc(makeJob(campaignId))])
    // Both runs should resolve (the loser skips concept_intake and falls
    // through to stage 2's stage_not_implemented → expected stop).
    for (const r of results) {
      expect(r.status).toBe('fulfilled')
    }

    // Exactly 2 generateText calls total — one for the generator, one for
    // the judge inside paint-job-validator. If both workers had raced past
    // the claim we'd see 4 calls.
    expect(vi.mocked(ai.generateText)).toHaveBeenCalledTimes(2)
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
})
