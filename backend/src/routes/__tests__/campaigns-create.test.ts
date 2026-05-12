// backend/src/routes/__tests__/campaigns-create.test.ts
//
// MYT-51 Task 9. Integration tests for POST /api/campaigns.
//
// Real Postgres (so migration 004's credit_ledger CHECK constraints
// genuinely fire), ioredis-mock for the rejection-storm counter, and a
// hand-rolled BullMQ Queue spy for the enqueue surface. Anthropic-backed
// modules (`synthesizeConcept`, `runInputGate`) are mocked at the module
// boundary so we control the happy / reject branching deterministically.
//
// Pattern mirrors dev-credits.test.ts (bypassPlugin + requireOnboarded +
// the route plugin) rather than buildApp — keeps the dependency surface
// tight to what T9 actually touches.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import IoredisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { bypassPlugin } from '../../auth/bypass-plugin.js'
import { requireOnboarded } from '../../auth/require-onboarded.js'
import { campaignsRoutes } from '../campaigns.js'
import type { PipelineSubscriber } from '../../sse/pipeline-subscriber.js'
import type { ConnectionCounter } from '../../sse/connection-counter.js'
import type { WorldGenQueueLike } from '../campaigns.js'

// --- Module mocks ---------------------------------------------------------
//
// The Anthropic-backed prep modules are mocked at the module boundary.
// Each test overrides the mock return for the call shape it cares about.

vi.mock('../../llm/prep/synthesize-concept.js', () => ({
  synthesizeConcept: vi.fn(),
}))
vi.mock('../../llm/prep/input-gate.js', () => ({
  runInputGate: vi.fn(),
}))

// Re-import after vi.mock so the test uses the stub.
import { synthesizeConcept } from '../../llm/prep/synthesize-concept.js'
import { runInputGate } from '../../llm/prep/input-gate.js'
import type { LanguageModelUsage } from 'ai'

const synthesizeConceptMock = vi.mocked(synthesizeConcept)
const runInputGateMock = vi.mocked(runInputGate)

// Reusable stub usage object — the route doesn't read this, so a
// shape-correct placeholder satisfies the strict LanguageModelUsage type.
const STUB_USAGE: LanguageModelUsage = {
  inputTokens: 10,
  outputTokens: 10,
  totalTokens: 20,
  inputTokenDetails: {
    noCacheTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokenDetails: {
    textTokens: 10,
    reasoningTokens: 0,
  },
}

// --- Test harness ---------------------------------------------------------

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')
const REDIS_KEY_PREFIX = `test:campaigns-create-${String(Date.now())}:`

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: (): void => {
      // discard log output
    },
  }
  return pino({ base: { component: 'migrate' } }, sink)
}

// Minimal stand-ins for the SSE machinery — campaignsRoutes accepts
// these in its Opts but the create route doesn't touch them. Keep them
// type-correct, no-op at runtime.
function noopSubscriber(): PipelineSubscriber {
  return {
    attach: () => () => {
      /* no-op */
    },
    close: () => Promise.resolve(),
  } as unknown as PipelineSubscriber
}
function noopCounter(): ConnectionCounter {
  return {
    increment: () => {
      /* no-op */
    },
    decrement: () => {
      /* no-op */
    },
    startPeriodicLog: () => () => {
      /* no-op */
    },
  } as unknown as ConnectionCounter
}

// Hand-rolled queue spy. The route only touches .add() + .getJobCounts().
// The test pre-populates `jobCounts` to drive the queue-depth guard and
// records every .add() call.
interface QueueSpy {
  readonly queue: WorldGenQueueLike
  readonly add: ReturnType<typeof vi.fn>
  setJobCounts(counts: number): void
}

function createQueueSpy(): QueueSpy {
  let jobCounts = 0
  const add = vi.fn().mockResolvedValue({ id: 'stub-job' })
  const getJobCounts = vi.fn<(states: readonly string[]) => Promise<Record<string, number>>>(
    () => {
      // BullMQ returns an object keyed by state; the route sums values.
      return Promise.resolve({ waiting: jobCounts, active: 0, delayed: 0 })
    },
  )
  const queue = {
    add,
    getJobCounts,
  } as unknown as WorldGenQueueLike
  return {
    queue,
    add,
    setJobCounts: (counts: number): void => {
      jobCounts = counts
    },
  }
}

interface SeededUser {
  readonly userId: string
  readonly devSub: string
}

async function seedUserWithCredits(pool: Pool, credits: number): Promise<SeededUser> {
  const userId = uuidv7()
  const devSub = `bypass:create-${userId.slice(-6)}`
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, devSub, 'CreateTest', `ct${userId.slice(-6)}`],
  )
  if (credits > 0) {
    await pool.query(
      `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type, source_id)
       VALUES ($1, $2, 'world_gen', $3, 'gift', NULL)`,
      [uuidv7(), userId, credits],
    )
  }
  return { userId, devSub }
}

async function buildTestApp(
  pool: Pool,
  redis: Redis,
  queueSpy: QueueSpy,
): Promise<FastifyInstance> {
  // bypassPlugin's Layer 2b probes the ECS metadata endpoint and requires
  // it to FAIL — replace fetch with a guaranteed-reject stub.
  globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))

  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, {
    global: false,
    max: 1000,
    timeWindow: '1 minute',
  })
  await app.register(bypassPlugin)
  await app.register(requireOnboarded, { pool })
  await app.register(campaignsRoutes, {
    pool,
    subscriber: noopSubscriber(),
    counter: noopCounter(),
    redis,
    redisKeyPrefix: REDIS_KEY_PREFIX,
    worldGenQueue: queueSpy.queue,
  })
  await app.ready()
  return app
}

describe('POST /api/campaigns (MYT-51 T9)', () => {
  let pool: Pool
  let redis: Redis
  let queueSpy: QueueSpy
  let app: FastifyInstance

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
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'test')

    // ioredis-mock is per-test so the rejection-storm counter starts at 0.
    // ioredis-mock's default export is class-shaped against the runtime
    // Redis interface; TS infers the cast as unnecessary because the
    // declared types overlap. Use a plain assignment.
    redis = new IoredisMock()
    queueSpy = createQueueSpy()

    synthesizeConceptMock.mockReset()
    runInputGateMock.mockReset()
    // Default to "allow" — most tests are happy-path.
    runInputGateMock.mockResolvedValue({
      verdict: 'allow',
      reason: null,
      rejectionMessage: null,
      reasoning: '',
      usage: STUB_USAGE,
    })

    // FK order matters: child tables before parents.
    await pool.query('DELETE FROM pipeline_runs')
    await pool.query('DELETE FROM campaign_members')
    await pool.query('DELETE FROM campaign_invites')
    await pool.query('DELETE FROM campaigns')
    await pool.query('DELETE FROM worlds')
    await pool.query('DELETE FROM credit_ledger')
    await pool.query("DELETE FROM users WHERE cognito_sub != 'system:mythrun'")

    app = await buildTestApp(pool, redis, queueSpy)
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })

  // -----------------------------------------------------------------------
  // Happy paths
  // -----------------------------------------------------------------------

  describe('happy path', () => {
    it('201 freeform: returns campaignId, debits ledger, seeds pipeline_runs, enqueues job', async () => {
      const { userId, devSub } = await seedUserWithCredits(pool, 1)
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: 'The Drowned Hills',
          world: {
            kind: 'new',
            source: {
              mode: 'freeform',
              concept:
                'A coastal kingdom where the tide goes out and never returns; the seabed becomes the new frontier.',
            },
          },
        },
      })
      expect(res.statusCode).toBe(201)
      const body = res.json<{ campaignId: string; worldId?: string }>()
      expect(body.campaignId).toMatch(/^[0-9a-f-]{36}$/)
      // Phoenix-Min7: worldId NOT in response.
      expect(body.worldId).toBeUndefined()

      // Ledger: starting +1 (gift), -1 (debit) — net 0.
      const ledger = await pool.query<{ amount: string; source_type: string }>(
        `SELECT amount::text AS amount, source_type FROM credit_ledger
         WHERE user_id = $1 ORDER BY granted_at ASC`,
        [userId],
      )
      expect(ledger.rows).toHaveLength(2)
      expect(Number(ledger.rows[1]?.amount)).toBe(-1)
      expect(ledger.rows[1]?.source_type).toBe('debit')

      // Seeded pipeline_runs row.
      const runs = await pool.query<{
        stage: string
        status: string
        started_at: string | null
      }>(
        `SELECT pipeline_runs.stage, pipeline_runs.status, pipeline_runs.started_at
           FROM pipeline_runs
           JOIN campaigns ON pipeline_runs.world_id = campaigns.world_id
          WHERE campaigns.id = $1`,
        [body.campaignId],
      )
      expect(runs.rows).toHaveLength(1)
      expect(runs.rows[0]?.stage).toBe('concept_intake')
      expect(runs.rows[0]?.status).toBe('pending')
      expect(runs.rows[0]?.started_at).toBeNull()

      // Owner membership row.
      const members = await pool.query<{ role: string }>(
        `SELECT role FROM campaign_members WHERE campaign_id = $1 AND user_id = $2`,
        [body.campaignId, userId],
      )
      expect(members.rows[0]?.role).toBe('owner')

      // Enqueued via the queue spy.
      expect(queueSpy.add).toHaveBeenCalledTimes(1)
      const [name, data, opts] = queueSpy.add.mock.calls[0] as [
        string,
        { campaignId: string },
        { jobId: string },
      ]
      expect(name).toBe('world-gen')
      expect(data).toEqual({ campaignId: body.campaignId })
      expect(opts.jobId).toBe(body.campaignId)

      // Synthesizer NOT called on freeform path.
      expect(synthesizeConceptMock).not.toHaveBeenCalled()
    })

    it('201 guided: synthesizer ran; concept stored on worlds is the synthesized one', async () => {
      const { devSub } = await seedUserWithCredits(pool, 1)
      const synthesizedConcept =
        'A rain-soaked archipelago where lighthouses are sentient and remember every shipwreck they have ever witnessed.'
      synthesizeConceptMock.mockResolvedValue({
        concept: synthesizedConcept,
        intentSummary: {
          aesthetics: ['rain', 'salt'],
          themes: ['memory'],
          sourcesInternal: ['internal-pick-1', 'internal-pick-2', 'internal-pick-3'],
        },
        usage: STUB_USAGE,
      })

      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: 'Lighthouse Chronicles',
          world: {
            kind: 'new',
            source: {
              mode: 'guided',
              picks: [
                { title: 'Studio Ghibli films', whyILikeIt: 'gentle melancholy and wind' },
                { title: 'Old maritime journals', whyILikeIt: 'isolation and salt' },
                { title: 'Stories about memory', whyILikeIt: 'what things remember' },
              ],
            },
          },
        },
      })
      expect(res.statusCode).toBe(201)
      const body = res.json<{ campaignId: string }>()

      expect(synthesizeConceptMock).toHaveBeenCalledTimes(1)
      // The gate received the synthesized concept + intentSummary
      // (verifying the downstream wiring matches Roc-Imp7 / D5).
      expect(runInputGateMock).toHaveBeenCalledTimes(1)
      const gateArgs = runInputGateMock.mock.calls[0]?.[0]
      expect(gateArgs?.concept).toBe(synthesizedConcept)
      expect(gateArgs?.intentSummary).not.toBeNull()

      // The world row stores the SYNTHESIZED concept (not the picks).
      const worlds = await pool.query<{ concept: string }>(
        `SELECT concept FROM worlds
         WHERE id = (SELECT world_id FROM campaigns WHERE id = $1)`,
        [body.campaignId],
      )
      expect(worlds.rows[0]?.concept).toBe(synthesizedConcept)
    })
  })

  // -----------------------------------------------------------------------
  // Gate rejections (422)
  // -----------------------------------------------------------------------

  describe('gate rejection (422)', () => {
    it.each(['srd_incompat', 'clone_intent', 'inappropriate'] as const)(
      '422 with reason=%s',
      async (reason) => {
      const { userId, devSub } = await seedUserWithCredits(pool, 1)
      runInputGateMock.mockResolvedValue({
        verdict: 'reject',
        reason,
        rejectionMessage: 'The proposed concept does not fit the rules.',
        reasoning: `${reason}: detailed server-only reasoning`,
        usage: STUB_USAGE,
      })
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: 'X',
          world: {
            kind: 'new',
            source: {
              mode: 'freeform',
              concept: 'A perfectly fine concept that the mock gate will reject anyway.',
            },
          },
        },
      })
      expect(res.statusCode).toBe(422)
      const body = res.json<{
        code: string
        reason: string
        rejectionMessage: string
        synthesizedConcept?: string
        reasoning?: string
      }>()
      expect(body.code).toBe('concept_rejected')
      expect(body.reason).toBe(reason)
      expect(body.rejectionMessage).toBe('The proposed concept does not fit the rules.')
      // Roc-Imp6: reasoning is server-side only, never in response.
      expect(body.reasoning).toBeUndefined()
      // synthesizedConcept is absent on freeform-mode rejections.
      expect(body.synthesizedConcept).toBeUndefined()

      // No debit happened.
      const balance = await pool.query<{ balance: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS balance FROM credit_ledger
         WHERE user_id = $1 AND credit_type = 'world_gen'`,
        [userId],
      )
      expect(Number(balance.rows[0]?.balance)).toBe(1)
      // No campaign / world row.
      const c = await pool.query(`SELECT id FROM campaigns WHERE created_by = $1`, [userId])
      expect(c.rows).toHaveLength(0)
      },
    )

    it('422 guided-mode rejection includes synthesizedConcept', async () => {
      const { devSub } = await seedUserWithCredits(pool, 1)
      const synth =
        'A clockwork bureaucracy of mountain-monks whose ledgers track every promise ever broken.'
      synthesizeConceptMock.mockResolvedValue({
        concept: synth,
        intentSummary: {
          aesthetics: ['ink'],
          themes: ['promise'],
          sourcesInternal: ['internal'],
        },
        usage: STUB_USAGE,
      })
      runInputGateMock.mockResolvedValue({
        verdict: 'reject',
        reason: 'clone_intent',
        rejectionMessage: 'This reads as a clone of a copyrighted work.',
        reasoning: 'clone_intent: ...',
        usage: STUB_USAGE,
      })

      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: 'Bureaucracy',
          world: {
            kind: 'new',
            source: {
              mode: 'guided',
              picks: [
                { title: 'Pick A', whyILikeIt: 'reason A' },
                { title: 'Pick B', whyILikeIt: 'reason B' },
                { title: 'Pick C', whyILikeIt: 'reason C' },
              ],
            },
          },
        },
      })
      expect(res.statusCode).toBe(422)
      const body = res.json<{ synthesizedConcept?: string }>()
      expect(body.synthesizedConcept).toBe(synth)
    })
  })

  // -----------------------------------------------------------------------
  // 400 — Zod body validation
  // -----------------------------------------------------------------------

  describe('body validation (400)', () => {
    it('400 on missing fields', async () => {
      const { devSub } = await seedUserWithCredits(pool, 1)
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: { name: 'X' },
      })
      expect(res.statusCode).toBe(400)
      const body = res.json<{ code: string }>()
      expect(body.code).toBe('invalid_body')
    })

    it('400 on unknown world.kind (the existing-arm seam)', async () => {
      const { devSub } = await seedUserWithCredits(pool, 1)
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: 'X',
          world: { kind: 'existing', sourceWorldId: 'doesnt-matter' },
        },
      })
      expect(res.statusCode).toBe(400)
    })

    it('400 on under-length concept', async () => {
      const { devSub } = await seedUserWithCredits(pool, 1)
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: 'X',
          world: {
            kind: 'new',
            source: { mode: 'freeform', concept: 'too short' },
          },
        },
      })
      expect(res.statusCode).toBe(400)
    })

    it('400 on wrong number of picks', async () => {
      const { devSub } = await seedUserWithCredits(pool, 1)
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: 'X',
          world: {
            kind: 'new',
            source: {
              mode: 'guided',
              picks: [
                { title: 'A', whyILikeIt: 'a' },
                { title: 'B', whyILikeIt: 'b' },
              ],
            },
          },
        },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  // -----------------------------------------------------------------------
  // Pre-checks (cheap before LLM)
  // -----------------------------------------------------------------------

  describe('insufficient credits (403)', () => {
    it('403 when balance is 0 at the peek step (Phoenix-Imp1)', async () => {
      const { devSub } = await seedUserWithCredits(pool, 0)
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: 'X',
          world: {
            kind: 'new',
            source: {
              mode: 'freeform',
              concept: 'A long enough concept string to clear the Zod bound trivially.',
            },
          },
        },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ code: 'insufficient_credits', creditType: 'world_gen' })
      // Gate not even consulted: peek fails before LLM.
      expect(runInputGateMock).not.toHaveBeenCalled()
    })

    it('403 when peek passes but the locked re-read finds zero', async () => {
      // Seed 1 credit so peek passes; insert a compensating -1 row AFTER
      // the route's peek runs. We simulate this by stubbing the input gate
      // to debit the user inside its execution — that runs between the
      // peek and the locked re-check.
      const { userId, devSub } = await seedUserWithCredits(pool, 1)
      runInputGateMock.mockImplementation(async () => {
        await pool.query(
          `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type, source_id)
           VALUES ($1, $2, 'world_gen', -1, 'debit', $3)`,
          [uuidv7(), userId, uuidv7()],
        )
        return {
          verdict: 'allow',
          reason: null,
          rejectionMessage: null,
          reasoning: '',
          usage: STUB_USAGE,
        }
      })

      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: 'X',
          world: {
            kind: 'new',
            source: {
              mode: 'freeform',
              concept: 'A long enough concept string to clear the Zod bound trivially.',
            },
          },
        },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ code: 'insufficient_credits', creditType: 'world_gen' })
      // No campaign rows created.
      const c = await pool.query(`SELECT id FROM campaigns WHERE created_by = $1`, [userId])
      expect(c.rows).toHaveLength(0)
    })
  })

  describe('concurrent-generation guard (409)', () => {
    it('409 when an in-flight world already exists for this user', async () => {
      const { userId, devSub } = await seedUserWithCredits(pool, 1)
      // Pre-seed an in-flight world + campaign for this user.
      const worldId = uuidv7()
      const campaignId = uuidv7()
      await pool.query(
        `INSERT INTO worlds (id, created_by, name, concept, status)
         VALUES ($1, $2, 'In Flight', 'inflight', 'generating')`,
        [worldId, userId],
      )
      await pool.query(
        `INSERT INTO campaigns (id, world_id, created_by, name)
         VALUES ($1, $2, $3, 'In Flight')`,
        [campaignId, worldId, userId],
      )

      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: 'X',
          world: {
            kind: 'new',
            source: {
              mode: 'freeform',
              concept: 'A long enough concept string to clear the Zod bound trivially.',
            },
          },
        },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ code: 'concurrent_generation_in_progress' })
      expect(runInputGateMock).not.toHaveBeenCalled()
    })
  })

  describe('rejection-storm cooldown (429)', () => {
    it('429 when Redis counter is at 4 (over the 3-per-hour threshold)', async () => {
      const { userId, devSub } = await seedUserWithCredits(pool, 1)
      // Set the counter past the threshold; key shape matches
      // rejection-storm.ts.
      await redis.set(`${REDIS_KEY_PREFIX}rejection_storm:${userId}`, '4', 'EX', 3600)

      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: 'X',
          world: {
            kind: 'new',
            source: {
              mode: 'freeform',
              concept: 'A long enough concept string to clear the Zod bound trivially.',
            },
          },
        },
      })
      expect(res.statusCode).toBe(429)
      const body = res.json<{ code: string }>()
      expect(body.code).toBe('rejection_storm_cooldown')
      // Retry-After header reflects the TTL.
      const retryAfter = res.headers['retry-after']
      expect(retryAfter).toBeDefined()
      expect(Number(retryAfter)).toBeGreaterThan(0)
      expect(runInputGateMock).not.toHaveBeenCalled()
    })

    it('increments storm counter on 422', async () => {
      const { userId, devSub } = await seedUserWithCredits(pool, 1)
      runInputGateMock.mockResolvedValue({
        verdict: 'reject',
        reason: 'srd_incompat',
        rejectionMessage: 'Nope.',
        reasoning: 'srd_incompat: ...',
        usage: STUB_USAGE,
      })

      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: 'X',
          world: {
            kind: 'new',
            source: {
              mode: 'freeform',
              concept: 'A long enough concept string to clear the Zod bound trivially.',
            },
          },
        },
      })
      expect(res.statusCode).toBe(422)
      const stormKey = `${REDIS_KEY_PREFIX}rejection_storm:${userId}`
      const current = await redis.get(stormKey)
      expect(current).toBe('1')
    })

    it('resets storm counter on successful 201', async () => {
      const { userId, devSub } = await seedUserWithCredits(pool, 1)
      // Pre-seed below threshold so cooldown is NOT active.
      await redis.set(`${REDIS_KEY_PREFIX}rejection_storm:${userId}`, '2', 'EX', 3600)

      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: 'X',
          world: {
            kind: 'new',
            source: {
              mode: 'freeform',
              concept: 'A long enough concept string to clear the Zod bound trivially.',
            },
          },
        },
      })
      expect(res.statusCode).toBe(201)
      const current = await redis.get(`${REDIS_KEY_PREFIX}rejection_storm:${userId}`)
      expect(current).toBeNull()
    })
  })

  describe('queue-depth admission (503)', () => {
    it('503 with Retry-After:60 when getJobCounts returns >20', async () => {
      const { devSub } = await seedUserWithCredits(pool, 1)
      queueSpy.setJobCounts(21)

      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: 'X',
          world: {
            kind: 'new',
            source: {
              mode: 'freeform',
              concept: 'A long enough concept string to clear the Zod bound trivially.',
            },
          },
        },
      })
      expect(res.statusCode).toBe(503)
      const body = res.json<{ code: string }>()
      expect(body.code).toBe('queue_full')
      expect(res.headers['retry-after']).toBe('60')
      expect(runInputGateMock).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  describe('auth', () => {
    it('403 username_required for a sub with no users row', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: {
          'content-type': 'application/json',
          'x-mythrun-dev-sub': 'bypass:no-user-row',
        },
        payload: {
          name: 'X',
          world: {
            kind: 'new',
            source: {
              mode: 'freeform',
              concept: 'A long enough concept string to clear the Zod bound trivially.',
            },
          },
        },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ code: 'username_required' })
    })
  })
})
