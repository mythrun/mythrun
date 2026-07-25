/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/prefer-promise-reject-errors -- test fixture file: fake async-generator stream shapes (no awaits) + unknown-typed rejection reasons, mirroring ai.test.ts */
// backend/src/routes/__tests__/campaign-preview-stream.test.ts
//
// myth-umggn. Integration tests for POST /api/campaigns/synthesize-preview/stream
// — the SSE sibling of synthesize-preview that streams the world brief live.
//
// Same harness as campaign-preview.test.ts: real Postgres (the credit peek
// reads a seeded ledger), ioredis-mock (storm counter + preview store), and
// the Anthropic-backed prep modules mocked at the module boundary
// (`streamSynthesizeConcept`, `runInputGate`). No real LLM.
//
// The load-bearing contracts under test:
//   - guard order: 400/429/403 are PLAIN JSON (no SSE hijack, zero LLM calls)
//   - happy path: delta frames stream the prose; the terminal `complete`
//     carries {previewId, concept}; the preview parks EXACTLY as the
//     non-streaming route parks it (reworkCount:0, no credit charged)
//   - gate reject: terminal `rejected` frame mirrors the 422 payload
//     (reason/rejectionMessage/synthesizedConcept), the storm counter
//     increments, and NOTHING is parked
//   - failure honesty: a mid-stream LLM failure ends in a terminal `error`
//     frame with the mapped code — never a hung half-brief

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
import { campaignPreviewStreamRoutes } from '../campaign-preview-stream.js'
import { getPreview } from '../../preview/preview-store.js'
import {
  LlmContentFilteredError,
  LlmRateLimitedError,
} from '../../llm/errors.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

// --- Module mocks ---------------------------------------------------------
// Partial mock: stub `streamSynthesizeConcept` (the Sonnet stream) but keep
// the REAL `SynthesizerPick` zod schema — the shared body schema uses it as a
// value, so a full stub would break body validation.
vi.mock('../../llm/prep/synthesize-concept.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../llm/prep/synthesize-concept.js')>()
  return { ...actual, streamSynthesizeConcept: vi.fn(), streamSynthesizeFromConcept: vi.fn() }
})
vi.mock('../../llm/prep/input-gate.js', () => ({
  runInputGate: vi.fn(),
}))

import {
  streamSynthesizeConcept,
  streamSynthesizeFromConcept,
  type SynthesizerOutput,
  type SynthesizerStream,
} from '../../llm/prep/synthesize-concept.js'
import { runInputGate } from '../../llm/prep/input-gate.js'
import type { LanguageModelUsage } from 'ai'

const streamSynthesizeConceptMock = vi.mocked(streamSynthesizeConcept)
const streamSynthesizeFromConceptMock = vi.mocked(streamSynthesizeFromConcept)
const runInputGateMock = vi.mocked(runInputGate)

const STUB_USAGE: LanguageModelUsage = {
  inputTokens: 10,
  outputTokens: 10,
  totalTokens: 20,
  inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 10, reasoningTokens: 0 },
}

const databaseUrl = process.env.DATABASE_URL ?? ''
const REDIS_KEY_PREFIX = `test:campaign-preview-stream-${String(Date.now())}:`
const FRONTEND_BASE_URL = 'http://localhost:5173'

const VALID_PICKS = [
  { title: 'Studio Ghibli films', whyILikeIt: 'gentle melancholy and wind' },
  { title: 'Old maritime journals', whyILikeIt: 'isolation and salt' },
  { title: 'Stories about memory', whyILikeIt: 'what things remember' },
]

const TITLE = 'The Lamp Archipelago'
const CONCEPT =
  'A rain-soaked archipelago where lighthouses are sentient and remember every shipwreck.'
const INTENT: SynthesizerOutput['intentSummary'] = {
  aesthetics: ['rain', 'salt'],
  themes: ['memory'],
  sourcesInternal: ['p1', 'p2', 'p3'],
}

/** Build a SynthesizerStream stub: yields `deltas`, then settles `output`. */
function fakeSynthStream(opts: {
  deltas: readonly string[]
  output?: SynthesizerOutput
  outputError?: unknown
}): SynthesizerStream {
  async function* gen(): AsyncGenerator<string> {
    for (const d of opts.deltas) yield d
  }
  let output: Promise<SynthesizerOutput>
  if (opts.outputError !== undefined) {
    output = Promise.reject(opts.outputError)
    // Mark the eager rejection handled (the fixture is built before the route
    // consumes it); the route's `await` still observes the rejection.
    output.catch(() => undefined)
  } else {
    output = Promise.resolve(opts.output ?? { title: TITLE, concept: CONCEPT, intentSummary: INTENT })
  }
  return { deltas: gen(), output }
}

interface SseFrame {
  event: string
  data: unknown
}

/** Parse a raw SSE response body into its frames (comment frames skipped). */
function parseFrames(body: string): SseFrame[] {
  const frames: SseFrame[] = []
  for (const raw of body.split('\n\n')) {
    let event = 'message'
    let data = ''
    let sawField = false
    for (const line of raw.split('\n')) {
      if (line.length === 0 || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const name = colon === -1 ? line : line.slice(0, colon)
      const valueRaw = colon === -1 ? '' : line.slice(colon + 1)
      const value = valueRaw.startsWith(' ') ? valueRaw.slice(1) : valueRaw
      if (name === 'event') {
        event = value
        sawField = true
      } else if (name === 'data') {
        data = data === '' ? value : `${data}\n${value}`
        sawField = true
      }
    }
    if (sawField) frames.push({ event, data: data === '' ? undefined : JSON.parse(data) })
  }
  return frames
}

/** The `data:` frames (the typed event union), excluding the `close` frame. */
function dataFrames(body: string): { type: string; [k: string]: unknown }[] {
  return parseFrames(body)
    .filter((f) => f.event === 'message')
    .map((f) => f.data as { type: string; [k: string]: unknown })
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

async function buildTestApp(pool: Pool, redis: Redis): Promise<FastifyInstance> {
  globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))

  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(bypassPlugin)
  await app.register(requireOnboarded, { pool })
  await app.register(campaignPreviewStreamRoutes, {
    pool,
    redis,
    redisKeyPrefix: REDIS_KEY_PREFIX,
    frontendBaseUrl: FRONTEND_BASE_URL,
  })
  await app.ready()
  return app
}

function inject(app: FastifyInstance, devSub: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/campaigns/synthesize-preview/stream',
    headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
    payload: payload as Record<string, unknown>,
  })
}

describe('POST /api/campaigns/synthesize-preview/stream (myth-umggn)', () => {
  let pool: Pool
  let redis: Redis
  let app: FastifyInstance
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('campaign-preview-stream')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'test')

    redis = new IoredisMock()

    streamSynthesizeConceptMock.mockReset()
    streamSynthesizeFromConceptMock.mockReset()
    runInputGateMock.mockReset()
    streamSynthesizeConceptMock.mockReturnValue(
      fakeSynthStream({ deltas: [CONCEPT], output: { title: TITLE, concept: CONCEPT, intentSummary: INTENT } }),
    )
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
  // Happy path: deltas → complete, preview parked exactly like the JSON route
  // -----------------------------------------------------------------------

  it('streams delta frames then a terminal complete; parks the preview (reworkCount:0, non-charging)', async () => {
    const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
    streamSynthesizeConceptMock.mockReturnValue(
      fakeSynthStream({
        deltas: ['A rain-soaked archipelago ', 'where lighthouses are sentient ', 'and remember every shipwreck.'],
        output: { title: TITLE, concept: CONCEPT, intentSummary: INTENT },
      }),
    )

    const res = await inject(app, devSub, { picks: VALID_PICKS })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')

    const events = dataFrames(res.body)
    const deltas = events.filter((e) => e.type === 'delta')
    expect(deltas.map((d) => d.text).join('')).toBe(CONCEPT)
    const terminal = events[events.length - 1]
    // myth-z3icr: the terminal carries the world's NAME alongside the prose.
    expect(terminal).toMatchObject({ type: 'complete', title: TITLE, concept: CONCEPT })
    const previewId = String(terminal?.previewId)
    expect(previewId).toMatch(/^[0-9a-f-]{36}$/)

    // The server closes the one-shot stream with the 'complete' reason.
    const closeFrame = parseFrames(res.body).find((f) => f.event === 'close')
    expect(closeFrame?.data).toEqual({ reason: 'complete' })

    // Parked EXACTLY like the non-streaming route: same store, reworkCount:0.
    const stored = await getPreview(redis, REDIS_KEY_PREFIX, userId, previewId)
    expect(stored?.title).toBe(TITLE)
    expect(stored?.concept).toBe(CONCEPT)
    expect(stored?.reworkCount).toBe(0)

    // Non-charging: only the +1 gift in the ledger.
    const balance = await pool.query<{ balance: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS balance FROM credit_ledger
       WHERE user_id = $1 AND credit_type = 'world_gen'`,
      [userId],
    )
    expect(Number(balance.rows[0]?.balance)).toBe(1)

    // The gate judged the FINAL (validated) concept — with the disconnect
    // signal threaded, so a client gone during the gate beat cancels it too.
    expect(runInputGateMock).toHaveBeenCalledTimes(1)
    expect(runInputGateMock.mock.calls[0]?.[0]?.concept).toBe(CONCEPT)
    expect(runInputGateMock.mock.calls[0]?.[0]?.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('the terminal complete carries the VALIDATED concept when it diverges from the streamed text (repair)', async () => {
    const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
    const repaired = 'A repaired concept the post-stream validation produced.'
    streamSynthesizeConceptMock.mockReturnValue(
      fakeSynthStream({
        deltas: ['A half-streamed brief that the repair chain rewrote'],
        output: { title: TITLE, concept: repaired, intentSummary: INTENT },
      }),
    )

    const res = await inject(app, devSub, { picks: VALID_PICKS })

    const events = dataFrames(res.body)
    const terminal = events[events.length - 1]
    expect(terminal).toMatchObject({ type: 'complete', concept: repaired })
    const stored = await getPreview(redis, REDIS_KEY_PREFIX, userId, String(terminal?.previewId))
    expect(stored?.concept).toBe(repaired)
  })

  // -----------------------------------------------------------------------
  // Gate reject: terminal rejected frame mirrors the 422 payload
  // -----------------------------------------------------------------------

  it('gate reject ends in a terminal rejected frame (422-payload mirror), increments the storm counter, parks nothing', async () => {
    const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
    runInputGateMock.mockResolvedValue({
      verdict: 'reject',
      reason: 'clone_intent',
      rejectionMessage: 'This reads as a clone of a copyrighted work.',
      reasoning: 'clone_intent: server-only reasoning',
      usage: STUB_USAGE,
    })

    const res = await inject(app, devSub, { picks: VALID_PICKS })

    expect(res.statusCode).toBe(200)
    const events = dataFrames(res.body)
    const terminal = events[events.length - 1]
    expect(terminal).toEqual({
      type: 'rejected',
      code: 'concept_rejected',
      reason: 'clone_intent',
      rejectionMessage: 'This reads as a clone of a copyrighted work.',
      synthesizedConcept: CONCEPT,
    })
    // Server-only reasoning never leaks into any frame.
    expect(res.body).not.toContain('server-only reasoning')
    // No complete frame, nothing parked.
    expect(events.some((e) => e.type === 'complete')).toBe(false)
    // The storm counter incremented (same side-effect as the 422 route).
    const count = await redis.get(`${REDIS_KEY_PREFIX}rejection_storm:${userId}`)
    expect(count).toBe('1')
  })

  // -----------------------------------------------------------------------
  // Guard order: pre-stream failures are PLAIN JSON, zero LLM calls
  // -----------------------------------------------------------------------

  it('403 insufficient_credits as plain JSON when balance is 0 — stream never starts', async () => {
    const { devSub } = await seedUserWithCredits(pool, scope, 0)

    const res = await inject(app, devSub, { picks: VALID_PICKS })

    expect(res.statusCode).toBe(403)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.json()).toEqual({ code: 'insufficient_credits', creditType: 'world_gen' })
    expect(streamSynthesizeConceptMock).not.toHaveBeenCalled()
    expect(runInputGateMock).not.toHaveBeenCalled()
  })

  it('429 rejection_storm_cooldown as plain JSON — stream never starts', async () => {
    const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
    await redis.set(`${REDIS_KEY_PREFIX}rejection_storm:${userId}`, '4', 'EX', 3600)

    const res = await inject(app, devSub, { picks: VALID_PICKS })

    expect(res.statusCode).toBe(429)
    expect(res.json<{ code: string }>().code).toBe('rejection_storm_cooldown')
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    expect(streamSynthesizeConceptMock).not.toHaveBeenCalled()
  })

  it('400 invalid_body as plain JSON on the wrong number of picks', async () => {
    const { devSub } = await seedUserWithCredits(pool, scope, 1)

    const res = await inject(app, devSub, {
      picks: [{ title: 'A', whyILikeIt: 'a' }],
    })

    expect(res.statusCode).toBe(400)
    expect(res.json<{ code: string }>().code).toBe('invalid_body')
    expect(streamSynthesizeConceptMock).not.toHaveBeenCalled()
  })


  // -----------------------------------------------------------------------
  // myth-6t06f — the FREEFORM arm streams the same proposal from the
  // player's own words, gating them BEFORE a token of Sonnet burns.
  // -----------------------------------------------------------------------

  describe('freeform proposal (myth-6t06f)', () => {
    const PLAYER_CONCEPT =
      'A drowned harbour town where the salvage guilds fight over what the tide gives back.'
    const FREEFORM_TITLE = 'The Ninth Tide'
    const FREEFORM_CONCEPT = 'The drowned harbour town, rendered back as a proposal.'

    beforeEach(() => {
      streamSynthesizeFromConceptMock.mockReturnValue(
        fakeSynthStream({
          deltas: [FREEFORM_CONCEPT],
          output: { title: FREEFORM_TITLE, concept: FREEFORM_CONCEPT, intentSummary: INTENT },
        }),
      )
    })

    it('streams the player concept into a titled complete frame and parks it', async () => {
      const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)

      const res = await inject(app, devSub, { concept: PLAYER_CONCEPT })

      expect(res.statusCode).toBe(200)
      const events = dataFrames(res.body)
      expect(events.filter((e) => e.type === 'delta').map((d) => d.text).join('')).toBe(
        FREEFORM_CONCEPT,
      )
      const terminal = events[events.length - 1]
      expect(terminal).toMatchObject({
        type: 'complete',
        title: FREEFORM_TITLE,
        concept: FREEFORM_CONCEPT,
      })

      // Parked EXACTLY like a brainstorm proposal — same store, same record.
      const stored = await getPreview(redis, REDIS_KEY_PREFIX, userId, String(terminal?.previewId))
      expect(stored?.title).toBe(FREEFORM_TITLE)
      expect(stored?.reworkCount).toBe(0)

      // The freeform synthesizer ran; the brainstorm one never did.
      expect(streamSynthesizeFromConceptMock).toHaveBeenCalledTimes(1)
      expect(streamSynthesizeFromConceptMock.mock.calls[0]?.[0]).toBe(PLAYER_CONCEPT)
      expect(streamSynthesizeConceptMock).not.toHaveBeenCalled()
    })

    it('gates the player RAW words ONCE, before the stream opens', async () => {
      const { devSub } = await seedUserWithCredits(pool, scope, 1)

      await inject(app, devSub, { concept: PLAYER_CONCEPT })

      // One gate call, on the PLAYER's text — never a second pass over the
      // synthesis (which would double the cost and re-judge unaltered text).
      expect(runInputGateMock).toHaveBeenCalledTimes(1)
      expect(runInputGateMock.mock.calls[0]?.[0]?.concept).toBe(PLAYER_CONCEPT)
      expect(runInputGateMock.mock.calls[0]?.[0]?.intentSummary).toBeNull()
      expect(runInputGateMock.mock.calls[0]?.[0]?.abortSignal).toBeInstanceOf(AbortSignal)
    })

    it('a rejected concept ends in a rejected frame echoing the PLAYER text, with ZERO synthesis', async () => {
      const { userId, devSub } = await seedUserWithCredits(pool, scope, 1)
      runInputGateMock.mockResolvedValue({
        verdict: 'reject',
        reason: 'inappropriate',
        rejectionMessage: "That's off the table here.",
        reasoning: 'server-only reasoning',
        usage: STUB_USAGE,
      })

      const res = await inject(app, devSub, { concept: PLAYER_CONCEPT })

      const events = dataFrames(res.body)
      expect(events[events.length - 1]).toEqual({
        type: 'rejected',
        code: 'concept_rejected',
        reason: 'inappropriate',
        rejectionMessage: "That's off the table here.",
        // The judged text IS the player's own — the rejection screen shows it
        // and seeds "adjust it yourself" from it.
        synthesizedConcept: PLAYER_CONCEPT,
      })
      expect(res.body).not.toContain('server-only reasoning')
      // Not one delta arrived: the gate ran before the stream did.
      expect(events.some((e) => e.type === 'delta')).toBe(false)
      expect(streamSynthesizeFromConceptMock).not.toHaveBeenCalled()
      // Same side-effect as every other rejection.
      expect(await redis.get(`${REDIS_KEY_PREFIX}rejection_storm:${userId}`)).toBe('1')
    })

    it('400 invalid_body as plain JSON on a concept under the 20-char floor', async () => {
      const { devSub } = await seedUserWithCredits(pool, scope, 1)

      const res = await inject(app, devSub, { concept: 'too short' })

      expect(res.statusCode).toBe(400)
      expect(res.json<{ code: string }>().code).toBe('invalid_body')
      expect(runInputGateMock).not.toHaveBeenCalled()
      expect(streamSynthesizeFromConceptMock).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // Failure honesty: mid-stream failures end in a terminal error frame
  // -----------------------------------------------------------------------

  it('content-filter failure → terminal error frame {code: content_filtered}', async () => {
    const { devSub } = await seedUserWithCredits(pool, scope, 1)
    streamSynthesizeConceptMock.mockReturnValue(
      fakeSynthStream({
        deltas: ['Half a br'],
        outputError: new LlmContentFilteredError('content filter tripped'),
      }),
    )

    const res = await inject(app, devSub, { picks: VALID_PICKS })

    expect(res.statusCode).toBe(200)
    const events = dataFrames(res.body)
    expect(events[events.length - 1]).toEqual({ type: 'error', code: 'content_filtered' })
    expect(runInputGateMock).not.toHaveBeenCalled()
  })

  it('upstream LLM failure → terminal error frame {code: llm_upstream_unavailable}', async () => {
    const { devSub } = await seedUserWithCredits(pool, scope, 1)
    streamSynthesizeConceptMock.mockReturnValue(
      fakeSynthStream({
        deltas: [],
        outputError: new LlmRateLimitedError('upstream rate limited'),
      }),
    )

    const res = await inject(app, devSub, { picks: VALID_PICKS })

    const events = dataFrames(res.body)
    expect(events[events.length - 1]).toEqual({
      type: 'error',
      code: 'llm_upstream_unavailable',
    })
  })

  it('non-LLM failure after open (gate throws) → terminal error frame {code: internal_error}', async () => {
    const { devSub } = await seedUserWithCredits(pool, scope, 1)
    runInputGateMock.mockRejectedValue(new Error('redis fell over'))

    const res = await inject(app, devSub, { picks: VALID_PICKS })

    const events = dataFrames(res.body)
    expect(events[events.length - 1]).toEqual({ type: 'error', code: 'internal_error' })
  })
})
