// backend/src/routes/__tests__/campaign-preview.test.ts
//
// MYT-89 Task A3. Integration tests for POST /api/campaigns/synthesize-preview.
//
// Real Postgres (so the credit_ledger balance peek genuinely reads a seeded
// ledger), ioredis-mock for the rejection-storm counter + the preview store,
// and the Anthropic-backed prep modules (`synthesizeConcept`, `runInputGate`)
// mocked at the module boundary — exactly the seam campaigns-create.test.ts
// uses. No real LLM.
//
// Focus (cost-control, spec §5): a 0-credit user must hit ZERO LLM calls —
// the credit peek runs BEFORE synthesize, and the test asserts the synth mock
// was never invoked. This route NEVER charges a credit (the debit happens at
// commit); the peek is non-charging.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import IoredisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { bypassPlugin } from '../../auth/bypass-plugin.js'
import { requireOnboarded } from '../../auth/require-onboarded.js'
import { campaignPreviewRoutes } from '../campaign-preview.js'
import { getPreview } from '../../preview/preview-store.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

// --- Module mocks ---------------------------------------------------------
// Partial mock: stub `synthesizeConcept` (the Sonnet call) but keep the REAL
// `SynthesizerPick` zod schema — the route uses it as a value for body
// validation (z.array(SynthesizerPick)), so a stub would break parsing.
vi.mock('../../llm/prep/synthesize-concept.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../llm/prep/synthesize-concept.js')>()
  return { ...actual, synthesizeConcept: vi.fn() }
})
vi.mock('../../llm/prep/input-gate.js', () => ({
  runInputGate: vi.fn(),
}))
// A4 — the rework primitive (Sonnet). Mocked at the module boundary; no real LLM.
vi.mock('../../llm/prep/revise-concept.js', () => ({
  reviseConcept: vi.fn(),
}))

import { synthesizeConcept } from '../../llm/prep/synthesize-concept.js'
import { runInputGate } from '../../llm/prep/input-gate.js'
import { reviseConcept } from '../../llm/prep/revise-concept.js'
import { putPreview } from '../../preview/preview-store.js'
import type { LanguageModelUsage } from 'ai'

const synthesizeConceptMock = vi.mocked(synthesizeConcept)
const runInputGateMock = vi.mocked(runInputGate)
const reviseConceptMock = vi.mocked(reviseConcept)

// Shape-correct usage placeholder (the route never reads it).
const STUB_USAGE: LanguageModelUsage = {
  inputTokens: 10,
  outputTokens: 10,
  totalTokens: 20,
  inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 10, reasoningTokens: 0 },
}

const databaseUrl = process.env.DATABASE_URL ?? ''
const REDIS_KEY_PREFIX = `test:campaign-preview-${String(Date.now())}:`

const VALID_PICKS = [
  { title: 'Studio Ghibli films', whyILikeIt: 'gentle melancholy and wind' },
  { title: 'Old maritime journals', whyILikeIt: 'isolation and salt' },
  { title: 'Stories about memory', whyILikeIt: 'what things remember' },
]

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

async function buildTestApp(pool: Pool, redis: Redis): Promise<FastifyInstance> {
  // bypassPlugin's Layer 2b probes the ECS metadata endpoint and requires it
  // to FAIL — replace fetch with a guaranteed-reject stub.
  globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))

  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(bypassPlugin)
  await app.register(requireOnboarded, { pool })
  await app.register(campaignPreviewRoutes, {
    pool,
    redis,
    redisKeyPrefix: REDIS_KEY_PREFIX,
  })
  await app.ready()
  return app
}

function inject(app: FastifyInstance, devSub: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/campaigns/synthesize-preview',
    headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
    payload: payload as Record<string, unknown>,
  })
}

function injectRework(
  app: FastifyInstance,
  devSub: string,
  previewId: string,
  payload: unknown,
) {
  return app.inject({
    method: 'POST',
    url: `/api/campaigns/preview/${previewId}/rework`,
    headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
    payload: payload as Record<string, unknown>,
  })
}

// Shared intentSummary shape for seeded/revised preview records.
const STUB_INTENT = {
  aesthetics: ['revised'],
  themes: ['change'],
  sourcesInternal: ['r1', 'r2', 'r3'],
}

describe('POST /api/campaigns/synthesize-preview (MYT-89 A3)', () => {
  let pool: Pool
  let redis: Redis
  let app: FastifyInstance
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('campaign-preview')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'test')

    redis = new IoredisMock()

    synthesizeConceptMock.mockReset()
    runInputGateMock.mockReset()
    reviseConceptMock.mockReset()
    // Default revised output; individual A4 tests override as needed.
    reviseConceptMock.mockResolvedValue({
      concept: 'A revised concept honoring the change while keeping the original spine intact.',
      intentSummary: {
        aesthetics: ['revised'],
        themes: ['change'],
        sourcesInternal: ['r1', 'r2', 'r3'],
      },
    })
    // Default synth output; individual tests override as needed.
    synthesizeConceptMock.mockResolvedValue({
      concept:
        'A rain-soaked archipelago where lighthouses are sentient and remember every shipwreck they have ever witnessed.',
      intentSummary: {
        aesthetics: ['rain', 'salt'],
        themes: ['memory'],
        sourcesInternal: ['internal-pick-1', 'internal-pick-2', 'internal-pick-3'],
      },
      usage: STUB_USAGE,
    })
    // Default to "allow".
    runInputGateMock.mockResolvedValue({
      verdict: 'allow',
      reason: null,
      rejectionMessage: null,
      reasoning: '',
      usage: STUB_USAGE,
    })

    await cleanupTestScope(pool, scope)
    app = await buildTestApp(pool, redis)
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  it('201 returns {previewId, concept}; stored record has reworkCount:0 and NO credit is charged', async () => {
    const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
    const synthesizedConcept =
      'A quiet valley where the seasons are governed by a sleeping god no one remembers naming.'
    synthesizeConceptMock.mockResolvedValue({
      concept: synthesizedConcept,
      intentSummary: {
        aesthetics: ['moss', 'stone'],
        themes: ['forgetting'],
        sourcesInternal: ['a', 'b', 'c'],
      },
      usage: STUB_USAGE,
    })

    const res = await inject(app, devSub, { picks: VALID_PICKS })

    expect(res.statusCode).toBe(201)
    const body = res.json<{ previewId: string; concept: string }>()
    expect(body.previewId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.concept).toBe(synthesizedConcept)

    // The stored preview round-trips for the same user with reworkCount:0.
    const stored = await getPreview(redis, REDIS_KEY_PREFIX, userId, body.previewId)
    expect(stored).not.toBeNull()
    expect(stored?.concept).toBe(synthesizedConcept)
    expect(stored?.reworkCount).toBe(0)

    // Non-charging: the ledger still shows only the +1 gift, no debit.
    const balance = await pool.query<{ balance: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS balance FROM credit_ledger
       WHERE user_id = $1 AND credit_type = 'world_gen'`,
      [userId],
    )
    expect(Number(balance.rows[0]?.balance)).toBe(1)

    // Both LLM stages ran once; the gate saw the synthesized concept.
    expect(synthesizeConceptMock).toHaveBeenCalledTimes(1)
    expect(runInputGateMock).toHaveBeenCalledTimes(1)
    expect(runInputGateMock.mock.calls[0]?.[0]?.concept).toBe(synthesizedConcept)
  })

  // -----------------------------------------------------------------------
  // 0-credit → 403 and ZERO LLM calls (the cost-control fix)
  // -----------------------------------------------------------------------

  it('403 insufficient_credits when balance is 0 — and the synth mock is NEVER called', async () => {
    const { devSub } = await seedUserWithCredits(pool, scope, 0)

    const res = await inject(app, devSub, { picks: VALID_PICKS })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'insufficient_credits', creditType: 'world_gen' })
    // The whole point: no Sonnet burn for a 0-credit user.
    expect(synthesizeConceptMock).not.toHaveBeenCalled()
    expect(runInputGateMock).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // Gate rejection → 422 with synthesizedConcept
  // -----------------------------------------------------------------------

  it('422 concept_rejected includes the synthesizedConcept (guided mode)', async () => {
    const { devSub } = await seedUserWithCredits(pool, scope, 1)
    const synth = 'A clockwork bureaucracy of mountain-monks whose ledgers track every broken promise.'
    synthesizeConceptMock.mockResolvedValue({
      concept: synth,
      intentSummary: { aesthetics: ['ink'], themes: ['promise'], sourcesInternal: ['x'] },
      usage: STUB_USAGE,
    })
    runInputGateMock.mockResolvedValue({
      verdict: 'reject',
      reason: 'clone_intent',
      rejectionMessage: 'This reads as a clone of a copyrighted work.',
      reasoning: 'clone_intent: server-only reasoning',
      usage: STUB_USAGE,
    })

    const res = await inject(app, devSub, { picks: VALID_PICKS })

    expect(res.statusCode).toBe(422)
    const body = res.json<{
      code: string
      reason: string
      rejectionMessage: string
      synthesizedConcept?: string
      reasoning?: string
    }>()
    expect(body.code).toBe('concept_rejected')
    expect(body.reason).toBe('clone_intent')
    expect(body.rejectionMessage).toBe('This reads as a clone of a copyrighted work.')
    expect(body.synthesizedConcept).toBe(synth)
    // Server-only reasoning never leaks to the response.
    expect(body.reasoning).toBeUndefined()
  })

  // -----------------------------------------------------------------------
  // Rejection-storm cooldown → 429 (before any LLM call)
  // -----------------------------------------------------------------------

  it('429 rejection_storm_cooldown when the counter is over threshold — no LLM call', async () => {
    const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
    // Past the 3-per-hour threshold (4th trips cooldown).
    await redis.set(`${REDIS_KEY_PREFIX}rejection_storm:${userId}`, '4', 'EX', 3600)

    const res = await inject(app, devSub, { picks: VALID_PICKS })

    expect(res.statusCode).toBe(429)
    expect(res.json<{ code: string }>().code).toBe('rejection_storm_cooldown')
    const retryAfter = res.headers['retry-after']
    expect(retryAfter).toBeDefined()
    expect(Number(retryAfter)).toBeGreaterThan(0)
    expect(synthesizeConceptMock).not.toHaveBeenCalled()
    expect(runInputGateMock).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // 400 — Zod body validation (wrong number of picks)
  // -----------------------------------------------------------------------

  it('400 invalid_body on the wrong number of picks — no LLM call', async () => {
    const { devSub } = await seedUserWithCredits(pool, scope, 1)

    const res = await inject(app, devSub, {
      picks: [
        { title: 'A', whyILikeIt: 'a' },
        { title: 'B', whyILikeIt: 'b' },
      ],
    })

    expect(res.statusCode).toBe(400)
    expect(res.json<{ code: string }>().code).toBe('invalid_body')
    expect(synthesizeConceptMock).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // A4 — POST /api/campaigns/preview/:previewId/rework (single-shot rework)
  // -----------------------------------------------------------------------

  describe('rework (MYT-89 A4)', () => {
    const ORIGINAL_CONCEPT =
      'A drowned cathedral-city where the tide keeps the calendar and every bell is rung by the dead.'

    it('200 reworks a fresh preview: overwrites the concept and sets reworkCount:1', async () => {
      const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
      const previewId = await putPreview(redis, REDIS_KEY_PREFIX, userId, {
        concept: ORIGINAL_CONCEPT,
        intentSummary: STUB_INTENT,
        reworkCount: 0,
      })
      const revised =
        'A sun-bleached cathedral-city where the tide keeps the calendar and the living ring the bells at noon.'
      reviseConceptMock.mockResolvedValue({
        concept: revised,
        intentSummary: { aesthetics: ['bleached'], themes: ['renewal'], sourcesInternal: ['s'] },
      })

      const res = await injectRework(app, devSub, previewId, { change: 'make it brighter, less morbid' })

      expect(res.statusCode).toBe(200)
      const body = res.json<{ previewId: string; concept: string }>()
      expect(body.previewId).toBe(previewId)
      expect(body.concept).toBe(revised)

      // Store now holds the reworked concept with reworkCount bumped to 1.
      const stored = await getPreview(redis, REDIS_KEY_PREFIX, userId, previewId)
      expect(stored?.concept).toBe(revised)
      expect(stored?.reworkCount).toBe(1)

      // The prior concept + the change note were the revise inputs.
      expect(reviseConceptMock).toHaveBeenCalledTimes(1)
      expect(reviseConceptMock.mock.calls[0]).toEqual([
        ORIGINAL_CONCEPT,
        'make it brighter, less morbid',
      ])
    })

    it('422 on a gate-rejected rework leaves the ORIGINAL concept and reworkCount:0 intact', async () => {
      const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
      const previewId = await putPreview(redis, REDIS_KEY_PREFIX, userId, {
        concept: ORIGINAL_CONCEPT,
        intentSummary: STUB_INTENT,
        reworkCount: 0,
      })
      const rejectedRevision = 'A revised concept that reads as a clone of a copyrighted work.'
      reviseConceptMock.mockResolvedValue({
        concept: rejectedRevision,
        intentSummary: STUB_INTENT,
      })
      runInputGateMock.mockResolvedValue({
        verdict: 'reject',
        reason: 'clone_intent',
        rejectionMessage: 'This reads as a clone of a copyrighted work.',
        reasoning: 'clone_intent: server-only reasoning',
        usage: STUB_USAGE,
      })

      const res = await injectRework(app, devSub, previewId, { change: 'make it exactly like <IP>' })

      expect(res.statusCode).toBe(422)
      const body = res.json<{
        code: string
        reason: string
        synthesizedConcept?: string
        reasoning?: string
      }>()
      expect(body.code).toBe('concept_rejected')
      expect(body.reason).toBe('clone_intent')
      // Guided mode surfaces the (revised) concept that was judged.
      expect(body.synthesizedConcept).toBe(rejectedRevision)
      // Server-only reasoning never leaks.
      expect(body.reasoning).toBeUndefined()

      // Load-bearing invariant: a rejected rework mutates NOTHING in the store.
      const stored = await getPreview(redis, REDIS_KEY_PREFIX, userId, previewId)
      expect(stored?.concept).toBe(ORIGINAL_CONCEPT)
      expect(stored?.reworkCount).toBe(0)
    })

    it('409 rework_exhausted when the preview was already reworked (reworkCount:1) — no LLM call', async () => {
      const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
      const previewId = await putPreview(redis, REDIS_KEY_PREFIX, userId, {
        concept: ORIGINAL_CONCEPT,
        intentSummary: STUB_INTENT,
        reworkCount: 1,
      })

      const res = await injectRework(app, devSub, previewId, { change: 'one more change' })

      expect(res.statusCode).toBe(409)
      expect(res.json<{ code: string }>().code).toBe('rework_exhausted')
      expect(reviseConceptMock).not.toHaveBeenCalled()
      expect(runInputGateMock).not.toHaveBeenCalled()
    })

    it('410 preview_expired for an unknown previewId (uniform with commit, NOT 404)', async () => {
      const { devSub } = await seedUserWithCredits(pool, scope, 1)

      const res = await injectRework(app, devSub, uuidv7(), { change: 'x' })

      expect(res.statusCode).toBe(410)
      expect(res.json<{ code: string }>().code).toBe('preview_expired')
      expect(reviseConceptMock).not.toHaveBeenCalled()
    })

    it('410 preview_expired when another user owns the previewId (IDOR isolation)', async () => {
      const owner = await seedUserWithCredits(pool, scope, 1, 0)
      const other = await seedUserWithCredits(pool, scope, 1, 1)
      const previewId = await putPreview(redis, REDIS_KEY_PREFIX, owner.userId, {
        concept: ORIGINAL_CONCEPT,
        intentSummary: STUB_INTENT,
        reworkCount: 0,
      })

      const res = await injectRework(app, other.devSub, previewId, { change: 'let me at it' })

      expect(res.statusCode).toBe(410)
      expect(res.json<{ code: string }>().code).toBe('preview_expired')
      // The owner's preview is untouched.
      const stored = await getPreview(redis, REDIS_KEY_PREFIX, owner.userId, previewId)
      expect(stored?.concept).toBe(ORIGINAL_CONCEPT)
      expect(stored?.reworkCount).toBe(0)
    })

    it('400 invalid_body on an empty change note — no LLM call', async () => {
      const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
      const previewId = await putPreview(redis, REDIS_KEY_PREFIX, userId, {
        concept: ORIGINAL_CONCEPT,
        intentSummary: STUB_INTENT,
        reworkCount: 0,
      })

      const res = await injectRework(app, devSub, previewId, { change: '' })

      expect(res.statusCode).toBe(400)
      expect(res.json<{ code: string }>().code).toBe('invalid_body')
      expect(reviseConceptMock).not.toHaveBeenCalled()
    })

    // ---------------------------------------------------------------------
    // A4 cost-control: same guards synthesize-preview has, mirrored onto
    // rework — a rejection-producing rework loop must not burn Sonnet.
    // ---------------------------------------------------------------------

    it('403 insufficient_credits when balance is 0 — reviseConcept is NEVER called', async () => {
      const { userId, devSub } = await seedUserWithCredits(pool, scope, 0)
      const previewId = await putPreview(redis, REDIS_KEY_PREFIX, userId, {
        concept: ORIGINAL_CONCEPT,
        intentSummary: STUB_INTENT,
        reworkCount: 0,
      })

      const res = await injectRework(app, devSub, previewId, { change: 'brighten it up' })

      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ code: 'insufficient_credits', creditType: 'world_gen' })
      // The whole point: no Sonnet burn for a 0-credit user, even holding a valid previewId.
      expect(reviseConceptMock).not.toHaveBeenCalled()
      expect(runInputGateMock).not.toHaveBeenCalled()
      // Invariant preserved: the parked concept + unspent budget survive.
      const stored = await getPreview(redis, REDIS_KEY_PREFIX, userId, previewId)
      expect(stored?.concept).toBe(ORIGINAL_CONCEPT)
      expect(stored?.reworkCount).toBe(0)
    })

    it('429 rejection_storm_cooldown when the counter is over threshold — no LLM call', async () => {
      const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
      const previewId = await putPreview(redis, REDIS_KEY_PREFIX, userId, {
        concept: ORIGINAL_CONCEPT,
        intentSummary: STUB_INTENT,
        reworkCount: 0,
      })
      // Past the 3-per-hour threshold (4th trips cooldown).
      await redis.set(`${REDIS_KEY_PREFIX}rejection_storm:${userId}`, '4', 'EX', 3600)

      const res = await injectRework(app, devSub, previewId, { change: 'brighten it up' })

      expect(res.statusCode).toBe(429)
      expect(res.json<{ code: string }>().code).toBe('rejection_storm_cooldown')
      const retryAfter = res.headers['retry-after']
      expect(retryAfter).toBeDefined()
      expect(Number(retryAfter)).toBeGreaterThan(0)
      expect(reviseConceptMock).not.toHaveBeenCalled()
      expect(runInputGateMock).not.toHaveBeenCalled()
      // Untouched preview.
      const stored = await getPreview(redis, REDIS_KEY_PREFIX, userId, previewId)
      expect(stored?.reworkCount).toBe(0)
    })
  })
})
