# MYT-66 — Transient SessionController, DM Turn Pipeline & Distributed Lock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A transient `SessionController` runs one DM turn — under a per-session distributed lock, in a BullMQ turn worker — through a deterministic ST→FT→Scribe conductor with the tiers stubbed, broadcasting frames cross-container and flushing state, and recovering on another worker if killed mid-turn.

**Architecture:** A BullMQ session-turn worker (in the dedicated `worker.ts` process) acquires a first-party Redis lock (`SET NX PX` + `eval` Lua extend/release on ioredis — no new package), constructs a transient controller that bulk-loads turn state from realtime Redis, runs the conductor (injected stub tiers), publishes `dm_thinking`/`text_delta`/`turn_end` to the session pub/sub channel (the MYT-65 `SessionHub` fans out to sockets), atomically flushes, and releases. Crash recovery rides BullMQ stalled-job redelivery + the never-flush-on-crash invariant.

**Tech Stack:** Node 24, TypeScript (strict), ioredis, BullMQ 5, Postgres (pg), Vitest. Spec: `docs/superpowers/specs/2026-06-05-myt-66-session-controller-design.md` (read §15 H1–H12 — every hardening item maps to a task below).

---

## File structure

**Create:**
- `backend/src/contract/session-channel.ts` — exported pub/sub channel helper (`sessionChannel`, `sessionChannelPattern`, `campaignIdFromChannel`). (H7)
- `backend/src/session/session-lock.ts` — the per-session distributed lock (`createSessionLock` → `acquire`/`extend`/`release`).
- `backend/src/session/tiers/types.ts` — `TurnContext`/`FtTurnContext`/`StSecrets`/`StEvaluation`/`AssistantMessage`/`ConversationMessage`/`TriggerMessage`/`TurnEmit`/`ScribeResult` + `SlowThinker`/`FastThinker`/`Scribe` interfaces. (H4/H5/H9/H12)
- `backend/src/session/tiers/stubs.ts` — `StubSlowThinker`/`StubFastThinker`/`StubScribe`.
- `backend/src/session/turn-publisher.ts` — `createTurnPublisher(redis, keyPrefix)` → a `TurnEmit` + frame helpers (publishes via the channel helper).
- `backend/src/session/session-controller.ts` — `SessionController` (load/process/flush).
- `backend/src/session/turn-queue.ts` — `QUEUE_SESSION_TURN`, `TurnJobPayload`, `TurnQueueLike`, `enqueueTurn`, `turnJobName`.
- `backend/src/session/turn-worker.ts` — `processTurnJob` (the worker body) + `buildSessionTurnWorker`.

**Modify:**
- `backend/src/contract/session-events.ts` — add `dm_thinking`/`text_delta`/`turn_end`/`turn_error` to `SERVER_FRAME_TYPES` + `ServerFrame`. (H2/H8)
- `backend/src/ws/session-hub.ts` — consume `session-channel.ts` instead of inline literals. (H7)
- `backend/src/redis/session-state.ts` — add turn-state keys + `loadTurnState`/`flushTurnState` (atomic) + widen the checkpoint envelope. (H3/H6)
- `backend/src/server-queues.ts` — `buildSessionTurnQueue` + `stubSessionTurnQueue`. (H10)
- `backend/src/app-deps.ts` — add `sessionTurnQueue: TurnQueueLike`. (H10)
- `backend/src/server.ts` — thread `sessionTurnQueue` into both `AppDeps` literals (real + `fallbackStart`). (H10) (NO worker here — see worker.ts.)
- `backend/src/worker.ts` — register the turn worker (health array, log line, shutdown). (worker topology)
- `backend/src/routes/dev.ts` (or the existing dev-routes module) + `backend/src/contract/backend-routes.ts` — `POST /api/dev/campaigns/:campaignId/fire-turn` (the minimal test/dev trigger).

**Tests** are colocated under `__tests__/` next to each source file (per `backend/src/__tests__/CONVENTIONS.md`).

> **Cross-task contract (read before every task).** Types are defined once in `tiers/types.ts` (Task 4) and `session-events.ts` (Task 1); never redefine them. Redis: the **lock + turn-state + pub/sub** use the **realtime** client (`createRedisClient`); the **queue** uses the **batch** client (`createBullmqRedisClient`). The session-state key base is `${keyPrefix}session:${campaignId}:…`; the pub/sub channel is `${keyPrefix}session:campaign:${campaignId}` (different — do not conflate). All backend tests target `mythrun_test`; real-Redis tests mirror `session-suspend.test.ts` (unique queue name per run, targeted `remove` in `afterEach`, never `obliterate`).

---

### Task 1: Server frames — `dm_thinking` / `text_delta` / `turn_end` / `turn_error`

**Files:**
- Modify: `backend/src/contract/session-events.ts`
- Test: `backend/src/contract/__tests__/session-events.test.ts` (existing — extend)

The `session-events.ts` header already reserves these for MYT-66. Add them as **server→client only** (NOT to `CLIENT_FRAME_TYPES`/`classifyClientFrame`). Each DM frame carries a `turnId` (H2: stable across redeliveries, used by the client to dedup a re-streamed turn).

- [ ] **Step 1 — failing test.** In `session-events.test.ts`, add:
```ts
import { SERVER_FRAME_TYPES, classifyClientFrame } from '../session-events.js'

it('MYT-66 DM frames are server-only and present', () => {
  for (const t of ['dm_thinking', 'text_delta', 'turn_end', 'turn_error']) {
    expect((SERVER_FRAME_TYPES as readonly string[]).includes(t)).toBe(true)
    expect(classifyClientFrame(t)).toBe(false) // never an inbound client frame
  }
})
```
- [ ] **Step 2 — run, expect FAIL** (`pnpm exec vitest run src/contract/__tests__/session-events.test.ts`): the four strings are absent.
- [ ] **Step 3 — implement.** Append to `SERVER_FRAME_TYPES`: `'dm_thinking', 'text_delta', 'turn_end', 'turn_error'`. Add to the `ServerFrame` union:
```ts
  | { type: 'dm_thinking'; turnId: string }
  | { type: 'text_delta'; turnId: string; text: string }
  | { type: 'turn_end'; turnId: string }
  | { type: 'turn_error'; turnId: string; message: string }
```
(None carry `seq` — they are intra-turn/control frames, consistent with the existing presence-frame rule. Do not touch `CLIENT_FRAME_TYPES`/`ClientFrame`/`classifyClientFrame`.)
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit:** `git add backend/src/contract/session-events.ts backend/src/contract/__tests__/session-events.test.ts && git commit -m "feat(MYT-66): DM turn server frames (dm_thinking/text_delta/turn_end/turn_error)"`

---

### Task 2: Exported pub/sub channel helper (H7)

**Files:**
- Create: `backend/src/contract/session-channel.ts`
- Modify: `backend/src/ws/session-hub.ts` (consume the helper)
- Test: `backend/src/contract/__tests__/session-channel.test.ts`

The channel format is currently a literal inside `session-hub.ts`. Extract it so the turn worker (a different process) publishes to the **exact** channel `SessionHub` subscribes to — a wrong re-derivation would silently fan out to no one.

- [ ] **Step 1 — failing test** (`session-channel.test.ts`):
```ts
import { sessionChannel, sessionChannelPattern, campaignIdFromChannel } from '../session-channel.js'

const P = 'staging:use1:'
it('round-trips campaignId through the channel string', () => {
  const ch = sessionChannel(P, 'camp-1')
  expect(ch).toBe('staging:use1:session:campaign:camp-1')
  expect(sessionChannelPattern(P)).toBe('staging:use1:session:campaign:*')
  expect(campaignIdFromChannel(P, ch)).toBe('camp-1') // suffix-slice, prefix contains colons
})
```
- [ ] **Step 2 — run, expect FAIL** (module missing).
- [ ] **Step 3 — implement `session-channel.ts`:**
```ts
const SUFFIX = 'session:campaign:'

export function sessionChannel(keyPrefix: string, campaignId: string): string {
  return `${keyPrefix}${SUFFIX}${campaignId}`
}

export function sessionChannelPattern(keyPrefix: string): string {
  return `${keyPrefix}${SUFFIX}*`
}

/** Suffix-slice — the prefix contains colons, so never split on ':'. */
export function campaignIdFromChannel(keyPrefix: string, channel: string): string {
  return channel.slice(`${keyPrefix}${SUFFIX}`.length)
}
```
- [ ] **Step 4 — refactor `session-hub.ts`** to import and use these (replace the inline `pattern`/`channelPrefix`/`channelFor` and the suffix-slice in the `pmessage` handler). Run the existing `session-hub.test.ts` to confirm no regression.
- [ ] **Step 5 — run both tests, expect PASS.**
- [ ] **Step 6 — commit:** `git add backend/src/contract/session-channel.ts backend/src/contract/__tests__/session-channel.test.ts backend/src/ws/session-hub.ts && git commit -m "refactor(MYT-66): extract exported session pub/sub channel helper (H7)"`

---

### Task 3: Session lock (`session-lock.ts`)

**Files:**
- Create: `backend/src/session/session-lock.ts`
- Test: `backend/src/session/__tests__/session-lock.test.ts` (real Redis — realtime)

First ioredis `eval` Lua in the codebase; follow the `reseedSeq` house style (`KEYS`/`ARGV`, `redis.call`). The lock is **coordination, not safety-critical** (§4).

**Contract:**
```ts
export interface SessionLockHandle {
  readonly token: string
  extend(): Promise<boolean>   // false => lock lost (token mismatch / expired+reacquired)
  release(): Promise<void>     // compare-and-delete; no-op if not ours (H12.c)
}
export interface SessionLock {
  tryAcquire(campaignId: string): Promise<SessionLockHandle | null> // null => already held
}
export function createSessionLock(redis: Redis, keyPrefix: string, ttlMs: number): SessionLock
```
- Key: `${keyPrefix}session:lock:${campaignId}`.
- `tryAcquire`: `redis.set(key, token, 'PX', ttlMs, 'NX')` where `token = randomUUID()`; returns a handle on `'OK'`, else `null`.
- `extend`: `eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) else return 0 end", 1, key, token, ttlMs)` → `result === 1`.
- `release`: `eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, key, token)` — compare-and-delete, so it can never delete a successor's lock.

- [ ] **Step 1 — failing tests** (real realtime Redis via `createRedisClient(process.env.REDIS_REALTIME_URL ?? 'redis://127.0.0.1:6379')`; unique campaignId per test via `randomUUID()`; `await redis.quit()` in `afterAll`). Cover:
  - acquire → second `tryAcquire` (same campaignId) returns `null`; after `release`, a fresh `tryAcquire` succeeds.
  - `extend` returns `true` while held; after `release`, a stale handle's `extend` returns `false`.
  - expiry: acquire with `ttlMs: 200`, no extend, `await setTimeout(300)`, then `tryAcquire` succeeds (the key expired).
  - compare-and-delete safety: acquire handle A (ttl 200) → let it expire → acquire handle B → A.release() must NOT delete B's lock (assert B.extend() still `true` after A.release()).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** per the contract above. Use `import { randomUUID } from 'node:crypto'`. Keep the Lua as inline `const` strings with a one-line comment that Lua is atomic (no check-then-act race), mirroring the `reseedSeq` precedent.
- [ ] **Step 4 — run, expect PASS** (`pnpm exec vitest run src/session/__tests__/session-lock.test.ts`).
- [ ] **Step 5 — commit:** `git add backend/src/session/session-lock.ts backend/src/session/__tests__/session-lock.test.ts && git commit -m "feat(MYT-66): per-session Redis distributed lock (SET-NX-PX + Lua extend/release)"`

---

### Task 4: Tier types + stubs (H4/H5/H9/H12)

**Files:**
- Create: `backend/src/session/tiers/types.ts`, `backend/src/session/tiers/stubs.ts`
- Test: `backend/src/session/tiers/__tests__/stubs.test.ts`

Define the seam once. **Enforced-ignorance is structural:** the FT is typed against `FtTurnContext` (public-by-construction); the ST/Scribe receive secrets only via constructor deps.

- [ ] **Step 1 — `types.ts`** (no test needed for pure types; assert via the stub test):
```ts
import type { TextDeltaFrame } from '../../contract/session-events.js' // see note below

export interface TriggerMessage { readonly userId: string; readonly characterName: string; readonly text: string }
/** Provisional (H12.f): MYT-68's tool loop needs multi-part content; widen then. */
export interface ConversationMessage { readonly role: 'user' | 'assistant'; readonly content: string; readonly characterName?: string }
export interface TokenUsage { readonly input: number; readonly output: number }

/** PUBLIC-BY-CONSTRUCTION (H4): every field is FT-safe. The FT and ST both read this; secrets never go here. */
export interface FtTurnContext {
  readonly campaignId: string
  readonly triggerMessages: readonly TriggerMessage[]
  readonly ftHistory: readonly ConversationMessage[]
  readonly runningSummary: string
  readonly participants: readonly string[]   // the Redis :state shape (H12.b), NOT repo SessionParticipant
  readonly usage: TokenUsage
  readonly workingSet: readonly unknown[]      // reserved (H9); empty in MYT-66
}
export type TurnContext = FtTurnContext // alias today; the ST's view is FtTurnContext & StSecrets in MYT-69

export interface StEvaluation { readonly intervene: boolean; readonly direction?: string; readonly summaryUpdate?: string; readonly usage?: TokenUsage }
export interface AssistantMessage { readonly role: 'assistant'; readonly content: string; readonly usage?: TokenUsage }
export interface ScribeResult { readonly workingSetDeltas: readonly unknown[] } // controller flushes these (H9)

/** Publishes ONE text_delta cross-container. Typed to the frame union so MYT-68 can emit more (H5). */
export type TurnEmit = (text: string) => Promise<void>

export interface SlowThinker { evaluate(ctx: FtTurnContext): Promise<StEvaluation> }
/** render's signature is PROVISIONAL (H5): MYT-68 adds a resolveTool callback + wider emit. */
export interface FastThinker { render(ctx: FtTurnContext, emit: TurnEmit): Promise<AssistantMessage> }
export interface Scribe { extract(ctx: FtTurnContext): Promise<ScribeResult> }
```
(Note: `TextDeltaFrame` import is only needed if you expose the frame type; if `TurnEmit` takes a plain `string` as above, drop that import. Keep `TurnEmit` as `(text: string) => Promise<void>` for MYT-66 — the publisher in Task 6 builds the frame.)
- [ ] **Step 2 — `stubs.test.ts`:**
```ts
const ctx: FtTurnContext = { campaignId: 'c', triggerMessages: [], ftHistory: [], runningSummary: '', participants: [], usage: { input: 0, output: 0 }, workingSet: [] }

it('StubSlowThinker does not intervene', async () => { expect(await new StubSlowThinker().evaluate(ctx)).toEqual({ intervene: false }) })
it('StubFastThinker emits one delta and returns a canned line', async () => {
  const emitted: string[] = []
  const msg = await new StubFastThinker().render(ctx, async (t) => { emitted.push(t) })
  expect(emitted).toEqual(['(the DM considers the scene…)'])
  expect(msg).toMatchObject({ role: 'assistant', content: expect.any(String) })
})
it('StubScribe is a no-op returning empty deltas', async () => { expect(await new StubScribe().extract(ctx)).toEqual({ workingSetDeltas: [] }) })
```
- [ ] **Step 3 — run, expect FAIL.**
- [ ] **Step 4 — implement `stubs.ts`** (three small classes implementing the interfaces; the FT emits the one canned delta then returns `{ role: 'assistant', content: '(the DM responds.)' }`).
- [ ] **Step 5 — run, expect PASS.**
- [ ] **Step 6 — commit:** `git add backend/src/session/tiers && git commit -m "feat(MYT-66): tier-boundary types + stubs (public-by-construction TurnContext)"`

---

### Task 5: Turn-state extension + atomic flush + widened checkpoint (H3/H6)

**Files:**
- Modify: `backend/src/redis/session-state.ts`
- Test: `backend/src/redis/__tests__/session-state.test.ts` (existing — extend; ioredis-mock)

Add three turn-state keys and a bulk load + **atomic** flush, plus widen `checkpoint`.

- [ ] **Step 1 — failing test** (ioredis-mock per the existing file; `flushall` in `beforeEach`):
```ts
it('loadTurnState round-trips an atomic flushTurnState', async () => {
  const s = makeSessionState(redis, 'p:')
  await s.flushTurnState('c1', { ftHistory: [{ role: 'user', content: 'hi' }], summary: 'sum', usage: { input: 2, output: 3 } })
  expect(await s.loadTurnState('c1')).toEqual({ ftHistory: [{ role: 'user', content: 'hi' }], summary: 'sum', usage: { input: 2, output: 3 } })
})
it('loadTurnState returns empties when unset', async () => {
  expect(await makeSessionState(redis, 'p:').loadTurnState('c-none')).toEqual({ ftHistory: [], summary: '', usage: { input: 0, output: 0 } })
})
```
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** Add key closures `historyKey`/`summaryKey`/`usageKey` (mirroring `seqKey`/`stateKey`: `${base(campaignId)}:ft_history` etc.). Add to the `SessionState` interface + the returned object:
```ts
loadTurnState(campaignId: string): Promise<TurnState>
flushTurnState(campaignId: string, ts: TurnState): Promise<void>
```
where `TurnState = { ftHistory: ConversationMessage[]; summary: string; usage: TokenUsage }` (import from `../session/tiers/types.js`). `loadTurnState`: `mget` the three keys, JSON-parse with empty defaults. `flushTurnState`: an **atomic `MULTI`** (H3) — `redis.multi().set(historyKey, JSON.stringify(ftHistory)).set(summaryKey, summary).set(usageKey, JSON.stringify(usage)).pexpire(historyKey, STATE_TTL*1000)...(all three).exec()`. (This is the first real `MULTI` in the codebase — one inline comment noting it.)
- [ ] **Step 4 — widen checkpoint (H6).** Change the envelope to `{ kind: 'myt66-checkpoint', maxSeq, state, turnState }` where `turnState` is read via `loadTurnState(campaignId)`. Bump `kind` to `'myt66-checkpoint'`; the suspend reader (none yet) parses the superset. Add a test asserting the written envelope (capture via a fake `CheckpointStore`) has `kind: 'myt66-checkpoint'` and a `turnState` field.
- [ ] **Step 5 — run, expect PASS.**
- [ ] **Step 6 — commit:** `git add backend/src/redis/session-state.ts backend/src/redis/__tests__/session-state.test.ts && git commit -m "feat(MYT-66): turn-state keys + atomic flush + widened checkpoint envelope (H3/H6)"`

---

### Task 6: Turn publisher (`turn-publisher.ts`)

**Files:**
- Create: `backend/src/session/turn-publisher.ts`
- Test: `backend/src/session/__tests__/turn-publisher.test.ts` (ioredis-mock pub/sub)

The worker process has no `SessionHub`; it publishes frames itself, via the Task-2 channel helper, on a realtime client.

**Contract:**
```ts
export interface TurnPublisher {
  dmThinking(campaignId: string, turnId: string): Promise<void>
  textDelta(campaignId: string, turnId: string, text: string): Promise<void>
  turnEnd(campaignId: string, turnId: string): Promise<void>
  turnError(campaignId: string, turnId: string, message: string): Promise<void>
  emitFor(campaignId: string, turnId: string): TurnEmit // bound text_delta emitter for the FT
}
export function createTurnPublisher(redis: Redis, keyPrefix: string): TurnPublisher
```
Each method `redis.publish(sessionChannel(keyPrefix, campaignId), JSON.stringify(frame))` with the matching `ServerFrame`. `emitFor` returns `(text) => this.textDelta(campaignId, turnId, text)`.

- [ ] **Step 1 — failing test:** a second ioredis-mock client `psubscribe`s `sessionChannelPattern('p:')`, collects `pmessage` payloads; assert `dmThinking`/`textDelta`/`turnEnd` publish the correct JSON frames (with `turnId`) on `sessionChannel('p:', 'c1')`. (ioredis-mock supports pub/sub within one process.)
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** per the contract.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit:** `git add backend/src/session/turn-publisher.ts backend/src/session/__tests__/turn-publisher.test.ts && git commit -m "feat(MYT-66): cross-process turn frame publisher"`

---

### Task 7: SessionController (`session-controller.ts`)

**Files:**
- Create: `backend/src/session/session-controller.ts`
- Test: `backend/src/session/__tests__/session-controller.test.ts` (ioredis-mock + injected fake tiers/publisher)

The transient conductor. Constructor injects: `{ sessionState, tiers: { st, ft, scribe }, publisher, campaignId, turnId }`.

**Contract:**
```ts
export interface SessionControllerDeps {
  sessionState: SessionState
  st: SlowThinker; ft: FastThinker; scribe: Scribe
  publisher: TurnPublisher
}
export class SessionController {
  constructor(deps: SessionControllerDeps, campaignId: string, turnId: string)
  loadFromRedis(): Promise<void>
  processDmTurn(triggerMessages: TriggerMessage[]): Promise<void>
  flushToRedis(): Promise<void>
}
```
`loadFromRedis`: `loadTurnState` + `getState` (participants) into in-memory fields. `processDmTurn`: (1) build `FtTurnContext` from in-memory state + `triggerMessages`; (2) `st.evaluate(ctx)` → append `summaryUpdate` to in-memory summary, accumulate `usage` (H12.a); (3) append trigger messages to in-memory `ftHistory` (with ST direction injected into the last user message iff `intervene`); (4) `ft.render(ctx, publisher.emitFor(campaignId, turnId))` → append the returned `AssistantMessage` to `ftHistory`, accumulate usage; (5) `publisher.turnEnd(...)`; (6) fire `scribe.extract(ctx)` async, swallow errors (`.catch(log)`), do not await its completion before returning. `flushToRedis`: `flushTurnState` with the mutated in-memory state. **No Redis writes between load and flush except via these methods.**

- [ ] **Step 1 — failing tests** (inject spy/fake tiers):
  - conductor order: a recording fake asserts `st.evaluate` → `ft.render` → `scribe.extract` called in order; `publisher.turnEnd` called once before `scribe.extract` resolves.
  - mutations: after `processDmTurn([{userId:'u',characterName:'Mara',text:'I search'}])`, the in-memory `ftHistory` ends with the trigger as a `user` message then the assistant message; `usage` is the sum of tier usages.
  - ST direction injected only when `intervene` (two stub-ST variants — `{intervene:false}` and `{intervene:true, direction:'be terse', summaryUpdate:'x'}`; assert the summary append + the direction in history happen only in the second). (H12.g)
  - Scribe error does not throw out of `processDmTurn` (inject a throwing scribe; assert `processDmTurn` resolves).
  - load→process→flush→reload round-trips the mutated state (real ioredis-mock `sessionState`).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** per the contract.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit:** `git add backend/src/session/session-controller.ts backend/src/session/__tests__/session-controller.test.ts && git commit -m "feat(MYT-66): transient SessionController conductor (load/process/flush)"`

---

### Task 8: Turn queue + producer wiring (H10)

**Files:**
- Create: `backend/src/session/turn-queue.ts`
- Modify: `backend/src/server-queues.ts`, `backend/src/app-deps.ts`, `backend/src/server.ts`
- Test: `backend/src/session/__tests__/turn-queue.test.ts` (real batch Redis — mirror `session-suspend.test.ts`)

**`turn-queue.ts`:**
```ts
export const QUEUE_SESSION_TURN = 'session-turn' as const
export const TURN_JOB_NAME = 'turn' as const
export interface TurnJobPayload { readonly campaignId: string; readonly sessionId: string; readonly turnId: string; readonly triggerMessages: readonly TriggerMessage[] }
export interface TurnQueueLike { add: Queue<TurnJobPayload>['add'] }
export function enqueueTurn(queue: TurnQueueLike, payload: TurnJobPayload): Promise<unknown> {
  return queue.add(TURN_JOB_NAME, payload) // NO custom jobId — the lock is the per-session mutex (H10)
}
```
The `turnId` (H2) is allocated by the caller (`randomUUID()`) at enqueue and is **stable across BullMQ redeliveries** because it's in the payload (a redelivered job carries the same payload).

- [ ] **Step 1 — failing test** (real batch Redis, mirror the `session-suspend.test.ts` broker block exactly — unique `queueName` via `Date.now()`+`pid`, `createBullmqRedisClient(REDIS_BATCH_URL ?? 'redis://127.0.0.1:6380')`, **targeted `remove` in `afterEach`, never `obliterate`**): `enqueueTurn` adds exactly one waiting job whose payload round-trips (`getWaitingCount()===1`; `getJob` → payload equals input incl. `turnId`).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement `turn-queue.ts`** + add `buildSessionTurnQueue(redisBatch)` and `stubSessionTurnQueue()` to `server-queues.ts` — **mirror `buildSessionSuspendQueue`/`stubSessionSuspendQueue` exactly** (`defaultJobOptions: { removeOnComplete: true, removeOnFail: true, attempts: 3 }` — pin `attempts: 3` so a transient crash retries; the lock makes retries safe). Return `{ bullmqQueue, sessionTurnQueue }`. Add `sessionTurnQueue: TurnQueueLike` to `AppDeps` in `app-deps.ts`. Thread it into **both** `AppDeps` literals in `server.ts` (the real one after the `build*Queue` calls, and the `fallbackStart` stub using `stubSessionTurnQueue()`), and extend `withSessionPrepShutdown` to also close the raw turn queue. (NOTE: the turn **worker** is wired in Task 9 in `worker.ts`, not here.)
- [ ] **Step 4 — run, expect PASS;** then `pnpm --filter @mythrun/backend typecheck` (catches the `fallbackStart`/`AppDeps` threading — both literals must compile).
- [ ] **Step 5 — commit:** `git add backend/src/session/turn-queue.ts backend/src/server-queues.ts backend/src/app-deps.ts backend/src/server.ts backend/src/session/__tests__/turn-queue.test.ts && git commit -m "feat(MYT-66): session-turn queue + producer wiring (enqueueTurn, AppDeps, stub)"`

---

### Task 9: Turn worker (`turn-worker.ts`) + worker.ts wiring (H1/H2/H8)

**Files:**
- Create: `backend/src/session/turn-worker.ts`
- Modify: `backend/src/worker.ts`
- Test: `backend/src/session/__tests__/turn-worker.test.ts` (ioredis-mock + injected fakes for unit; the real end-to-end is Task 10/11)

**`processTurnJob(deps, job)`** — the body, lock-fenced + heartbeat + terminal-failure:
```ts
export interface TurnProcessorDeps {
  lock: SessionLock; sessionState: SessionState; publisher: TurnPublisher
  makeTiers: () => { st: SlowThinker; ft: FastThinker; scribe: Scribe }
  heartbeatMs: number; logger: pino.Logger
}
export async function processTurnJob(deps: TurnProcessorDeps, job: { data: TurnJobPayload }): Promise<{ ran: boolean }>
```
Flow:
1. `const handle = await deps.lock.tryAcquire(campaignId)`. If `null` → `return { ran: false }` (contention; BullMQ `attempts` re-runs it; §8/MYT-67 own the real trigger queue). Else start a heartbeat: `setInterval` every `heartbeatMs` calling `handle.extend()`; if `extend()` resolves `false`, set a `lockLost` flag (H1 stalled-resume guard).
2. `try { await publisher.dmThinking(campaignId, turnId); const controller = new SessionController({ sessionState, ...makeTiers(), publisher }, campaignId, turnId); await controller.loadFromRedis(); if (lockLost) throw new LockLostError(); await controller.processDmTurn(triggerMessages); if (lockLost) throw new LockLostError(); await controller.flushToRedis() }`
3. `catch (err)` → if `lockLost`: log + return (do NOT flush, do NOT publish turn_error — the winner owns it). Else (real failure that will exhaust attempts): rethrow so BullMQ marks it failed/retries; on the FINAL attempt, a `failed`-event handler (wired in worker.ts) publishes `turn_error` + clears `dm_responding` (H8).
4. `finally` → `clearInterval(heartbeat)`; `await handle.release()` (compare-and-delete — safe even after lock loss, H12.c).

- [ ] **Step 1 — failing tests** (inject a fake `SessionLock` + recording publisher + stub tiers, ioredis-mock state):
  - happy path: `tryAcquire` returns a handle → `processTurnJob` returns `{ran:true}`, publishes `dm_thinking`→`text_delta`→`turn_end`, flushes state, calls `handle.release()`.
  - contention: `tryAcquire` returns `null` → returns `{ran:false}`, no publish, no flush.
  - lock-lost: a fake handle whose `extend()` returns `false` (drive the heartbeat with a tiny `heartbeatMs`) → `processTurnJob` aborts without flushing; `release()` still called.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement `processTurnJob`** + `buildSessionTurnWorker(redisRealtime, redisBatchUrl, redisKeyPrefix, repo, signal)` — **mirror `buildSessionSuspendWorker`** (dedicated `createBullmqRedisClient` + the mandatory `waitFor` ping-probe BEFORE `new Worker`), constructing the `lock`/`sessionState`/`publisher` on `redisRealtime` and `makeTiers: () => ({ st: new StubSlowThinker(), ft: new StubFastThinker(), scribe: new StubScribe() })`. Wire a `worker.on('failed', ...)` that, when `job.attemptsMade >= job.opts.attempts`, publishes `turn_error` (H8).
- [ ] **Step 4 — wire into `worker.ts`** (NOT server.ts): build the turn worker in `main()` alongside session-prep, add it to the `startHealthServer` `workers` array, the `queues:` log line (`QUEUE_SESSION_TURN`), and the shutdown `Promise.all` (`closeWithDeadline`). Pin BullMQ timing on the worker options: `{ connection, concurrency: 5, lockDuration: 30_000, stalledInterval: 30_000, maxStalledCount: 3 }` with `ttlMs = 45_000`, `heartbeatMs = 15_000` for the lock — i.e. `lockDuration < sessionLockTtl ≈ stalledInterval` (H1; add a comment with the inequality).
- [ ] **Step 5 — run unit tests + `pnpm --filter @mythrun/backend typecheck`, expect PASS.**
- [ ] **Step 6 — commit:** `git add backend/src/session/turn-worker.ts backend/src/worker.ts backend/src/session/__tests__/turn-worker.test.ts && git commit -m "feat(MYT-66): session-turn worker (lock-fenced conductor, heartbeat, terminal-failure) + worker.ts wiring"`

---

### Task 10: Dev trigger route + end-to-end enqueue→worker→broadcast test (H7)

**Files:**
- Create/modify: the dev-routes module (e.g. `backend/src/routes/dev.ts`) + `backend/src/contract/backend-routes.ts`
- Test: `backend/src/session/__tests__/turn-e2e.test.ts` (real batch + realtime Redis; constructs a real `Worker`)

The minimal test/dev trigger and the round-trip proof (a worker-published frame reaches a **real** subscriber — the H7 guarantee).

- [ ] **Step 1 — failing E2E test** (the new real-`Worker` pattern): build a batch queue (unique name) + a real `Worker(QUEUE, (job) => processTurnJob(deps, job), { connection })` with a realtime publisher; a SECOND realtime client `psubscribe`s `sessionChannelPattern(prefix)`; seed `sessionState.setState(campaignId, {participants:[...], mode:'exploration', status:'active'})`; `enqueueTurn(queue, {campaignId, sessionId, turnId, triggerMessages:[...]})`; `vi.waitFor` until the subscriber has collected a `dm_thinking`, a `text_delta`, and a `turn_end` (all carrying the same `turnId`); then assert `sessionState.loadTurnState(campaignId)` shows the appended history. Clean up with targeted `remove` + `quit` (never `obliterate`).
- [ ] **Step 2 — run, expect FAIL** (worker/route not wired).
- [ ] **Step 3 — implement the dev route** `POST /api/dev/campaigns/:campaignId/fire-turn` (dev-only, under the existing `/api/dev/*` bypass-auth surface — mirror `POST /api/dev/credits/grant`): body `{ triggerText: string }`; resolves `sessionId` from `repo.sessions.getActiveByCampaign(campaignId)`, allocates `turnId = randomUUID()`, builds one `TriggerMessage` (the dev sub's character via `repo.characters.findUserCharacterForCampaign`), calls `enqueueTurn(deps.sessionTurnQueue, ...)`, returns `202 { turnId }`. Register the route in `backend-routes.ts` (+ the dev-tool-verifier will add a panel or exempt it — controller handles that gate at close-out).
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit:** `git add backend/src/routes/dev.ts backend/src/contract/backend-routes.ts backend/src/session/__tests__/turn-e2e.test.ts && git commit -m "feat(MYT-66): dev fire-turn trigger + enqueue→worker→broadcast E2E (real subscriber round-trip)"`

---

### Task 11: Crash-recovery integration test

**Files:**
- Test: `backend/src/session/__tests__/turn-recovery.test.ts` (real batch + realtime Redis; two real `Worker`s)

Prove the done-when: a turn killed mid-flight is recovered + completed by another worker from clean state.

- [ ] **Step 1 — failing/red test.** Construct worker A whose injected tiers **force-expire the lock mid-turn** (a fake FT that, inside `render`, deletes the lock key directly via the realtime client to simulate a crashed-and-expired holder, then never flushes — i.e. A aborts on lock loss). Construct worker B with normal stub tiers on the same queue. `enqueueTurn` once. Assert: (a) the turn ultimately completes (B publishes `turn_end` for the job's `turnId`), and (b) `loadTurnState` reflects exactly one completed turn (no double-append — the `turnId`/never-flush invariant), and (c) the lock is free at the end (`tryAcquire` succeeds). Drive with `vi.waitFor`; clean up with targeted `remove`.
  - (If forcing two competing workers is flaky, the deterministic variant: run `processTurnJob` directly, force `lockLost` mid-turn via a fake handle, assert no flush; then run a second `processTurnJob` to completion from the clean state and assert the single-turn end state. Prefer the deterministic variant if the two-worker race is hard to make reliable — the spec's §13 allows the force-expire form.)
- [ ] **Step 2 — run, expect FAIL/red, then drive to green** (this test mostly exercises already-built code; if it reveals a gap in `processTurnJob`'s abort/flush ordering, fix there).
- [ ] **Step 3 — run the full session suite** (`pnpm exec vitest run src/session src/redis/__tests__/session-state.test.ts src/contract`) + `pnpm --filter @mythrun/backend typecheck`, expect PASS.
- [ ] **Step 4 — commit:** `git add backend/src/session/__tests__/turn-recovery.test.ts && git commit -m "test(MYT-66): crash-recovery — turn completes on another worker from clean state"`

---

## Self-review

**Spec coverage (§ → task):** §3 modules → all tasks; §4 lock → T3 (H12.c finally compare-delete); §5 controller + state held → T7 (+ T5 turn-state, participants as Redis `string[]` H12.b); §6 tier seams → T4 (H4 public-by-construction, H5 provisional render, H9 workingSet/ScribeResult, H12.a usage on StEvaluation/accumulate); §7 worker + crash recovery → T9 (H1 timing inequality, H8 terminal turn_error) + T11; §8 contention → T9 (tryAcquire→{ran:false}); §9 flush/checkpoint → T5 (H3 atomic MULTI, H6 envelope kind bump + honest scope); §11 frames → T1 (H2 turnId); §13 tests → T3/T7/T10/T11; H7 channel helper → T2 + T10 round-trip; H10 producer wiring → T8. **Deferred-by-design (out of MYT-66, no task — matches spec §1 Out of scope):** real tiers (MYT-68/69/73), real triggers + trigger queue (MYT-67), ledger/combat (MYT-70/75), ft_history windowing (H11 → MYT-69), DM-message persistence + idempotent seq (H12.d → later), debug frames (H12.e), multi-part ConversationMessage (H12.f → MYT-68).

**Placeholder scan:** every code step shows real code or an exact mirror target (`buildSessionSuspendQueue`/`buildSessionSuspendWorker`/`session-suspend.test.ts`) with the concrete deltas; no "TODO"/"handle errors"/"similar to" without the code.

**Type consistency:** `FtTurnContext`/`TurnContext`/`TriggerMessage`/`ConversationMessage`/`TokenUsage`/`StEvaluation`/`AssistantMessage`/`ScribeResult`/`TurnEmit` defined once in T4 and consumed unchanged in T5/T7/T8/T9; `TurnJobPayload`/`TurnQueueLike` defined in T8 used in T9/T10; `QUEUE_SESSION_TURN`/`TURN_JOB_NAME` single-sourced in T8; `SessionLock`/`SessionLockHandle` in T3 used in T9; `TurnPublisher` in T6 used in T7/T9/T10.

---

## Execution

The user has chosen **subagent-driven-development**. After moving this plan into Beads (one bead per task, blockers per the dependency notes — serial order T1→T11, with T1/T2/T3 independent, T4←T1, T5←T4, T6←T1,T2, T7←T4,T5,T6, T8←T4, T9←T3,T7,T8, T10←T8,T9, T11←T9,T10), implement via `superpowers:subagent-driven-development` (Opus subagents; controller commits per task after the two-stage review).
