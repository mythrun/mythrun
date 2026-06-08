# MYT-67 — DM Trigger System (explicit / solo / typing-gated auto)

> **Status:** Design — approved in brainstorm 2026-06-08, pending blind review.
> **Issue:** MYT-67 (Session Runtime + Combat L1 milestone, 3rd issue).
> **Builds on:** MYT-65 (WS transport, session-hub pub/sub, Redis session-state) and MYT-66 (transient SessionController, `session-turn` BullMQ queue + per-session lock, dev `fire-turn` poke).
> **Spec refs:** Multiplayer Session Runtime §5 (DM trigger), §6 (response flow), §15 (routes), §17.1 (conductor). This design **amends** §5's debounce model and §6's trigger/drain — see §13.
> **Tiers stubbed:** the conductor's ST/FT/Scribe remain the MYT-66 stubs. The DM-trigger **classifier** is a *distinct* cognitive tier and IS built for real here.

---

## 1. Goal

Decide **when** the AI DM responds in a multiplayer session, and enqueue exactly one `session-turn` per decision. Three trigger modes:

- **Explicit** — a player summons the DM (`dm_invoke` frame, or a message whose text begins with the literal `@dm`/`@DM`). Fires immediately.
- **Solo** — a 1-member campaign always gets a DM response, gated only by the quiet window (no classifier).
- **Auto** — in multiplayer, a Haiku classifier decides `shouldRespond` once the room has gone quiet.

**Done when:** each trigger path fires correctly, the DM never interrupts a player mid-thought, and concurrent / in-flight triggers queue rather than collide — all coordinated correctly across multiple server containers.

## 2. The core model: a typing-gated quiet window

The trigger is gated on *"is anyone still composing?"*, not on raw message arrival. The DM fires only after the campaign has been **quiet** — no one typing, no new message — for a short window. This is the "never cut a player off mid-thought" guarantee.

This shape is the production-canonical one. The research (see brainstorm 2026-06-08; sources: XEP-0085, Matrix Client-Server API, Ably Chat, Stream, Discord/Slack docs) found that **every** robust chat system treats "stopped typing" as a **timeout, not an event** — no system trusts a client to send the final "stop", because a client can crash mid-typing. The indicator is kept alive by a periodic client **heartbeat** and dies by a **server-side TTL**. We adopt that directly, and extend it: the same activity that refreshes the typing state also resets a server-authoritative quiet-window timer that fires the DM.

Two independent concerns, both driven by the same client activity (typing heartbeats + messages):

1. **Typing display state** (who is typing) — Redis per-member keys with a TTL (§4.1). Consumed by the frontend later; built now as the infra MYT-65 deferred.
2. **The quiet-window trigger timer** — a resettable BullMQ debounce job per campaign (§4.2). This is what actually fires the DM.

Both live in Redis/BullMQ (shared), so they are correct no matter which container a player is connected to. **No in-process timers, no leader election** — the anti-pattern every scaled chat system avoids.

## 3. Process placement

| Concern | Runs in | Why |
|---|---|---|
| Observe typing/message frames; refresh typing state; reschedule the debounce job; handle explicit/solo fast-path | **API server** (`ws-session.ts` inbound handler) | The frame arrives here, at exactly one container per frame (the player's own connection). Single ingestion point → no double-scheduling. |
| Mature the quiet window; re-validate; classify; enqueue the turn | **Worker** (`worker.ts` process, new `dm-trigger` BullMQ worker) | LLM work + turn enqueue belong off the request path, in the existing worker process that already holds the Anthropic client and Redis. |
| Run the turn (lock + conductor) | **Worker** (`session-turn` worker, MYT-66) | Unchanged. |

The `dm-trigger` queue (decision) is kept cleanly separate from the `session-turn` queue (execution).

## 4. Components

### 4.1 Typing-state tracking (display infra)

Per-member Redis key, set/refreshed by the client's throttled typing heartbeat:

```
{prefix}session:typing:{campaignId}:{userId} = "1"   EX = TYPING_TTL_S (8)
```

- **Set/refresh** on every inbound `typing_start` frame (the client throttles these to ~one per `TYPING_HEARTBEAT_S` = 3s while composing).
- **Clear** (`DEL`) on `typing_stop`, on `player_message` from that user (a send implies "done with this message"), and on disconnect (`handleDisconnect`).
- **Authoritative stop = key expiry.** An explicit `typing_stop` is a best-effort fast-path only. A client that starts typing then crashes self-heals in ≤ `TYPING_TTL_S`; it can never wedge the trigger shut. (`TYPING_TTL_S` = 8 > 2× the 3s heartbeat, so a single dropped heartbeat does not flicker the indicator.)
- **Fan-out** of `typing_start`/`typing_stop` to other members already exists (MYT-65 `hub.publish`). MYT-67 adds the *tracked state*, not new fan-out.
- A "who is typing" query (`SCAN`/keyset over `…typing:{campaignId}:*`, or a per-campaign `SET` of typing users) is exposed for the future frontend indicator. Not consumed by the trigger itself (the trigger uses the debounce job, §4.2) — kept because Miklos scoped the typing infra into this issue and it is the canonical display state.

### 4.2 Activity-driven quiet-window debounce

The authoritative "quiet for N seconds" timer is **one BullMQ delayed job per campaign in deduplication/debounce mode**. On *any* activity in the campaign (a `typing_start` heartbeat **or** a `player_message`), from any container, the server reschedules it:

```ts
await dmTriggerQueue.add(
  'evaluate',
  { campaignId },
  {
    deduplication: { id: `dm-trigger:${campaignId}`, ttl: QUIET_WINDOW_MS, extend: true, replace: true },
    delay: QUIET_WINDOW_MS, // e.g. 4000ms of required quiet
  },
)
```

BullMQ debounce mode (`extend + replace + delay`) means: a second add with the same dedup id during the delay **replaces** the prior job and **resets** the countdown; only the most recent job matures, and it matures **exactly once**. Because the job lives in Redis (the queue), members split across containers all reset the *same* timer.

Alongside the reschedule, the server stamps a monotonic activity marker used for the maturity re-validation guard (§4.3):

```
{prefix}session:last-activity:{campaignId} = <ms epoch>   EX = a few × QUIET_WINDOW
```

**Rejected alternatives** (from the research, recorded so we don't revisit): Redis keyspace-expiry notifications (Redis pub/sub is fire-and-forget — a worker reconnect silently drops the fire; expiry is lazy, not at T=0 — a correctness bug for a once-per-room trigger); and an in-instance `setTimeout` + lock-elected owner (hand-rolls exactly-once we already get from BullMQ, and the owner dying strands the timer). **Implementation note:** use the per-`add` `deduplication` option (or `job.changeDelay`), **never** `upsertJobScheduler` — that recurring-scheduler API is a known-buggy surface (BullMQ #3430/#3063/#3378).

### 4.3 The `dm-trigger` worker

When the debounce job matures (sustained quiet), the worker:

1. **Re-validate quiet** — read `last-activity:{campaignId}`; if `now − lastActivity < QUIET_WINDOW_MS`, a reset landed in the same tick — exit without firing (belt-and-suspenders over BullMQ's replace semantics; cheap Redis read, worth it for a server-authoritative LLM trigger). Auto/solo only; the explicit fast-path skips this.
2. **Resolve the active session** — `repo.sessions.getActiveByCampaign(campaignId)`. None → exit (nothing to drive; mirrors the dev `fire-turn` 409 case).
3. **Determine the mode & decision:**
   - **Explicit pending** (a `dm-trigger:{campaignId}:explicit` Redis flag, set by `@dm`/`dm_invoke`) → skip the classifier, force `shouldRespond=true`, clear the flag.
   - **Solo** (campaign `totalMembers === 1`) → skip the classifier, `shouldRespond=true`.
   - **Auto** (multiplayer) → call the Haiku classifier (§4.4) over the recent player-message batch.
4. **On `shouldRespond=true`** → enqueue a `session-turn` job (§4.6) carrying the trigger metadata + classification. **On false** → exit (optionally publish the debug frame, §4.9).

The recent player-message batch fed to the classifier is the last `N` player messages since the previous DM turn (read from `repo.sessionMessages` by `seq`, bounded). Exact `N`/window is a plan detail.

### 4.4 The Haiku DM-trigger classifier (real)

A real Anthropic Haiku call — ZFC: the "should the DM respond, and how hard a turn is this" judgment is delegated to a model, never a heuristic. New surfaces:

- **Prompt template** `backend/src/llm/prompts/dm-trigger-classifier.txt` (file, not inline). Inputs: the recent player-message batch (attributed to character names), light session context (e.g. the running summary if available). **Enforced ignorance:** the classifier sees only public-tier conversation context — no `sd_playbook`, no secrets. It decides *whether to respond*, not *what the response is*.
- **Zod schema** `backend/src/llm/schemas/dm-trigger-classification.ts`:
  ```ts
  { shouldRespond: boolean; complexity: 'low' | 'high'; confidence: number /*0–1*/; reason: string }
  ```
  Free-prose `reason` gets a `.min()` floor, no `.max()` (per the LLM-schema convention).
- **Routing** (spec §5): `shouldRespond=false` & `confidence>0.8` → no turn. `true` & `low` & `>0.8` → turn with a *skip-ST* hint. `true` & `high` → full ST→FT hint. `confidence<0.8` → escalate (treat as high). The routing **decision lives here**; it is plumbed onto the turn payload (§4.6) and **consumed by MYT-68/69** — the MYT-66 stub conductor ignores it for now.
- Runs through the single Anthropic abstraction layer with the model from config (no hardcoded model name).

### 4.5 Trigger modes (server-side detection)

Detected in the `ws-session.ts` inbound handler — all **mechanical/structural** checks, ZFC-compliant (no semantic analysis):

- **Explicit:** a new `dm_invoke` client frame, **or** a `player_message` whose `text` (trimmed) starts with the literal `@dm`/`@DM`. → set the `…:explicit` flag + reschedule the debounce job with `delay: 0` (fire ASAP; the summon implies the player is done).
- **Solo:** detected at decision time in the worker (`totalMembers === 1`), not the server — keeps membership logic in one place. The server still reschedules the debounce on each message (so a rapid solo multi-message thought still coalesces into one response after the pause).
- **Auto:** the default — reschedule the debounce with `delay: QUIET_WINDOW_MS`.

### 4.6 `session-turn` payload extension

`TurnJobPayload` (MYT-66) gains trigger metadata:

```ts
interface TurnJobPayload {
  // … existing: campaignId, sessionId, turnId, triggerMessages
  trigger: {
    kind: 'explicit' | 'solo' | 'auto'
    classification?: { complexity: 'low' | 'high'; confidence: number } // present for 'auto'
  }
}
```

MYT-68/69 read `trigger.classification` for the skip-ST routing. The dev `fire-turn` route (MYT-66) sets `kind: 'explicit'` (it is a manual poke). Backward-compatible: the field is additive; the stub conductor ignores it.

### 4.7 Collision & drain

Invariant: **at most one `session-turn` in flight per campaign** (MYT-66 lock), and triggers arriving during a turn produce **at most one coherent follow-up** on the accumulated context — never a backlog of stale replies, never a lost meaningful trigger.

Mechanism:

- The `session-turn` enqueue uses a per-campaign dedup id (`session-turn:{campaignId}`), so two near-simultaneous decisions collapse to one.
- **During an in-flight turn**, the `dm-trigger` worker's enqueue is suppressed by that dedup (a turn is active). Meanwhile, *new* player activity reschedules the `dm-trigger` debounce job. After the turn completes and the players go quiet, the debounce matures → enqueues the follow-up turn, which re-loads fresh context (the new messages). 
- If players were **quiet** during the turn (nothing new to say), the debounce does not re-fire — correct: no spurious follow-up.
- This replaces MYT-66's crude `{ran:false}` + blind-`attempts` contention placeholder. On the rare residual lock contention (e.g. across a stalled-job recovery), the `session-turn` worker re-enqueues itself with a short bounded delay rather than relying on BullMQ failure-retry backoff. (Retry bound/params: plan detail.)

### 4.8 Terminal `turn_error` via `QueueEvents` (closes `myth-tvnb`)

MYT-66 left a tracked gap: the `worker.on('failed')` JS listener fires for the throw-then-`attempts`-exhausted terminal, but **not** for the `maxStalledCount`-exhaustion terminal (a holder that crashes mid-turn 3×) — BullMQ transitions stalled→failed inside a Lua script and emits only a broker-side event. MYT-67 adds a `QueueEvents('session-turn')` subscriber (in `worker.ts`) that listens for the broker `failed` event and publishes the terminal `turn_error` frame for that case, so a player's client never waits forever on a turn that will never complete. Dedup against the existing JS-listener publish (publish `turn_error` idempotently per `turnId`).

### 4.9 Debug observability

A debug server→client frame (debug stream, not the player transcript) carrying the trigger decision lets the dev-tool *see* why the DM did/didn't fire:

```
{ type: 'dm_trigger'; turnId?: string; kind: 'explicit'|'solo'|'auto'; shouldRespond: boolean;
  complexity?: 'low'|'high'; confidence?: number; reason?: string }
```

Emitted by the `dm-trigger` worker. Also structured-logged (pino). This is the primary signal the dev-tool E2E smoke asserts on (§11). Mirrors the spec's `st_evaluation`/`scribe_result` debug stream.

## 5. Wire contract changes (`contract/session-events.ts`)

- **Add `dm_invoke`** to `CLIENT_FRAME_TYPES` and the client payload union: `{ type: 'dm_invoke' }` (no fields — the explicit summon).
- `typing_start` / `typing_stop` already exist (MYT-65). No change to their shape; MYT-67 changes server-side *handling* (state + reschedule).
- **Add `dm_trigger`** to the server frame union (debug, §4.9). Non-seq (control/debug, like `dm_thinking`).
- `dm_thinking` / `text_delta` / `turn_end` / `turn_error` already exist (MYT-66) and already bracket a turn for the frontend's input-greying — no new lockout frame needed.

## 6. Redis keys & data model

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `{prefix}session:typing:{campaignId}:{userId}` | string `"1"` | `TYPING_TTL_S` (8) | Per-member typing display state; expiry = authoritative stop |
| `{prefix}session:last-activity:{campaignId}` | string (ms epoch) | few × quiet window | Maturity re-validation guard (§4.3) |
| `{prefix}session:dm-trigger:{campaignId}:explicit` | string flag | short (≥ quiet window) | "An explicit summon is pending" → worker skips the classifier |

All ephemeral. None persisted to Postgres (typing/trigger state is transient, per canonical practice). BullMQ dedup state lives in the queue's own Redis structures.

## 7. Config constants (shared, tunable)

Single source of truth (config module), shared by server + worker (and, later, the frontend must use the same numbers — the canonical "all clients share one timeout" rule):

| Constant | Default | Source |
|---|---|---|
| `TYPING_HEARTBEAT_S` | 3 | Slack's throttle; client refresh cadence |
| `TYPING_TTL_S` | 8 | > 2× heartbeat (no-flicker) + crash self-heal |
| `QUIET_WINDOW_MS` | 4000 | "room to type" before the DM fires; tune to feel (4–6s) |
| `DM_TRIGGER_CLASSIFIER_MODEL` | Haiku (config constant) | tiered inference |
| `CONFIDENCE_FLOOR` | 0.8 | §5 escalation threshold |

Latency note: a *message send* clears the sender's typing key, so the common path is `QUIET_WINDOW (~4s) + Haiku (~1s) ≈ 5s` after send. The 8s-TTL path only governs an abandoned draft (nothing to respond to).

## 8. Data flow

**Auto (multiplayer):**
```
player_message / typing_start (any container)
  → server: refresh typing state; stamp last-activity; reschedule dm-trigger debounce (delay=QUIET_WINDOW)
  → [players keep typing → repeated reschedules; job never matures]
  → [players quiet for QUIET_WINDOW] → debounce matures (exactly once)
  → dm-trigger worker: re-validate quiet → active session? → Haiku classify(recent batch)
      → shouldRespond? → enqueue session-turn{kind:'auto', classification} (deduped)
  → session-turn worker (MYT-66): lock → dm_thinking → stub conductor → turn_end → release
```

**Solo:** as auto, but worker sees `totalMembers===1` → skip classifier → always enqueue.

**Explicit (`@dm` / `dm_invoke`):**
```
frame → server: set explicit flag; reschedule debounce delay=0
  → dm-trigger worker: explicit flag set → skip classifier → clear flag → enqueue session-turn{kind:'explicit'}
```

**In-flight drain:** activity during a turn reschedules the debounce; the worker's enqueue is dedup-suppressed while the turn is active; after the turn + quiet, the debounce matures → one follow-up on fresh context (§4.7).

## 9. Error handling

- **Haiku classifier failure** (transient/timeout/auth): catch; treat as *no trigger* this cycle (fail-closed — better a missed DM beat than a spurious one) + structured-log + emit the debug frame with the error. The next activity re-drives the debounce, so it self-heals. (No retry storm: one classify per maturity.)
- **No active session:** worker exits quietly (§4.3 step 2).
- **Dropped/crashed client mid-typing:** typing key TTL expiry (§4.1) + `handleDisconnect` clear; cannot wedge the trigger.
- **Lock contention:** bounded re-enqueue-with-delay (§4.7), not infinite retry.
- **Combat mode:** out of scope (MYT-75). Trigger logic assumes exploration mode.

## 10. Testing strategy

- **Unit (mocked):** mode detection (`@dm` prefix, `dm_invoke`, solo count); the classifier Zod schema (valid/invalid); routing thresholds (the §5 confidence/complexity matrix); the maturity re-validation guard; collision dedup logic; `QueueEvents` terminal-error publish idempotency. Typing-state set/refresh/clear/expiry against a real Redis (per the session-test convention — real Redis, `mythrun_test`).
- **Debounce behavior:** an integration test asserting *N activity pulses spaced < window apart → fires once at last-pulse + window, not N times* (the research's required regression test for BullMQ debounce; pin the BullMQ version).
- **dev-tool E2E wire smoke (required, per the dev-tool-E2E rule):** drive the real WS at the wire level — open SSE/WS, send `typing_start` heartbeats then a `player_message`, observe (a) the debounce holds while "typing", (b) on quiet the **real Haiku classifier** runs and a `dm_trigger` debug frame + `dm_thinking` appear, (c) `@dm` fires immediately, (d) solo fires without a classifier. Assert observable end-state (`dm_thinking`/`dm_trigger` with `shouldRespond=true`), not "no errors". A dev-tool panel (built by the dev-tool-verifier) drives typing + messages and shows the trigger decisions.

## 11. Scope boundary

**In (backend, MYT-67):** typing-state tracking; the debounce timer; the `dm-trigger` queue + worker; the real Haiku classifier (prompt + schema + routing); the `dm_invoke` frame; explicit/solo/auto detection; the session-turn payload extension; collision/drain; the `QueueEvents` terminal `turn_error`; the `dm_trigger` debug frame; a dev-tool panel.

**Out (Frontend milestone):** local keystroke→`typing_start`/`typing_stop` detection + heartbeat throttle; the cosmetic "DM responding in…" countdown; greying input on `dm_thinking`. MYT-67 only **exposes** the signals these need (which MYT-65/66 frames already do). Typing indicators are exercised at the **wire level** in this issue, not via a real frontend.

**Still stubbed:** the conductor's ST/FT/Scribe (MYT-66 stubs) — a fired turn runs the stub conductor. The classification routing is plumbed but dormant until MYT-68/69.

## 12. Amendments to the Multiplayer Session Runtime spec

- **§5 (Debounce):** replace "wait 3s of silence, *then* classify" with the typing-gated quiet-window model (classify on quiet maturity; the quiet signal is activity-driven, typing-state-aware). Record the canonical-pattern rationale.
- **§5 (Solo):** solo keeps the quiet window (room-to-type), skipping only the classifier — refines "no debounce".
- **§6 (step 1 / step 6):** the trigger acquires/queues via the `dm-trigger` debounce + `session-turn` dedup + lock; "drain queue" is the post-turn debounce re-fire (§4.7).
- **§15 (routes/frames):** add `dm_invoke` (client) and `dm_trigger` (server, debug).

These land in the spec when MYT-67 ships (alongside the wiki update).

## 13. Open questions / deferred

- Exact recent-batch size `N` / window for the classifier input (plan detail; start with "messages since last DM turn", capped).
- `QUIET_WINDOW_MS` final value — ship 4s, tune to feel during smoke.
- Whether the `dm_trigger` debug frame is gated behind a debug flag or always on the debug stream (lean: always on the debug stream, like `st_evaluation`).
- Bounded-retry params for residual lock contention (§4.7).

## 14. File-level change map (informs the plan)

**New:**
- `backend/src/session/typing-state.ts` — Redis typing keys: set/refresh/clear/listActive.
- `backend/src/session/dm-trigger-queue.ts` — queue name, payload, `rescheduleDebounce` / `fireExplicit` producers.
- `backend/src/session/dm-trigger-worker.ts` — maturity → re-validate → mode → classify/skip → enqueue session-turn.
- `backend/src/llm/schemas/dm-trigger-classification.ts` — Zod schema.
- `backend/src/llm/prompts/dm-trigger-classifier.txt` — prompt template.
- `backend/src/session/dm-trigger-classifier.ts` — the Haiku call (through the LLM abstraction).
- `backend/src/session/session-turn-queue-events.ts` — `QueueEvents` subscriber (myth-tvnb).
- `backend/dev-tool/src/components/dm-trigger-panel.ts` — dev-tool panel (built by the verifier).

**Modified:**
- `backend/src/contract/session-events.ts` — `dm_invoke` (client), `dm_trigger` (server).
- `backend/src/routes/ws-session.ts` — inbound handler: typing-state writes, debounce reschedule, explicit/solo detection, disconnect clear.
- `backend/src/session/turn-queue.ts` — `TurnJobPayload.trigger` field; session-turn dedup id.
- `backend/src/session/turn-worker.ts` — read `trigger` (plumb); bounded contention re-enqueue (replace `{ran:false}`+blind retry).
- `backend/src/routes/dev-fire-turn.ts` — set `trigger.kind='explicit'`.
- `backend/src/server-queues.ts` / `app-deps.ts` / `server.ts` — wire the `dm-trigger` queue producer into the WS route deps.
- `backend/src/worker.ts` — register the `dm-trigger` worker (5th worker) + the `QueueEvents` subscriber.
- `backend/dev-tool/verify-registry.ts` — register the dm-trigger panel.
