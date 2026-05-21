# Worker Resilience + Dev Logging — Design

**Scope:** combines two filed bugs into one shipping unit:

- **myth-449j** — streamObject Zod failures throw inside the AI SDK's WebStreams transform, escape our stage-handler try/catch, become unhandled rejections, and crash the worker process (Node 24 default behavior).
- **myth-lmz6** — no persistent dev-server log capture; when the worker crashes the only diagnostic is terminal scrollback.

Combined because: better logs make a resilient process actually useful (a worker that silently soft-recovers without persistent logs is worse than a visibly crashing one), and a resilient process needs durable forensics for the rare cases it doesn't recover.

---

## 1. The failure shape we're fixing

`backend/src/llm/ai.ts:540` wraps the AI SDK's `streamObject`. The wrapper attaches a `.then(...)` rejection handler to `sdkResult.object` (the final-tree Promise), which is where the repair chain fires. But the **partial-object stream** (`partialObjectStream`, `fullStream`) is the SDK's untouched getter. When the SDK's internal WebStreams transform validates a partial chunk against the Zod schema and rejects (somewhere around `stream-object.ts:737`), the rejection propagates through whatever consumes the partial stream — but it can also escape via a parallel transform pipeline the SDK uses internally that the consumer doesn't have a handle on.

Concretely: when stage 4's Sonnet stream emitted malformed UUIDs in `hierarchy_stragglers` on May 20 03:40 UTC, the resulting rejection bypassed the `runEntityRelationshipsStage` try/catch, surfaced as an unhandledRejection, and the server's startup-failure force-exit path (`backend/src/server.ts:438-442`) ran. The whole worker died, taking every other in-flight campaign with it.

Zero `process.on('unhandledRejection')` or `process.on('uncaughtException')` handlers exist anywhere in `backend/src/`. Node 24's default behavior (process exits) is what we have.

---

## 2. Defense-in-depth: two layers

### Layer 1 — Local guard in `runStreamingStage` (clean exception conversion)

`backend/src/llm/prep/streaming-extractor.ts` already loops over `partialObjectStream` to drive its closed-entry emit gate. The for-await loop is currently NOT wrapped in a try/catch — if the SDK's partialObjectStream iterator rejects, the rejection propagates up to the caller's await chain. The local guard adds the missing try/catch so the rejection is observed at a known boundary, logged with structured context, then rethrown.

On catch:

```ts
try {
  for await (const partial of partialObjectStream) { ... }
  // ... post-loop trailing-entry pass ...
} catch (err) {
  config.logger?.warn({
    event: 'streaming.stream_died',
    stage: config.stage,
    survivors: emitted.size,
    error: errToWire(err),
  }, 'streaming-extractor: stream died mid-flight; rethrowing')
  throw err
}
```

The handler's `await result.object` then also rejects (the SDK fires both side rejections in parallel; the wrapper's repair chain runs against the `object` rejection per ai.ts:571–586). Persistence does NOT happen on a stream-failed run: `persistTree(client, worldId, validatedTree, ...)` only runs after `result.object` resolves to a validated tree. If the repair chain exhausts, the wrapper rethrows, the stage handler's `await result.object` throws, and the world-gen-processor's per-stage failure handler (`handleStageError`) marks the world failed and publishes `phase: 'world_gen_failed'` as it does today.

**No soft-recovery.** Holistic schema validation of the full tree is the unit of correctness — partial persistence would risk shipping entities that look valid individually but violate cross-entity invariants (e.g., a region's prose name-drops a faction that didn't get persisted). The user's explicit position: if the stream dies, hard-fail. The global handler in Layer 2 is the resilience net for cases the local guard doesn't catch (rejections that escape through SDK-internal side streams).

Stages 4 and 4b use `generateObject`, not `streamObject` — they batch at end-of-stream by construction, so this layer doesn't apply to them. Their failures (which fire from `await result.object` and are caught by the wrapper's repair chain) are already handled correctly.

### Layer 2 — Global `unhandledRejection` + `uncaughtException` handlers (the safety net)

Installed early in `backend/src/server.ts:main()`, before `app.listen`. Installing the handler **suppresses** Node 24's default termination behavior (default is `throw`, which crashes the process) — the spec relies on this suppression for soft-survival to be possible at all.

On rejection:

1. Read AsyncLocalStorage context (§3 below) to learn `{jobId, worldId, campaignId, stage}`. If no context exists (the rejection didn't originate inside a job's frame), skip steps 5 and proceed.
2. Log at error level with `event: 'process.unhandled_rejection'`, full stack, ALS context, rejection reason.
3. Push the current timestamp onto a ring buffer of recent rejection timestamps. Buffer threshold is tuned for the worker's concurrency: with `CONCURRENCY_WORLD_GEN = 3` (see `backend/src/llm/middleware/bullmq-config.ts`), one bad Anthropic release can produce 3 simultaneous rejections, so a 2-event threshold would hair-trigger. Default: **5 rejections within 5 minutes** triggers escalation.
4. **Soft-escalation:** count timestamps in the buffer within the last 5 minutes.
   - If ≥ 5: this is chronic. Mark the in-flight job failed (best-effort — see below), flush pino synchronously, then `process.exit(1)`. ECS / tsx watch restarts the container.
   - Else: log and continue.
5. **Mark-failed best-effort** uses the ALS context:
   - `UPDATE worlds SET status='failed' WHERE id = $1` for `ctx.worldId`.
   - Publish SSE: `{type: 'phase', phase: 'world_gen_failed'}` on `${keyPrefix}pipeline:campaign:${campaignId}`. The constant matches what `world-gen-processor.ts:867-887`'s existing `handleStageError` publishes; using the same phase name keeps SSE subscribers from seeing two distinct terminal phases under racing-completion edge cases.
   - The current BullMQ job: no clean way to mark it failed from outside the processor's await chain. The BullMQ lock expires (default ~30s for world-gen) and the queue's stalled-job-recovery moves the job out of "active." The world row already reflects failure; the operator-visible state is correct from the moment we mark it.

**Sync flush before exit (real mechanism, not `pino.flushSync()`).** The handler needs a guarantee that the final error log reaches stdout before `process.exit(1)`. Pino's default logger has no `flushSync()` method; the spec uses the documented mechanism: the logger is constructed against `pino.destination({sync: true})` in dev + staging + prod alike. Synchronous writes to stdout block the calling code until the OS write returns, so by the time `process.exit(1)` runs, the log line has left the process and is in the kernel pipe (dev) or the Docker stdout stream (prod), where ECS's awslogs driver picks it up. The minor throughput cost vs async writes is acceptable for a structured-log workload at our scale.

Same handler logic applies for `uncaughtException` — synchronous throws that escape try/catch. Belt-and-suspenders.

**Concurrency note for the ALS read.** With `CONCURRENCY_WORLD_GEN = 3`, three jobs are typically in-flight simultaneously. AsyncLocalStorage propagates context through Promise reaction chains correctly when the rejection originates in the same async lineage as the job that scheduled the awaited work. The known fragility: if the AI SDK creates an internal stream consumer (e.g., `fullStream`) whose async lineage doesn't carry the job's ALS frame, the handler may see no context or the wrong job's context. The §7 tests must specifically exercise the concurrent-jobs scenario, including: rejection from inside a per-job stream returning the correct ALS context; rejection from a top-level non-job-scoped Promise returning `undefined` context (and the handler degrading to log-only).

---

## 3. AsyncLocalStorage job context

New file `backend/src/worker/job-context.ts`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks'
import type { WorldGenStage } from '../llm/prep/streaming-extractor.js'

export interface JobContext {
  readonly jobId: string
  readonly worldId: string
  readonly campaignId: string
  stage: WorldGenStage | 'pre-stage' | 'post-stage'
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

export function setStage(stage: WorldGenStage | 'pre-stage' | 'post-stage'): void {
  const ctx = storage.getStore()
  if (ctx !== undefined) ctx.stage = stage
}
```

Wiring:

- The BullMQ processor function in `backend/src/llm/prep/world-gen-processor.ts` wraps its per-job body in `runWithJobContext(...)`.
- The stage dispatch loop in the same file calls `setStage(stage)` at the top of each iteration so the ALS context always knows the active stage.

Cost: one `AsyncLocalStorage.run` per job (cheap), one `setStage` per stage (cheap). No other code reads from ALS unless it wants to — the data is there if the global handler needs it.

---

## 4. Why no soft-recovery (the path we considered and dropped)

An earlier draft of this spec proposed soft-recovering stages 2 and 3 with whatever entities passed `sub_schema` validation during the stream. The premise was that "what already streamed is already in DB" — i.e., mid-stream persistence. Reviewing the code revealed that's not what happens: `runStreamingStage` publishes SSE wire events mid-stream but DB persistence happens at end-of-stream via `persistTree(validatedTree, ...)` after `await result.object` resolves to the full validated tree.

Closing that gap would require either mid-stream DB writes (significant restructuring of stages 2 and 3) or a "tolerant persist" that filters end-of-stream by a survivor set. The user's call: neither. Holistic schema validation of the full tree is the unit of correctness. Soft-recovery would risk shipping entities that look valid individually but violate cross-entity invariants — a region's prose name-drops a faction that didn't get persisted, an NPC's parent-location-id points at a location that didn't make it through. The blast radius of partial persistence on a freshly generated world is bigger than the convenience of "use what survived."

If a stream dies, hard-fail. Layer 2 catches what Layer 1 doesn't.

---

## 5. Dev log persistence

The architectural insight from the brainstorm: **all application code stays unchanged.** Every logger call already produces pino JSON to stdout. The only environmental difference is who captures stdout — ECS awslogs driver in prod (`infra/modules/serving/main.tf:199-205`), nothing in dev today.

Adding pino multistream would break that invariant by making dev do dual-writes prod doesn't do. The right move is to add a dev-local stdout capture mechanism that mirrors what ECS provides in prod.

### Implementation

- New script: `backend/scripts/dev-logged.sh`. Bash. Does three things:
  1. `set -euo pipefail` at the top so a broken segment of the pipe surfaces as a non-zero script exit (without this, bash's default makes `$?` reflect only the last pipe segment).
  2. `mkdir -p logs && find logs -name 'dev-*.log' -mtime +7 -delete` (cleanup older than 7 days). Runs on every dev-server start.
  3. Computes today's filename: `logs/dev-$(date +%F).log`.
  4. Execs `tsx watch ... | tee -a "$LOG_FILE" | pnpm exec pino-pretty` (preserves the existing tsx watch behavior; tees raw JSON to file; renders terminal output via pino-pretty for human reading). `pnpm exec` resolves the binary against the workspace's `node_modules/.bin` so the script works regardless of whether the user's shell has it on PATH.

- `backend/package.json` scripts:
  - `dev` → `bash scripts/dev-logged.sh` (the new default)
  - `dev:raw` → the current command (raw stdout, no capture, no pretty) for the rare case you want it

- `.gitignore` gains `backend/logs/`.

- `pino-pretty` added to `backend/devDependencies` (canonical companion to pino for dev terminal viewing).

- The pino logger in `backend/src/llm/logger.ts` is constructed against `pino.destination({sync: true})` in all environments. Synchronous writes to stdout block until the OS `write()` syscall returns, so when the global handler logs and then immediately `process.exit(1)`s, the final diagnostic has already left the process. The throughput cost is acceptable for our log volume.

### What this does NOT do

- No new logger abstractions in app code. Every existing `logger.info(...)` continues to work unchanged.
- No new pino destinations or transports inside the application. The capture is purely a stdout-pipeline concern.
- No changes to staging or prod. Both still rely on ECS awslogs → CloudWatch.

---

## 6. Files touched

**New files:**
- `backend/src/worker/job-context.ts` — AsyncLocalStorage wrapper.
- `backend/scripts/dev-logged.sh` — dev capture wrapper.
- `backend/src/worker/__tests__/job-context.test.ts` — unit tests for the ALS wrapper.
- `backend/src/__tests__/unhandled-rejection.test.ts` — process-level handler tests.

**Modified files:**
- `backend/src/llm/prep/streaming-extractor.ts` — try/catch local guard around the for-await; structured warn on catch; rethrow.
- `backend/src/llm/prep/world-gen-processor.ts` — wrap per-job body in `runWithJobContext`; call `setStage(stage)` in the stage loop.
- `backend/src/server.ts` — install `unhandledRejection` + `uncaughtException` handlers in `main()` before `app.listen`.
- `backend/src/llm/logger.ts` — sync destination so the global handler's final log reaches stdout before `process.exit(1)`.
- `backend/package.json` — `dev` script, new `dev:raw`, new `pino-pretty` devDependency.
- `.gitignore` — `backend/logs/`.
- `backend/src/llm/prep/__tests__/streaming-extractor.test.ts` — stream-died-logs-and-rethrows test case.

---

## 7. Testing

### Layer 1 (local guard) — unit tests in streaming-extractor.test.ts

- **Stream-died log + rethrow.** Drive the partial stream until N entities emit, then have the upstream stream reject. Expect a `streaming.stream_died` warn log carrying `stage`, `survivors: N`, `error: errToWire(err)`. Expect the original error to propagate (rethrow).
- **No-error happy path.** Stream completes normally. No `stream_died` log. `finalTree` defined, returned to caller.

### Layer 2 (global handler) — integration tests in unhandled-rejection.test.ts

- **Single rejection inside ALS context.** Fire a rejection from a `setTimeout` inside `runWithJobContext`. Expect the handler to log with the job context, mark `worlds.status='failed'`, publish SSE `phase: 'world_gen_failed'`, NOT exit. Use a fake `process.exit` shim.
- **Five rejections within 5 min.** Same as above, fired in quick succession. Expect the fifth to call `process.exit(1)` after marking failed.
- **Five rejections spread across 6 min.** Use fake timers. Confirm the fifth one does NOT exit (the window slid the older entries out).
- **Rejection outside ALS context.** Fire a top-level rejection. Expect the handler to log without context, NOT mark any world failed, NOT exit on first occurrence.
- **Concurrent jobs ALS isolation.** Run two `runWithJobContext` calls concurrently (different jobIds + worldIds). Fire a rejection from inside job A's async lineage. Verify the handler reads job A's context, marks job A's world failed, does NOT touch job B's world. This is the concurrency=3 scenario in microcosm.

### Layer 3 (dev logging) — script smoke

- `bash scripts/dev-logged.sh --self-test` (a self-test mode that exits immediately after creating the file). Verify the log file exists, contains today's date in the filename, and that `pino-pretty` is available.

### Manual / non-test verification

- Trigger a `streamObject` failure via a deliberately broken schema in a dev session: confirm the worker survives, the world is marked failed, the SSE feed receives `phase: 'world_gen_failed'`, and the dev log file contains the structured rejection log.
- Restart `pnpm dev` and confirm files older than 7 days in `logs/` get cleaned up.

---

## 8. Migration / backward compatibility

- No DB migration.
- No SSE wire-protocol change. The `phase: 'failed'` event is already in `pipeline-events.ts`.
- `runStreamingStage`'s signature gains an optional `softRecoveryThreshold` field; existing call sites that don't pass it fall through to the rethrow path (current behavior). Stage 2 and 3 are the only ones that pass it.

---

## 9. What this design intentionally doesn't do

- **No retries.** The user's explicit choice: same input → same failure; retries waste credits and operator time. The world is marked failed; the user re-triggers manually.
- **No soft-recovery with survivors.** §4 explains the rationale: holistic-tree validation is the unit of correctness; partial persistence risks cross-entity invariant violations. Hard-fail is the contract.
- **No multistream in pino.** The dev capture is purely a stdout-pipeline concern; app code stays unchanged.
- **No log shipping to CloudWatch from dev.** Dev logs are local files; staging and prod continue to use ECS' awslogs driver.
- **No proactive BullMQ job.moveToFailed from outside the processor.** The lock-expiry path is sufficient. The accepted cost: `worlds.status='failed'` lands immediately, but the BullMQ job stays in "active" for up to ~30s until its lock expires and the stalled-job recovery moves it out. The operator-visible state via the world row + SSE phase event is correct from the moment we mark it; the BullMQ-side lag is internal-only.
- **No log redaction.** The application's existing pino logger has no `redact:` config; LLM prompts and middleware-emitted error bindings are logged in full. This is pre-existing scope (we don't redact in production CloudWatch either) and isn't introduced by persisting dev logs to disk. A future redaction pass is a separate concern; if/when it lands, it applies to ALL environments uniformly via the shared pino instance.
- **No `AbortSignal` propagation through the streamObject wrapper.** The AI SDK supports `abortSignal` + `onAbort` for bounded stream execution; we don't use it today. A future "cancel a running world-gen" feature would want it; for the current resilience scope, the soft-recovery + global handler path is sufficient.

---

## 10. Open questions

None at design time. All decisions enumerated above came out of the brainstorm.
