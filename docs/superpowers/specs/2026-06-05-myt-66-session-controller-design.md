# MYT-66 — Transient SessionController, DM Turn Pipeline & Distributed Lock — Design

> **Status:** design, pre-implementation. Second issue of the *Session Runtime + Combat L1* milestone; builds directly on MYT-65 (WS transport, session lifecycle, Redis session-state — shipped).
> **Spec basis:** Multiplayer Session Runtime §4 (transient controller), §6 (DM response flow), §17.1 (deterministic conductor), §17.7 (write-authority timing). This document records the implementation-level decisions taken during the 2026-06-05 brainstorm and the amendments they make to those sections.

## 1. Goal & framing

MYT-66 is the **turn-execution engine**: a transient `SessionController` that, when a turn is triggered, acquires a per-session distributed lock, loads session state from Redis, runs the fixed macro sequence (ST → FT → Scribe) as **deterministic code**, flushes state back to Redis, and releases the lock — surviving a mid-turn container crash via recovery on another worker.

The cognitive tiers (ST / FT / Scribe) are **stubbed** in this issue behind stable interfaces. MYT-68 (FT), MYT-69 (ST), and MYT-73 (Scribe) each swap one stub for a real implementation against the seams defined here. The trigger *system* (explicit / solo / auto-classifier + the mid-turn trigger queue) is **MYT-67**, which depends on this issue; MYT-66 exposes `enqueueTurn(...)` and drives its own end-to-end test through a minimal test/dev trigger.

**Done when:** a triggered turn acquires the lock, runs the stubbed-tier pipeline, broadcasts its frames, flushes, and releases; a container killed mid-turn is recovered and completed by another worker from clean state.

### In scope
- Transient `SessionController` (load → process → flush → destroy).
- `session-lock.ts`: per-session distributed lock (official Redis pattern on ioredis).
- The deterministic conductor (the §6 / §17.1 macro sequence) with stubbed tiers.
- Stable tier-boundary interfaces (`SlowThinker` / `FastThinker` / `Scribe`) + deterministic stub implementations.
- A BullMQ session-turn queue + worker (mirrors the MYT-65 suspend worker) and the `enqueueTurn` producer.
- Turn state added to session-state (`ft_history`, `summary`, `usage`) + flush/checkpoint reuse of MYT-65's checkpoint store.
- New server frames (`dm_thinking`, `text_delta`, `turn_end`) broadcast cross-container via the MYT-65 pub/sub path.
- Crash recovery: lock-expiry + BullMQ stalled-job redelivery; the never-flush-on-crash invariant.
- A minimal test/dev trigger to satisfy the done-when.

### Out of scope (later issues)
- Real ST / FT / Scribe (MYT-69 / MYT-68 / MYT-73).
- Real trigger modes + the mid-turn trigger queue + drain (MYT-67).
- The shared live character ledger + Rules Lawyer (MYT-70); combat state + mode switch (MYT-75).
- World-knowledge lookups (MYT-72) and retrieval substrates (MYT-71).
- Skill-check / dice tool resolution and roll-animation gating (MYT-68).

## 2. Architecture overview

A DM turn runs in a **BullMQ session-turn worker**, NOT inline on the WS connection. Rationale: BullMQ gives per-*job* stalled-job recovery for free (a worker dies → the job is redelivered to another), which is exactly the crash-recovery the done-when requires, and it matches every other async unit (world-gen, character-creation, session-prep, suspend). The cost is one enqueue→dequeue hop before streaming begins (tens of ms), acceptable for a multi-second LLM turn.

The worker runs in the **dedicated `worker.ts` process** (alongside world-gen / character-creation / session-prep), **not** the API process — so an API container crash (which drops WS sockets) never takes an in-flight turn down with it, and the turn worker never shares a process with a live `SessionHub`. It never holds the socket: it publishes `ServerFrame`s to the session's Redis pub/sub channel, and the API containers' MYT-65 `SessionHub` subscribers fan them out to the live sockets. This is the same publish→subscribe→fan-out path MYT-65 built; MYT-66 adds a *publisher* on the worker side.

> **Channel discipline (hardening H7):** MYT-65's pub/sub channel format (`{keyPrefix}session:campaign:{campaignId}`) is currently a hardcoded literal inside `session-hub.ts` with no exported surface. MYT-66 **extracts it into an exported helper** (`sessionChannel(keyPrefix, campaignId)` + the subscribe-pattern constant), refactors `SessionHub` to consume it, and the worker's publisher consumes the *same* helper — so the worker cannot silently publish to a channel no one subscribes to (a `redis.publish` to a dead channel returns `0` and throws nothing). The §13 integration test asserts a frame published by the worker is received by a **real** `SessionHub` subscriber, round-tripping the channel string.

```
enqueueTurn(campaignId, triggerMessages)
        │  (BullMQ job on the batch Redis queue)
        ▼
 session-turn worker  ──acquire──►  session lock (realtime Redis, SET NX PX)
        │                                  │ heartbeat extends every ~10s
        ├─ publish dm_thinking ────────────┼──► Redis pub/sub ──► API SessionHub ──► WS sockets
        │                                  │
        ├─ new SessionController.loadFromRedis()   (bulk read: ft_history, summary, state, usage)
        │                                  │
        ├─ conductor.processDmTurn():
        │     ST.evaluate(ctx)   (stub: {intervene:false})
        │     FT.render(ctx, emit)(stub: emit text_delta×N, return assistant msg)  ──► publish text_delta
        │     publish turn_end
        │     Scribe.extract(ctx)(stub: no-op; async, errors swallowed)
        │                                  │
        ├─ controller.flushToRedis()       (bulk write: ft_history, summary, usage) + checkpoint if ≥5min
        └─ release lock + stop heartbeat   (Lua compare-and-delete)
```

### Redis instance split
- **Realtime Redis** — session-state (MYT-65), the **session lock**, and the pub/sub channel. The lock lives next to the state it guards.
- **Batch Redis** — the BullMQ session-turn queue (mirrors all existing workers via `createBullmqRedisClient(batchUrl)`).

The worker process therefore holds two clients: a BullMQ-tuned batch client for the queue, and a realtime client for the lock + session-state reads/writes + frame publishing.

## 3. Module structure

| File | Responsibility |
|------|----------------|
| `src/session/session-lock.ts` | The per-session distributed lock: `acquire` / `extend` / `release` over a realtime ioredis client. Official Redis pattern (SET NX PX + Lua). |
| `src/session/session-controller.ts` | The transient controller: `loadFromRedis` / `flushToRedis` / `processDmTurn` (the conductor). Holds in-memory turn state. |
| `src/session/tiers/types.ts` | The tier-boundary types: `TurnContext`, `StEvaluation`, `AssistantMessage`, `TurnEmit`, and the `SlowThinker` / `FastThinker` / `Scribe` interfaces. |
| `src/session/tiers/slow-thinker.stub.ts` | Stub ST: returns `{ intervene: false }`. |
| `src/session/tiers/fast-thinker.stub.ts` | Stub FT: emits a deterministic `text_delta` (or two) via `emit`, returns a canned assistant message. |
| `src/session/tiers/scribe.stub.ts` | Stub Scribe: no-op (logs at debug). |
| `src/session/turn-queue.ts` | `enqueueTurn(campaignId, triggerMessages)` producer + `buildSessionTurnQueue` / the job payload type. |
| `src/session/turn-worker.ts` | The BullMQ processor: lock → controller → flush → release, with the heartbeat and frame publishing. `buildSessionTurnWorker` wired into `server.ts` like `buildSessionSuspendWorker`. |
| `src/redis/session-state.ts` (extend) | Add the turn-state keys: `ft_history`, `summary`, `usage` getters/setters + bulk `loadTurnState` / `flushTurnState`. |
| `src/contract/session-events.ts` (extend) | Add `dm_thinking`, `text_delta`, `turn_end` to `SERVER_FRAME_TYPES` + the `ServerFrame` union + `classify` coverage. |

Each module has one clear responsibility, a small surface, and is unit-testable in isolation (the lock against real Redis; the controller against stubs + a fake state store; the worker as an integration test).

## 4. The distributed lock (`session-lock.ts`)

No third-party lock library clears the repo dependency bar (`node-redlock` is an abandoned 4-year-old beta; `redis-semaphore` / `@sesamecare-oss/redlock` are individual/small-org, non-industry-standard). The lock is therefore a **first-party helper implementing Redis's own documented "Distributed Locks" pattern** on `ioredis` (industry-standard, already a dependency). This adds **no new package**.

### Semantics

- **Key:** `{prefix}session:lock:{campaignId}` on the realtime Redis.
- **Acquire:** `SET key <token> NX PX <ttlMs>` where `<token>` is a per-acquisition random value (`randomUUID()`). Returns a held-lock handle on success, `null` on contention (key already set). Non-blocking — the caller decides what to do on `null` (§8).
- **Extend (heartbeat):** a Lua script — `if redis.call('GET', key) == token then return redis.call('PEXPIRE', key, ttlMs) else return 0 end`. Run on a timer every `ttlMs / 3` (≈10s for a 30s TTL) while the turn runs. A `0` return means the lock was lost (expired + reacquired by someone else) → abort the turn (§8 / §10).
- **Release:** a Lua script — `if redis.call('GET', key) == token then return redis.call('DEL', key) else return 0 end`. Compare-and-delete so a worker can **never** release a lock it no longer owns (the classic correctness requirement).

### Liveness = the lock itself (amends §6)

§6 as written specifies two timers — a 120s lock + a separate 30s `dm_responding` flag with a heartbeat — plus a manual "break stale lock" step. **This design unifies them:** the lock's own TTL + heartbeat-extend *is* the liveness signal. A crashed holder stops extending; the lock atomically expires within `ttlMs` (≈30s); the next worker acquires the now-free key with a plain `SET NX`. **There is no manual break-stale step** — that step is a race window (two workers can both observe "stale" and both break + acquire), and atomic TTL expiry avoids it entirely. Worst-case takeover latency is unchanged from §6's `dm_responding` (≈30s).

`dm_responding` survives only as a **UI signal** ("DM is responding…"), decoupled from lock correctness — it is set/cleared alongside the lock but is never consulted to decide ownership.

**TTL choice & the takeover timing model (hardening H1).** `ttlMs = 30_000`, heartbeat every `10_000`. The TTL must comfortably exceed one heartbeat interval (so a brief GC pause doesn't drop the lock). Worst-case takeover after a crash is **lock-TTL expiry + BullMQ stalled-redelivery + retry backoff** — i.e. **~30–45s, NOT the "≈30s" of §6's `dm_responding`** (the unified design couples takeover to the TTL; this is the honest cost of dropping break-stale). The concurrency safety property rests on three coordinated facts, which the plan pins as explicit values and the spec states as invariants:
1. **A *live* worker cannot be double-run.** The heartbeat keeps extending the lock every ~10s, so even if BullMQ *spuriously* redelivers a still-alive worker's job (its event loop lagged past `lockDuration` but it's alive), the redelivered job's `tryAcquire` fails against the live-held lock. The heartbeat — not the TTL — is the primary double-run guard.
2. **A *crashed* worker frees the lock promptly.** With no heartbeat the lock expires within `ttlMs`; size `ttlMs` ≈ BullMQ's effective stalled-redelivery time so the redelivered job's `tryAcquire` succeeds on first try (the dead holder's lock has already expired) rather than burning its §8 backoff budget.
3. **A *stalled-then-resumed* worker aborts.** If a worker stalls long enough to miss BOTH its BullMQ job-lock renewal AND the session-lock heartbeat, a second worker acquires; when the original resumes, its next heartbeat-extend returns `0` → it aborts (§10) and its frames are dropped by the turn-id fence (H2). The exposure is the ≤1 heartbeat-interval window in H2.

Pin the inequality in the plan: `bullmq.lockDuration < sessionLockTtl`, and `sessionLockTtl ≈ bullmq.stalledInterval` (within a stated clock-skew budget). Lock expiry is evaluated on the single Redis server clock, so worker-to-worker clock skew does **not** affect it (a strength of single-instance vs. multi-instance Redlock).

### Why single-instance is sufficient
The lock is **coordination, not a safety-critical mutex**. On a (rare) miss — e.g., a pathological pause that lets the TTL lapse mid-turn — two turns could briefly run for one session; the consequence is bounded (some duplicated/interleaved streaming) and absorbed by the clean-retry, never-flush-on-crash design (§9). We are not guarding a financial invariant, so the multi-instance Redlock guarantee (and its well-known criticisms) is irrelevant here.

## 5. The transient SessionController (`session-controller.ts`)

A controller is **created per turn and GC'd after** — never long-lived. Its lifecycle, driven by the worker:

```ts
interface SessionController {
  loadFromRedis(): Promise<void>                              // bulk read into memory
  processDmTurn(triggerMessages: PlayerMessage[]): Promise<void>  // the conductor
  flushToRedis(): Promise<void>                               // bulk write + checkpoint
}
```

### What it holds in-memory (MYT-66 subset)

| State | Redis key | Notes |
|-------|-----------|-------|
| FT message history | `session:{campaignId}:ft_history` | the conversation the FT sees; new key (MYT-66) |
| Running summary | `session:{campaignId}:summary` | maintained by the ST (stub: unchanged) |
| Participants + session metadata | `session:{campaignId}:state` | reused from MYT-65 `getState`/`setState` |
| Token usage counters | `session:{campaignId}:usage` | new key (MYT-66); incremented per tier call |

**Deliberately excluded** (later issues): the shared live character ledger (MYT-70), combat state (MYT-75). The §4 table lists these; MYT-66's controller omits them and the `TurnContext` does not carry them.

`loadFromRedis` performs one bulk read (a pipeline / MGET over the keys); `flushToRedis` performs one bulk write. The controller does NOT read or write between load and flush except through its own in-memory copy — so a crash before flush leaves Redis exactly at pre-turn state (the recovery invariant, §9).

### The conductor (`processDmTurn`) — deterministic code, never an LLM

Following §17.1: orchestration is code; reasoning is delegated to bounded tier specialists. The fixed sequence:

1. **ST evaluate** — `st.evaluate(ctx)` → `StEvaluation`. (Stub: `{ intervene: false }`.) Append any `summaryUpdate` to the running summary in-memory; publish `st_evaluation` (debug frame — optional in MYT-66, see §11). The §5 tiered ST-skip (low-complexity → skip ST) is a *trigger-classifier* output and belongs to MYT-67/MYT-69; MYT-66 always calls the (stub) ST.
2. **FT render** — add `triggerMessages` to `ft_history` (attributed to player **character** names, not usernames — enforced-ignorance posture, though attribution data is trivial here), with the ST direction injected iff `intervene`. Call `ft.render(ctx, emit)`; `emit` publishes `text_delta` frames. Append the returned `AssistantMessage` to `ft_history` in-memory. Publish `turn_end`.
3. **Scribe** — `scribe.extract(ctx)` fired **async, non-blocking**; its errors are caught and logged and **never** fail the turn (§13). (Stub: no-op.) The real per-turn Scribe (tripwire + working-set append, §17.7) is MYT-73; MYT-66 only establishes the async-after-turn_end seam.

No LLM decides "what happens this turn." The only future autonomy is the FT's in-stream tool loop (MYT-68), which does not exist yet here.

## 6. The tier-stub boundary

The contract MYT-68 / 69 / 73 build against:

```ts
interface TurnContext {
  campaignId: string
  triggerMessages: PlayerMessage[]
  ftHistory: ConversationMessage[]   // read-only view of in-memory history
  runningSummary: string
  participants: SessionParticipant[]
  usage: { input: number; output: number }
}

type TurnEmit = (frame: TextDeltaFrame) => Promise<void>  // publishes a text_delta cross-container

interface StEvaluation { intervene: boolean; direction?: string; summaryUpdate?: string }
interface AssistantMessage { role: 'assistant'; content: string; usage?: { input: number; output: number } }

interface SlowThinker { evaluate(ctx: TurnContext): Promise<StEvaluation> }
interface FastThinker { render(ctx: TurnContext, emit: TurnEmit): Promise<AssistantMessage> }
interface Scribe      { extract(ctx: TurnContext): Promise<void> }
```

The controller is constructed with the three tier instances injected (constructor dependency injection), so a later issue swaps `new StubSlowThinker()` for `new RealSlowThinker(deps)`. This drop-in holds for the **ST and Scribe** (their `evaluate`/`extract` signatures are stable); the **FastThinker's `render` signature is provisional** — MYT-68's in-stream tool loop adds a tool-resolve callback and a wider emit (hardening H5), so `render` and the conductor's step 2 *will* grow then. Secret-tier inputs reach the ST/Scribe via their **constructor deps, never `TurnContext`** (hardening H4 — this is the enforced-ignorance boundary, made structural, not conventional). The stubs make the **whole pipeline run deterministically end-to-end now**: ST no-op, FT emits one canned `text_delta` (`"(the DM considers the scene…)"`) and returns a canned assistant line, Scribe no-op. This is what lets the crash-recovery test assert a *complete* turn without any model calls.

## 7. Turn queue, worker & crash recovery

### Producer
`enqueueTurn(campaignId: string, triggerMessages: PlayerMessage[]): Promise<void>` adds a job to the session-turn queue (batch Redis). The job payload is `{ campaignId, sessionId, triggerMessages }`. MYT-67's real triggers call this; MYT-66's test/dev trigger calls it directly.

### Worker (`buildSessionTurnWorker`)
Registered in the dedicated **`worker.ts`** `main()` (like the world-gen / session-prep workers — `worker.ts` already constructs the realtime client + key prefix), **not** double-hosted in `server.ts`. It follows the `buildSessionSuspendWorker` *construction* pattern (a dedicated `createBullmqRedisClient(batchUrl)` connection + the **mandatory `waitFor` ping-probe before `new Worker`**, per the MYT-65 boot-race lesson) and additionally holds a realtime client for the lock + state + frame publishing. Processor:

1. `tryAcquire` the session lock. On `null` (a turn is already running for this session) → re-enqueue the job with a short backoff delay and return (§8). On success → start the heartbeat.
2. Publish `dm_thinking`.
3. `new SessionController(...)` + `loadFromRedis`.
4. `processDmTurn(triggerMessages)` (publishes `text_delta` / `turn_end`).
5. `flushToRedis` (+ checkpoint if ≥5 min since last — reuses MYT-65's `CheckpointStore`: `readMaxSeq` → `sessionMessages.maxSeq`, `writeCheckpoint` → `sessions.update(stRunningSummary envelope)`; the envelope is extended to carry the turn-state snapshot).
6. `release` the lock + stop the heartbeat (in a `finally`, so an error still releases).

### Crash recovery (the load-bearing behavior)
A worker dies mid-turn → it stops renewing **both** BullMQ's job-lock and our session lock. After ~30s: BullMQ marks the job **stalled** and redelivers it to another worker (`lockDuration` / `stalledInterval` tuned to align with the 30s session-lock TTL so they free together); the session lock has **expired** (no heartbeat). The new worker `tryAcquire`s the free lock and re-runs the turn from clean Redis state — the dead turn never flushed (§5), so there is nothing to undo. BullMQ is at-least-once; the never-flush-on-crash invariant makes the retry **safe and deterministic** (with stub tiers, byte-identical). The player may have seen partial streamed text; on the retry the FT re-streams (real-tier UX of "DM response interrupted → retried" is MYT-68's concern).

## 8. Contention (failed acquire)

In MYT-66 the only contention is a second turn enqueued for a session whose turn is in flight. Behavior: `tryAcquire` returns `null` → the worker re-enqueues the job with a bounded backoff (a few attempts, then drop-with-log). This is a deliberately *minimal* placeholder. The real model — a **trigger queue** that collects triggers arriving mid-turn and drains them after the current turn (§6 steps 1 & 6) — is **MYT-67**, which replaces this re-enqueue with proper queue + drain semantics. MYT-66's test exercises the single-turn happy path + the crash-recovery path; it does not need true concurrent-turn handling.

## 9. Flush & checkpoint

`flushToRedis` writes `ft_history`, `summary`, and `usage` back **atomically** — a single `MULTI`/`EXEC` (or Lua) over the turn-state keys + TTL refresh, NOT a pipeline of independent `SET`s (hardening H3) — so a mid-flush failure can never leave torn state (new history, stale usage) that the retry would then double-append. If ≥5 minutes since the last checkpoint, it calls the MYT-65 `checkpoint(campaignId, sessionId, store)`.

**Checkpoint scope (honest, hardening H6).** MYT-66 *writes* a widened envelope (the running summary + a compact turn-state snapshot) but builds **no read-back / cold-start-from-checkpoint path** — that loader (parent §13 step 5) is a later issue. So MYT-66 does NOT yet deliver "recover turn state from Postgres after a full Redis loss"; in-session crash recovery rides BullMQ redelivery + the never-flush invariant (§7), which needs no checkpoint read. The envelope shares the `st_running_summary` column with the **suspend** writer: MYT-66 bumps the envelope `kind` to a superset the suspend reader still parses, and the two writers are last-writer-wins (both carry `maxSeq` + `state`; MYT-66 adds fields suspend ignores). When the ledger (MYT-70) lands it extends this same versioned envelope — so the `kind`/versioning discipline is fixed here, once.

Flush is the **last durable write** before release. The recovery invariant is precise: **nothing is written to durable Redis/Postgres session state before flush.** Published frames (`dm_thinking`/`text_delta`/`turn_end`) are NOT durable state — they are at-least-once and the client dedups a re-streamed turn by `turnId` (hardening H2).

## 10. Error handling

- **Lock lost mid-turn** (heartbeat extend returns `0`): abort the turn immediately, do **not** flush, do not publish further frames; log a warning. State stays at pre-turn; another worker (which now holds the lock) owns continuation. This is the same safe path as a crash.
- **Tier error** (ST or FT throws): the turn fails; do not flush partial state; release the lock; let BullMQ apply its retry policy (bounded). With stub tiers this path is only reachable via injected faults in tests.
- **Scribe error:** swallowed + logged; never fails the turn (§17.7 / §6 step 4).
- **Publish error** (Redis pub/sub down): per-frame best-effort with logging; a dropped frame does not abort the turn (clients recover via reconnect replay, MYT-65). Mirrors MYT-65's `SessionHub` fault isolation.
- **`finally`-release:** the lock release + heartbeat-stop run in a `finally` so any throw still frees the lock (belt-and-suspenders over the TTL).

## 11. Server frames added

MYT-65's `SERVER_FRAME_TYPES` had no DM frames. MYT-66 adds the minimum for a stubbed turn:
- `dm_thinking` — turn start (the UI "DM is responding…" cue; carries no seq).
- `text_delta` — FT prose chunk (`{ type, text }`); the only streamed content frame.
- `turn_end` — turn complete.

Debug frames `st_evaluation` and `scribe_result` (§6) are **deferred** to the issues that produce real ST/Scribe output (MYT-69 / MYT-73) — emitting them from stubs would add contract surface with nothing meaningful behind it. (If the dev-tool wants to observe stub turns, `dm_thinking` + `text_delta` + `turn_end` already prove the pipeline.) `skill_check` / `dice_roll` are MYT-68. These frames are **server→client only** and never carry plot information beyond the FT's public prose (enforced-ignorance posture holds trivially: the worker only ever publishes FT output + presence-style cues).

## 12. Amendments to the runtime spec

- **§6 (lock liveness):** replace the two-timer lock + separate `dm_responding` flag + manual break-stale with a single TTL + heartbeat-extend lock; `dm_responding` becomes a UI-only signal. Same ≈30s takeover, no break-stale race.
- **§4 / §6 (substrate):** the turn runs in a BullMQ session-turn worker, not inline; crash recovery is BullMQ stalled-job redelivery + lock TTL expiry.
- **§17.1 (conductor):** confirmed as deterministic code with injected tier specialists; MYT-66 ships the conductor + stubs.
- **§6 step 4 (Scribe timing):** MYT-66 establishes only the async-after-`turn_end` seam; the tripwire/working-set design (§17.7) is MYT-73.

## 13. Testing strategy

- **Lock (real Redis):** acquire/extend/release happy path; contention (`tryAcquire` returns null when held); expiry (no heartbeat → key gone after TTL); compare-and-delete safety (cannot release a re-acquired lock); extend-returns-0 on lost lock.
- **Conductor (stubs + fake state store):** asserts the macro order (ST → FT → Scribe), the in-memory mutations (trigger messages appended, ST direction injected only when `intervene`, assistant message appended, usage incremented), and that Scribe is fired after `turn_end` and its error doesn't fail the turn.
- **Load/flush round-trip:** load → mutate → flush → reload yields the mutated state; crash-before-flush leaves Redis unchanged.
- **Integration (`enqueueTurn` → worker):** a real queued job runs the full pipeline and publishes `dm_thinking` → `text_delta` → `turn_end` in order; Redis state is flushed; lock is released.
- **Crash recovery:** start a turn, kill the worker / force-expire the lock mid-turn, assert another worker redelivers and completes the turn from clean state, with the lock ultimately released.

All backend tests target `mythrun_test`; the lock + worker integration tests need a real Redis (realtime + batch) — both must be provisioned in CI's `deploy.yml` build job (already true after the MYT-65 follow-up that added the 6380 batch service).

## 14. Open / deferred

- **Exact checkpoint-envelope shape** when it grows beyond `stRunningSummary` — a small schema decision settled at plan time (must stay backward-compatible with MYT-65's envelope).
- **BullMQ `lockDuration` / `stalledInterval` / `maxStalledCount` exact values** — tuned at plan time to align with the 30s lock TTL and bound retry storms.
- **Slow-Thinker call-shape** (§17.8) remains open at the tier level but does not affect MYT-66 (the stub satisfies the interface; MYT-69 decides the real shape).

## 15. Round-1 blind-review hardening

A four-reviewer blind panel (lenses: distributed-locking, state/flush, tier-boundary, integration) found **0 showstoppers** and a strong batch of forward-compat + correctness hardening. Resolved decisions, folded into the sections above and implemented by the plan:

- **H1 — Crash-recovery timing model (applied §4).** The heartbeat (not the TTL) is the primary double-run guard for a *live* worker; the TTL frees a *crashed* worker's lock; a *stalled-then-resumed* worker aborts on a failed extend. Plan pins `bullmq.lockDuration < sessionLockTtl ≈ bullmq.stalledInterval` with a clock-skew budget. Real takeover is ~30–45s, not "≈30s" — stated honestly.
- **H2 — `turnId` frame fence (applied §9; §11 adds the field).** A stable `turnId` (UUIDv7 derived from the BullMQ jobId, **constant across redeliveries**, NOT regenerated per worker) rides `dm_thinking`/`text_delta`/`turn_end`. Client rule: a `dm_thinking` with a `turnId` already seen *replaces* the prior partial render for that turn — so an at-least-once re-stream (retry) or a stalled-worker's late frames dedup cleanly. The `emit` closure is fenced on the lock token so a worker that lost the lock drops its own frames at the publisher. With stub tiers the re-stream is byte-identical; the field + fence are what make MYT-68's non-deterministic FT safe. MYT-66 test: assert `turnId` is present and stable across a forced redelivery.
- **H3 — Atomic flush (applied §9).** `flushToRedis` is a single `MULTI`/`EXEC` (or Lua) so a mid-flush failure cannot leave torn state.
- **H4 — Public-by-construction `TurnContext` + secrets via constructor (applied §6).** `TurnContext` is FT-safe by contract — every field is public-tier. The FT is typed against a narrow `FtTurnContext`; the ST receives `FtTurnContext & StSecrets`, where `StSecrets` (the `sd_playbook`, NPC secrets, narrative threads) is loaded by the ST from its **constructor deps**, never threaded through `TurnContext`. Adding a secret to the ST's view is then a compile-time-isolated change that *cannot* reach `FastThinker.render` — enforced ignorance becomes structural, not a field-discipline convention (CLAUDE.md #1).
- **H5 — FT `render` seam is provisional (applied §6).** `TurnEmit` is typed to the DM-frame union (not only `TextDeltaFrame`), and the MYT-68 tool loop will add a `resolveTool` callback + the conductor's 4–5-iteration cap. The resolver return type is reserved so a tool result may be an **ST-authored relay** (the §17.4 lookup flow), not only a mechanical constraint — so MYT-72's FT→resolver→ST→FT path isn't foreclosed.
- **H6 — Honest checkpoint scope + dual-writer discipline (applied §9).** MYT-66 writes the widened envelope but builds no read-back; in-session recovery rides BullMQ redelivery, not the checkpoint. The envelope `kind` is bumped to a suspend-readable superset; writers are last-writer-wins; versioning is fixed here for the future ledger field (MYT-70).
- **H7 — Exported channel helper + round-trip test (applied §2).** The pub/sub channel format becomes an exported helper consumed by both `SessionHub` and the worker; the §13 integration test round-trips a worker-published frame through a real subscriber, so a wrong-channel silent-zero-fan-out cannot ship.
- **H8 — Terminal-failure liveness.** `maxStalledCount` is set deliberately (≥2–3, pinned in the plan), and on terminal job failure (retries/stalls exhausted, or an unrecoverable tier error) a `turn_error` frame is published to the session channel and the `dm_responding` UI flag is cleared — the player sees "DM response failed, retry," never silence. Add the "retries exhausted / job failed terminally" row to §10's error matrix.
- **H9 — Working-set seam reserved.** `TurnContext` carries a `workingSet` field (empty array in MYT-66) so the FT/resolver read seam (working-set ∪ canon, §17.7) exists from the start. The `Scribe` seam returns a `ScribeResult` carrying working-set **deltas the controller flushes** (or an injected writer that routes through the controller's flush) — never a direct async Redis write, which would violate the never-flush-on-crash invariant. The per-turn Scribe's core-secret tripwire takes its secrets via constructor deps (same channel as H4).
- **H10 — Full producer wiring + jobId policy.** §7's `enqueueTurn` requires the complete producer contract: `buildSessionTurnQueue` **and** `stubSessionTurnQueue` (the boot-gate-disabled path; `AppDeps` requires a non-undefined value), threaded through `AppDeps` in **both** `buildApp` sites (real + `fallbackStart`), the shutdown drain extended, and `defaultJobOptions` set (`removeOnComplete`/`removeOnFail: true`, `attempts`, `maxStalledCount`). Turn jobs use **no custom jobId** — the per-session mutex is the lock, not the jobId — so stalled-redelivery and the §8 re-enqueue both work without dedup-clobber.
- **H11 — `ft_history` windowing seam named.** Unbounded `ft_history` growth is bounded by the ST running-summary windowing, which is **MYT-69's** responsibility (`loadFromRedis` will return a windowed view while the summary carries older context). MYT-66 flushes the full append — a known, temporary unboundedness acceptable only because stub-tier test sessions are short; a tracking bead records it so it isn't silently load-bearing in production.
- **H12 — Precision notes.** (a) `usage` is mutated only in the in-memory copy and persisted solely by `flushToRedis`; tier calls never write the Redis usage key directly (retry-safe by contract). `StEvaluation` gains a `usage` field and the controller **accumulates each tier's returned usage** (the FT's is summed across tool-loop passes) rather than "incrementing per call." (b) `TurnContext.participants` carries the lightweight Redis `:state` shape (the `string[]` of participant ids/names), NOT the Postgres `SessionParticipant` row — preserving the "one Redis read, no DB between load and flush" invariant; §6's type is corrected to the Redis shape. (c) The `finally`-release uses the compare-and-delete Lua form **only** (never an unconditional `DEL`) so it can never delete a successor's freshly-acquired lock. (d) MYT-66 does **not** persist DM turns to `session_messages` (no seq assignment); a recovered turn is live-stream-replayable only, and durable DM-message persistence + idempotent per-turn seq is explicitly a later issue. (e) `st_evaluation`/`scribe_result` are pre-reserved as a **debug-only frame category** (excluded from the player transcript/search per §17.7) sharing the turn's seq, so MYT-69/73 slot them in without re-opening the frame contract. (f) `ConversationMessage`/`AssistantMessage` content is flagged provisional — MYT-68's tool loop needs multi-part (Anthropic content-block) content in `ft_history`, a stored-shape change the checkpoint envelope (§14) must accommodate. (g) §13's conductor test injects a stub-ST-with-`summaryUpdate` variant so the summary-append-then-flush path is covered (the canned stub returns none).
