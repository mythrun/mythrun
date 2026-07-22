# Worker Resilience + Dev Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the world-gen worker from crashing when streamObject rejects via SDK-internal transforms. Install a process-level safety net that marks jobs failed with correlated AsyncLocalStorage context. Persist dev-server logs to disk for post-mortem forensics.

**Architecture:** Two-layer error containment (try/catch in `runStreamingStage`, process-level `unhandledRejection`/`uncaughtException` handlers with 5-in-5min soft-escalation) backed by `AsyncLocalStorage`-propagated job context. Dev stdout-tee wrapper mirrors what ECS' awslogs driver provides in prod — application code stays unchanged.

**Tech Stack:** Node 24, TypeScript strict, pino + pino-pretty, `node:async_hooks`, BullMQ, bash.

**Beads:** myth-449j (resilience), myth-lmz6 (dev logging).

---

## File Structure

**New files:**
- `backend/src/worker/job-context.ts` — `AsyncLocalStorage` wrapper with `runWithJobContext` / `getJobContext` / `setStage`.
- `backend/src/worker/__tests__/job-context.test.ts` — unit tests for ALS propagation.
- `backend/src/boot/process-error-handlers.ts` — installer for `unhandledRejection` + `uncaughtException` handlers + ring-buffer escalation logic.
- `backend/src/boot/__tests__/process-error-handlers.test.ts` — handler integration tests.
- `backend/scripts/dev-logged.sh` — dev capture wrapper (tee to dated file + pino-pretty for terminal).

**Modified files:**
- `backend/src/llm/prep/streaming-extractor.ts` — try/catch around the partial-stream for-await + a small `errToWire` helper.
- `backend/src/llm/prep/__tests__/streaming-extractor.test.ts` — one new stream-died test case.
- `backend/src/llm/prep/world-gen-processor.ts` — wrap the per-job body in `runWithJobContext`; call `setStage(stage)` at the top of the stage loop iteration.
- `backend/src/llm/logger.ts` — construct against `pino.destination({sync: true})` for deterministic flush-on-exit.
- `backend/src/server.ts` — install process error handlers in `main()` before `app.listen`.
- `backend/package.json` — `dev` script invokes the new wrapper; add `dev:raw` for the rare raw-stdout case; add `pino-pretty` to devDependencies.
- `.gitignore` — `backend/logs/`.

---

## Phase 1 — Local guard in `runStreamingStage`

### Task 1.1: Add a stream-died test case

**Files:**
- Test: `backend/src/llm/prep/__tests__/streaming-extractor.test.ts`

- [ ] **Step 1: Read the existing test file's helpers** to mirror their shape.

Run: `grep -n "makeRedis\|fakeJob\|partials\|async function\*" backend/src/llm/prep/__tests__/streaming-extractor.test.ts | head -10`

Confirm: `makeRedis()` returns `{publish: vi.fn().mockResolvedValue(1)}`, `fakeJob = {updateProgress: vi.fn()}`, `partials(snapshots: unknown[])` is an async generator.

- [ ] **Step 2: Add a new test at the end of the `describe` block**

Open `backend/src/llm/prep/__tests__/streaming-extractor.test.ts`, scroll to the closing `})` of the outer `describe`, insert this test immediately before it:

```typescript
it('myth-449j: stream rejection produces structured warn log and rethrows', async () => {
  const redis = makeRedis()
  const warn = vi.fn()
  const boom = new Error('upstream-stream-died')

  // Two yielded partials, then the generator rejects.
  // eslint-disable-next-line @typescript-eslint/require-await
  async function* failingPartials(): AsyncGenerator {
    yield { regions: [{ name: 'R1', access_level: 'known', prose: 'p', facts: [] }] }
    yield {
      regions: [
        { name: 'R1', access_level: 'known', prose: 'p', facts: [] },
        { name: 'R2' },
      ],
    }
    throw boom
  }

  await expect(
    runStreamingStage(failingPartials(), {
      stage: 'world_and_factions',
      campaignId: 'c-stream-died',
      job: fakeJob,
      redisRealtime: redis,
      keyPrefix: 'test:',
      arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
      bypassAccessFilter: true,
      endpointTierMap: new Map(),
      logger: { warn },
    }),
  ).rejects.toBe(boom)

  // The local guard logged the stream death.
  const streamDiedCalls = warn.mock.calls.filter((c) => {
    const arg0 = c[0] as unknown
    if (typeof arg0 !== 'object' || arg0 === null) return false
    const obj = arg0 as Record<string, unknown>
    return obj.event === 'streaming.stream_died'
  })
  expect(streamDiedCalls).toHaveLength(1)
  const payload = streamDiedCalls[0]?.[0] as Record<string, unknown>
  expect(payload.stage).toBe('world_and_factions')
  expect(payload.survivors).toBe(1) // R1 emitted (closed by R2 appearing in chunk 2)
  // errToWire shape (defined in next task)
  expect(payload.error).toMatchObject({ message: 'upstream-stream-died' })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && pnpm vitest run src/llm/prep/__tests__/streaming-extractor.test.ts -t "myth-449j"`

Expected: FAIL — current `runStreamingStage` has no try/catch, the error propagates without a `streaming.stream_died` log. Possibly the rejection shape differs (`.rejects.toBe(boom)` should pass — the error does propagate raw).

### Task 1.2: Implement the local guard

**Files:**
- Modify: `backend/src/llm/prep/streaming-extractor.ts`

- [ ] **Step 1: Add the `errToWire` helper above `runStreamingStage`**

Open `backend/src/llm/prep/streaming-extractor.ts`. Find the existing `async function maybeEmit(...)` function. Immediately after its closing brace, before `export async function runStreamingStage`, insert:

```typescript
function errToWire(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    }
  }
  return { value: String(err) }
}
```

- [ ] **Step 2: Wrap the for-await loop (and the post-loop pass) in try/catch**

In the same file, find `export async function runStreamingStage`. Replace its body from the `for await (const partial of partialObjectStream) {` opening up to (but not including) the `return { finalTree, emittedSynthKeys: emitted }` line with:

```typescript
  try {
    for await (const partial of partialObjectStream) {
      chunkCount += 1
      finalTree = partial
      const tree = partial as unknown as Record<string, unknown>
      for (const arrayCfg of config.arrays) {
        const arr = tree[arrayCfg.path]
        /* c8 ignore start — defensive: array config whose path doesn't
         * resolve to an Array in the in-flight partial. The closed-entry
         * gate only fires after the LLM has populated the array, so this
         * branch is reachable only from stage 1-style stages with no
         * configured array (not from the streaming stages 2-4). */
        if (!Array.isArray(arr)) continue
        /* c8 ignore stop */
        const entries = arr as unknown[]
        for (let i = 0; i < entries.length - 1; i++) {
          const synthKey = `${config.stage}/${arrayCfg.path}/${String(i)}`
          if (emitted.has(synthKey)) continue
          const entry = entries[i]
          /* c8 ignore start — defensive: stage-end Zod requires every
           * entry to be an object. Reaching this with a non-object means
           * the LLM emitted a primitive at this array position; Zod will
           * fail the stage at validate-time. */
          if (typeof entry !== 'object' || entry === null) continue
          /* c8 ignore stop */
          await maybeEmit(config, arrayCfg, entry as Record<string, unknown>, synthKey, emitted)
        }
      }
      await config.job.updateProgress(chunkCount)
    }

    /* c8 ignore start — defensive: the AI SDK's partialObjectStream always
     * yields at least one chunk on a successful call. This throw fires only
     * if the SDK returns an empty iterable (broken stream / cancellation
     * before any data) — covered by integration testing, not unit. */
    if (finalTree === undefined) {
      throw new Error('streaming-extractor: partialObjectStream yielded no values')
    }
    /* c8 ignore stop */

    // Post-loop pass: trailing entry of each array.
    /* c8 ignore start */
    const finalRoot = finalTree as unknown as Record<string, unknown>
    for (const arrayCfg of config.arrays) {
      const arr = finalRoot[arrayCfg.path]
      if (!Array.isArray(arr)) continue
      const entries = arr as unknown[]
      if (entries.length === 0) continue
      const lastIdx = entries.length - 1
      const synthKey = `${config.stage}/${arrayCfg.path}/${String(lastIdx)}`
      if (emitted.has(synthKey)) continue
      const entry = entries[lastIdx]
      if (typeof entry !== 'object' || entry === null) continue
      await maybeEmit(config, arrayCfg, entry as Record<string, unknown>, synthKey, emitted)
    }
    /* c8 ignore stop */
  } catch (err) {
    // myth-449j: stream-died local guard. The SDK's partialObjectStream
    // may reject mid-flight (Zod transform throws, schema parse fails
    // on a partial chunk, network drop). Without this catch, the
    // rejection propagates up bare; with it, we log the stage context
    // plus a structured error shape, then rethrow so the world-gen
    // processor's per-stage handleStageError publishes the canonical
    // stage-failed + phase=world_gen_failed events.
    config.logger?.warn(
      {
        event: 'streaming.stream_died',
        stage: config.stage,
        survivors: emitted.size,
        error: errToWire(err),
      },
      'streaming-extractor: stream died mid-flight; rethrowing',
    )
    throw err
  }
```

- [ ] **Step 3: Run the new test — verify it passes**

Run: `cd backend && pnpm vitest run src/llm/prep/__tests__/streaming-extractor.test.ts -t "myth-449j"`

Expected: PASS.

### Task 1.3: Verify existing tests still pass

- [ ] **Step 1: Run the full streaming-extractor test file**

Run: `cd backend && pnpm vitest run src/llm/prep/__tests__/streaming-extractor.test.ts`

Expected: all existing tests pass + the new `myth-449j` test passes.

- [ ] **Step 2: Typecheck**

Run: `cd backend && pnpm typecheck 2>&1 | tail -5`

Expected: clean.

### Task 1.4: Commit Phase 1

- [ ] **Step 1: Commit**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
git add backend/src/llm/prep/streaming-extractor.ts backend/src/llm/prep/__tests__/streaming-extractor.test.ts
git commit -m "fix(world-gen): try/catch the partial-stream for-await (myth-449j)

The AI SDK's partialObjectStream can reject mid-flight (Zod transform
throws on a malformed UUID, schema parse on a partial chunk, network
drop). Without a local catch the rejection escaped the stage handler
and surfaced as an unhandled rejection — which Node 24's default
behavior turns into a worker process exit.

The local guard adds a try/catch around the for-await loop, logs
structured warn (event=streaming.stream_died, stage, survivors,
errToWire(err)), then rethrows so the world-gen-processor's
handleStageError fires the canonical stage-failed + phase=world_gen_failed
SSE events.

Hard-fail semantics: persistence does not happen on a stream-failed
run (persistTree only runs after result.object resolves). Stage 2
and 3 produce zero entities for the failed stage; the world is
marked failed and the user re-triggers. No soft-recovery — the holistic
tree is the unit of correctness."
```

---

## Phase 2 — AsyncLocalStorage job context

### Task 2.1: Create the ALS wrapper module

**Files:**
- Create: `backend/src/worker/job-context.ts`

- [ ] **Step 1: Write the module**

Create the file with this content:

```typescript
// backend/src/worker/job-context.ts
//
// myth-449j: AsyncLocalStorage-propagated context per BullMQ job. The
// process-level unhandledRejection handler reads this to learn which
// job was in flight when a rejection escaped both the local guard
// (streaming-extractor.ts) and the wrapper's repair chain (ai.ts). With
// CONCURRENCY_WORLD_GEN=3 we may have three jobs running concurrently;
// each lives in its own ALS frame, so the handler sees the right one
// for the failing async lineage.

import { AsyncLocalStorage } from 'node:async_hooks'
import type { WorldGenStage } from '../llm/prep/streaming-extractor.js'

export type StageMarker = WorldGenStage | 'pre-stage' | 'post-stage'

export interface JobContext {
  readonly jobId: string
  readonly worldId: string
  readonly campaignId: string
  stage: StageMarker
}

const storage = new AsyncLocalStorage<JobContext>()

export function runWithJobContext<T>(
  ctx: Omit<JobContext, 'stage'>,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ ...ctx, stage: 'pre-stage' }, fn)
}

export function getJobContext(): JobContext | undefined {
  return storage.getStore()
}

export function setStage(stage: StageMarker): void {
  const ctx = storage.getStore()
  if (ctx !== undefined) ctx.stage = stage
}
```

### Task 2.2: Add unit tests for the ALS wrapper

**Files:**
- Create: `backend/src/worker/__tests__/job-context.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// backend/src/worker/__tests__/job-context.test.ts
import { describe, it, expect } from 'vitest'
import { runWithJobContext, getJobContext, setStage } from '../job-context.js'

describe('job-context (AsyncLocalStorage)', () => {
  it('returns undefined outside a runWithJobContext frame', () => {
    expect(getJobContext()).toBeUndefined()
  })

  it('propagates context through awaits inside the frame', async () => {
    await runWithJobContext(
      { jobId: 'j1', worldId: 'w1', campaignId: 'c1' },
      async () => {
        expect(getJobContext()).toMatchObject({
          jobId: 'j1', worldId: 'w1', campaignId: 'c1', stage: 'pre-stage',
        })
        await Promise.resolve()
        expect(getJobContext()).toMatchObject({ jobId: 'j1', stage: 'pre-stage' })
      },
    )
  })

  it('setStage updates the active context in place', async () => {
    await runWithJobContext(
      { jobId: 'j2', worldId: 'w2', campaignId: 'c2' },
      async () => {
        setStage('world_and_factions')
        expect(getJobContext()?.stage).toBe('world_and_factions')
        setStage('post-stage')
        expect(getJobContext()?.stage).toBe('post-stage')
      },
    )
  })

  it('isolates context across two concurrent frames', async () => {
    const seenA: (string | undefined)[] = []
    const seenB: (string | undefined)[] = []
    const jobA = runWithJobContext(
      { jobId: 'A', worldId: 'wA', campaignId: 'cA' },
      async () => {
        seenA.push(getJobContext()?.jobId)
        await new Promise((r) => setTimeout(r, 10))
        seenA.push(getJobContext()?.jobId)
      },
    )
    const jobB = runWithJobContext(
      { jobId: 'B', worldId: 'wB', campaignId: 'cB' },
      async () => {
        seenB.push(getJobContext()?.jobId)
        await new Promise((r) => setTimeout(r, 10))
        seenB.push(getJobContext()?.jobId)
      },
    )
    await Promise.all([jobA, jobB])
    expect(seenA).toEqual(['A', 'A'])
    expect(seenB).toEqual(['B', 'B'])
  })

  it('setStage outside a frame is a no-op (does not throw)', () => {
    expect(() => setStage('world_and_factions')).not.toThrow()
    expect(getJobContext()).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `cd backend && pnpm vitest run src/worker/__tests__/job-context.test.ts`

Expected: all 5 tests pass.

### Task 2.3: Wire ALS context into the world-gen processor

**Files:**
- Modify: `backend/src/llm/prep/world-gen-processor.ts`

- [ ] **Step 1: Add the import at the top of the file**

Find the existing import block (the `import type { Job }` and similar lines near the top). Add:

```typescript
import { runWithJobContext, setStage } from '../../worker/job-context.js'
```

- [ ] **Step 2: Wrap the per-job body in runWithJobContext**

Find `export function createWorldGenProcessor(deps: WorldGenDeps)` and inside the returned function `async function processWorldGen(job: Job<WorldGenJobPayload>)`. Currently the body starts with `const { campaignId } = job.data` and runs to the end of the function.

Wrap the entire body inside `runWithJobContext(...)`. The pattern:

```typescript
return async function processWorldGen(job: Job<WorldGenJobPayload>): Promise<void> {
  const { campaignId } = job.data
  const ctx = await loadCampaignContext(deps.pool, campaignId)
  /* c8 ignore start */
  if (ctx === null) {
    deps.logger.warn({ campaignId }, 'world-gen: campaign not found; job dropped')
    return
  }
  /* c8 ignore stop */

  // myth-449j: bind job identifiers into AsyncLocalStorage so the
  // process-level unhandledRejection handler can mark the right
  // world failed when a rejection escapes both the local guard and
  // the AI-SDK wrapper's repair chain.
  await runWithJobContext(
    {
      jobId: String(job.id ?? 'unknown'),
      worldId: ctx.world.id,
      campaignId,
    },
    async () => {
      // ...existing body that was previously here (the rest of processWorldGen)...
    },
  )
}
```

Concretely: in the file, locate the line that begins with `await deps.pool.query(` after the `loadCampaignContext` null guard. Everything from that line through the function's closing `}` becomes the body of the inner `async () => { ... }` passed to `runWithJobContext`. The `if (ctx === null)` early-return stays OUTSIDE because it must short-circuit before we install a context — but the rest of the function moves inside.

(There's no logic change here, just an indentation shift. The `setStage` call goes inside the stage loop in the next step.)

- [ ] **Step 3: Call setStage at the top of each stage iteration**

Inside the for-loop `for (const stage of WORLD_GEN_STAGES) {` (which is now inside the `runWithJobContext` body), immediately after `const claim = await atomicClaimStage(...)`, add:

```typescript
setStage(stage)
```

This updates the ALS context's `stage` field at the moment we begin work on that stage, so the unhandledRejection handler logs the right stage if a rejection fires.

- [ ] **Step 4: Typecheck**

Run: `cd backend && pnpm typecheck 2>&1 | tail -5`

Expected: clean.

- [ ] **Step 5: Run the world-gen-processor tests**

Run: `cd backend && pnpm vitest run src/llm/prep/__tests__/world-gen-processor.test.ts`

Expected: all tests pass. The ALS wrapper is transparent to test fixtures that don't read context.

### Task 2.4: Commit Phase 2

- [ ] **Step 1: Commit**

```bash
git add backend/src/worker/job-context.ts \
        backend/src/worker/__tests__/job-context.test.ts \
        backend/src/llm/prep/world-gen-processor.ts
git commit -m "feat(worker): AsyncLocalStorage job context for handler correlation

myth-449j: foundation for the process-level unhandledRejection
handler. Wraps each BullMQ world-gen job's body in
runWithJobContext({jobId, worldId, campaignId}) so the global handler
can identify the in-flight job from any async lineage that descended
from the job's frame. setStage(stage) updates the active stage at the
top of each stage iteration.

No behavior change today — the handler that reads this context lands
in the next phase."
```

---

## Phase 3 — pino sync destination

### Task 3.1: Switch the logger to a sync destination

**Files:**
- Modify: `backend/src/llm/logger.ts`

- [ ] **Step 1: Read the current logger**

Run: `cat backend/src/llm/logger.ts`

Confirm: it's currently `pino({base: {component: 'llm'}, level: process.env.LOG_LEVEL ?? 'info'})`.

- [ ] **Step 2: Replace with a sync-destination construction**

Replace the contents of `backend/src/llm/logger.ts` with:

```typescript
import pino from 'pino'

/**
 * Module-level pino instance for the LLM layer.
 *
 * Used by the middleware to emit structured `event: 'llm.call'` and
 * `event: 'llm.error'` log lines on every wrapped model call. Lives outside
 * Fastify request scope because the middleware fires from inside the SDK
 * call stack, which doesn't have a request context.
 *
 * Constructed against `pino.destination({sync: true})` so synchronous
 * writes block until the OS write() returns. This is the documented pino
 * mechanism for the "exit problem" — when the process-level
 * unhandledRejection handler logs and then immediately process.exit(1)s,
 * the final diagnostic has already left the process and is in the kernel
 * pipe (dev) or the Docker stdout stream (prod) where ECS's awslogs
 * driver picks it up. See backend/src/boot/process-error-handlers.ts.
 *
 * Throughput cost vs async: negligible at our log volume. Pino docs
 * explicitly support sync mode for use cases like ours.
 *
 * Tests mock the SDK at the import boundary (`vi.mock('ai')`); they do not
 * need to mock this logger. If a test needs to assert log shape, it can
 * `vi.spyOn(logger, 'info')` / `vi.spyOn(logger, 'error')`.
 */
export const logger = pino(
  {
    base: { component: 'llm' },
    level: process.env.LOG_LEVEL ?? 'info',
  },
  pino.destination({ sync: true }),
)
```

- [ ] **Step 3: Run the broader test suite to confirm no regression**

Run: `cd backend && pnpm test 2>&1 | tail -10`

Expected: all tests pass. (Tests that spy on `logger.info`/`logger.error` are unaffected by the destination change.)

### Task 3.2: Commit Phase 3

- [ ] **Step 1: Commit**

```bash
git add backend/src/llm/logger.ts
git commit -m "fix(logger): construct pino against sync destination

myth-449j prerequisite: the process-level unhandledRejection handler
needs to guarantee its final diagnostic log reaches stdout before
process.exit(1). Pino's default async destination batches writes
through a worker thread; on a hard exit those writes can be lost.

pino.destination({sync: true}) blocks the caller until the OS write()
syscall returns. By the time process.exit(1) runs, the log line is
in the kernel pipe (dev) or the Docker stdout stream (prod) where
ECS' awslogs driver picks it up. This is the documented exit-safety
mechanism per pino docs."
```

---

## Phase 4 — Global `unhandledRejection` + `uncaughtException` handlers

### Task 4.1: Create the handler module skeleton

**Files:**
- Create: `backend/src/boot/process-error-handlers.ts`

- [ ] **Step 1: Write the module**

```typescript
// backend/src/boot/process-error-handlers.ts
//
// myth-449j Layer 2: process-level safety net. Installs
// 'unhandledRejection' + 'uncaughtException' handlers that:
//   1. Read AsyncLocalStorage context (the per-job frame from
//      backend/src/worker/job-context.ts) to learn which job, world,
//      campaign, and stage was active.
//   2. Log structured at error level with full stack + ALS context.
//   3. Track recent rejections in a sliding-window ring buffer; if
//      ≥ 5 within 5 minutes, this is chronic — flush and exit so
//      ECS / tsx watch restarts the container.
//   4. Mark the in-flight world failed (best-effort) and publish a
//      world_gen_failed phase event via Redis Pub/Sub so SSE
//      subscribers see a clean terminal phase.
//
// Installing these handlers SUPPRESSES Node 24's default
// terminate-on-unhandled-rejection behavior — this is required for
// soft-survival across concurrent BullMQ jobs (CONCURRENCY=3). The
// process must keep running for the two siblings that didn't fail.

import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { getJobContext } from '../worker/job-context.js'

export interface ProcessErrorHandlerDeps {
  readonly pool: Pool
  readonly redisRealtime: Pick<Redis, 'publish'>
  readonly redisKeyPrefix: string
  readonly logger: Logger
  // Hook for tests; production passes the real process.exit. Returns
  // never in production, but tests pass a recording mock.
  readonly exit: (code: number) => void
  // Hook for tests; production passes Date.now.
  readonly now: () => number
}

const WINDOW_MS = 5 * 60 * 1000
const ESCALATION_THRESHOLD = 5

export function installProcessErrorHandlers(
  deps: ProcessErrorHandlerDeps,
): { uninstall: () => void } {
  const recent: number[] = []

  function pruneOld(): void {
    const cutoff = deps.now() - WINDOW_MS
    while (recent.length > 0 && (recent[0] ?? 0) < cutoff) {
      recent.shift()
    }
  }

  async function markFailedBestEffort(worldId: string, campaignId: string): Promise<void> {
    try {
      await deps.pool.query(
        `UPDATE worlds SET status = 'failed' WHERE id = $1`,
        [worldId],
      )
    } catch (markErr) {
      deps.logger.error(
        { event: 'process.mark_failed.pg_error', worldId, err: markErr },
        'process-error-handlers: failed to mark world failed in PG',
      )
    }
    try {
      await deps.redisRealtime.publish(
        `${deps.redisKeyPrefix}pipeline:campaign:${campaignId}`,
        JSON.stringify({ type: 'phase', phase: 'world_gen_failed' }),
      )
    } catch (publishErr) {
      deps.logger.error(
        { event: 'process.mark_failed.publish_error', campaignId, err: publishErr },
        'process-error-handlers: failed to publish world_gen_failed phase',
      )
    }
  }

  function reasonToWire(reason: unknown): Record<string, unknown> {
    if (reason instanceof Error) {
      return { name: reason.name, message: reason.message, stack: reason.stack }
    }
    return { value: String(reason) }
  }

  async function handle(eventName: 'unhandled_rejection' | 'uncaught_exception', reason: unknown): Promise<void> {
    const ctx = getJobContext()
    deps.logger.error(
      {
        event: `process.${eventName}`,
        jobContext: ctx ?? null,
        reason: reasonToWire(reason),
      },
      `process-error-handlers: ${eventName} caught`,
    )

    recent.push(deps.now())
    pruneOld()

    if (ctx !== undefined) {
      await markFailedBestEffort(ctx.worldId, ctx.campaignId)
    }

    if (recent.length >= ESCALATION_THRESHOLD) {
      deps.logger.fatal(
        {
          event: 'process.escalation_exit',
          recentCount: recent.length,
          windowMs: WINDOW_MS,
        },
        `process-error-handlers: ${String(ESCALATION_THRESHOLD)} rejections in ${String(WINDOW_MS / 1000)}s — exiting`,
      )
      deps.exit(1)
    }
  }

  const onRejection = (reason: unknown): void => {
    void handle('unhandled_rejection', reason)
  }
  const onException = (err: Error): void => {
    void handle('uncaught_exception', err)
  }

  process.on('unhandledRejection', onRejection)
  process.on('uncaughtException', onException)

  return {
    uninstall: () => {
      process.off('unhandledRejection', onRejection)
      process.off('uncaughtException', onException)
    },
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && pnpm typecheck 2>&1 | tail -5`

Expected: clean.

### Task 4.2: Add tests for the handler

**Files:**
- Create: `backend/src/boot/__tests__/process-error-handlers.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// backend/src/boot/__tests__/process-error-handlers.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import pino from 'pino'
import { installProcessErrorHandlers } from '../process-error-handlers.js'
import { runWithJobContext } from '../../worker/job-context.js'

interface PoolStub {
  readonly query: ReturnType<typeof vi.fn>
}
interface RedisStub {
  readonly publish: ReturnType<typeof vi.fn>
}

function makeDeps(opts: { now?: () => number } = {}): {
  pool: PoolStub
  redisRealtime: RedisStub
  exit: ReturnType<typeof vi.fn>
  install: () => { uninstall: () => void }
} {
  const pool: PoolStub = { query: vi.fn().mockResolvedValue({ rows: [] }) }
  const redisRealtime: RedisStub = { publish: vi.fn().mockResolvedValue(1) }
  const exit = vi.fn()
  const logger = pino({ level: 'silent' })
  const install = () =>
    installProcessErrorHandlers({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool: pool as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redisRealtime: redisRealtime as any,
      redisKeyPrefix: 'test:',
      logger,
      exit,
      now: opts.now ?? Date.now,
    })
  return { pool, redisRealtime, exit, install }
}

async function flushMicrotasks(): Promise<void> {
  // Two awaits to drain the void-handle chain inside installProcessErrorHandlers.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('installProcessErrorHandlers', () => {
  let installed: { uninstall: () => void } | null = null
  beforeEach(() => {
    installed = null
  })
  afterEach(() => {
    installed?.uninstall()
  })

  it('rejection inside ALS context marks the right world failed and does not exit', async () => {
    const { pool, redisRealtime, exit, install } = makeDeps()
    installed = install()
    await runWithJobContext(
      { jobId: 'j1', worldId: 'w1', campaignId: 'c1' },
      async () => {
        process.emit('unhandledRejection', new Error('boom'), Promise.resolve())
        await flushMicrotasks()
      },
    )
    expect(pool.query).toHaveBeenCalledWith(
      `UPDATE worlds SET status = 'failed' WHERE id = $1`,
      ['w1'],
    )
    expect(redisRealtime.publish).toHaveBeenCalledWith(
      'test:pipeline:campaign:c1',
      JSON.stringify({ type: 'phase', phase: 'world_gen_failed' }),
    )
    expect(exit).not.toHaveBeenCalled()
  })

  it('5 rejections within 5 minutes triggers exit(1)', async () => {
    let t = 1_000_000
    const { exit, install } = makeDeps({ now: () => t })
    installed = install()
    for (let i = 0; i < 5; i++) {
      await runWithJobContext(
        { jobId: `j${String(i)}`, worldId: `w${String(i)}`, campaignId: `c${String(i)}` },
        async () => {
          process.emit('unhandledRejection', new Error(`boom-${String(i)}`), Promise.resolve())
          await flushMicrotasks()
        },
      )
      t += 1000 // 1s between rejections
    }
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('5 rejections spread across 6+ minutes does NOT trigger exit', async () => {
    let t = 1_000_000
    const { exit, install } = makeDeps({ now: () => t })
    installed = install()
    for (let i = 0; i < 5; i++) {
      await runWithJobContext(
        { jobId: `j${String(i)}`, worldId: `w${String(i)}`, campaignId: `c${String(i)}` },
        async () => {
          process.emit('unhandledRejection', new Error(`boom-${String(i)}`), Promise.resolve())
          await flushMicrotasks()
        },
      )
      t += 91 * 1000 // 91s between → window slides oldest out
    }
    expect(exit).not.toHaveBeenCalled()
  })

  it('rejection outside ALS context logs but does not mark any world failed', async () => {
    const { pool, redisRealtime, exit, install } = makeDeps()
    installed = install()
    process.emit('unhandledRejection', new Error('top-level boom'), Promise.resolve())
    await flushMicrotasks()
    expect(pool.query).not.toHaveBeenCalled()
    expect(redisRealtime.publish).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('concurrent jobs: rejection inside job A marks A failed, not B', async () => {
    const { pool, install } = makeDeps()
    installed = install()
    const seenWorldIds: string[] = []
    pool.query.mockImplementation(async (_sql: string, params: unknown[]) => {
      seenWorldIds.push(params[0] as string)
      return { rows: [] }
    })
    const jobA = runWithJobContext(
      { jobId: 'A', worldId: 'wA', campaignId: 'cA' },
      async () => {
        // small delay so jobB starts in parallel
        await new Promise((r) => setTimeout(r, 5))
        process.emit('unhandledRejection', new Error('A boom'), Promise.resolve())
        await flushMicrotasks()
      },
    )
    const jobB = runWithJobContext(
      { jobId: 'B', worldId: 'wB', campaignId: 'cB' },
      async () => {
        await new Promise((r) => setTimeout(r, 20))
      },
    )
    await Promise.all([jobA, jobB])
    expect(seenWorldIds).toEqual(['wA'])
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `cd backend && pnpm vitest run src/boot/__tests__/process-error-handlers.test.ts`

Expected: 5 tests pass.

- [ ] **Step 3: Typecheck**

Run: `cd backend && pnpm typecheck 2>&1 | tail -5`

Expected: clean.

### Task 4.3: Install the handlers in server.ts

**Files:**
- Modify: `backend/src/server.ts`

- [ ] **Step 1: Add the import near the top of server.ts**

In the import block of `backend/src/server.ts`, add:

```typescript
import { installProcessErrorHandlers } from './boot/process-error-handlers.js'
```

- [ ] **Step 2: Install the handlers early in main()**

Find `export async function main(): Promise<void> {` in `backend/src/server.ts`. The function loads env + builds clients before `app.listen(...)`. We want the handlers installed BEFORE any non-trivial async work — so they catch any rejection from the boot flow itself.

The cleanest insertion point is right after `const env = loadEnv()` (or however env is first loaded in main()) and after the `pg` / `redisRealtime` clients are constructed (so we can pass them to `installProcessErrorHandlers`). Add:

```typescript
const llmLogger = (await import('./llm/logger.js')).logger
installProcessErrorHandlers({
  pool: pg,
  redisRealtime: rTR,
  redisKeyPrefix: env.redisKeyPrefix,
  logger: llmLogger,
  exit: (code) => process.exit(code),
  now: Date.now,
})
```

(If `pg` and `rTR` aren't named exactly that in main() — they're the pool ref and the realtime-redis ref — substitute the actual local variable names. The variables exist in main; read the file to confirm.)

- [ ] **Step 3: Typecheck**

Run: `cd backend && pnpm typecheck 2>&1 | tail -5`

Expected: clean.

- [ ] **Step 4: Run the full backend test suite**

Run: `cd backend && pnpm test 2>&1 | tail -10`

Expected: all tests pass.

### Task 4.4: Commit Phase 4

- [ ] **Step 1: Commit**

```bash
git add backend/src/boot/process-error-handlers.ts \
        backend/src/boot/__tests__/process-error-handlers.test.ts \
        backend/src/server.ts
git commit -m "feat(worker): process-level unhandledRejection + uncaughtException handlers

myth-449j Layer 2: catches anything that escapes the streaming-extractor
local guard (Phase 1) and the AI-SDK wrapper's repair chain. Reads
AsyncLocalStorage job context (Phase 2) so it knows which world to
mark failed.

Soft-escalation: 5 rejections in 5 minutes → process.exit(1). ECS /
tsx watch restarts the container. Under steady-state with
CONCURRENCY_WORLD_GEN=3 a single bad Anthropic release produces ~3
simultaneous rejections; threshold is tuned so transient blips don't
hair-trigger an exit.

Mark-failed best-effort: UPDATE worlds SET status='failed' for the
ALS world id; publish phase=world_gen_failed on the campaign's SSE
channel. BullMQ job state lags by ~30s until the lock expires; the
operator-visible world row is correct from the moment we mark it."
```

---

## Phase 5 — Dev log persistence (myth-lmz6)

### Task 5.1: Add pino-pretty as a dev dependency

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Add pino-pretty**

Run: `cd backend && pnpm add -D pino-pretty`

Expected: `pino-pretty` appears under `devDependencies` in `backend/package.json`. `pnpm-lock.yaml` updates.

### Task 5.2: Gitignore the logs directory

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Append the ignore rule**

Open `.gitignore` at the repo root. Append:

```
backend/logs/
```

### Task 5.3: Create the dev-logged wrapper script

**Files:**
- Create: `backend/scripts/dev-logged.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# backend/scripts/dev-logged.sh
#
# myth-lmz6: wrap `tsx watch ... src/server.ts` so its stdout is
# preserved in a daily log file under backend/logs/. Mirrors what
# ECS' awslogs driver provides in prod, without modifying any
# application code.
#
# - set -euo pipefail: surface errors anywhere in the pipe; default
#   bash hides them behind only-the-last-segment's exit code.
# - find -mtime +7 -delete: keep the last ~7 days of dev logs.
#   Cleanup runs on each script start (idempotent).
# - tee -a then pnpm exec pino-pretty: tee writes raw JSON to the file
#   first (greppable, jq-friendly), then pino-pretty renders the
#   terminal copy for the human reading along.
# - --self-test: bare-mode probe used by CI to verify the script's
#   prerequisites without booting the server.

set -euo pipefail

# Paths are relative to the backend/ directory (where this script's
# parent .. is the backend root).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

LOG_DIR="$(pwd)/logs"
LOG_FILE="$LOG_DIR/dev-$(date +%F).log"

# Self-test mode: verify directory creation, pino-pretty availability,
# and exit cleanly. Used by tests.
if [[ "${1:-}" == "--self-test" ]]; then
  mkdir -p "$LOG_DIR"
  touch "$LOG_FILE"
  pnpm exec pino-pretty --help > /dev/null
  echo "ok"
  exit 0
fi

mkdir -p "$LOG_DIR"
# Clean up old daily files. -mtime +7 means "more than 7 days old".
find "$LOG_DIR" -name 'dev-*.log' -mtime +7 -delete

# Run tsx watch with the existing env-file flags from package.json.
# Tee raw JSON to today's file; then render terminal via pino-pretty.
exec pnpm exec tsx watch --env-file=.env.development --env-file-if-exists=../.env.worktree src/server.ts 2>&1 \
  | tee -a "$LOG_FILE" \
  | pnpm exec pino-pretty
```

- [ ] **Step 2: Make the script executable**

Run: `cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun && chmod +x backend/scripts/dev-logged.sh`

- [ ] **Step 3: Smoke-test the script**

Run: `cd backend && bash scripts/dev-logged.sh --self-test`

Expected: prints `ok`, exits 0. The file `backend/logs/dev-$(date +%F).log` is created.

### Task 5.4: Repoint `pnpm dev` at the wrapper

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Update the scripts section**

Open `backend/package.json`. Find the `"scripts"` block. Locate the current line:

```json
"dev": "tsx watch --env-file=.env.development --env-file-if-exists=../.env.worktree src/server.ts",
```

Replace with:

```json
"dev": "bash scripts/dev-logged.sh",
"dev:raw": "tsx watch --env-file=.env.development --env-file-if-exists=../.env.worktree src/server.ts",
```

(`dev:raw` preserves the original command for editor integrations or smoke runs that need raw stdout without pino-pretty in the loop.)

- [ ] **Step 2: Verify the json still parses**

Run: `cd backend && node -e "JSON.parse(require('fs').readFileSync('package.json'))"`

Expected: no output (parse succeeded).

### Task 5.5: Commit Phase 5

- [ ] **Step 1: Commit**

```bash
git add backend/package.json backend/scripts/dev-logged.sh .gitignore pnpm-lock.yaml
git commit -m "feat(dev): persistent dev-server log capture (myth-lmz6)

Adds backend/scripts/dev-logged.sh: a thin bash wrapper that pipes
tsx watch stdout through tee (raw JSON to backend/logs/dev-YYYY-MM-DD.log)
and pino-pretty (human-readable terminal output). pnpm dev is
repointed at the wrapper; pnpm dev:raw preserves the previous raw
command for the rare case the operator needs un-tee'd stdout.

Daily rollover with 7-day retention (find -mtime +7 -delete on each
start). backend/logs/ is gitignored. pino-pretty added to backend
devDependencies.

App code is unchanged: every existing logger.info call still pino-
JSONs to stdout. The capture is a stdout-pipeline concern, mirroring
what ECS awslogs provides in prod."
```

---

## Phase 6 — Verify & ship

### Task 6.1: Full backend test + lint + typecheck

- [ ] **Step 1: Test suite**

Run: `cd backend && pnpm test 2>&1 | tail -10`

Expected: all tests pass (1426+ tests pre-existing + ~10 new from this plan).

- [ ] **Step 2: Typecheck**

Run: `cd backend && pnpm typecheck 2>&1 | tail -5`

Expected: clean.

- [ ] **Step 3: Lint**

Run: `cd backend && pnpm lint 2>&1 | tail -10`

Expected: 0 errors. Warnings on `max-lines-per-function` for `process-error-handlers.ts` are acceptable (the handler logic + tests are intentionally self-contained).

### Task 6.2: Manual smoke — kill-stream resilience

- [ ] **Step 1: Bounce the dev backend with the new wrapper**

Run: `cd backend && pnpm dev`

Expected: terminal shows pino-pretty output; `backend/logs/dev-$(date +%F).log` is created and contains raw JSON.

- [ ] **Step 2: Hit it with the constructed-state smoke**

In another terminal:

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun/backend
pnpm smoke:entity-consolidation-flow
```

Expected: smoke completes (this isn't a resilience test on its own, just verifies the dev wrapper hasn't broken anything load-bearing).

- [ ] **Step 3: Manually verify worker survival**

In a third terminal, ad-hoc trigger an unhandled rejection by hitting a dev endpoint that we know throws. (If no such endpoint exists, the engineer running this plan can construct one: a tsx repl that calls `process.emit('unhandledRejection', new Error('manual-test'), Promise.resolve())` from inside `runWithJobContext`.)

Confirm in the dev log file:
- Log line `event: 'process.unhandled_rejection'` appears.
- The jobContext is non-null and matches the in-flight job.
- The world row's status flipped to `failed`.
- An SSE `phase: 'world_gen_failed'` event was published.
- The dev server did NOT exit.

- [ ] **Step 4: Stop the dev server**

`Ctrl-C` in the dev terminal. Confirm the script exits cleanly.

### Task 6.3: Push

- [ ] **Step 1: Run pre-push checks one more time**

```bash
cd backend && pnpm test 2>&1 | tail -5
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun && set -a && source backend/.env.development && set +a && pnpm wiki:check 2>&1 | tail -5
```

- [ ] **Step 2: Push**

```bash
git push origin main
```

If `wiki:check` flags drift, accept-drift (the changes are internal-mechanism only; narrative pages don't shift):

```bash
set -a && source backend/.env.development && set +a && pnpm wiki:accept-drift
git add docs/wiki/content/ docs/wiki/site/
git commit -m "docs(wiki): accept-drift after resilience+dev-logging ship"
git push origin main
```

- [ ] **Step 3: Close beads**

```bash
bd close myth-449j
bd close myth-lmz6
```

---

## Self-Review

**Spec coverage check:**
- §1 failure shape → §Phase 1 (local guard around for-await).
- §2 Layer 1 → Phase 1.
- §2 Layer 2 → Phase 4 (process-error-handlers).
- §2 sync-flush requirement → Phase 3 (pino.destination({sync: true})).
- §3 AsyncLocalStorage job context → Phase 2.
- §4 (no soft-recovery) → reflected by Phase 1 design (catch + log + rethrow, no threshold).
- §5 Dev log persistence → Phase 5.
- §6 Files touched → all addressed across phases.
- §7 Testing → tasks 1.1, 2.2, 4.2, 5.3 cover all enumerated tests; manual verification in 6.2.
- §8 Migration → no DB; signature change to `runStreamingStage` is non-breaking (no new required params).
- §9 What we don't do → reflected by the lack of retry-loop, soft-recovery, multistream, redaction, AbortSignal tasks.

**Placeholder scan:** none.

**Type consistency:** `runWithJobContext`, `getJobContext`, `setStage`, `JobContext`, `StageMarker` consistent across phases 2/4. `installProcessErrorHandlers` signature consistent. `errToWire` shape consistent (Phase 1 streaming-extractor helper, Phase 4 reasonToWire is the equivalent).

Plan is complete.
