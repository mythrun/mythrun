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
import fastifyPlugin from 'fastify-plugin'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import IoredisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { bypassPlugin } from '../../auth/bypass-plugin.js'
import { requireOnboarded } from '../../auth/require-onboarded.js'
import { campaignsRoutes } from '../campaigns.js'
import type { PipelineSubscriber } from '../../sse/pipeline-subscriber.js'
import type { ConnectionCounter } from '../../sse/connection-counter.js'
import type { WorldGenQueueLike } from '../campaigns.js'
import { REGISTERED_DECORATOR } from '../../auth/constants.js'
import type { AuthUser } from '../../auth/types.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

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
// MYT-89 A5: guided create now commits an already-gated preview. Tests seed the
// preview store directly (putPreview) for a real previewId rather than routing
// through synthesize-preview — this plugin registration doesn't mount the
// preview route, and the create handler only reads via getPreview.
import { putPreview } from '../../preview/preview-store.js'
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

// Shape-correct intentSummary for seeded preview records (SynthesizerOutput
// shape). The create commit reads only `concept` off the preview, but a stored
// record always carries the intent it was synthesized from.
const STUB_INTENT = {
  aesthetics: ['rain', 'salt'],
  themes: ['memory'],
  sourcesInternal: ['internal-pick-1', 'internal-pick-2', 'internal-pick-3'],
}

// --- Test harness ---------------------------------------------------------

const databaseUrl = process.env.DATABASE_URL ?? ''
const REDIS_KEY_PREFIX = `test:campaigns-create-${String(Date.now())}:`

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
  const getJobCounts = vi.fn<(states: readonly string[]) => Promise<Record<string, number>>>(() => {
    // BullMQ returns an object keyed by state; the route sums values.
    return Promise.resolve({ waiting: jobCounts, active: 0, delayed: 0 })
  })
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

async function seedUserWithCredits(
  pool: Pool,
  scope: TestScope,
  credits: number,
  index = 0,
): Promise<SeededUser> {
  const userId = uuidv7()
  const devSub = scope.userSub(index)
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, devSub, scope.displayName(index), scope.username(index)],
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

// myth-exac T21: test-only auth plugin that attaches request.user with
// caller-supplied scopes. Used to exercise the devBypassAccessFilter gate
// independent of the real bypassPlugin — which enforces NODE_ENV at request
// time and ALWAYS attaches `scopes: ['bypass']`. We need both axes:
// scopes=[] (non-bypass auth) and NODE_ENV=production (prod env). Mirrors
// the pattern in campaigns-snapshot.test.ts's noBypassScopeAuth.
function customAuthImpl(
  app: FastifyInstance,
  opts: { readonly sub: string; readonly scopes: readonly string[] },
): Promise<void> {
  if (app.hasDecorator(REGISTERED_DECORATOR)) {
    throw new Error('customAuth: auth already registered')
  }
  app.decorate(REGISTERED_DECORATOR, 'test-custom' as const)
  // eslint-disable-next-line @typescript-eslint/require-await
  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.url === undefined) return
    if (request.routeOptions.config.auth === 'public') return
    const user: AuthUser = {
      sub: opts.sub,
      cognitoUsername: 'test_custom',
      scopes: Object.freeze([...opts.scopes]),
    }
    request.user = Object.freeze(user)
  })
  return Promise.resolve()
}
const customAuth = fastifyPlugin(customAuthImpl, {
  fastify: '5.x',
  name: 'mythrun-test-custom-auth',
})

async function buildCustomAuthApp(
  pool: Pool,
  redis: Redis,
  queueSpy: QueueSpy,
  authOpts: { readonly sub: string; readonly scopes: readonly string[] },
): Promise<FastifyInstance> {
  globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(customAuth, authOpts)
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
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('campaigns-create')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
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

    // myth-5jdo: scoped cleanup replaces blanket DELETEs.
    await cleanupTestScope(pool, scope)

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
      const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: scope.campaignName(0),
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

    it('201 guided: commits the already-gated preview concept; NO re-synth, NO re-gate', async () => {
      const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
      // The gated concept was parked at synthesize-preview time. Seed it
      // directly (real previewId) and commit with it.
      const gatedConcept =
        'A rain-soaked archipelago where lighthouses are sentient and remember every shipwreck they have ever witnessed.'
      const previewId = await putPreview(redis, userId, {
        concept: gatedConcept,
        intentSummary: STUB_INTENT,
        reworkCount: 0,
      })

      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          world: {
            kind: 'new',
            source: { mode: 'guided', previewId },
          },
        },
      })
      expect(res.statusCode).toBe(201)
      const body = res.json<{ campaignId: string }>()

      // The commit does NOT re-synthesize and does NOT re-gate — the stored
      // concept is server-authored and already passed the gate at preview time.
      expect(synthesizeConceptMock).not.toHaveBeenCalled()
      expect(runInputGateMock).not.toHaveBeenCalled()

      // The world row stores the PREVIEW's concept verbatim.
      const worlds = await pool.query<{ concept: string }>(
        `SELECT concept FROM worlds
         WHERE id = (SELECT world_id FROM campaigns WHERE id = $1)`,
        [body.campaignId],
      )
      expect(worlds.rows[0]?.concept).toBe(gatedConcept)

      // The commit path is otherwise identical: the credit was debited and the
      // world-gen job enqueued.
      const ledger = await pool.query<{ amount: string; source_type: string }>(
        `SELECT amount::text AS amount, source_type FROM credit_ledger
         WHERE user_id = $1 AND source_type = 'debit'`,
        [userId],
      )
      expect(ledger.rows).toHaveLength(1)
      expect(Number(ledger.rows[0]?.amount)).toBe(-1)
      expect(queueSpy.add).toHaveBeenCalledTimes(1)
    })

    it('410 preview_expired when the guided previewId is absent/expired', async () => {
      const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
      // A well-formed but never-stored previewId → 410 (NOT 400 — the body is
      // valid; the concept-source load is what misses).
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          world: {
            kind: 'new',
            source: { mode: 'guided', previewId: uuidv7() },
          },
        },
      })
      expect(res.statusCode).toBe(410)
      expect(res.json()).toEqual({ code: 'preview_expired' })
      // Nothing committed, nothing debited, nothing enqueued.
      const c = await pool.query(`SELECT id FROM campaigns WHERE created_by = $1`, [userId])
      expect(c.rows).toHaveLength(0)
      expect(queueSpy.add).not.toHaveBeenCalled()
    })

    it('410 preview_expired when another user owns the previewId (IDOR isolation)', async () => {
      // Owner parks a preview; a DIFFERENT authenticated user tries to commit
      // it. getPreview bakes the userId into the Redis key, so the cross-user
      // load simply misses → the same 410 an absent id gets. No cross-user
      // world is ever created.
      const owner = await seedUserWithCredits(pool, scope, 1, 0)
      const other = await seedUserWithCredits(pool, scope, 1, 1)
      const previewId = await putPreview(redis, owner.userId, {
        concept: 'A private concept only the owner previewed.',
        intentSummary: STUB_INTENT,
        reworkCount: 0,
      })

      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': other.devSub },
        payload: {
          world: {
            kind: 'new',
            source: { mode: 'guided', previewId },
          },
        },
      })
      expect(res.statusCode).toBe(410)
      expect(res.json()).toEqual({ code: 'preview_expired' })
      const c = await pool.query(`SELECT id FROM campaigns WHERE created_by = $1`, [other.userId])
      expect(c.rows).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // Gate rejections (422)
  // -----------------------------------------------------------------------

  describe('gate rejection (422)', () => {
    it.each(['srd_incompat', 'clone_intent', 'inappropriate'] as const)(
      '422 with reason=%s',
      async (reason) => {
        const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
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
            name: scope.campaignName(0),
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

    // MYT-89 A5: the guided-mode gate rejection (422 with synthesizedConcept)
    // moved OFF the create commit — guided create now commits an already-gated
    // preview and does NOT re-gate. That 422 path now lives on the
    // synthesize-preview / rework routes and is covered by
    // campaign-preview.test.ts ('422 concept_rejected includes the
    // synthesizedConcept'). The freeform 422 above still exercises the create
    // route's own gate.
  })

  // -----------------------------------------------------------------------
  // 400 — Zod body validation
  // -----------------------------------------------------------------------

  describe('body validation (400)', () => {
    it('400 on missing fields', async () => {
      const { devSub } = await seedUserWithCredits(pool, scope, 1)
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: { name: scope.campaignName(0) },
      })
      expect(res.statusCode).toBe(400)
      const body = res.json<{ code: string }>()
      expect(body.code).toBe('invalid_body')
    })

    it('400 on unknown world.kind (the existing-arm seam)', async () => {
      const { devSub } = await seedUserWithCredits(pool, scope, 1)
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: scope.campaignName(0),
          world: { kind: 'existing', sourceWorldId: 'doesnt-matter' },
        },
      })
      expect(res.statusCode).toBe(400)
    })

    it('400 on under-length concept', async () => {
      const { devSub } = await seedUserWithCredits(pool, scope, 1)
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: scope.campaignName(0),
          world: {
            kind: 'new',
            source: { mode: 'freeform', concept: 'too short' },
          },
        },
      })
      expect(res.statusCode).toBe(400)
    })

    it('400 on a guided body missing previewId (schema, before any store load)', async () => {
      // MYT-89 A5: the guided arm now requires `previewId: string`. A guided
      // source without it is a body-shape bug — 400 at Zod, distinct from the
      // 410 a well-formed-but-absent previewId gets at the store load.
      const { devSub } = await seedUserWithCredits(pool, scope, 1)
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          world: {
            kind: 'new',
            source: { mode: 'guided' },
          },
        },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json<{ code: string }>().code).toBe('invalid_body')
    })
  })

  // -----------------------------------------------------------------------
  // Pre-checks (cheap before LLM)
  // -----------------------------------------------------------------------

  describe('insufficient credits (403)', () => {
    it('403 when balance is 0 at the peek step (Phoenix-Imp1)', async () => {
      const { devSub } = await seedUserWithCredits(pool, scope, 0)
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: scope.campaignName(0),
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
      const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
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
          name: scope.campaignName(0),
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

    it('rethrows non-InsufficientCreditsError from executeCreateTransaction (falls through to Fastify 500)', async () => {
      // Covers the falsy arm of `if (err instanceof InsufficientCreditsError)`
      // at routes/campaigns.ts:415. Force the inner pipeline to throw a
      // generic Error by making the input gate reject — its rejection
      // propagates up through executeCreateTransaction's outer catch and
      // out to the route handler, where it's NOT InsufficientCreditsError,
      // so the fall-through `throw err` fires.
      const { devSub } = await seedUserWithCredits(pool, scope, 1)
      runInputGateMock.mockRejectedValueOnce(new Error('input gate exploded'))
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: scope.campaignName(0),
          world: {
            kind: 'new',
            source: {
              mode: 'freeform',
              concept: 'A long enough concept string to clear the Zod bound trivially.',
            },
          },
        },
      })
      // Fastify's default 500 (the global handler doesn't have a typed
      // mapping for this error class).
      expect(res.statusCode).toBe(500)
    })
  })

  describe('concurrent-generation guard (409)', () => {
    it('409 when an in-flight world already exists for this user', async () => {
      const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
      // Pre-seed an in-flight world + campaign for this user.
      const worldId = uuidv7()
      const campaignId = uuidv7()
      await pool.query(
        `INSERT INTO worlds (id, created_by, name, concept, status)
         VALUES ($1, $2, $3, 'inflight', 'generating')`,
        [worldId, userId, scope.worldName(0)],
      )
      await pool.query(
        `INSERT INTO campaigns (id, world_id, created_by, name)
         VALUES ($1, $2, $3, $4)`,
        [campaignId, worldId, userId, scope.campaignName(0)],
      )

      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: scope.campaignName(0),
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
      const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
      // Set the counter past the threshold; key shape matches
      // rejection-storm.ts.
      await redis.set(`${REDIS_KEY_PREFIX}rejection_storm:${userId}`, '4', 'EX', 3600)

      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: scope.campaignName(0),
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
      const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
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
          name: scope.campaignName(0),
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
      const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
      // Pre-seed below threshold so cooldown is NOT active.
      await redis.set(`${REDIS_KEY_PREFIX}rejection_storm:${userId}`, '2', 'EX', 3600)

      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: scope.campaignName(0),
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
      const { devSub } = await seedUserWithCredits(pool, scope, 1)
      queueSpy.setJobCounts(21)

      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          name: scope.campaignName(0),
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
  // myth-exac T21 — devBypassAccessFilter field gate + persistence
  // -----------------------------------------------------------------------

  describe('POST /api/campaigns devBypassAccessFilter — myth-exac', () => {
    it('201 with devBypassAccessFilter:true under bypass-auth + dev env persists the flag', async () => {
      const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          world: {
            kind: 'new',
            source: {
              mode: 'freeform',
              concept: 'A long enough concept string to clear the Zod bound trivially.',
            },
          },
          devBypassAccessFilter: true,
        },
      })
      expect(res.statusCode).toBe(201)
      const body = res.json<{ campaignId: string }>()

      const worlds = await pool.query<{ dev_bypass_access_filter: boolean }>(
        `SELECT dev_bypass_access_filter FROM worlds
         WHERE id = (SELECT world_id FROM campaigns WHERE id = $1)`,
        [body.campaignId],
      )
      expect(worlds.rows[0]?.dev_bypass_access_filter).toBe(true)

      // The debit + owner row + enqueue still happen — bypass only widens
      // the access projection, it does NOT short-circuit the create flow.
      const ledger = await pool.query<{ amount: string }>(
        `SELECT amount::text AS amount FROM credit_ledger
         WHERE user_id = $1 AND source_type = 'debit'`,
        [userId],
      )
      expect(ledger.rows).toHaveLength(1)
      expect(Number(ledger.rows[0]?.amount)).toBe(-1)
    })

    it('400 bypass_not_permitted under non-bypass auth (scopes=[])', async () => {
      // Custom auth attaches scopes=[] (no 'bypass') while NODE_ENV stays
      // 'test'. The gate's first conjunct fails.
      await app.close()
      const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
      app = await buildCustomAuthApp(pool, redis, queueSpy, {
        sub: devSub,
        scopes: [],
      })

      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json' },
        payload: {
          world: {
            kind: 'new',
            source: {
              mode: 'freeform',
              concept: 'A long enough concept string to clear the Zod bound trivially.',
            },
          },
          devBypassAccessFilter: true,
        },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'bypass_not_permitted' })

      // Nothing got persisted — gate fires BEFORE the credit peek / INSERT.
      const worlds = await pool.query(`SELECT id FROM worlds WHERE created_by = $1`, [userId])
      expect(worlds.rows).toHaveLength(0)
    })

    it('400 bypass_not_permitted under bypass-auth + prod env', async () => {
      // The route gate's second conjunct: NODE_ENV ∈ {development,test}.
      // The real bypass plugin would reject NODE_ENV='production' at
      // request time (Layer 2a re-check), so we use a custom auth plugin
      // that fabricates scopes=['bypass'] without that layer — exactly the
      // misconfigured-deploy scenario the route's NODE_ENV check defends
      // against.
      await app.close()
      const { devSub } = await seedUserWithCredits(pool, scope, 1)
      app = await buildCustomAuthApp(pool, redis, queueSpy, {
        sub: devSub,
        scopes: ['bypass'],
      })
      vi.stubEnv('NODE_ENV', 'production')

      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json' },
        payload: {
          world: {
            kind: 'new',
            source: {
              mode: 'freeform',
              concept: 'A long enough concept string to clear the Zod bound trivially.',
            },
          },
          devBypassAccessFilter: true,
        },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'bypass_not_permitted' })
    })

    it('201 with devBypassAccessFilter omitted → column defaults to false', async () => {
      const { devSub } = await seedUserWithCredits(pool, scope, 1)
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
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
      const body = res.json<{ campaignId: string }>()

      const worlds = await pool.query<{ dev_bypass_access_filter: boolean }>(
        `SELECT dev_bypass_access_filter FROM worlds
         WHERE id = (SELECT world_id FROM campaigns WHERE id = $1)`,
        [body.campaignId],
      )
      expect(worlds.rows[0]?.dev_bypass_access_filter).toBe(false)
    })

    it('201 with devBypassAccessFilter:false → column persisted as false', async () => {
      // Explicit false should behave the same as omitted (gate is a `=== true`
      // check, so false skips it entirely).
      const { devSub } = await seedUserWithCredits(pool, scope, 1)
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
        payload: {
          world: {
            kind: 'new',
            source: {
              mode: 'freeform',
              concept: 'A long enough concept string to clear the Zod bound trivially.',
            },
          },
          devBypassAccessFilter: false,
        },
      })
      expect(res.statusCode).toBe(201)
      const body = res.json<{ campaignId: string }>()
      const worlds = await pool.query<{ dev_bypass_access_filter: boolean }>(
        `SELECT dev_bypass_access_filter FROM worlds
         WHERE id = (SELECT world_id FROM campaigns WHERE id = $1)`,
        [body.campaignId],
      )
      expect(worlds.rows[0]?.dev_bypass_access_filter).toBe(false)
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
          name: scope.campaignName(0),
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
