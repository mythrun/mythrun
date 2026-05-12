# MYT-49 — BullMQ worker wiring + LLM `wrapStream` middleware (design)

> **Status:** Design approved 2026-05-12 (brainstorming pass). Implementation next via writing-plans.
> **Linear:** MYT-49
> **Spec parent:** `docs/specs/2026-04-13-world-campaign-pipeline.md` §6 + §7
> **Spec parent:** `docs/specs/2026-04-10-infrastructure-devops.md` §3 (Worker ECS Service)
> **Estimate per Linear:** 1 working day
> **Worktree:** `.worktrees/myt-49` on branch `myt-49-bullmq-worker`

## 1. Goal

Take the no-op `backend/src/worker.ts` shell from a "boot, ping `redisBatch`, idle" stub to a production-shaped BullMQ worker with real plumbing — two registered `Worker` instances on the right queues, all four runtime dependencies wired (Redis batch + realtime, Postgres, BullMQ), a containerized health endpoint on port 3001, and graceful shutdown. Job processors remain no-op stubs at Phase 0 — real stage logic lands in MYT-51/52/53/54.

Concurrently, extend MYT-44's `logAndNormalizeMiddleware` with `wrapStream` so streaming prep stages (`world_and_factions`, `locations_and_npcs`, `character_integration` in MYT-52/53) can emit cost-attributed log lines through the same channel `wrapGenerate` already uses.

Flip the worker ECS service from `desired_count=0` to `1` via a CI Deploy step so the worker is actually running once the task-def revision lands.

## 2. Decisions made during brainstorming

| # | Decision | Why |
|---|---|---|
| D1 | Two BullMQ `Worker` instances at module scope in `worker.ts` — `world-gen` (concurrency 3) and `campaign-setup` (concurrency 5) — both on `redisBatch`. | Matches the spec's queue topology + concurrency caps. Concurrency budget at Anthropic per spec: 25 streams worst-case (5 campaign-setup × 5 player jobs); 3+5 is the right ceiling. |
| D2 | Stub processors at Phase 0 — log `event: 'worker.job.received'`, call `job.updateProgress(100)`, return. | Spec is explicit: real stage logic lands in MYT-51 onward. Stub processors prove the worker is alive without inviting "did we accidentally start running prep?" confusion. |
| D3 | Open `redisRealtime` connection too, even though the stub doesn't use it. Ping at boot. | MYT-52's streaming entity events will `PUBLISH` to `redisRealtime`. Opening the connection now (a) proves the runtime config has both URLs wired, (b) avoids "wait, why don't we have realtime in the worker?" rework when MYT-52 lands. Connection cost is trivial. |
| D4 | Create `pg.Pool` with `max: 4` per Infrastructure §5.3, even though stubs don't query. | Same reasoning as D3 — proves the wiring works, ready for MYT-51's real persisters. |
| D5 | Health server on port 3001 using **Fastify**, single route `GET /health` (singular — matches Infrastructure §3.1's `CMD-SHELL` example), no auth, probes all four runtime deps. | Fastify because we already depend on it and the existing `/health/ready` route's `probe()` helper is reusable. `/health` (not `/health/ready`) because the Infrastructure spec's container healthCheck command targets `/health`. |
| D6 | Graceful shutdown order: health server → BullMQ Workers → pg.Pool → Redis clients → exit 0. | Same drain ordering as `createShutdown` in `backend/src/app.ts` (HTTP first, then DB, then Redis). Worker close needs to drain in-flight jobs; the health server stops 200-ing first so ECS marks the container unhealthy and stops sending new traffic. |
| D7 | Pre-existing `aws_ecs_service.worker` has `lifecycle.ignore_changes = [desired_count, task_definition]` — "CI owns task count." Flip from 0 → 1 happens via a new **separate job** `deploy-staging-worker` in `.github/workflows/deploy.yml`, parallel to the API's `deploy-staging`, with its own concurrency group. | Matches the API service convention (MYT-28 used CI for the same flip). Independent failure domains — worker boot failure doesn't block API deploy and vice versa. Separate concurrency group means worker-only redeploys don't queue behind the API. Idempotent `update-service --desired-count 1` step. |
| D8 | DEFER adding `'world-gen'` / `'campaign-setup'` to `backend/src/contract/pipeline-jobs.ts` to MYT-51. | The dev-tool ship gate (MYT-47) requires every contract entry to have dev-tool coverage. Phase 0 stub processors produce no user-observable output. The job names become user-observable when MYT-51 ships real character-creation flows; that's when they enter the contract + get exempt'd (with reason) or covered in dev tool. |
| D9 | Extend `MythrunContext` (in `backend/src/llm/middleware.ts`) to include `worldId?: string`, `campaignId?: string`, `stage?: string` alongside existing `sessionId?: string`, `userId?: string`. All optional. | Per spec §7.1, the streaming-stage callers thread `providerOptions.mythrun = { worldId, campaignId?, userId?, stage }` to attribute cost to the right `pipeline_runs` row. Session-runtime callers continue to thread `sessionId, userId`. A unified context keeps one extraction helper and one log-line shape. |
| D10 | `wrapStream` uses Vercel's stream-result shape: returns a wrapped `LanguageModelV3StreamResult` whose `stream` is a `pipeThrough`'d `TransformStream`. Terminal-state matrix in §4.6.1 enumerates six terminal states (success, provider-graceful error, in-stream error, truncation, cancellation, open-time error), each producing exactly one log line — guarded by a `terminated: boolean` flag against double-logging. Mythrun-typed errors propagate to the caller in every error case, matching the `wrapGenerate` contract. | Caller iterates the wrapped stream exactly like the original. The middleware extracts usage from the `finish` part (Vercel doesn't surface it until then). Latency is wall-clock from stream open to stream close. The terminal-state-matrix-with-`terminated`-flag pattern resolves the convergent blind-review finding that earlier drafts left the error path ambiguous. |
| D11 | BullMQ Workers need a dedicated ioredis factory (`createBullmqRedisClient`) — `maxRetriesPerRequest: null`, no `retryStrategy: () => null`. The existing `createRedisClient` stays for the API's rate-limiter / future `Queue` enqueueing where fast-fail is correct. | BullMQ docs are explicit: passing an ioredis client with `maxRetriesPerRequest != null` to a `Worker` throws at startup. Worker blocking commands (`BRPOPLPUSH`) must allow indefinite retry across reconnects. The API's rate-limiter has the opposite need (fast-fail on transient blips). One factory per use case. |
| D12 | `worker.close()` is wrapped in a bounded `closeWithDeadline(worker, 100_000ms)` helper. On deadline-exceeded, fall through to `worker.close(true)` to force close (in-flight jobs left as stalled — picked up by another worker via BullMQ's stalled-job detection). | BullMQ's `worker.close()` has no built-in timeout — it blocks indefinitely on in-flight jobs. Under ECS `stopTimeout = 120s`, that's SIGKILL bait. The 100s budget reserves ~20s headroom for pg/Redis cleanup. Phase 0 stubs return in <1ms so this is moot; load-bearing for MYT-51 onward. |

## 3. File structure

```
backend/src/worker.ts                              # full rewrite
backend/src/worker/                                # NEW dir
├── bullmq-config.ts                               # QUEUE_NAMES + CONCURRENCY constants
├── stub-processor.ts                              # the no-op stub
└── health-server.ts                               # Fastify /health on 3001 (127.0.0.1)
backend/src/redis/bullmq-client.ts                 # NEW — BullMQ-compatible ioredis factory
backend/src/llm/__tests__/middleware-stream.test.ts  # NEW test file
backend/package.json                               # add `bullmq` dep
pnpm-lock.yaml                                     # regenerated
docs/wiki/content/runtime/worker.html              # NEW wiki page

# Mutations to existing files:
# - backend/src/worker.ts: full rewrite from no-op shell
# - backend/src/llm/middleware.ts: append wrapStream + extend MythrunContext
# - infra/modules/serving/main.tf: worker portMappings + healthCheck (§5.1);
#   worker service health_check_grace_period_seconds (§5.2)
# - .github/workflows/deploy.yml: new `deploy-staging-worker` job (§6.1)
```

## 4. Components

### 4.1 `backend/src/worker/bullmq-config.ts`

Tiny constants module — single source of truth for queue names + concurrency caps so the worker registrations and the eventual API-side `Queue` instances can import the same values without drift.

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

### 4.2 `backend/src/worker/stub-processor.ts`

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

export function makeStubProcessor(logger: Logger) {
  return async function stubProcessor(job: Job): Promise<void> {
    logger.info(
      {
        event: 'worker.job.received',
        queue: job.queueName,
        jobId: job.id,
        type: typeof job.data === 'object' && job.data !== null && 'type' in job.data
          ? (job.data as { type: unknown }).type
          : undefined,
      },
      'stub processor — real stage logic lands in MYT-51 onward',
    )
    await job.updateProgress(100)
  }
}
```

### 4.3 `backend/src/worker/health-server.ts`

Fastify on port 3001. One route. Reuses the `probe()` helper pattern from `backend/src/routes/health-ready.ts` (extracted into a tiny shared helper if useful, or duplicated since the worker context differs slightly).

```ts
// Worker /health endpoint on port 3001. Container ECS healthCheck hits
// this. 200 when all four runtime deps respond within PROBE_TIMEOUT_MS:
// redis-batch, redis-realtime, pg, and both BullMQ workers running.
// 503 otherwise with the failed probe names in the response body.

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
    if (failed.length > 0) return reply.code(503).send({ healthy: false, failed })
    return reply.code(200).send({ healthy: true })
  })
  await app.listen({ host: '0.0.0.0', port })
  return app
}

async function probe(name: string, fn: () => Promise<unknown>): Promise<{ name: string; ok: boolean; error?: string }> {
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`probe timeout after ${String(PROBE_TIMEOUT_MS)}ms`)), PROBE_TIMEOUT_MS)
      }),
    ])
    return { name, ok: true }
  } catch (err) {
    return { name, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
```

Health server binds to `127.0.0.1`. ECS container healthCheck runs from inside the same container and reaches `localhost`; `127.0.0.1` is sufficient and avoids exposing the port if the security group ever drifts. (Initial design considered `0.0.0.0`; switched to `127.0.0.1` per blind-review M2 — defense in depth, identical functional behavior under Fargate.)

In code: pass `host: '127.0.0.1'` to `app.listen({ host, port })`.

### 4.4 `backend/src/worker.ts` (full rewrite)

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
  // `maxRetriesPerRequest: null` and `enableOfflineQueue: true` — the default
  // `createRedisClient` factory sets these the OTHER way (fast-fail for the
  // API/Queue use case). `createBullmqRedisClient` is the BullMQ-compatible
  // factory (see §4.7).
  const redisBatch = createBullmqRedisClient(env.redisBatchUrl)
  await redisBatch.ping()
  // redisRealtime uses the regular client — only used for PUBLISH later (MYT-52);
  // BullMQ constraints don't apply.
  const redisRealtime = createRedisClient(env.redisRealtimeUrl)
  await redisRealtime.ping()
  const pg = createPgPool(env.databaseUrl, { max: WORKER_PG_POOL_SIZE })
  await pg.query('SELECT 1')

  // Register BullMQ Workers (stub processors at Phase 0).
  // Each Worker internally `.duplicate()`s the passed connection for its blocking
  // BRPOPLPUSH client — that's fine; both Workers share the underlying redisBatch
  // for non-blocking commands.
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

    // 1. Close health server first — /health stops 200-ing immediately, so we're
    //    honest about being unhealthy while tearing things down. (Worker has no
    //    inbound traffic to shed; this is about honesty, not traffic-shedding.)
    await health.close().catch((err: unknown) => logger.error({ err }, 'health server close failed'))

    // 2. Drain BullMQ workers with a bounded grace period. `worker.close()` has
    //    no built-in timeout — it'll block forever waiting for in-flight jobs.
    //    Under ECS stopTimeout=120s, anything still in flight after
    //    WORKER_CLOSE_GRACE_MS gets force-closed via worker.close(true) (which
    //    discards lock + leaves jobs to be picked up by another worker as stalled).
    //    Phase 0 stubs return in <1ms so this is moot; load-bearing once MYT-51
    //    lands real processors.
    await Promise.all([
      closeWithDeadline(worldGenWorker, WORKER_CLOSE_GRACE_MS),
      closeWithDeadline(campaignSetupWorker, WORKER_CLOSE_GRACE_MS),
    ])

    // 3. pg pool — drains active connections.
    await pg.end().catch((err: unknown) => logger.error({ err }, 'pg pool end failed'))

    // 4. Redis last — Workers issue terminal commands during close() (move job
    //    active→completed, release lock), so Redis must still be alive then.
    await redisBatch.quit().catch(() => undefined)
    await redisRealtime.quit().catch(() => undefined)

    process.exit(0)
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void shutdown(signal))
  }

  // Block forever — keep the event loop alive. Shutdown via signal handler.
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

### 4.5 `backend/src/redis/bullmq-client.ts` (NEW)

BullMQ requires specific ioredis options that conflict with the API's existing `createRedisClient` factory. From BullMQ docs: `maxRetriesPerRequest` MUST be `null`, `enableOfflineQueue` MUST be true (default), and an active retryStrategy must be in place so the Worker survives transient Redis blips.

```ts
import { Redis, type RedisOptions } from 'ioredis'

/**
 * BullMQ-compatible ioredis factory. The Worker / QueueEvents instances need
 * settings that diverge from the API's fast-fail Redis profile:
 *
 *   - maxRetriesPerRequest: null      // BullMQ throws if this is set; blocking commands MUST allow indefinite retry
 *   - enableOfflineQueue:  true       // default; Workers queue commands during reconnect
 *   - retryStrategy:       exp-backoff with 30s cap (vs API's `() => null`)
 *
 * Used only by the worker process. The API process keeps using the existing
 * `createRedisClient` for its rate-limiter + future Queue enqueueing.
 */
export function createBullmqRedisClient(url: string): Redis {
  const options: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Default retryStrategy: 50ms, 100ms, ..., capped at 30s.
    // No `retryStrategy: () => null` override — Workers MUST survive reconnects.
  }
  const client = new Redis(url, options)
  // Same error swallow as createRedisClient — real errors surface via promise rejections.
  client.on('error', () => undefined)
  return client
}
```

The existing `createRedisClient` stays unchanged — the API's rate limiter + future `Queue` enqueueing have different needs (fast-fail on transient Redis blips, no offline queue).

### 4.6 `backend/src/llm/middleware.ts` (extend)

Two changes:

**a. Expand `MythrunContext`:**
```ts
interface MythrunContext {
  readonly sessionId?: string | undefined
  readonly userId?: string | undefined
  readonly worldId?: string | undefined
  readonly campaignId?: string | undefined
  readonly stage?: string | undefined
}
```
Update `extractMythrunContext` to extract all five.

**b. Add `wrapStream` to the returned middleware object.**

#### 4.6.1 Terminal-state matrix

A stream call ends in exactly one of these terminal states, each producing exactly one log line:

| Terminal state | Trigger | Log line | Caller-facing behavior |
|---|---|---|---|
| **Success** | `type === 'finish'` part observed | `event: 'llm.call'` with `usage` + `finishReason: 'stop'\|'length'\|'tool-calls'\|...` + `mode: 'stream'` | Stream closes normally; consumer's `for-await` exits cleanly |
| **Provider-graceful error** | `type === 'finish'` part observed with `finishReason.unified === 'error'` | `event: 'llm.call'` with `finishReason: 'error'` (tokens are present — provider returned tokens but flagged error) | Stream closes normally; operator alerts on `finishReason: 'error'` separately |
| **In-stream error part** | `type === 'error'` part observed | `event: 'llm.error'` with the mapped error class + `mode: 'stream'` | `controller.error(mapToMythrunError(part.error))` — consumer's `for-await` throws the Mythrun-typed error |
| **Truncation** | Stream closes WITHOUT a `finish` part AND without an `error` part | `event: 'llm.error'` with `reason: 'truncated'` | `controller.error(new LlmStructuredOutputError('stream truncated'))` — consumer throws |
| **Cancellation** | Stream's `cancel(reason)` handler fires (caller AbortSignal / downstream close) | `event: 'llm.error'` with `reason: 'cancelled'`, `cause: reason` | No additional throw — cancellation is the caller's intent |
| **Open-time error** | `doStream()` itself throws before returning | `event: 'llm.error'` with the mapped error | Mythrun-typed error thrown from `wrapStream` itself (matches `wrapGenerate` contract) |

**Invariants:**
- Exactly one log line per stream call. A `terminated: boolean` closure variable guards against double-logging: once any terminal state fires, `flush()` early-returns.
- Mythrun-typed errors reach the caller in every error case. Parity with `wrapGenerate`.
- Token-counted log lines are emitted only when token counts are actually known (the `finish` part). Truncated streams emit `llm.error`, not a zero-token `llm.call` — that would silently undercount cost attribution.

#### 4.6.2 Implementation sketch

```ts
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
        ...ctx,
      },
      'llm stream failed to open',
    )
    throw mapToMythrunError(err)
  }

  let terminated = false
  let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {}
  let finishReason: string | undefined

  function logSuccess(): void {
    if (terminated) return
    terminated = true
    logger.info(
      {
        event: 'llm.call',
        model: modelId,
        mode: 'stream',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        latencyMs: Date.now() - start,
        finishReason,
        ...ctx,
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
        ...ctx,
      },
      'llm stream failed',
    )
  }

  const transform = new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
    transform(part, controller) {
      if (part.type === 'finish') {
        const inT = part.usage.inputTokens.total
        const outT = part.usage.outputTokens.total
        usage = {
          inputTokens: inT,
          outputTokens: outT,
          totalTokens: inT !== undefined && outT !== undefined ? inT + outT : undefined,
        }
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
      // No re-throw — cancellation is the consumer's intent.
    },
  })

  return {
    ...result,
    stream: result.stream.pipeThrough(transform),
  }
},
```

`LlmStructuredOutputError` is the existing class from `backend/src/llm/errors.ts`. Reusing it for stream truncation keeps the caller's error taxonomy unified (caller catches the same shape for `generateObject` failures and `streamObject` truncations).

### 4.7 Tests (`backend/src/llm/__tests__/middleware-stream.test.ts`)

Vitest with `vi.mock` at the `@ai-sdk/provider` boundary (matching MYT-44's pattern in `middleware.test.ts`). Fake `LanguageModelV3StreamResult` with a controllable stream. The terminal-state matrix in §4.6.1 dictates the test cases — one per state, plus context-threading + regression:

1. **Success — `finish` with usage**: stream emits `text-delta` × 3, then `finish` with usage → asserts exactly one `event: 'llm.call'` log with the right tokens + `finishReason` + `mode: 'stream'` + threaded context. Consumer's `for-await` exits cleanly. No `llm.error` log.
2. **Success — `finish` with `finishReason.unified === 'error'`**: provider returned tokens but flagged error → asserts `event: 'llm.call'` with `finishReason: 'error'`, NOT `llm.error`.
3. **In-stream error part**: stream emits `text-delta` then `type: 'error'` part → asserts exactly one `event: 'llm.error'` log + consumer's `for-await` throws `LlmRateLimitedError` (or the appropriate mapped class for the part's error payload). No `llm.call` log.
4. **Truncation**: stream emits `text-delta` × 2 then closes WITHOUT a `finish` part → asserts `event: 'llm.error'` log with `reason: 'truncated'` + consumer's `for-await` throws `LlmStructuredOutputError`. No `llm.call` log.
5. **Cancellation**: caller cancels the wrapped stream (`reader.cancel('aborted by test')`) → asserts `event: 'llm.error'` log with `reason: 'cancelled'`, `cause: 'aborted by test'`. No throw to consumer (cancellation is consumer's intent). No `llm.call` log.
6. **Open-time error**: `doStream()` rejects with `APICallError` 401 → asserts `event: 'llm.error'` log + `wrapStream` itself throws `LlmAuthError` (matches `wrapGenerate` contract). No `llm.call` log.
7. **Context threading**: providerOptions.mythrun = `{ worldId: 'w1', stage: 'world_and_factions' }` → both appear in the log line; absent fields don't appear (sessionId, userId, campaignId not emitted by pino).
8. **No-usage finish**: `finish` event with `usage.inputTokens.total === undefined` → log line emits `inputTokens: undefined` (pino omits), doesn't crash, `totalTokens: undefined`.
9. **Backwards-compat regression**: existing 3 `wrapGenerate` tests in `middleware.test.ts` continue to pass against the expanded `MythrunContext` shape.

Invariant check: cases 1–6 each assert "exactly one log line was emitted" — guards against the double-log hazard from `flush()` firing after a non-success terminal state. The `terminated` flag in §4.6.2 is what enforces this; tests must verify it works.

## 5. Infrastructure (`infra/modules/serving/main.tf`)

Two changes — task-def and service.

### 5.1 Task-def container changes

Add to `aws_ecs_task_definition.worker.container_definitions[0]`:

```hcl
portMappings = [{
  containerPort = 3001
  protocol      = "tcp"
}]
healthCheck = {
  command     = ["CMD-SHELL", "node -e \"require('http').get('http://localhost:3001/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))\""]
  interval    = 30
  timeout     = 5
  retries     = 3
  startPeriod = 60
}
```

`startPeriod = 60` matches the API's value (main.tf:213). Worker cold-boot is heavier than API (BullMQ Worker registration includes a Redis Lua script load on first connection, plus two Redis pings + pg `SELECT 1` + Fastify boot); 30s would risk killing healthy boots during their warm-up window. The `.on('error', () => process.exit(1))` clause catches connection-refused during boot (port not yet bound).

Drop the existing inline comment "No container-level healthCheck — ... Add when the worker has an actual implementation (Prep Pipeline milestone)." since we're now adding it.

### 5.2 Service-level grace period

Add `health_check_grace_period_seconds = 120` to `aws_ecs_service.worker`:

```hcl
resource "aws_ecs_service" "worker" {
  # ...existing args...
  health_check_grace_period_seconds = 120  # matches stopTimeout + API service's grace; first-deploy cold-start headroom
  # ...
}
```

Once the container-level healthCheck exists (§5.1), ECS uses it to gate task health for deployment stability calculations. Without `health_check_grace_period_seconds`, the default is 0 — a worker that takes longer than `startPeriod` to first-pass the healthCheck (rare but possible under image-pull + cold-start) gets marked unhealthy by ECS before it's had a chance. 120s matches the API service's value (main.tf:212).

### 5.3 What stays unchanged

`desired_count = 0` stays in TF (CI flips it via §6's idempotent `Ensure desired-count is 1` step).

## 6. CI Deploy step (`.github/workflows/deploy.yml`)

**Pattern: copy the API deploy pattern verbatim, swapping container/service names.** Do NOT hand-roll a `jq`-based task-def filter — the existing `aws-actions/amazon-ecs-render-task-definition` + `aws-actions/amazon-ecs-deploy-task-definition` actions handle read-only-field stripping correctly and preserve all task-def fields (tags, ephemeralStorage, etc.) that a whitelist would silently drop.

### 6.1 Structure: separate job, separate concurrency group

Worker deploy lives in its own job `deploy-staging-worker`, parallel to `deploy-staging`. Both depend on `[build, db-migrate]`. Separate concurrency group `deploy-mythrun-staging-worker` so a worker-only redeploy doesn't queue behind an API deploy (and vice versa). Independent failure domains.

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

### 6.2 Why this shape

- **`needs.build.outputs.image`** (NOT `steps.digest.outputs.image` — that step is in the `build` job, not this one).
- **Cluster is `mythrun`** (single shared cluster, not `mythrun-staging`).
- **Render-action + deploy-action** instead of hand-rolled `jq` — preserves all task-def fields, including tags + future additions.
- **Drop `--force-new-deployment`** — implicit when `--task-definition` references a freshly-registered revision.
- **RolloutState poll** — `aws ecs wait services-stable` returns SUCCESS after circuit-breaker rollback; the poll catches that and red-lights CI within ~2 min instead of letting an apparently-green deploy mask a rolled-back worker.

### 6.3 IAM — no change needed

The existing `mythrun-github-actions-staging` OIDC role grants `ecs:UpdateService` cluster-scoped to `mythrun` and `ecs:RegisterTaskDefinition` family-scoped to `mythrun-${env}-*:*`, both of which cover the worker service. See `infra/environments/staging/main.tf:297-326`.

### 6.4 TF + CI drift reminder

Per the user's memory `reference_tf_ci_taskdef_split.md`: TF-side worker-container changes (env var, healthCheck tweak, CPU bump) register a new task-def revision but do NOT roll the running worker (per `ignore_changes = [task_definition]` on the service). The next CI Deploy run carries the change live. After any TF change to the worker container_def, dispatch a Deploy workflow run.

## 7. `package.json` change

Add to `backend/package.json` `dependencies`:
```json
"bullmq": "^5.20.0"
```
(or whichever 5.x is current). Regenerate `pnpm-lock.yaml`.

## 8. Ship gate (no new contract entries)

Per D8: NOT adding `'world-gen'` / `'campaign-setup'` to `backend/src/contract/pipeline-jobs.ts` at this stage. Stub processors aren't user-observable; nothing for the dev-tool to cover. MYT-51 lands the entries when real character-creation flows ship.

`pnpm dev-tool:check` continues to exit 0 (contracts stay empty).

## 9. Wiki page (`docs/wiki/content/runtime/worker.html`)

New page covering:
1. **What it is** — separate ECS Fargate service running `node dist/worker.js`. Two BullMQ Workers on `redisBatch`: `world-gen` (concurrency 3) and `campaign-setup` (concurrency 5).
2. **Why a separate service** — long-running Opus streams hold connections open; isolating from API avoids event-loop starvation; independent scaling.
3. **Connections opened at boot** — redisBatch + redisRealtime + pg.Pool (size 4). All probe at startup; boot-fail-fast on any failure.
4. **Health endpoint** — `GET http://localhost:3001/health`. Probes all four runtime deps. 200 healthy / 503 with failed probe list.
5. **Stub processors at Phase 0** — log job receipt, mark complete. Real stage logic lands in MYT-51 onward.
6. **Graceful shutdown** — order: health server → BullMQ Workers (drain in-flight) → pg.Pool → Redis quit → exit.
7. **wrapStream middleware** — what it logs, when (every streaming LLM call), the context fields it threads.

Sources block tracks: `backend/src/worker.ts`, `backend/src/worker/bullmq-config.ts`, `backend/src/worker/stub-processor.ts`, `backend/src/worker/health-server.ts`, `backend/src/llm/middleware.ts`, `infra/modules/serving/main.tf`.

## 10. Done-when checklist

- [ ] `pnpm add bullmq` in backend workspace; lockfile regenerated and committed
- [ ] `backend/src/worker.ts` rewritten per §4.4
- [ ] `backend/src/worker/{bullmq-config,stub-processor,health-server}.ts` created
- [ ] `backend/src/llm/middleware.ts` extends `MythrunContext` + adds `wrapStream`
- [ ] `backend/src/llm/__tests__/middleware-stream.test.ts` created with 5 test cases; all pass
- [ ] Existing `wrapGenerate` tests still pass
- [ ] `infra/modules/serving/main.tf` worker container def gets `portMappings` + `healthCheck`
- [ ] `.github/workflows/deploy.yml` gets the worker-deploy step (register + update-service + wait stable)
- [ ] `docs/wiki/content/runtime/worker.html` lands with the 7-section structure
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm wiki:check && pnpm dev-tool:check` all green in the worktree
- [ ] Local manual: `pnpm dev` (the worker — need a `dev:worker` script? OR just `node dist/worker.js` after build) boots, /health 200 on `localhost:3001`, BullMQ Workers visible in Redis `KEYS bull:*`
- [ ] Staging Deploy run lands the new task-def, flips worker `desired_count` to 1, ECS health checks turn green
- [ ] Merge worktree → main → push per CLAUDE.md merge-back flow

Note on the local dev script: there's no `dev:worker` script today. Probably worth adding `"dev:worker": "tsx watch src/worker.ts"` to `backend/package.json` so the worker can be developed with HMR-equivalent. Not a hard requirement; flagging for plan.

## 11. Out of scope (explicit non-goals)

- **Real job processors** (world gen stages, character creation stages) — those land in MYT-51 (non-streaming world gen + credit gate + cost cap), MYT-52 (streaming world gen + entity events), MYT-53 (per-player character creation), MYT-54 (barrier + post-creation).
- **`pipeline-jobs.ts` contract entries** for `world-gen` / `campaign-setup` — deferred to MYT-51 when real jobs ship.
- **Anthropic rate-limit headroom verification** at queue concurrency caps — that's MYT-55's hardening task.
- **BullMQ retry strategy / dead-letter** — BullMQ's actual default is `attempts: 1` (no retries), set per-job via `Queue.add(..., { attempts, backoff })` or via `Queue.defaultJobOptions`. Stubs always return cleanly, so retries are moot at Phase 0. MYT-51 onward picks per-job retry policy per spec §6 Retry Strategy when enqueueing real jobs from the API side.
- **QueueEvents for the barrier job** — MYT-54's responsibility.
- **`Queue` instances on the API side** for enqueueing — they land in MYT-51 (`POST /api/worlds`).

## 12. Estimate

1 working day. Breakdown:

- BullMQ install + lockfile regen + initial worker.ts rewrite: 1 hour
- `bullmq-config.ts` + `stub-processor.ts`: 30 minutes
- `health-server.ts`: 1 hour (Fastify boot + probe pattern + tests if any)
- `wrapStream` middleware extension + tests (5 cases): 2 hours (the test setup is the bulk)
- Wiki update extension to `MythrunContext` ripples in the existing test fixture for `wrapGenerate`: 30 minutes
- TF additions (portMappings + healthCheck): 30 minutes
- CI deploy.yml step (copy + adapt API service deploy pattern): 1 hour
- Wiki page: 1 hour
- Verification + merge-back: 30 minutes
- Buffer (BullMQ API surprises, infra debugging): 1 hour

Tight but achievable. The TF + CI changes are the highest-risk surface — getting the `register-task-definition` JSON shape right takes a careful copy from the existing API step.
