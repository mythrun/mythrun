// backend/src/llm/prep/__tests__/session-prep-processor.test.ts
//
// MYT-61 T4: BullMQ processor for the session-prep job. One job per
// (campaign_id, session_number). Wraps T4 (MYT-59)'s pure
// `generateSessionPrep` stage with the per-stage pipeline_runs lifecycle:
// claim → generate → persist (session_preps) → mark completed → publish.
//
// pipeline_runs keys on (campaign, stage); the per-session uniqueness comes
// from `stage = `session-prep:${sessionNumber}``, so two sessions in the same
// campaign get independent claim/mark rows.
//
// Test style mirrors character-integration-processor.test.ts: real Postgres
// (createTestPool + guardTestDatabase + runMigrations) and a vi.spyOn on the
// stage module's `generateSessionPrep` export. The stage itself is unit-
// tested in stages/__tests__/session-prep.test.ts; this file pins the
// processor's lifecycle invariants without driving real Opus.
//
// CRITICAL invariant (differs from character-integration): a session-prep
// FAILURE — terminal or not — must NOT flip campaigns.status to 'failed'. A
// prep failure is session-scoped; the campaign stays active. Both failure
// cases assert the campaign row's status is unchanged.

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { DelayedError } from 'bullmq'
import IoredisMock from 'ioredis-mock'
import { guardTestDatabase } from '../../../db/__tests__/guard-db.js'
import { runMigrations } from '../../../db/migrate.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../../repo/__tests__/_helpers/test-pool.js'
import {
  createSessionPrepProcessor,
  processSessionPrepJob,
  type SessionPrepJobPayload,
  type SessionPrepProcessorDeps,
} from '../session-prep-processor.js'
import * as sessionPrepStage from '../stages/session-prep.js'
import * as secretTripwire from '../../secret-tripwire.js'
import { buildReturningVoicesSection } from '../session-prep-processor.js'
import { createSessionsRepo } from '../../../repo/sessions.js'
import type { SessionHandoff } from '../../schemas/post-session-analysis.js'
import {
  LlmStructuredOutputError,
  LlmRateLimitedError,
} from '../../errors.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: () => {
      // discard
    },
  }
  return pino(
    { base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } },
    sink,
  )
}

interface SeedResult {
  readonly campaignId: string
  readonly ownerUserId: string
  readonly worldId: string
}

// `token` + `moveToDelayed` mirror the live BullMQ Job the worker hands the
// processor: the Worker stamps `job.token` before invoking it, and the park
// path calls `job.moveToDelayed(ts, token)` (llm-outage-resilience §3.1).
// Legacy tests never reach either.
function makeJob(payload: SessionPrepJobPayload): Parameters<typeof processSessionPrepJob>[1] & {
  moveToDelayed: ReturnType<typeof vi.fn>
} {
  return {
    data: payload,
    token: 'job-lock-token',
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
  }
}

interface MakeDepsOverrides {
  readonly publishEvent?: SessionPrepProcessorDeps['publishEvent']
  readonly publishProse?: SessionPrepProcessorDeps['publishProse']
}

const REDIS_KEY_PREFIX = 'test:spp:'

function makeDeps(
  pool: Pool,
  overrides: MakeDepsOverrides = {},
): SessionPrepProcessorDeps & { redisRealtime: InstanceType<typeof IoredisMock> } {
  return {
    pool,
    // The processor's only Redis use is the §3.1 pre-claim health GET —
    // ioredis-mock's shared keyspace serves it; the degraded-park test sets
    // the state key and beforeEach flushes it.
    redisRealtime: new IoredisMock(),
    redisKeyPrefix: REDIS_KEY_PREFIX,
    publishEvent: overrides.publishEvent ?? (() => Promise.resolve()),
    publishProse: overrides.publishProse ?? (() => Promise.resolve()),
  }
}

// The stage usage shape the processor reads (inputTokens/outputTokens drive
// the Opus cost). Full LanguageModelUsage shape (the token-detail fields are
// SDK-required but the processor only reads the three top-level counts).
const STAGE_USAGE = {
  inputTokens: 5000,
  outputTokens: 9000,
  totalTokens: 14000,
  inputTokenDetails: { noCacheTokens: 5000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 9000, reasoningTokens: 0 },
} as const

// Opus rates from MODEL_PRICING['claude-opus-5']: input 5.0, output 25.0
// per million. (5000*5 + 9000*25) / 1e6 = (25000 + 225000) / 1e6 = 0.25.
// MYT-101: the opening tripwire (Haiku) usage folded into the stage cost.
// Haiku rates from MODEL_PRICING: input 1.0, output 5.0 per million.
const TRIPWIRE_USAGE = {
  inputTokens: 1000,
  outputTokens: 50,
  totalTokens: 1050,
  inputTokenDetails: { noCacheTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 50, reasoningTokens: 0 },
} as const
const EXPECTED_COST_USD =
  (5000 * 5.0 + 9000 * 25.0) / 1_000_000 + (1000 * 1.0 + 50 * 5.0) / 1_000_000

// §6 — the pure verbatim-injection builder. Exercised end-to-end through the
// processor below; these direct cases pin the empty/skip arms (an NPC with an
// empty voice array is skipped; a handoff with nothing to inject returns '').
describe('buildReturningVoicesSection (MYT-74b §6)', () => {
  it('returns "" for an undefined handoff', () => {
    expect(buildReturningVoicesSection(undefined)).toBe('')
  })

  it('skips NPCs with an empty voice array and renders only voiced ones + places', () => {
    const handoff: SessionHandoff = {
      party: [],
      timeOfDay: 'dusk',
      unresolvedThreads: [],
      npcs: [
        { name: 'Silent', state: 'absent', voice: [] },
        { name: 'Voss', state: 'hostile', voice: ['You came back.'] },
      ],
      keyLocations: [{ name: 'the bilge', atmosphere: 'Salt on the wind.' }],
    }
    const out = buildReturningVoicesSection(handoff)
    expect(out).not.toContain('Silent:')
    expect(out).toContain('Voss:')
    expect(out).toContain('- "You came back."')
    expect(out).toContain('- the bilge: "Salt on the wind."')
  })

  it('returns "" when the handoff has no voiced NPCs and no key locations', () => {
    const handoff: SessionHandoff = {
      party: [{ characterName: 'Kael', location: 'here', condition: 'fine' }],
      timeOfDay: 'noon',
      unresolvedThreads: ['a thread'],
      npcs: [{ name: 'Quiet', state: 'gone', voice: [] }],
      keyLocations: [],
    }
    expect(buildReturningVoicesSection(handoff)).toBe('')
  })
})

describe('processSessionPrepJob (MYT-61 T4)', () => {
  let pool: Pool
  let scope: TestScope
  let userCounter: number

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    await runMigrations({
      pool,
      migrationsDir: REAL_MIGRATIONS_DIR,
      logger: silentLogger(),
    })
    scope = makeTestScope('sessionprepproc')
    userCounter = 0
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    vi.restoreAllMocks()
    // ioredis-mock instances share one keyspace per connection config — the
    // degraded-park test's llm-health state key must not leak into later
    // tests' health reads.
    await new IoredisMock().flushall()
    // MYT-101: default-clean opening tripwire; the breach test overrides once.
    vi.spyOn(secretTripwire, 'runSecretTripwire').mockResolvedValue({
      result: { severity: 'none', confidence: 0.95, secretRef: null },
      usage: { ...TRIPWIRE_USAGE },
      repairAttempted: false,
    })
    await cleanupTestScope(pool, scope)
  })

  // Owner user + complete world + campaign (status 'setup'). The stage is
  // stubbed, so no world entities / party seeding is needed — the processor's
  // claim/persist/mark path only reads campaigns.world_id (getWorldId).
  async function seed(): Promise<SeedResult> {
    const ownerUserId = uuidv7()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    const n = userCounter++

    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
      [ownerUserId, scope.userSub(n), scope.displayName(n), scope.username(n)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status)
       VALUES ($1, $2, $3, 'A test concept', 'complete')`,
      [worldId, ownerUserId, scope.worldName(n)],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, status)
       VALUES ($1, $2, $3, $4, 'setup')`,
      [campaignId, worldId, ownerUserId, scope.campaignName(n)],
    )

    return { campaignId, ownerUserId, worldId }
  }

  async function campaignStatus(campaignId: string): Promise<string | undefined> {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM campaigns WHERE id = $1`,
      [campaignId],
    )
    return rows[0]?.status
  }

  it('happy path: generates prep, persists session_preps, marks pipeline_runs completed, publishes prep-started then prep-ready, streams prose deltas to publishProse', async () => {
    const { campaignId } = await seed()
    // The mock now exercises the optional prose sink: a single
    // sd_playbook delta carrying a SECRET-flavored payload (the SD
    // playbook may contain plot secrets — it must ONLY ever flow to
    // publishProse, never to publishEvent).
    const stageSpy = vi
      .spyOn(sessionPrepStage, 'generateSessionPrep')
      .mockImplementationOnce((_repo, args) => {
        args.onProseDelta?.('sd_playbook', 'SECRET')
        return Promise.resolve({
          ft_context: 'FT',
          sd_playbook: 'SD',
          opening: 'OPENING '.repeat(15).trim(),
          usage: { ...STAGE_USAGE },
        })
      })

    const events: Record<string, unknown>[] = []
    const prose: Record<string, unknown>[] = []
    const processor = createSessionPrepProcessor(
      makeDeps(pool, {
        publishEvent: (cid, e) => {
          events.push({ campaignId: cid, ...e })
          return Promise.resolve()
        },
        publishProse: (cid, e) => {
          prose.push({ campaignId: cid, ...e })
          return Promise.resolve()
        },
      }),
    )
    await processor(makeJob({ campaignId, sessionNumber: 1 }))

    expect(stageSpy).toHaveBeenCalledTimes(1)

    // session_preps row persisted with the two prose artifacts.
    const preps = await pool.query<{ ft_context: string; sd_playbook: string; opening: string }>(
      `SELECT ft_context, sd_playbook, opening FROM session_preps
        WHERE campaign_id = $1 AND session_number = 1`,
      [campaignId],
    )
    expect(preps.rowCount).toBe(1)
    expect(preps.rows[0]?.ft_context).toBe('FT')
    expect(preps.rows[0]?.sd_playbook).toBe('SD')
    expect(preps.rows[0]?.opening).toBe('OPENING '.repeat(15).trim())

    // pipeline_runs row keyed on (campaign, 'session-prep:1'), user_id NULL.
    const runs = await pool.query<{ status: string; cost_usd: string }>(
      `SELECT status, cost_usd FROM pipeline_runs
        WHERE campaign_id = $1 AND stage = 'session-prep:1'
          AND user_id IS NULL`,
      [campaignId],
    )
    expect(runs.rowCount).toBe(1)
    expect(runs.rows[0]?.status).toBe('completed')
    // cost_usd is NUMERIC(10,6) → pg returns a string; compare numerically.
    expect(Number(runs.rows[0]?.cost_usd)).toBeCloseTo(EXPECTED_COST_USD, 6)

    // Phase events on publishEvent: prep-started BEFORE prep-ready.
    const startedIdx = events.findIndex((e) => e.type === 'prep-started')
    const readyIdx = events.findIndex((e) => e.type === 'prep-ready')
    expect(startedIdx).toBeGreaterThanOrEqual(0)
    expect(readyIdx).toBeGreaterThan(startedIdx)
    expect(events[startedIdx]?.sessionNumber).toBe(1)
    const ready = events[readyIdx]
    expect(ready?.sessionNumber).toBe(1)
    expect(Number(ready?.costUsd)).toBeCloseTo(EXPECTED_COST_USD, 6)

    // Prose delta lands on publishProse with the field + text payload.
    const delta = prose.find((e) => e.type === 'prep-delta')
    expect(delta).toBeDefined()
    expect(delta?.field).toBe('sd_playbook')
    expect(delta?.text).toBe('SECRET')

    // ENFORCED IGNORANCE — the player-facing channel (publishEvent) must
    // NEVER carry a prep-delta (sd_playbook prose may contain secrets), and
    // the prose channel must never carry a prep-* phase event.
    expect(events.some((e) => e.type === 'prep-delta')).toBe(false)
    expect(prose.some((e) => e.type === 'prep-started')).toBe(false)
    expect(prose.some((e) => e.type === 'prep-ready')).toBe(false)
    expect(prose.some((e) => e.type === 'prep-failed')).toBe(false)
  })

  it('type-level: publishEvent rejects a prep-delta (ProseEvent) payload — proves the channel quarantine', () => {
    const deps = makeDeps(pool)
    // The player-facing publishEvent is typed to PipelineEvent; prep-delta is
    // a ProseEvent and lives only on PROSE_SSE_EVENTS, so this MUST NOT
    // compile. The @ts-expect-error is the assertion — if the quarantine ever
    // regresses (publishEvent widened to accept prose), tsc fails on an
    // *unused* expect-error directive.
    // @ts-expect-error prep-delta is a ProseEvent, not assignable to PipelineEvent
    void deps.publishEvent('cid', { type: 'prep-delta', field: 'ft_context', text: 'x' })
    // publishProse, conversely, MUST accept it.
    void deps.publishProse('cid', { type: 'prep-delta', field: 'ft_context', text: 'x' })
  })

  it('resume: returns without generating when pipeline_runs for (campaign, session-prep:1) is already completed', async () => {
    const { campaignId } = await seed()

    // Pre-seed the per-session pipeline_runs row at 'completed' (a prior
    // successful run that BullMQ then retried). atomicClaimStage's ON CONFLICT
    // returns 'completed' → the processor no-ops.
    await pool.query(
      `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, completed_at, cost_usd, user_id)
       VALUES ($1, $2, 'session-prep:1', 'completed', now(), now(), 0.5, NULL)`,
      [uuidv7(), campaignId],
    )

    const stageSpy = vi
      .spyOn(sessionPrepStage, 'generateSessionPrep')
      .mockImplementation(() => {
        throw new Error('stage must not be called on resume')
      })
    const events: Record<string, unknown>[] = []
    const prose: Record<string, unknown>[] = []

    await processSessionPrepJob(
      makeDeps(pool, {
        publishEvent: (cid, e) => {
          events.push({ campaignId: cid, ...e })
          return Promise.resolve()
        },
        publishProse: (cid, e) => {
          prose.push({ campaignId: cid, ...e })
          return Promise.resolve()
        },
      }),
      makeJob({ campaignId, sessionNumber: 1 }),
    )

    expect(stageSpy).not.toHaveBeenCalled()
    // The no-op path publishes nothing on either channel.
    expect(events).toHaveLength(0)
    expect(prose).toHaveLength(0)
    // No session_preps row was written by the no-op path.
    const preps = await pool.query(
      `SELECT 1 FROM session_preps WHERE campaign_id = $1 AND session_number = 1`,
      [campaignId],
    )
    expect(preps.rowCount).toBe(0)
  })

  it('MYT-101: a hard_reveal opening fails the stage (retryable) and persists NOTHING', async () => {
    const { campaignId } = await seed()
    vi.spyOn(sessionPrepStage, 'generateSessionPrep').mockResolvedValueOnce({
      ft_context: 'FT',
      sd_playbook: 'SD with a core secret',
      opening: 'o'.repeat(120),
      usage: { ...STAGE_USAGE },
    })
    vi.spyOn(secretTripwire, 'runSecretTripwire').mockResolvedValueOnce({
      result: { severity: 'hard_reveal', confidence: 0.4, secretRef: 'npc:prioress' },
      usage: { ...TRIPWIRE_USAGE },
      repairAttempted: false,
    })
    const events: Record<string, unknown>[] = []

    await expect(
      processSessionPrepJob(
        makeDeps(pool, {
          publishEvent: (cid, e) => {
            events.push({ campaignId: cid, ...e })
            return Promise.resolve()
          },
        }),
        makeJob({ campaignId, sessionNumber: 1 }),
      ),
    ).rejects.toThrow(/tripwire/)

    // The opening gate stays STRICT (myth-retprop): any non-clean severity fails.
    const runs = await pool.query<{ status: string }>(
      `SELECT status FROM pipeline_runs
        WHERE campaign_id = $1 AND stage = 'session-prep:1' AND user_id IS NULL`,
      [campaignId],
    )
    expect(runs.rows[0]?.status).toBe('failed')
    const failed = events.find((e) => e.type === 'prep-failed')
    expect(failed?.terminal).toBe(false)
    // A tripped opening is NEVER persisted — the whole prep row is withheld.
    const preps = await pool.query(
      `SELECT 1 FROM session_preps WHERE campaign_id = $1 AND session_number = 1`,
      [campaignId],
    )
    expect(preps.rowCount).toBe(0)
  })

  it('MYT-101: a hard_reveal opening with a NULL secretRef formats the failure as ref none', async () => {
    const { campaignId } = await seed()
    vi.spyOn(sessionPrepStage, 'generateSessionPrep').mockResolvedValueOnce({
      ft_context: 'FT',
      sd_playbook: 'SD',
      opening: 'o'.repeat(120),
      usage: { ...STAGE_USAGE },
    })
    vi.spyOn(secretTripwire, 'runSecretTripwire').mockResolvedValueOnce({
      result: { severity: 'hard_reveal', confidence: 0.9, secretRef: null },
      usage: { ...TRIPWIRE_USAGE },
      repairAttempted: false,
    })
    await expect(
      processSessionPrepJob(makeDeps(pool), makeJob({ campaignId, sessionNumber: 1 })),
    ).rejects.toThrow(/ref none/)
  })

  it('MYT-101 / myth-retprop: a soft_consistency opening ALSO fails the strict prep gate', async () => {
    const { campaignId } = await seed()
    vi.spyOn(sessionPrepStage, 'generateSessionPrep').mockResolvedValueOnce({
      ft_context: 'FT',
      sd_playbook: 'SD with a core secret',
      opening: 'o'.repeat(120),
      usage: { ...STAGE_USAGE },
    })
    vi.spyOn(secretTripwire, 'runSecretTripwire').mockResolvedValueOnce({
      result: { severity: 'soft_consistency', confidence: 0.6, secretRef: '[SECRET-1]' },
      usage: { ...TRIPWIRE_USAGE },
      repairAttempted: false,
    })
    // Unlike the per-turn path (where soft_consistency is tolerated and steered
    // silently), the once-generated opening is simply REGENERATED rather than
    // shipped with a secret-adjacent brush — so any non-clean severity throws.
    await expect(
      processSessionPrepJob(makeDeps(pool), makeJob({ campaignId, sessionNumber: 1 })),
    ).rejects.toThrow(/tripwire/)
    const preps = await pool.query(
      `SELECT 1 FROM session_preps WHERE campaign_id = $1 AND session_number = 1`,
      [campaignId],
    )
    expect(preps.rowCount).toBe(0)
  })

  it('non-terminal failure: marks pipeline_runs failed, publishes prep-failed{terminal:false}, RETHROWS, leaves campaign status unchanged', async () => {
    const { campaignId } = await seed()
    vi.spyOn(sessionPrepStage, 'generateSessionPrep').mockRejectedValueOnce(
      new LlmRateLimitedError('upstream 429'),
    )
    const events: Record<string, unknown>[] = []

    await expect(
      processSessionPrepJob(
        makeDeps(pool, {
          publishEvent: (cid, e) => {
            events.push({ campaignId: cid, ...e })
            return Promise.resolve()
          },
        }),
        makeJob({ campaignId, sessionNumber: 1 }),
      ),
    ).rejects.toBeInstanceOf(LlmRateLimitedError)

    const runs = await pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM pipeline_runs
        WHERE campaign_id = $1 AND stage = 'session-prep:1'
          AND user_id IS NULL`,
      [campaignId],
    )
    expect(runs.rows[0]?.status).toBe('failed')
    // The `message` local still feeds markStageFailed({error}); only the
    // published payload dropped it in favor of {sessionNumber, terminal}.
    expect(runs.rows[0]?.error).toBe('upstream 429')

    const failed = events.find((e) => e.type === 'prep-failed')
    expect(failed).toBeDefined()
    expect(failed?.sessionNumber).toBe(1)
    expect(failed?.terminal).toBe(false)

    // A prep failure must NOT fail the campaign.
    expect(await campaignStatus(campaignId)).toBe('setup')
  })

  it('terminal failure: marks pipeline_runs failed, publishes prep-failed{terminal:true}, does NOT rethrow, leaves campaign status unchanged', async () => {
    const { campaignId } = await seed()
    vi.spyOn(sessionPrepStage, 'generateSessionPrep').mockRejectedValueOnce(
      new LlmStructuredOutputError('schema repair chain exhausted'),
    )
    const events: Record<string, unknown>[] = []

    // Terminal errors must NOT rethrow (no BullMQ retry).
    await expect(
      processSessionPrepJob(
        makeDeps(pool, {
          publishEvent: (cid, e) => {
            events.push({ campaignId: cid, ...e })
            return Promise.resolve()
          },
        }),
        makeJob({ campaignId, sessionNumber: 1 }),
      ),
    ).resolves.toBeUndefined()

    const runs = await pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM pipeline_runs
        WHERE campaign_id = $1 AND stage = 'session-prep:1'
          AND user_id IS NULL`,
      [campaignId],
    )
    expect(runs.rows[0]?.status).toBe('failed')
    expect(runs.rows[0]?.error).toBe('schema repair chain exhausted')

    const failed = events.find((e) => e.type === 'prep-failed')
    expect(failed).toBeDefined()
    expect(failed?.sessionNumber).toBe(1)
    expect(failed?.terminal).toBe(true)

    // CRITICAL: a TERMINAL prep failure must still NOT fail the campaign —
    // unlike character-integration, prep is session-scoped.
    expect(await campaignStatus(campaignId)).toBe('setup')
  })

  // §6 — a prior ended session's handoff carries verbatim NPC voice +
  // location atmosphere. The processor must deterministically APPEND those
  // excerpts to ft_context (NEVER paraphrase them through the prep LLM). We
  // seed a real ended session with analysis, stub the stage (so `ft_context`
  // is a known prefix), and assert the persisted ftContext ends with the
  // verbatim "Returning characters and places" section BYTE-IDENTICAL.
  it('appends the verbatim returning-voices section (handoff voice + atmosphere) to the persisted ftContext', async () => {
    const { campaignId } = await seed()

    const handoff: SessionHandoff = {
      party: [{ characterName: 'Kael', location: 'the bilge', condition: 'bleeding' }],
      timeOfDay: 'just before dawn',
      unresolvedThreads: ['the smuggled crate'],
      npcs: [{ name: 'Voss', state: 'hostile', voice: ['You came back.'] }],
      keyLocations: [{ name: 'the bilge', atmosphere: 'Salt on the wind.' }],
    }
    const sessions = createSessionsRepo(pool)
    const prior = await sessions.create({ campaignId, sessionNumber: 1 })
    await sessions.markEnded(prior.id)
    await sessions.writeAnalysis(prior.id, {
      summary: 'The party fled the docks.',
      emergingThreads: ['the missing crate'],
      handoff,
    })

    vi.spyOn(sessionPrepStage, 'generateSessionPrep').mockResolvedValue({
      ft_context: 'GENERATED FT',
      sd_playbook: 'SD',
      opening: 'o'.repeat(120),
      usage: { ...STAGE_USAGE },
    })

    const processor = createSessionPrepProcessor(makeDeps(pool))
    await processor(makeJob({ campaignId, sessionNumber: 2 }))

    const preps = await pool.query<{ ft_context: string }>(
      `SELECT ft_context FROM session_preps WHERE campaign_id = $1 AND session_number = 2`,
      [campaignId],
    )
    expect(preps.rowCount).toBe(1)
    const ftContext = preps.rows[0]?.ft_context ?? ''
    // The persisted ft_context = the generated prefix + the EXACT section the
    // pure builder produces for this handoff (byte-identical concatenation).
    const expectedSection = buildReturningVoicesSection(handoff)
    expect(ftContext).toBe('GENERATED FT' + expectedSection)
    // And the section verbatim-carries the voice + atmosphere strings.
    expect(ftContext.endsWith(expectedSection)).toBe(true)
    expect(ftContext).toContain('Returning characters and places')
    expect(ftContext).toContain('- "You came back."')
    expect(ftContext).toContain('- the bilge: "Salt on the wind."')
  })

  it('leaves ftContext unchanged (no trailing section) when there are NO prior ended sessions', async () => {
    const { campaignId } = await seed()
    // No prior sessions seeded → getPriorContextForPrep returns [] → no handoff
    // → buildReturningVoicesSection('') → ftContext === the generated value.
    vi.spyOn(sessionPrepStage, 'generateSessionPrep').mockResolvedValue({
      ft_context: 'GENERATED FT',
      sd_playbook: 'SD',
      opening: 'o'.repeat(120),
      usage: { ...STAGE_USAGE },
    })

    const processor = createSessionPrepProcessor(makeDeps(pool))
    await processor(makeJob({ campaignId, sessionNumber: 1 }))

    const preps = await pool.query<{ ft_context: string }>(
      `SELECT ft_context FROM session_preps WHERE campaign_id = $1 AND session_number = 1`,
      [campaignId],
    )
    expect(preps.rows[0]?.ft_context).toBe('GENERATED FT')
    expect(preps.rows[0]?.ft_context).not.toContain('Returning characters and places')
  })

  it('ON CONFLICT idempotency: running the happy path twice for (campaign,1) leaves exactly one session_preps row', async () => {
    const { campaignId } = await seed()
    vi.spyOn(sessionPrepStage, 'generateSessionPrep').mockResolvedValue({
      ft_context: 'FT',
      sd_playbook: 'SD',
      opening: 'o'.repeat(120),
      usage: { ...STAGE_USAGE },
    })

    const processor = createSessionPrepProcessor(makeDeps(pool))
    await processor(makeJob({ campaignId, sessionNumber: 1 }))
    // Second run: the pipeline_runs row is now 'completed', so atomicClaimStage
    // returns 'completed' and the processor no-ops — but even if it generated
    // again, the session_preps ON CONFLICT DO NOTHING keeps a single row.
    await processor(makeJob({ campaignId, sessionNumber: 1 }))

    const preps = await pool.query(
      `SELECT 1 FROM session_preps WHERE campaign_id = $1 AND session_number = 1`,
      [campaignId],
    )
    expect(preps.rowCount).toBe(1)
  })

  // ------------------------------------------------------------------
  // llm-outage-resilience §3.1 — parking parity (Task 9). Mirrors the
  // world-gen reference: a park-eligible (connectivity / rate-limit via the
  // ai.ts-attached llmFailureClass), non-terminal failure with park budget
  // remaining marks the stage row failed AS TODAY (claimable on wake),
  // stamps llm_resume_stamps (pipeline 'session_prep', entity_id =
  // campaignId — the BINDING contract the promote scan codes against),
  // publishes prep-failed{terminal:false, failureClass}, then self-delays
  // via job.moveToDelayed + DelayedError. The campaign row NEVER flips.
  // ------------------------------------------------------------------
  describe('parking (llm-outage-resilience §3.1 — Task 9 parity)', () => {
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000

    // The park predicate reads the `llmFailureClass` property ai.ts attaches
    // to every classified error it surfaces (Task 4 contract). The stage spy
    // bypasses ai.ts, so the hand-attached class survives to the processor.
    function classedError(
      llmFailureClass: 'connectivity' | 'rate-limit' | 'abort' | 'other',
      opts: { terminal?: boolean } = {},
    ): Error {
      return Object.assign(new Error(`upstream failure (${llmFailureClass})`), {
        llmFailureClass,
        ...(opts.terminal === true ? { terminal: true } : {}),
      })
    }

    function stageThrows(err: Error): void {
      vi.spyOn(sessionPrepStage, 'generateSessionPrep').mockRejectedValueOnce(err)
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
           FROM llm_resume_stamps WHERE pipeline = 'session_prep' AND entity_id = $1`,
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
         VALUES ('session_prep', $1, $2, $3, $4, 'connectivity')`,
        [campaignId, s.attempt, s.nextResumeAt, s.consumedMs],
      )
    }

    it('parks a connectivity failure: stamp + failed row + DelayedError, campaign untouched', async () => {
      const { campaignId } = await seed()
      stageThrows(classedError('connectivity'))
      const events: Record<string, unknown>[] = []
      const deps = makeDeps(pool, {
        publishEvent: (cid, e) => {
          events.push({ campaignId: cid, ...e })
          return Promise.resolve()
        },
      })
      const job = makeJob({ campaignId, sessionNumber: 1 })
      const before = Date.now()
      // Explicit worker token (the 3rd processor arg) takes precedence.
      await expect(processSessionPrepJob(deps, job, 'worker-token')).rejects.toBeInstanceOf(
        DelayedError,
      )

      // First park: rung 1 armed 30s out, 30s of budget consumed.
      const stamp = await readStamp(campaignId)
      expect(stamp).not.toBeNull()
      expect(stamp?.resume_attempt).toBe(1)
      expect(stamp?.last_error_class).toBe('connectivity')
      expect(Number(stamp?.park_consumed_ms)).toBe(30_000)
      expect(stamp?.next_resume_at).not.toBeNull()

      // The stage row failed AS TODAY — claimable on wake (no stage skip).
      const run = await pool.query<{ status: string }>(
        `SELECT status FROM pipeline_runs
          WHERE campaign_id = $1 AND stage = 'session-prep:1' AND user_id IS NULL`,
        [campaignId],
      )
      expect(run.rows[0]?.status).toBe('failed')

      // A prep park never touches the campaign (prep never does — pinned).
      expect(await campaignStatus(campaignId)).toBe('setup')

      // Self-delay: same job, ~30s out, under the worker's lock token.
      expect(job.moveToDelayed).toHaveBeenCalledTimes(1)
      const [ts, token] = job.moveToDelayed.mock.calls[0] as [number, string]
      expect(token).toBe('worker-token')
      expect(ts).toBeGreaterThanOrEqual(before + 30_000)
      expect(ts).toBeLessThan(before + 40_000)

      // prep-failed carries the additive class hint; terminal stays false.
      const failed = events.find((e) => e.type === 'prep-failed')
      expect(failed?.terminal).toBe(false)
      expect(failed?.failureClass).toBe('connectivity')

      // Publish precedes the self-delay (spec step 3 ordering).
      expect(events.length).toBeGreaterThan(0)
    })

    it('parks a rate-limit failure, falling back to job.token when no worker token is threaded', async () => {
      const { campaignId } = await seed()
      stageThrows(classedError('rate-limit'))
      const deps = makeDeps(pool)
      const job = makeJob({ campaignId, sessionNumber: 1 })
      await expect(processSessionPrepJob(deps, job)).rejects.toBeInstanceOf(DelayedError)

      const stamp = await readStamp(campaignId)
      expect(stamp?.last_error_class).toBe('rate-limit')
      const [, token] = job.moveToDelayed.mock.calls[0] as [number, string | undefined]
      expect(token).toBe('job-lock-token')
    })

    it('degraded park consumes no budget (sitewide outage already known → consume:false)', async () => {
      const { campaignId } = await seed()
      stageThrows(classedError('connectivity'))
      const deps = makeDeps(pool)
      // The tracker reads `${keyPrefix}llm-health:state` — present ⇔ degraded.
      await deps.redisRealtime.set(
        `${REDIS_KEY_PREFIX}llm-health:state`,
        JSON.stringify({ since: Date.now() }),
      )
      await expect(
        processSessionPrepJob(deps, makeJob({ campaignId, sessionNumber: 1 })),
      ).rejects.toBeInstanceOf(DelayedError)

      const stamp = await readStamp(campaignId)
      expect(stamp?.resume_attempt).toBe(1)
      expect(Number(stamp?.park_consumed_ms)).toBe(0)
      expect(stamp?.next_resume_at).not.toBeNull()
    })

    it('re-park climbs the ladder: attempt 1 → 2 delays 120s and accumulates the budget', async () => {
      const { campaignId } = await seed()
      // A prior park whose wake claimed (next_resume_at cleared) then failed
      // connectivity again — the surviving rung/budget fields drive rung 2.
      await seedStamp(campaignId, { attempt: 1, consumedMs: 30_000, nextResumeAt: null })
      stageThrows(classedError('connectivity'))
      const deps = makeDeps(pool)
      const job = makeJob({ campaignId, sessionNumber: 1 })
      const before = Date.now()
      await expect(processSessionPrepJob(deps, job)).rejects.toBeInstanceOf(DelayedError)

      const stamp = await readStamp(campaignId)
      expect(stamp?.resume_attempt).toBe(2)
      expect(Number(stamp?.park_consumed_ms)).toBe(150_000)
      const [ts] = job.moveToDelayed.mock.calls[0] as [number]
      expect(ts).toBeGreaterThanOrEqual(before + 120_000)
      expect(ts).toBeLessThan(before + 130_000)
    })

    it("exhausted budget falls through to today's failed path exactly (retryable rethrow)", async () => {
      const { campaignId } = await seed()
      await seedStamp(campaignId, { attempt: 4, consumedMs: SIX_HOURS_MS, nextResumeAt: null })
      const err = classedError('connectivity')
      stageThrows(err)
      const events: Record<string, unknown>[] = []
      const deps = makeDeps(pool, {
        publishEvent: (cid, e) => {
          events.push({ campaignId: cid, ...e })
          return Promise.resolve()
        },
      })
      const job = makeJob({ campaignId, sessionNumber: 1 })
      // Non-terminal → rethrow so BullMQ's own retry policy fires, as today.
      await expect(processSessionPrepJob(deps, job)).rejects.toBe(err)

      expect(job.moveToDelayed).not.toHaveBeenCalled()
      const failed = events.find((e) => e.type === 'prep-failed')
      expect(failed?.terminal).toBe(false)
      // The spent stamp is untouched (clearStamp is completion's / the manual
      // retry route's job — the fresh-episode arm).
      const stamp = await readStamp(campaignId)
      expect(Number(stamp?.park_consumed_ms)).toBe(SIX_HOURS_MS)
    })

    it("a non-park-eligible class ('abort') keeps today's behavior — no stamp, no delay", async () => {
      const { campaignId } = await seed()
      const err = classedError('abort')
      stageThrows(err)
      const job = makeJob({ campaignId, sessionNumber: 1 })
      await expect(processSessionPrepJob(makeDeps(pool), job)).rejects.toBe(err)
      expect(job.moveToDelayed).not.toHaveBeenCalled()
      expect(await readStamp(campaignId)).toBeNull()
    })

    it('a TERMINAL error never parks even when park-eligible by class (re-entry rule stands)', async () => {
      const { campaignId } = await seed()
      stageThrows(classedError('connectivity', { terminal: true }))
      const job = makeJob({ campaignId, sessionNumber: 1 })
      // Terminal → today's clean stop (no BullMQ rethrow).
      await expect(processSessionPrepJob(makeDeps(pool), job)).resolves.toBeUndefined()
      expect(job.moveToDelayed).not.toHaveBeenCalled()
      expect(await readStamp(campaignId)).toBeNull()
    })

    it('claim success clears next_resume_at; rung + budget fields SURVIVE the claim', async () => {
      const { campaignId } = await seed()
      await seedStamp(campaignId, {
        attempt: 2,
        consumedMs: 150_000,
        nextResumeAt: new Date(Date.now() + 60_000),
      })
      // The wake claims, then fails on a NON-park class (plain Error) — the
      // stamp row itself survives with the resume disarmed.
      const err = new Error('plain non-terminal failure')
      stageThrows(err)
      await expect(
        processSessionPrepJob(makeDeps(pool), makeJob({ campaignId, sessionNumber: 1 })),
      ).rejects.toBe(err)

      const stamp = await readStamp(campaignId)
      expect(stamp).not.toBeNull()
      expect(stamp?.next_resume_at).toBeNull()
      expect(stamp?.resume_attempt).toBe(2)
      expect(Number(stamp?.park_consumed_ms)).toBe(150_000)
    })

    it('stage COMPLETION clears the stamp (fresh episode budget once the outage passes)', async () => {
      const { campaignId } = await seed()
      await seedStamp(campaignId, {
        attempt: 3,
        consumedMs: 450_000,
        nextResumeAt: new Date(Date.now() + 60_000),
      })
      vi.spyOn(sessionPrepStage, 'generateSessionPrep').mockResolvedValueOnce({
        ft_context: 'FT',
        sd_playbook: 'SD',
        opening: 'o'.repeat(120),
        usage: { ...STAGE_USAGE },
      })
      await processSessionPrepJob(makeDeps(pool), makeJob({ campaignId, sessionNumber: 1 }))
      expect(await readStamp(campaignId)).toBeNull()
    })

    it('the processor STOPS on an in-flight stage (retryable rethrow — never a silent skip)', async () => {
      const { campaignId } = await seed()
      // A live (not-stuck) session-prep:1 row — e.g. BullMQ's stall handling
      // re-drove a dead worker's job while the stage genuinely runs elsewhere.
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, user_id)
         VALUES ($1, $2, 'session-prep:1', 'running', now(), NULL)`,
        [uuidv7(), campaignId],
      )
      const stageSpy = vi.spyOn(sessionPrepStage, 'generateSessionPrep').mockImplementation(() => {
        throw new Error('stage must not run past an in-flight claim')
      })
      const events: Record<string, unknown>[] = []
      await expect(
        processSessionPrepJob(
          makeDeps(pool, {
            publishEvent: (cid, e) => {
              events.push({ campaignId: cid, ...e })
              return Promise.resolve()
            },
          }),
          makeJob({ campaignId, sessionNumber: 1 }),
        ),
      ).rejects.toMatchObject({ code: 'stage_in_flight' })
      expect(stageSpy).not.toHaveBeenCalled()
      expect(events).toHaveLength(0)
    })
  })
})
