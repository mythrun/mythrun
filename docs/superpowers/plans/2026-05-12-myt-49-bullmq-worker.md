# MYT-49 BullMQ worker + `wrapStream` middleware — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the no-op `backend/src/worker.ts` shell into a production-shaped BullMQ worker with two `Worker` instances (`world-gen` + `campaign-setup`), a containerized `/health` server on port 3001, graceful shutdown bounded under ECS `stopTimeout`, and extend MYT-44's LLM middleware with `wrapStream` so streaming prep stages can emit cost-attributed log lines. Flip the worker ECS service from `desired_count=0` → 1 via a new CI Deploy job.

**Architecture:** New `backend/src/worker/` directory holds the worker-specific modules (bullmq-config constants, stub processor, Fastify health server). A new `backend/src/redis/bullmq-client.ts` factory creates ioredis clients with BullMQ-compatible options (`maxRetriesPerRequest: null`). The existing `backend/src/llm/middleware.ts` gets a `wrapStream` implementation governed by a 6-state terminal-state matrix — each state produces exactly one log line, gated by a `terminated` flag. Infra: TF gets a worker `healthCheck` + `health_check_grace_period_seconds = 120`; CI gets a separate `deploy-staging-worker` job mirroring the API pattern verbatim.

**Tech Stack:** Node 24 + TypeScript strict mode + Fastify 5 + BullMQ 5 + ioredis 5 + pg 8 + Vercel AI SDK v3 + Vitest + Terraform + GitHub Actions.

**Working directory:** `.worktrees/myt-49/` (worktree on branch `myt-49-bullmq-worker`). All commands below run from this directory unless noted.

**Spec:** `docs/superpowers/specs/2026-05-12-myt-49-bullmq-worker-design.md`

---

### Task 1: Install BullMQ + regenerate lockfile

Foundation — must land first; everything else imports BullMQ types.

**Files:**
- Modify: `backend/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Install bullmq in the backend workspace**

```bash
pnpm add --filter @mythrun/backend bullmq@^5
```

Expected: pnpm resolves `bullmq` 5.x, adds it to `backend/package.json` `dependencies`, regenerates `pnpm-lock.yaml` (new entry + transitive deps like `msgpackr`, `node-abort-controller`).

- [ ] **Step 2: Verify install**

```bash
pnpm install --frozen-lockfile
```

Expected: 0 errors, lockfile matches. Confirms the lock change is committable as-is.

- [ ] **Step 3: Verify backend typecheck still passes**

```bash
pnpm --filter @mythrun/backend typecheck
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add backend/package.json pnpm-lock.yaml
git commit -m "chore(myt-49): add bullmq dep to backend workspace

Required for the prep-pipeline worker. Two Worker instances will land
in the next commits — world-gen (concurrency 3) and campaign-setup
(concurrency 5)."
```

---

### Task 2: `bullmq-config.ts` constants

Tiny constants module — single source of truth for queue names + concurrency caps.

**Files:**
- Create: `backend/src/worker/bullmq-config.ts`

- [ ] **Step 1: Create the file**

```ts
// Queue identifiers + concurrency caps. The worker uses these to register
// Worker instances; the API will use the same identifiers to enqueue jobs.
// Concurrency caps follow spec §6 Queue Architecture: 3 for world-gen
// (Opus heavy), 5 for campaign-setup (per-player parallelism × 5 players).

export const QUEUE_WORLD_GEN = 'world-gen' as const
export const QUEUE_CAMPAIGN_SETUP = 'campaign-setup' as const

export const CONCURRENCY_WORLD_GEN = 3
export const CONCURRENCY_CAMPAIGN_SETUP = 5
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm --filter @mythrun/backend typecheck
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add backend/src/worker/bullmq-config.ts
git commit -m "feat(myt-49): queue identifier + concurrency constants

Single source of truth for queue names and concurrency caps. Worker
registrations and future API-side Queue enqueueing will import from
here."
```

---

### Task 3: `bullmq-client.ts` factory

BullMQ-compatible ioredis factory. The existing `createRedisClient` sets `maxRetriesPerRequest: 1` which BullMQ throws on at startup.

**Files:**
- Create: `backend/src/redis/bullmq-client.ts`

- [ ] **Step 1: Create the file**

```ts
import { Redis, type RedisOptions } from 'ioredis'

/**
 * BullMQ-compatible ioredis factory. The Worker / QueueEvents instances need
 * settings that diverge from the API's fast-fail Redis profile:
 *
 *   - maxRetriesPerRequest: null      // BullMQ throws if this is set; blocking commands MUST allow indefinite retry
 *   - enableOfflineQueue:  true       // default; Workers queue commands during reconnect
 *   - retryStrategy:       default exp-backoff (vs API's `() => null` which would disable reconnect)
 *
 * Used only by the worker process. The API process keeps using the existing
 * `createRedisClient` for its rate-limiter + future Queue enqueueing.
 */
export function createBullmqRedisClient(url: string): Redis {
  const options: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  }
  const client = new Redis(url, options)
  // Same error swallow as createRedisClient — real errors surface via
  // promise rejections.
  client.on('error', () => undefined)
  return client
}
```

- [ ] **Step 2: Verify typecheck + lint**

```bash
pnpm --filter @mythrun/backend typecheck
pnpm --filter @mythrun/backend lint
```

Both expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add backend/src/redis/bullmq-client.ts
git commit -m "feat(myt-49): BullMQ-compatible ioredis factory

BullMQ Workers require maxRetriesPerRequest: null and an active
retryStrategy (so the Worker survives transient Redis blips). The
existing createRedisClient sets these the wrong way (fast-fail
profile for the API's rate-limiter). Use createBullmqRedisClient for
the worker; keep createRedisClient unchanged for the API."
```

---

### Task 4: `stub-processor.ts` (TDD)

No-op job processor. Real stage logic lands in MYT-51 onward.

**Files:**
- Create: `backend/src/worker/stub-processor.ts`
- Create: `backend/src/worker/__tests__/stub-processor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/worker/__tests__/stub-processor.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from 'pino'
import type { Job } from 'bullmq'
import { makeStubProcessor } from '../stub-processor.js'

function mockLogger(): Logger {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger
}

function mockJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-123',
    queueName: 'world-gen',
    data: { type: 'world-gen' },
    updateProgress: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as Job
}

describe('makeStubProcessor', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('logs worker.job.received and marks progress 100', async () => {
    const logger = mockLogger()
    const job = mockJob()
    const processor = makeStubProcessor(logger)

    await processor(job)

    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'worker.job.received',
        queue: 'world-gen',
        jobId: 'job-123',
        type: 'world-gen',
      }),
      expect.stringContaining('stub processor'),
    )
    expect(job.updateProgress).toHaveBeenCalledWith(100)
  })

  it('handles a job with non-object data without crashing', async () => {
    const logger = mockLogger()
    const job = mockJob({ data: 'string-payload' as unknown as Record<string, unknown> })
    const processor = makeStubProcessor(logger)

    await processor(job)

    expect(logger.info).toHaveBeenCalledOnce()
    const firstCall = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(firstCall?.[0]).toMatchObject({ type: undefined })
  })
})
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @mythrun/backend test src/worker/__tests__/stub-processor.test.ts --run
```

Expected: failure with `Cannot find module '../stub-processor.js'` or similar.

- [ ] **Step 3: Implement `stub-processor.ts`**

Create `backend/src/worker/stub-processor.ts`:

```ts
// Stub job processor — logs the receipt + marks progress complete, no real
// work. Real stage logic lands in MYT-51 (world gen non-streaming),
// MYT-52 (world gen streaming + entity events), MYT-53 (per-player
// character creation), MYT-54 (post-creation + barrier).
//
// Returning normally marks the BullMQ job 'completed'. Throwing would
// move it to 'failed'. We return; stubs should never fail.

import type { Job } from 'bullmq'
import type { Logger } from 'pino'

export function makeStubProcessor(logger: Logger): (job: Job) => Promise<void> {
  return async function stubProcessor(job: Job): Promise<void> {
    const dataType =
      typeof job.data === 'object' && job.data !== null && 'type' in job.data
        ? (job.data as { type: unknown }).type
        : undefined
    logger.info(
      {
        event: 'worker.job.received',
        queue: job.queueName,
        jobId: job.id,
        type: dataType,
      },
      'stub processor — real stage logic lands in MYT-51 onward',
    )
    await job.updateProgress(100)
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm --filter @mythrun/backend test src/worker/__tests__/stub-processor.test.ts --run
```

Expected: 2 tests pass.

- [ ] **Step 5: Verify typecheck + lint**

```bash
pnpm --filter @mythrun/backend typecheck
pnpm --filter @mythrun/backend lint
```

Both expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add backend/src/worker/stub-processor.ts backend/src/worker/__tests__/stub-processor.test.ts
git commit -m "feat(myt-49): no-op stub processor + tests

Factory pattern (makeStubProcessor(logger)) so tests can inject a mock
logger. Logs event: 'worker.job.received' with queue/jobId/data.type,
then marks progress 100. Returns normally so BullMQ marks the job
'completed'. Real stage logic lands MYT-51 onward."
```

---

### Task 5: `health-server.ts` (TDD)

Fastify on port 3001 with `GET /health` route. Probes all four runtime deps.

**Files:**
- Create: `backend/src/worker/health-server.ts`
- Create: `backend/src/worker/__tests__/health-server.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/worker/__tests__/health-server.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { Worker as BullmqWorker } from 'bullmq'
import type { FastifyInstance } from 'fastify'
import { startHealthServer } from '../health-server.js'

function mockPool(queryImpl?: () => Promise<unknown>): Pool {
  return { query: vi.fn(queryImpl ?? (async () => ({ rows: [] }))) } as unknown as Pool
}

function mockRedis(pingImpl?: () => Promise<string>): Redis {
  return { ping: vi.fn(pingImpl ?? (async () => 'PONG')) } as unknown as Redis
}

function mockWorker(name: string, isRunning = true): BullmqWorker {
  return { name, isRunning: vi.fn(() => isRunning) } as unknown as BullmqWorker
}

describe('startHealthServer', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
  })

  it('returns 200 with { healthy: true } when all probes pass', async () => {
    app = await startHealthServer(0, {
      pg: mockPool(),
      redisBatch: mockRedis(),
      redisRealtime: mockRedis(),
      workers: [mockWorker('world-gen'), mockWorker('campaign-setup')],
    })

    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ healthy: true })
  })

  it('returns 503 with the failed probe name when pg fails', async () => {
    app = await startHealthServer(0, {
      pg: mockPool(() => Promise.reject(new Error('pg down'))),
      redisBatch: mockRedis(),
      redisRealtime: mockRedis(),
      workers: [mockWorker('world-gen'), mockWorker('campaign-setup')],
    })

    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ healthy: false, failed: ['pg'] })
  })

  it('returns 503 with worker-<name> when a BullMQ worker is not running', async () => {
    app = await startHealthServer(0, {
      pg: mockPool(),
      redisBatch: mockRedis(),
      redisRealtime: mockRedis(),
      workers: [mockWorker('world-gen', true), mockWorker('campaign-setup', false)],
    })

    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ healthy: false, failed: ['worker-campaign-setup'] })
  })
})
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @mythrun/backend test src/worker/__tests__/health-server.test.ts --run
```

Expected: `Cannot find module '../health-server.js'`.

- [ ] **Step 3: Implement `health-server.ts`**

Create `backend/src/worker/health-server.ts`:

```ts
// Worker /health endpoint on port 3001 (bound to 127.0.0.1). Container ECS
// healthCheck hits this. 200 when all four runtime deps respond within
// PROBE_TIMEOUT_MS: redis-batch, redis-realtime, pg, and both BullMQ
// workers running. 503 otherwise with the failed probe names in the
// response body.

import Fastify, { type FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { Worker as BullmqWorker } from 'bullmq'

const PROBE_TIMEOUT_MS = 1000

interface HealthDeps {
  readonly pg: Pool
  readonly redisBatch: Redis
  readonly redisRealtime: Redis
  readonly workers: ReadonlyArray<BullmqWorker>
}

interface ProbeResult {
  readonly name: string
  readonly ok: boolean
}

async function probe(name: string, fn: () => Promise<unknown>): Promise<ProbeResult> {
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(`probe timeout after ${String(PROBE_TIMEOUT_MS)}ms`))
        }, PROBE_TIMEOUT_MS)
      }),
    ])
    return { name, ok: true }
  } catch {
    return { name, ok: false }
  }
}

export async function startHealthServer(
  port: number,
  deps: HealthDeps,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  app.get('/health', async (_req, reply) => {
    const probes = await Promise.all([
      probe('redis-batch', () => deps.redisBatch.ping()),
      probe('redis-realtime', () => deps.redisRealtime.ping()),
      probe('pg', () => deps.pg.query('SELECT 1')),
      ...deps.workers.map((w) =>
        probe(`worker-${w.name}`, async () => {
          if (!w.isRunning()) throw new Error('worker is not running')
        }),
      ),
    ])
    const failed = probes.filter((r) => !r.ok).map((r) => r.name)
    if (failed.length > 0) {
      return reply.code(503).send({ healthy: false, failed })
    }
    return reply.code(200).send({ healthy: true })
  })

  await app.listen({ host: '127.0.0.1', port })
  return app
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm --filter @mythrun/backend test src/worker/__tests__/health-server.test.ts --run
```

Expected: 3 tests pass.

- [ ] **Step 5: Verify typecheck + lint**

```bash
pnpm --filter @mythrun/backend typecheck
pnpm --filter @mythrun/backend lint
```

Both expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add backend/src/worker/health-server.ts backend/src/worker/__tests__/health-server.test.ts
git commit -m "feat(myt-49): worker /health Fastify server + tests

Tiny Fastify on 127.0.0.1:3001 with one route. Probes pg + redisBatch
+ redisRealtime + both BullMQ workers' isRunning() state, with a 1s
timeout per probe. 200 healthy / 503 with failed[]. ECS container
healthCheck (added in TF in a later task) hits this."
```

---

### Task 6: `middleware.ts` `wrapStream` extension (TDD, 9 cases)

This is the heaviest task — 9 test cases per the spec's terminal-state matrix.

**Files:**
- Modify: `backend/src/llm/middleware.ts` (extend `MythrunContext`, add `wrapStream`)
- Create: `backend/src/llm/__tests__/middleware-stream.test.ts`

- [ ] **Step 1: Write the failing test file (all 9 cases)**

Create `backend/src/llm/__tests__/middleware-stream.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, assert } from 'vitest'
import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import { logAndNormalizeMiddleware } from '../middleware.js'
import { logger } from '../logger.js'
import { LlmRateLimitedError, LlmStructuredOutputError, LlmAuthError } from '../errors.js'

const stubModel = {} as LanguageModelV3
const stubGenerate = (): Promise<never> => Promise.reject(new Error('generate not used'))

function makeStream(
  parts: LanguageModelV3StreamPart[],
): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
}

function makeStreamResult(
  parts: LanguageModelV3StreamPart[],
): LanguageModelV3StreamResult {
  return {
    stream: makeStream(parts),
    request: undefined,
    response: undefined,
  } as LanguageModelV3StreamResult
}

function emptyParams(): LanguageModelV3CallOptions {
  return {} as LanguageModelV3CallOptions
}

function paramsWithContext(mythrun: Record<string, unknown>): LanguageModelV3CallOptions {
  return { providerOptions: { mythrun } } as LanguageModelV3CallOptions
}

const finishPart = (
  inputTokens = 47,
  outputTokens = 8,
  unified = 'stop' as const,
): LanguageModelV3StreamPart => ({
  type: 'finish',
  usage: {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
  },
  finishReason: { unified, raw: 'end_turn' },
})

const textDeltaPart = (text: string): LanguageModelV3StreamPart => ({
  type: 'text-delta',
  id: 'block-1',
  delta: text,
})

async function drainStream(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
  const out: LanguageModelV3StreamPart[] = []
  for await (const part of stream) out.push(part)
  return out
}

describe('logAndNormalizeMiddleware wrapStream', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('case 1 — Success: finish with usage logs llm.call once with tokens + mode=stream', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-sonnet-test')
    assert(mw.wrapStream !== undefined, 'wrapStream must be defined')

    const out = await mw.wrapStream({
      doGenerate: stubGenerate,
      doStream: () =>
        Promise.resolve(makeStreamResult([textDeltaPart('h'), textDeltaPart('i'), finishPart()])),
      params: emptyParams(),
      model: stubModel,
    })

    const parts = await drainStream(out.stream)
    expect(parts.length).toBeGreaterThanOrEqual(3)
    expect(infoSpy).toHaveBeenCalledOnce()
    expect(errorSpy).not.toHaveBeenCalled()
    const [obj, msg] = infoSpy.mock.calls[0] ?? []
    expect(obj).toMatchObject({
      event: 'llm.call',
      model: 'claude-sonnet-test',
      mode: 'stream',
      inputTokens: 47,
      outputTokens: 8,
      totalTokens: 55,
      finishReason: 'stop',
    })
    expect(msg).toContain('stream completed')
  })

  it('case 2 — Success with finishReason=error: logs llm.call, not llm.error', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-haiku-test')
    assert(mw.wrapStream !== undefined)

    const out = await mw.wrapStream({
      doGenerate: stubGenerate,
      doStream: () =>
        Promise.resolve(makeStreamResult([textDeltaPart('hi'), finishPart(20, 4, 'error')])),
      params: emptyParams(),
      model: stubModel,
    })

    await drainStream(out.stream)
    expect(infoSpy).toHaveBeenCalledOnce()
    expect(errorSpy).not.toHaveBeenCalled()
    expect(infoSpy.mock.calls[0]?.[0]).toMatchObject({
      event: 'llm.call',
      finishReason: 'error',
      inputTokens: 20,
      outputTokens: 4,
    })
  })

  it('case 3 — In-stream error part: logs llm.error once, consumer throws Mythrun-typed error', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-sonnet-test')
    assert(mw.wrapStream !== undefined)

    const rateLimitErr = new APICallError({
      message: 'rate limited',
      url: 'https://api.anthropic.com/v1/messages',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: {},
      responseBody: 'rate limited',
    })
    const errorPart: LanguageModelV3StreamPart = { type: 'error', error: rateLimitErr }

    const out = await mw.wrapStream({
      doGenerate: stubGenerate,
      doStream: () => Promise.resolve(makeStreamResult([textDeltaPart('h'), errorPart])),
      params: emptyParams(),
      model: stubModel,
    })

    await expect(drainStream(out.stream)).rejects.toBeInstanceOf(LlmRateLimitedError)
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(infoSpy).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
      event: 'llm.error',
      mode: 'stream',
    })
  })

  it('case 4 — Truncation: stream closes without finish, logs llm.error + throws LlmStructuredOutputError', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-sonnet-test')
    assert(mw.wrapStream !== undefined)

    const out = await mw.wrapStream({
      doGenerate: stubGenerate,
      doStream: () => Promise.resolve(makeStreamResult([textDeltaPart('h'), textDeltaPart('i')])),
      params: emptyParams(),
      model: stubModel,
    })

    await expect(drainStream(out.stream)).rejects.toBeInstanceOf(LlmStructuredOutputError)
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(infoSpy).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
      event: 'llm.error',
      reason: 'truncated',
    })
  })

  it('case 5 — Cancellation: reader.cancel() logs llm.error with reason=cancelled', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-sonnet-test')
    assert(mw.wrapStream !== undefined)

    const slowStream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue(textDeltaPart('h'))
        // Don't close — wait for cancellation
        await new Promise(() => undefined)
      },
    })

    const out = await mw.wrapStream({
      doGenerate: stubGenerate,
      doStream: () =>
        Promise.resolve({
          stream: slowStream,
          request: undefined,
          response: undefined,
        } as LanguageModelV3StreamResult),
      params: emptyParams(),
      model: stubModel,
    })

    const reader = out.stream.getReader()
    const firstChunk = await reader.read()
    expect(firstChunk.done).toBe(false)
    await reader.cancel('aborted by test')
    // Give microtasks a tick to fire the cancel handler
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(errorSpy).toHaveBeenCalledOnce()
    expect(infoSpy).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
      event: 'llm.error',
      reason: 'cancelled',
    })
  })

  it('case 6 — Open-time error: doStream rejects, wrapStream throws Mythrun-typed error', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-sonnet-test')
    assert(mw.wrapStream !== undefined)

    const authErr = new APICallError({
      message: 'unauthorized',
      url: 'https://api.anthropic.com/v1/messages',
      requestBodyValues: {},
      statusCode: 401,
      responseHeaders: {},
      responseBody: 'unauthorized',
    })

    await expect(
      mw.wrapStream({
        doGenerate: stubGenerate,
        doStream: () => Promise.reject(authErr),
        params: emptyParams(),
        model: stubModel,
      }),
    ).rejects.toBeInstanceOf(LlmAuthError)

    expect(errorSpy).toHaveBeenCalledOnce()
    expect(infoSpy).not.toHaveBeenCalled()
  })

  it('case 7 — Context threading: worldId + stage threaded into log line', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-opus-test')
    assert(mw.wrapStream !== undefined)

    const out = await mw.wrapStream({
      doGenerate: stubGenerate,
      doStream: () => Promise.resolve(makeStreamResult([finishPart()])),
      params: paramsWithContext({ worldId: 'w1', stage: 'world_and_factions' }),
      model: stubModel,
    })
    await drainStream(out.stream)

    expect(infoSpy).toHaveBeenCalledOnce()
    expect(infoSpy.mock.calls[0]?.[0]).toMatchObject({
      worldId: 'w1',
      stage: 'world_and_factions',
    })
    // Absent fields are undefined (pino omits)
    const obj = infoSpy.mock.calls[0]?.[0] as Record<string, unknown>
    expect(obj.sessionId).toBeUndefined()
    expect(obj.userId).toBeUndefined()
    expect(obj.campaignId).toBeUndefined()
  })

  it('case 8 — No-usage finish: undefined tokens, doesnt crash', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-haiku-test')
    assert(mw.wrapStream !== undefined)

    // finishPart with missing totals
    const noUsageFinish: LanguageModelV3StreamPart = {
      type: 'finish',
      usage: {
        inputTokens: {
          total: undefined as unknown as number,
          noCache: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: undefined as unknown as number,
          text: 0,
          reasoning: 0,
        },
      },
      finishReason: { unified: 'stop', raw: 'end_turn' },
    }

    const out = await mw.wrapStream({
      doGenerate: stubGenerate,
      doStream: () => Promise.resolve(makeStreamResult([noUsageFinish])),
      params: emptyParams(),
      model: stubModel,
    })
    await drainStream(out.stream)

    expect(infoSpy).toHaveBeenCalledOnce()
    const obj = infoSpy.mock.calls[0]?.[0] as Record<string, unknown>
    expect(obj.inputTokens).toBeUndefined()
    expect(obj.outputTokens).toBeUndefined()
    expect(obj.totalTokens).toBeUndefined()
  })

  it('case 9 — Backwards-compat: wrapGenerate still works with expanded MythrunContext', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-haiku-test')
    assert(mw.wrapGenerate !== undefined)

    const out = await mw.wrapGenerate({
      doGenerate: () =>
        Promise.resolve({
          content: [{ type: 'text', text: 'hi' }],
          finishReason: { unified: 'stop', raw: 'end_turn' },
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 2, text: 2, reasoning: 0 },
          },
          warnings: [],
        }),
      doStream: () => Promise.reject(new Error('stream not used')),
      params: paramsWithContext({ worldId: 'w1', userId: 'u1', stage: 'concept_intake' }),
      model: stubModel,
    })

    expect(out.usage.inputTokens.total).toBe(5)
    expect(infoSpy).toHaveBeenCalledOnce()
    expect(infoSpy.mock.calls[0]?.[0]).toMatchObject({
      event: 'llm.call',
      worldId: 'w1',
      userId: 'u1',
      stage: 'concept_intake',
    })
  })
})
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @mythrun/backend test src/llm/__tests__/middleware-stream.test.ts --run
```

Expected: 9 tests fail with `wrapStream must be defined` (or similar — the existing middleware doesn't have wrapStream yet).

- [ ] **Step 3: Update `backend/src/llm/middleware.ts`**

Replace the file contents with:

```ts
import type {
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import { logger } from './logger.js'
import { mapToMythrunError, LlmStructuredOutputError } from './errors.js'

interface MythrunContext {
  readonly sessionId?: string | undefined
  readonly userId?: string | undefined
  readonly worldId?: string | undefined
  readonly campaignId?: string | undefined
  readonly stage?: string | undefined
}

function extractMythrunContext(params: unknown): MythrunContext {
  if (typeof params !== 'object' || params === null) return {}
  const providerOptions = (params as { providerOptions?: unknown }).providerOptions
  if (typeof providerOptions !== 'object' || providerOptions === null) return {}
  const mythrun = (providerOptions as { mythrun?: unknown }).mythrun
  if (typeof mythrun !== 'object' || mythrun === null) return {}
  const ctx = mythrun as MythrunContext
  return {
    sessionId: typeof ctx.sessionId === 'string' ? ctx.sessionId : undefined,
    userId: typeof ctx.userId === 'string' ? ctx.userId : undefined,
    worldId: typeof ctx.worldId === 'string' ? ctx.worldId : undefined,
    campaignId: typeof ctx.campaignId === 'string' ? ctx.campaignId : undefined,
    stage: typeof ctx.stage === 'string' ? ctx.stage : undefined,
  }
}

/**
 * Wrap a language model with logging + error normalization.
 *
 * `wrapGenerate`: emits `event: 'llm.call'` on success, `event: 'llm.error'`
 * on failure (mapped via mapToMythrunError + thrown).
 *
 * `wrapStream`: enforces a 6-state terminal-state matrix — each stream call
 * produces exactly one log line, guarded by a `terminated` flag.
 *
 *   | Terminal state         | Trigger                                | Log         | Caller-facing |
 *   |------------------------|----------------------------------------|-------------|----------------|
 *   | Success                | `type === 'finish'` part               | llm.call    | Stream closes  |
 *   | Provider-graceful err  | finishReason.unified === 'error'       | llm.call    | Stream closes  |
 *   | In-stream error part   | `type === 'error'` part                | llm.error   | controller.error(mapped) |
 *   | Truncation             | Stream closes, no finish, no error     | llm.error   | controller.error(LlmStructuredOutputError) |
 *   | Cancellation           | Stream's cancel() handler fires        | llm.error   | (no rethrow — caller's intent) |
 *   | Open-time error        | doStream() throws                      | llm.error   | wrapStream throws mapped error |
 *
 * Latency is wall-clock from stream open to terminal state.
 */
export function logAndNormalizeMiddleware(modelId: string): LanguageModelV3Middleware {
  return {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doGenerate, params }) => {
      const start = Date.now()
      const ctx = extractMythrunContext(params)
      try {
        const result = await doGenerate()
        const inputTokens = result.usage.inputTokens.total
        const outputTokens = result.usage.outputTokens.total
        const totalTokens =
          inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : undefined
        logger.info(
          {
            event: 'llm.call',
            model: modelId,
            mode: 'generate',
            inputTokens,
            outputTokens,
            totalTokens,
            latencyMs: Date.now() - start,
            finishReason: result.finishReason.unified,
            sessionId: ctx.sessionId,
            userId: ctx.userId,
            worldId: ctx.worldId,
            campaignId: ctx.campaignId,
            stage: ctx.stage,
          },
          'llm call completed',
        )
        return result
      } catch (err) {
        logger.error(
          {
            event: 'llm.error',
            model: modelId,
            mode: 'generate',
            err,
            latencyMs: Date.now() - start,
            sessionId: ctx.sessionId,
            userId: ctx.userId,
            worldId: ctx.worldId,
            campaignId: ctx.campaignId,
            stage: ctx.stage,
          },
          'llm call failed',
        )
        throw mapToMythrunError(err)
      }
    },
    wrapStream: async ({ doStream, params }) => {
      const start = Date.now()
      const ctx = extractMythrunContext(params)

      let result: LanguageModelV3StreamResult
      try {
        result = await doStream()
      } catch (err) {
        logger.error(
          {
            event: 'llm.error',
            model: modelId,
            mode: 'stream',
            err,
            latencyMs: Date.now() - start,
            sessionId: ctx.sessionId,
            userId: ctx.userId,
            worldId: ctx.worldId,
            campaignId: ctx.campaignId,
            stage: ctx.stage,
          },
          'llm stream failed to open',
        )
        throw mapToMythrunError(err)
      }

      let terminated = false
      let inputTokens: number | undefined
      let outputTokens: number | undefined
      let totalTokens: number | undefined
      let finishReason: string | undefined

      function logSuccess(): void {
        if (terminated) return
        terminated = true
        logger.info(
          {
            event: 'llm.call',
            model: modelId,
            mode: 'stream',
            inputTokens,
            outputTokens,
            totalTokens,
            latencyMs: Date.now() - start,
            finishReason,
            sessionId: ctx.sessionId,
            userId: ctx.userId,
            worldId: ctx.worldId,
            campaignId: ctx.campaignId,
            stage: ctx.stage,
          },
          'llm stream completed',
        )
      }

      function logError(err: unknown, reason?: string): void {
        if (terminated) return
        terminated = true
        logger.error(
          {
            event: 'llm.error',
            model: modelId,
            mode: 'stream',
            err,
            reason,
            latencyMs: Date.now() - start,
            sessionId: ctx.sessionId,
            userId: ctx.userId,
            worldId: ctx.worldId,
            campaignId: ctx.campaignId,
            stage: ctx.stage,
          },
          'llm stream failed',
        )
      }

      const transform = new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
        transform(part, controller) {
          if (part.type === 'finish') {
            inputTokens = part.usage.inputTokens.total
            outputTokens = part.usage.outputTokens.total
            totalTokens =
              inputTokens !== undefined && outputTokens !== undefined
                ? inputTokens + outputTokens
                : undefined
            finishReason = part.finishReason.unified
            logSuccess()
          } else if (part.type === 'error') {
            const mapped = mapToMythrunError(part.error)
            logError(part.error)
            controller.error(mapped)
            return
          }
          controller.enqueue(part)
        },
        flush(controller) {
          if (terminated) return
          // Stream closed without a finish or error part — truncation.
          const err = new LlmStructuredOutputError('llm stream truncated (no finish event)')
          logError(err, 'truncated')
          controller.error(err)
        },
        cancel(reason) {
          if (terminated) return
          logError(reason, 'cancelled')
          // No rethrow — cancellation is the consumer's intent.
        },
      })

      return {
        ...result,
        stream: result.stream.pipeThrough(transform),
      }
    },
  }
}
```

- [ ] **Step 4: Run new tests + existing wrapGenerate tests**

```bash
pnpm --filter @mythrun/backend test src/llm/__tests__/middleware-stream.test.ts src/llm/__tests__/middleware.test.ts --run
```

Expected: all 9 new stream tests pass + all 3 existing wrapGenerate tests pass.

- [ ] **Step 5: Verify typecheck + lint**

```bash
pnpm --filter @mythrun/backend typecheck
pnpm --filter @mythrun/backend lint
```

Both expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add backend/src/llm/middleware.ts backend/src/llm/__tests__/middleware-stream.test.ts
git commit -m "feat(myt-49): wrapStream middleware + extended MythrunContext

Six-state terminal-state matrix (success / provider-graceful error /
in-stream error / truncation / cancellation / open-time error), each
producing exactly one log line guarded by a 'terminated' flag.
Mythrun-typed errors propagate via controller.error() — parity with
wrapGenerate.

MythrunContext expanded to include worldId, campaignId, stage
alongside sessionId, userId. wrapGenerate also threads the new fields
+ adds mode: 'generate' discriminator for log queries.

9 new test cases cover the matrix end-to-end; 3 existing wrapGenerate
tests continue to pass."
```

---

### Task 7: `worker.ts` full rewrite + manual smoke

Replace the no-op shell with the real implementation. Boot smoke after.

**Files:**
- Modify: `backend/src/worker.ts` (full rewrite)

- [ ] **Step 1: Replace `backend/src/worker.ts`**

Replace the file contents with:

```ts
import { pathToFileURL } from 'node:url'
import { Worker as BullmqWorker } from 'bullmq'
import { loadEnv } from './config/env.js'
import { createPgPool } from './db/postgres.js'
import { createBullmqRedisClient } from './redis/bullmq-client.js'
import { createRedisClient } from './redis/client.js'
import {
  CONCURRENCY_CAMPAIGN_SETUP,
  CONCURRENCY_WORLD_GEN,
  QUEUE_CAMPAIGN_SETUP,
  QUEUE_WORLD_GEN,
} from './worker/bullmq-config.js'
import { makeStubProcessor } from './worker/stub-processor.js'
import { startHealthServer } from './worker/health-server.js'
import { logger } from './llm/logger.js'

const HEALTH_PORT = 3001
const WORKER_PG_POOL_SIZE = 4
// Reserve ~20s headroom under ECS stopTimeout=120s for pg + Redis cleanup.
const WORKER_CLOSE_GRACE_MS = 100_000

export async function main(): Promise<void> {
  const env = loadEnv()

  // Establish connections (boot-fail fast on any failure).
  // CRITICAL: BullMQ Workers require their own ioredis client with
  // `maxRetriesPerRequest: null` — the default `createRedisClient` factory
  // sets it to 1 (fast-fail for the API/Queue use case).
  // `createBullmqRedisClient` is the BullMQ-compatible factory.
  const redisBatch = createBullmqRedisClient(env.redisBatchUrl)
  await redisBatch.ping()
  // redisRealtime uses the regular client — only used for PUBLISH later
  // (MYT-52); BullMQ constraints don't apply.
  const redisRealtime = createRedisClient(env.redisRealtimeUrl)
  await redisRealtime.ping()
  const pg = createPgPool(env.databaseUrl, { max: WORKER_PG_POOL_SIZE })
  await pg.query('SELECT 1')

  // Register BullMQ Workers (stub processors at Phase 0).
  const stubProcessor = makeStubProcessor(logger)
  const worldGenWorker = new BullmqWorker(QUEUE_WORLD_GEN, stubProcessor, {
    connection: redisBatch,
    concurrency: CONCURRENCY_WORLD_GEN,
  })
  const campaignSetupWorker = new BullmqWorker(QUEUE_CAMPAIGN_SETUP, stubProcessor, {
    connection: redisBatch,
    concurrency: CONCURRENCY_CAMPAIGN_SETUP,
  })

  // Start health server last — only marks healthy once everything else is up.
  const health = await startHealthServer(HEALTH_PORT, {
    pg,
    redisBatch,
    redisRealtime,
    workers: [worldGenWorker, campaignSetupWorker],
  })

  logger.info(
    {
      event: 'worker.started',
      healthPort: HEALTH_PORT,
      queues: [QUEUE_WORLD_GEN, QUEUE_CAMPAIGN_SETUP],
    },
    'worker started',
  )

  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ event: 'worker.shutting_down', signal }, 'worker stopping')

    await health.close().catch((err: unknown) => {
      logger.error({ err }, 'health server close failed')
    })

    await Promise.all([
      closeWithDeadline(worldGenWorker, WORKER_CLOSE_GRACE_MS),
      closeWithDeadline(campaignSetupWorker, WORKER_CLOSE_GRACE_MS),
    ])

    await pg.end().catch((err: unknown) => {
      logger.error({ err }, 'pg pool end failed')
    })

    await redisBatch.quit().catch(() => undefined)
    await redisRealtime.quit().catch(() => undefined)

    process.exit(0)
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal)
    })
  }

  await new Promise<never>(() => undefined)
}

async function closeWithDeadline(worker: BullmqWorker, deadlineMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      worker.close(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`worker ${worker.name} close exceeded ${String(deadlineMs)}ms`))
        }, deadlineMs)
      }),
    ])
  } catch (err) {
    logger.error(
      { event: 'worker.close.deadline_exceeded', worker: worker.name, err },
      'worker close deadline exceeded; forcing close — in-flight jobs left as stalled',
    )
    await worker.close(true).catch(() => undefined)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntryPoint) {
  await main()
}
```

- [ ] **Step 2: Verify typecheck + lint**

```bash
pnpm --filter @mythrun/backend typecheck
pnpm --filter @mythrun/backend lint
```

Both expected: exit 0.

- [ ] **Step 3: Build the backend**

```bash
pnpm --filter @mythrun/backend build
```

Expected: `dist/worker.js` exists and `dist/worker/{bullmq-config,stub-processor,health-server}.js` all present.

- [ ] **Step 4: Manual smoke — boot the worker against local infra**

In one terminal:

```bash
pnpm db:up
```

In another terminal, with `NODE_ENV=development` exported (required by env loader):

```bash
NODE_ENV=development node --env-file=backend/.env.development backend/dist/worker.js
```

Expected: pino logs show `event: 'worker.started'` with `healthPort: 3001` and `queues: ['world-gen', 'campaign-setup']`. Process stays running.

In a third terminal, probe the health endpoint:

```bash
curl -i http://127.0.0.1:3001/health
```

Expected: `HTTP/1.1 200 OK` with body `{"healthy":true}`.

Probe BullMQ keys in Redis:

```bash
docker exec mythrun-redis-batch-1 redis-cli KEYS 'bull:*'
```

Expected: keys like `bull:world-gen:meta`, `bull:campaign-setup:meta` exist (BullMQ writes them when Workers register).

Stop the worker with `Ctrl-C`. Expected logs: `event: 'worker.shutting_down'` then process exits cleanly within a few seconds.

- [ ] **Step 5: Manual smoke — health endpoint reports 503 when pg is down**

```bash
docker stop mythrun-postgres-1
```

In the worker terminal, start again:

```bash
NODE_ENV=development node --env-file=backend/.env.development backend/dist/worker.js
```

Expected: boot fails at `pg.query('SELECT 1')` (boot-fail-fast). Process exits non-zero.

Restart Postgres:

```bash
docker start mythrun-postgres-1
```

Start worker again — should boot cleanly. Probe `/health` (200) — confirm. Stop the worker.

If pg dies mid-flight, `/health` should return 503 (the probe times out). To test:

```bash
# In a fresh terminal, start the worker again
NODE_ENV=development node --env-file=backend/.env.development backend/dist/worker.js &
WORKER_PID=$!
sleep 2
curl -s http://127.0.0.1:3001/health  # expect {"healthy":true}
docker stop mythrun-postgres-1
sleep 2
curl -s http://127.0.0.1:3001/health  # expect {"healthy":false,"failed":["pg"]}
kill $WORKER_PID
docker start mythrun-postgres-1
```

- [ ] **Step 6: Run all backend tests**

```bash
pnpm --filter @mythrun/backend test
```

Expected: green. (Includes the new wrapStream tests + stub-processor + health-server.)

- [ ] **Step 7: Commit**

```bash
git add backend/src/worker.ts
git commit -m "feat(myt-49): worker.ts rewrite — BullMQ + health server + bounded shutdown

Boot sequence: redisBatch (BullMQ factory) → redisRealtime (regular
factory) → pg pool size 4 → BullMQ Worker × 2 → Fastify /health on
127.0.0.1:3001. Each probe runs at startup; boot-fail-fast on failure.

Shutdown order: health server → BullMQ Worker.close() with 100s
bounded deadline (force-close fall-through on deadline-exceeded) → pg
pool → Redis quit → exit. Reserve ~20s headroom under ECS
stopTimeout=120s.

Manually smoke-verified locally: worker boots, /health returns 200,
BullMQ keys appear in Redis, graceful shutdown logs + exits, /health
returns 503 when pg is down."
```

---

### Task 8: TF — worker `portMappings` + `healthCheck` + service grace

**Files:**
- Modify: `infra/modules/serving/main.tf`

- [ ] **Step 1: Update `aws_ecs_task_definition.worker` container def**

In `infra/modules/serving/main.tf`, find the `container_definitions = jsonencode([{...}])` block of the worker task def (around lines 233–258). Replace the entire `containerDefinitions` block with:

```hcl
  container_definitions = jsonencode([{
    name      = "worker"
    image     = "${var.ecr_repository_url}:placeholder"
    essential = true

    command = ["node", "--max-old-space-size=768", "dist/worker.js"]

    portMappings = [{
      containerPort = 3001
      protocol      = "tcp"
    }]

    environment = local.common_env
    secrets     = local.common_secrets

    stopTimeout = 120

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.worker.name
        awslogs-region        = "us-east-1"
        awslogs-stream-prefix = "ecs"
      }
    }

    # Container-level healthCheck probes the Fastify /health server at
    # localhost:3001 (which itself probes BullMQ + Redis + pg). startPeriod 60s
    # matches the API's value — worker cold boot is heavier (BullMQ Lua
    # script load + two Redis pings + pg SELECT 1 + Fastify boot). The
    # `.on('error', ...)` clause catches connection-refused during boot.
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"require('http').get('http://localhost:3001/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
  }])
```

- [ ] **Step 2: Add `health_check_grace_period_seconds` to `aws_ecs_service.worker`**

In the same file, find `resource "aws_ecs_service" "worker"` (around line 369). Add `health_check_grace_period_seconds = 120` after `deployment_circuit_breaker`. The resource should look like:

```hcl
resource "aws_ecs_service" "worker" {
  name             = "mythrun-${var.environment}-worker"
  cluster          = var.ecs_cluster_name
  task_definition  = aws_ecs_task_definition.worker.arn
  launch_type      = "FARGATE"
  platform_version = "LATEST"
  desired_count    = 0 # Prep Pipeline milestone bumps to 1 when real worker exists

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_sg_id]
    assign_public_ip = false
  }

  # No load_balancer block — worker isn't ALB-registered.

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # 120s grace matches stopTimeout + API service's value; first-deploy
  # cold-start headroom (image pull + Node boot + Redis × 2 + pg + Fastify).
  health_check_grace_period_seconds = 120

  lifecycle {
    ignore_changes = [desired_count, task_definition]
  }

  tags = { Name = "mythrun-${var.environment}-worker" }
}
```

- [ ] **Step 3: Validate the TF**

```bash
cd infra/environments/staging
terraform fmt -check ../../modules/serving/main.tf
terraform validate
cd ../../..
```

Expected: both pass without errors. (If `terraform fmt -check` complains, run `terraform fmt ../../modules/serving/main.tf` to fix.)

- [ ] **Step 4: Run `terraform plan`**

```bash
cd infra/environments/staging
terraform plan -out=worker-changes.tfplan
cd ../../..
```

Expected: plan shows:
- `aws_ecs_task_definition.worker` will be replaced (create-before-destroy) with the new container def (`portMappings` + `healthCheck` added)
- `aws_ecs_service.worker` will be updated in-place to add `health_check_grace_period_seconds = 120`

Eyeball the diff. No unexpected changes to API resources.

- [ ] **Step 5: Apply the TF**

```bash
cd infra/environments/staging
terraform apply worker-changes.tfplan
cd ../../..
```

Expected: plan applies cleanly. New worker task-def revision registered against the `:placeholder` image. Service still at `desired_count = 0` (per `ignore_changes`); CI flips to 1 in Task 9.

- [ ] **Step 6: Commit**

```bash
git add infra/modules/serving/main.tf
git commit -m "infra(myt-49): worker portMappings + healthCheck + service grace

Worker task def now exposes port 3001 and has a container-level
healthCheck probing the Fastify /health server. startPeriod 60s
matches the API value; the `.on('error', ...)` clause catches
connection-refused during boot.

Worker service gets health_check_grace_period_seconds = 120 — same as
the API. First-deploy cold-start headroom for image pull + Node boot
+ Redis × 2 ping + pg SELECT 1 + Fastify boot.

desired_count stays 0 in TF (CI flips it via the new deploy step in
the next commit, per ignore_changes lifecycle)."
```

---

### Task 9: CI deploy workflow — `deploy-staging-worker` job

**Files:**
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Add the `deploy-staging-worker` job**

In `.github/workflows/deploy.yml`, append a new job after `deploy-staging`. The job should look like:

```yaml
  deploy-staging-worker:
    needs: [build, db-migrate]
    runs-on: ubuntu-latest
    timeout-minutes: 20
    environment: staging
    concurrency:
      group: deploy-mythrun-staging-worker
      cancel-in-progress: false
    env:
      AWS_REGION: us-east-1
      ECS_CLUSTER: mythrun
      ECS_SERVICE: mythrun-staging-worker
      TASK_DEF_FAMILY: mythrun-staging-worker
      CONTAINER_NAME: worker
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2

      - name: Configure AWS credentials via OIDC
        uses: aws-actions/configure-aws-credentials@v6.1.1
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Fetch current task definition
        run: |
          set -euo pipefail
          aws ecs describe-task-definition \
            --task-definition "${{ env.TASK_DEF_FAMILY }}" \
            --query 'taskDefinition' \
            > task-def.json

      - name: Render new task definition with digest image
        id: taskdef
        uses: aws-actions/amazon-ecs-render-task-definition@6853cfae8c3a7d978fbf68b5a55453395541dfbb # v1.8.5
        with:
          task-definition: task-def.json
          container-name: ${{ env.CONTAINER_NAME }}
          image: ${{ needs.build.outputs.image }}

      - name: Deploy new revision
        # Does NOT check rolloutState — see the explicit poll step below.
        uses: aws-actions/amazon-ecs-deploy-task-definition@a310a830f5c14e583e35d84e4e1ec7dd177c3c9c # v2.6.2
        with:
          task-definition: ${{ steps.taskdef.outputs.task-definition }}
          cluster: ${{ env.ECS_CLUSTER }}
          service: ${{ env.ECS_SERVICE }}
          wait-for-service-stability: true
          wait-for-minutes: 15

      - name: Ensure desired-count is 1
        # First deploy: flips 0 → 1. Subsequent: no-op. Runs AFTER deploy
        # action so ECS never tries to place on the :placeholder revision.
        run: |
          aws ecs update-service \
            --cluster "${{ env.ECS_CLUSTER }}" \
            --service "${{ env.ECS_SERVICE }}" \
            --desired-count 1 > /dev/null

      - name: Verify deployment completed (poll rolloutState)
        # `aws ecs wait services-stable` returns SUCCESS even after
        # circuit-breaker rollback. Poll rolloutState to catch that.
        run: |
          set -euo pipefail
          max_attempts=12
          for attempt in $(seq 1 "$max_attempts"); do
            SVC_JSON=$(aws ecs describe-services \
              --cluster "${{ env.ECS_CLUSTER }}" \
              --services "${{ env.ECS_SERVICE }}" \
              --query 'services[0]')
            ROLLOUT=$(echo "$SVC_JSON" | jq -r '.deployments[] | select(.status=="PRIMARY") | .rolloutState')
            RUNNING=$(echo "$SVC_JSON" | jq -r '.runningCount')
            DESIRED=$(echo "$SVC_JSON" | jq -r '.desiredCount')
            FAILED=$(echo "$SVC_JSON" | jq -r '.deployments[] | select(.status=="PRIMARY") | .failedTasks')
            echo "attempt=$attempt rolloutState=$ROLLOUT running=$RUNNING desired=$DESIRED failed=$FAILED"

            if [[ "$ROLLOUT" == "FAILED" ]]; then
              echo "::error::Worker deployment FAILED (circuit breaker)."
              exit 1
            fi

            if [[ "$ROLLOUT" == "COMPLETED" && "$RUNNING" == "$DESIRED" && "$FAILED" == "0" ]]; then
              echo "Worker deployment verified."
              exit 0
            fi

            if [[ "$attempt" -lt "$max_attempts" ]]; then
              sleep 10
            fi
          done
          echo "::error::Worker deployment did not reach COMPLETED within 2 min"
          exit 1
```

- [ ] **Step 2: Validate YAML parses**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml'))" && echo "YAML OK"
```

Expected: `YAML OK`.

- [ ] **Step 3: Lint the workflow (action-lint via gh)**

```bash
gh workflow view deploy.yml 2>&1 | head -5
```

Expected: gh successfully parses the workflow file (no `error:` lines).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci(myt-49): deploy-staging-worker job

New job parallel to deploy-staging. Same shape as the API deploy
pattern: fetch task-def → render-task-definition action with the
new image digest → deploy-task-definition action with wait-for-
stability → ensure desired-count is 1 (flips 0 → 1 on first run) →
poll rolloutState to catch circuit-breaker rollback.

Separate concurrency group (deploy-mythrun-staging-worker) so a
worker-only redeploy doesn't queue behind an API deploy.

needs: [build, db-migrate] so it waits for the image to land in
ECR but otherwise runs in parallel with the API job."
```

---

### Task 10: Wiki page

**Files:**
- Create: `docs/wiki/content/runtime/worker.html`
- Modify: `docs/wiki/structure.ts` (register the new page)

- [ ] **Step 1: Read wiki conventions**

```bash
cat docs/wiki/AUTHORING.md | head -120
ls docs/wiki/content/runtime/
head -50 docs/wiki/content/runtime/llm.html  # for the shape
head -50 docs/wiki/content/runtime/dev-tool.html  # for a recent page
```

Note the `<!--mythrun:sources ... -->` source-tracking block at the top of each page, used by `pnpm wiki:check` for drift detection.

- [ ] **Step 2: Create `docs/wiki/content/runtime/worker.html`**

Adapt the source-tracking shape from `llm.html`. Body covers the 7 sections from the spec §9.

```html
<!--
mythrun:sources
  docs/superpowers/specs/2026-05-12-myt-49-bullmq-worker-design.md
  docs/specs/2026-04-13-world-campaign-pipeline.md
  docs/specs/2026-04-10-infrastructure-devops.md
  backend/src/worker.ts
  backend/src/worker/bullmq-config.ts
  backend/src/worker/stub-processor.ts
  backend/src/worker/health-server.ts
  backend/src/redis/bullmq-client.ts
  backend/src/llm/middleware.ts
  infra/modules/serving/main.tf
  .github/workflows/deploy.yml
-->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Worker — Mythrun wiki</title>
    <link rel="stylesheet" href="../../style.css" />
  </head>
  <body>
    <h1>Worker</h1>

    <p>The worker is a separate ECS Fargate service running <code>node dist/worker.js</code>.
    Two BullMQ Workers listen on <code>redisBatch</code>:
    <code>world-gen</code> (concurrency 3) and <code>campaign-setup</code> (concurrency 5).
    Phase 0 ships stub processors that log job receipt and mark complete — real stage
    logic lands in MYT-51 onward.</p>

    <h2>Why a separate service</h2>
    <ul>
      <li>Long-running Opus streams hold connections open for tens of seconds.
      Running them in the API process would starve event-loop time from HTTP / WebSocket
      handlers.</li>
      <li>Worker scales independently of API on queue depth.</li>
      <li>Failure isolation: a worker OOM doesn't kill in-flight HTTP requests.</li>
    </ul>

    <h2>Boot sequence</h2>
    <ol>
      <li><code>loadEnv()</code> — fails fast if required env vars are missing.</li>
      <li><code>createBullmqRedisClient(env.redisBatchUrl)</code> + <code>ping()</code>.
      BullMQ requires <code>maxRetriesPerRequest: null</code>; the regular
      <code>createRedisClient</code> sets it to 1 (fast-fail) which would throw at
      Worker startup.</li>
      <li><code>createRedisClient(env.redisRealtimeUrl)</code> + <code>ping()</code>.
      Reserved for <code>PUBLISH</code> from MYT-52's streaming entity events; unused
      at Phase 0.</li>
      <li><code>createPgPool(databaseUrl, { max: 4 })</code> + <code>SELECT 1</code>.</li>
      <li>Register two <code>BullmqWorker</code> instances with the stub processor.</li>
      <li>Start Fastify <code>/health</code> server on <code>127.0.0.1:3001</code>
      last — only marks healthy once everything else is up.</li>
    </ol>

    <h2>Health endpoint</h2>
    <p><code>GET http://localhost:3001/health</code> probes pg + redisBatch + redisRealtime
    + both BullMQ workers' <code>isRunning()</code> state. 200 healthy / 503 with
    <code>failed[]</code> probe names. The ECS container-level healthCheck (defined in
    <code>infra/modules/serving/main.tf</code>) hits this every 30s with a 1s timeout
    per probe.</p>

    <h2>Graceful shutdown</h2>
    <p>SIGTERM → close health server → bounded <code>worker.close()</code> on both
    BullMQ Workers (100s deadline; falls through to <code>worker.close(true)</code> on
    deadline-exceeded, leaving in-flight jobs as stalled for another worker to pick up)
    → <code>pg.end()</code> → <code>redisBatch.quit()</code> + <code>redisRealtime.quit()</code>
    → <code>process.exit(0)</code>.</p>

    <p>ECS sends SIGTERM and waits 120s (<code>stopTimeout</code>) before SIGKILL. The
    100s worker-close deadline reserves ~20s for pg + Redis cleanup.</p>

    <h2><code>wrapStream</code> middleware</h2>
    <p>MYT-44's <code>logAndNormalizeMiddleware</code> gains a <code>wrapStream</code>
    implementation governed by a six-state terminal-state matrix:</p>
    <table>
      <thead>
        <tr><th>Terminal state</th><th>Trigger</th><th>Log line</th><th>Caller behavior</th></tr>
      </thead>
      <tbody>
        <tr><td>Success</td><td><code>type === 'finish'</code></td>
          <td><code>event: 'llm.call'</code></td><td>Stream closes</td></tr>
        <tr><td>Provider-graceful error</td>
          <td><code>finishReason === 'error'</code></td>
          <td><code>event: 'llm.call'</code></td><td>Stream closes</td></tr>
        <tr><td>In-stream error part</td><td><code>type === 'error'</code></td>
          <td><code>event: 'llm.error'</code></td>
          <td><code>controller.error(mapToMythrunError(part.error))</code></td></tr>
        <tr><td>Truncation</td><td>Stream closes without finish or error</td>
          <td><code>event: 'llm.error'</code> with <code>reason: 'truncated'</code></td>
          <td><code>controller.error(LlmStructuredOutputError)</code></td></tr>
        <tr><td>Cancellation</td><td>Stream's <code>cancel()</code> handler fires</td>
          <td><code>event: 'llm.error'</code> with <code>reason: 'cancelled'</code></td>
          <td>(no rethrow)</td></tr>
        <tr><td>Open-time error</td><td><code>doStream()</code> throws</td>
          <td><code>event: 'llm.error'</code></td>
          <td><code>wrapStream</code> throws mapped error</td></tr>
      </tbody>
    </table>
    <p>Invariant: exactly one log line per stream call, guarded by a
    <code>terminated</code> closure flag. Mythrun-typed errors propagate to the caller
    in every error case — parity with <code>wrapGenerate</code>.</p>

    <p>Streaming context: callers pass
    <code>providerOptions.mythrun = { worldId, campaignId?, userId?, stage }</code>
    to attribute cost to the right <code>pipeline_runs</code> row. The middleware
    threads these into the log line so MYT-43's cost-attribution path can join
    against them.</p>

    <h2>Deploy mechanism</h2>
    <p>The worker service is provisioned at <code>desired_count = 0</code> with
    <code>lifecycle.ignore_changes = [desired_count, task_definition]</code> — CI
    owns task count and revisions. The
    <code>deploy-staging-worker</code> job in <code>.github/workflows/deploy.yml</code>
    is parallel to <code>deploy-staging</code> (separate concurrency group). On every
    push to <code>main</code> it: fetches the current task def, swaps in the new image
    digest via the <code>aws-actions/amazon-ecs-render-task-definition</code> action,
    deploys via <code>aws-actions/amazon-ecs-deploy-task-definition</code> with
    <code>wait-for-service-stability</code>, then flips
    <code>desired_count</code> to 1 (no-op after the first deploy), then polls
    <code>rolloutState</code> for 2 minutes to catch circuit-breaker rollback.</p>

    <h2>Source-of-truth files</h2>
    <ul>
      <li><code>backend/src/worker.ts</code> — entry point</li>
      <li><code>backend/src/worker/bullmq-config.ts</code> — queue names + concurrency caps</li>
      <li><code>backend/src/worker/stub-processor.ts</code> — Phase 0 no-op</li>
      <li><code>backend/src/worker/health-server.ts</code> — Fastify /health</li>
      <li><code>backend/src/redis/bullmq-client.ts</code> — BullMQ-compatible ioredis factory</li>
      <li><code>backend/src/llm/middleware.ts</code> — <code>wrapGenerate</code> + <code>wrapStream</code></li>
      <li><code>infra/modules/serving/main.tf</code> — TF for the worker task-def + service</li>
      <li><code>.github/workflows/deploy.yml</code> — <code>deploy-staging-worker</code> job</li>
    </ul>
  </body>
</html>
```

- [ ] **Step 3: Register the page in `docs/wiki/structure.ts`**

Read `docs/wiki/structure.ts`. Find the entry for `runtime/dev-tool` (a recent peer page) and add `runtime/worker` alongside it, matching the existing structure exactly. The exact format depends on `structure.ts`'s shape — read it first.

- [ ] **Step 4: Run wiki check**

```bash
DATABASE_URL="postgresql://mythrun:mythrun_dev@localhost:5432/mythrun" pnpm wiki:check
```

Expected: green. If drift is reported for the new page, that's expected on first add — the source-hash needs to be computed. If `wiki:check` produces an `accept-drift` invitation, follow `docs/wiki/AUTHORING.md`.

If `wiki:check` is red for an unrelated reason, investigate before continuing.

- [ ] **Step 5: Commit**

```bash
git add docs/wiki/content/runtime/worker.html docs/wiki/structure.ts
# Plus any site/ regeneration the build produced:
git add docs/wiki/site/runtime/worker.html 2>/dev/null || true
git commit -m "docs(myt-49): wiki page for worker + wrapStream

Covers boot sequence, /health endpoint, graceful shutdown bounded
under ECS stopTimeout, wrapStream terminal-state matrix, and the
deploy mechanism (CI step + TF ignore_changes interaction). Sources
block references the design spec + parent specs + all implementation
files for wiki:check drift detection."
```

---

### Task 11: Final verification + branch backup push

- [ ] **Step 1: Run all quality gates**

```bash
pnpm typecheck
```

Expected: green across 3 workspaces.

```bash
pnpm lint
```

Expected: green (only pre-existing max-lines warnings, which are unrelated).

```bash
pnpm test
```

Expected: green. New tests from this work:
- `backend/src/worker/__tests__/stub-processor.test.ts` (2 tests)
- `backend/src/worker/__tests__/health-server.test.ts` (3 tests)
- `backend/src/llm/__tests__/middleware-stream.test.ts` (9 tests)
- Existing tests unchanged: `backend/src/llm/__tests__/middleware.test.ts` (3 tests) still pass against the expanded `MythrunContext`.

```bash
DATABASE_URL="postgresql://mythrun:mythrun_dev@localhost:5432/mythrun" pnpm wiki:check
```

Expected: green.

```bash
pnpm dev-tool:check
```

Expected: `dev-tool:check — 0 error(s), 0 warning(s) [routes:0 events:0 jobs:0]` (this issue does NOT add to the contract; that's deferred to MYT-51 per spec §8).

- [ ] **Step 2: Final manual smoke — boot the built artifact**

Build:

```bash
pnpm --filter @mythrun/backend build
```

Boot:

```bash
pnpm db:up
NODE_ENV=development node --env-file=backend/.env.development backend/dist/worker.js
```

Expected: `event: 'worker.started'` log line, process stays running.

In another terminal:

```bash
curl -s http://127.0.0.1:3001/health
docker exec mythrun-redis-batch-1 redis-cli KEYS 'bull:*' | head
```

Expected: `{"healthy":true}` from `/health`; `bull:world-gen:*` and `bull:campaign-setup:*` keys present in Redis.

Stop the worker with Ctrl-C. Expected: `event: 'worker.shutting_down'` + clean exit.

- [ ] **Step 3: Push the worktree branch as a remote backup**

```bash
git push -u origin myt-49-bullmq-worker
```

Expected: branch pushed. Remote backup exists.

- [ ] **Step 4: Signal ready for merge**

All gates green. Worktree branch is at the desired state. The actual merge back to main is handled per CLAUDE.md "Merging worktree work back":

```bash
# From main repo path (not the worktree):
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
git checkout main && git pull
git merge myt-49-bullmq-worker
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test
DATABASE_URL=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun pnpm wiki:check
pnpm dev-tool:check
git push origin main
# Flip Linear MYT-49 to Done
bd worktree remove myt-49
```

No commit at this step — Task 11 is verification + push only. Merge-back is the user's call.

---

## Plan complete

After Task 11, MYT-49 is ready for the merge-back flow. The worker container is provisioned with real BullMQ wiring + a health endpoint, `wrapStream` middleware governs streaming LLM calls with a deterministic 6-state log invariant, TF + CI flip the service from 0 → 1, and the wiki documents the whole shape. MYT-51 onward replaces the stub processors with real stage logic.
