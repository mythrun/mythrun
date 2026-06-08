# MYT-67 — DM Trigger System (explicit / solo / typing-gated auto)

> **Status:** Design — approved in brainstorm 2026-06-08; revised after round-1 blind review (see §16). Pending user-review gate.
> **Issue:** MYT-67 (Session Runtime + Combat L1 milestone, 3rd issue).
> **Builds on:** MYT-65 (WS transport, session-hub pub/sub, Redis session-state) and MYT-66 (transient SessionController, `session-turn` BullMQ queue + per-session lock, dev `fire-turn` poke).
> **Spec refs:** Multiplayer Session Runtime §5 (DM trigger), §6 (response flow), §15 (routes), §17.1 (conductor). This design **amends** §5's debounce model and §6's trigger/drain — see §13.
> **Tiers stubbed:** the conductor's ST/FT/Scribe remain the MYT-66 stubs. The DM-trigger **classifier** is a *distinct* cognitive tier and IS built for real here.

---

## 1. Goal

Decide **when** the AI DM responds in a multiplayer session, and enqueue exactly one `session-turn` per decision. Three trigger modes:

- **Explicit** — a player summons the DM (`dm_invoke` frame, or a message whose text begins with the literal `@dm`/`@DM`). Fires on a short floor, not a full quiet window.
- **Solo** — a 1-member campaign always gets a DM response, gated only by the quiet window (no classifier).
- **Auto** — in multiplayer, a Haiku classifier decides `shouldRespond` once the room has gone quiet.

**Done when:** each trigger path fires correctly, the DM never interrupts a player mid-thought, and concurrent / in-flight triggers queue rather than collide — all coordinated correctly across multiple server containers.

## 2. The core model: a typing-gated quiet window

The trigger is gated on *"is anyone still composing?"*, not on raw message arrival. The DM fires only after the campaign has been **quiet** — no one typing, no new message — for a short window. This is the "never cut a player off mid-thought" guarantee.

This shape is the production-canonical one. The research (brainstorm 2026-06-08; sources: XEP-0085, Matrix Client-Server API, Ably Chat, Stream, Discord/Slack docs) found that **every** robust chat system treats "stopped typing" as a **timeout, not an event** — no system trusts a client to send the final "stop", because a client can crash mid-typing. The indicator is kept alive by a periodic client **heartbeat** and dies by a **server-side TTL**. We adopt that and extend it: the same activity that refreshes the typing state resets a server-authoritative quiet-window timer that fires the DM.

Two independent concerns, both driven by the same client activity (typing heartbeats + messages):

1. **Typing display state** (who is typing) — Redis per-member keys with a TTL (§4.1). Consumed by the frontend later; built now as the infra MYT-65 deferred.
2. **The quiet-window trigger timer** — a resettable BullMQ debounce job per campaign (§4.2). This is what fires the DM.

Both live in Redis/BullMQ (shared), so they are correct no matter which container a player is connected to. **No in-process timers, no leader election** — the anti-pattern every scaled chat system avoids.

## 3. Process placement

| Concern | Runs in | Why |
|---|---|---|
| Observe typing/message frames; refresh typing state; reschedule the debounce job (auto/solo); **explicit: immediate `dm_thinking` + direct `session-turn` enqueue, bypassing the dm-trigger queue** | **API server** (`ws-session.ts` inbound handler) | The frame arrives here, at exactly one container per frame (the player's own connection). Single ingestion point → no double-scheduling. |
| Mature the quiet window; re-validate; classify; build the batch; enqueue the turn | **Worker** (`worker.ts` process, new `dm-trigger` BullMQ worker) | LLM work + turn enqueue belong off the request path, in the existing worker process that holds the Anthropic client and Redis. |
| Run the turn (lock + conductor); record the responded-seq watermark; set/clear the `dm_responding` flag | **Worker** (`session-turn` worker, MYT-66) | Extends MYT-66 with the watermark + responding flag (§4.7). |

The `dm-trigger` queue (decision) is kept cleanly separate from the `session-turn` queue (execution). **The `session-turn` queue keeps MYT-66's no-dedup, lock-is-the-mutex contract (H10) — unchanged (§4.7).**

## 4. Components

### 4.1 Typing-state tracking (display infra)

Per-member Redis key, set/refreshed by the client's throttled typing heartbeat:

```
{prefix}session:typing:{campaignId}:{userId} = "1"   EX = TYPING_TTL_S (8)
```

- **Set/refresh** on every inbound `typing_start` frame (the client throttles these to ~one per `TYPING_HEARTBEAT_S` = 3s while composing).
- **Clear** (`DEL`) on `typing_stop`, on `player_message` from that user (a send implies "done"), on disconnect (`handleDisconnect`), **and when a turn for the campaign fires** (`dm_thinking`) — so the indicator never shows "Alice is typing" *while the DM is responding* (resolves the TTL-vs-window visual overlap).
- **Authoritative stop = key expiry.** An explicit `typing_stop` is a best-effort fast-path only. A client that starts typing then crashes self-heals in ≤ `TYPING_TTL_S`; it can never wedge the trigger shut. (`TYPING_TTL_S` = 8 > 2× the 3s heartbeat → a single dropped heartbeat does not flicker.)
- **Keyed per user, not per connection.** Multi-tab for one user is out of scope here; the per-user key + TTL self-heal is acceptable (a stale tab's key expires). Presence (`session-state.ts`) remains per-`(containerId, userId)`; typing does not need that granularity for v1.
- **Fan-out** of `typing_start`/`typing_stop` to other members already exists (MYT-65 `hub.publish`). MYT-67 adds the *tracked state*, not new fan-out. The display "who is typing" query (`SCAN` over `…typing:{campaignId}:*`) is exposed for the future frontend; **the trigger itself does not read it** — it is driven by the debounce job (§4.2).

### 4.2 Activity-driven quiet-window debounce

The authoritative "quiet for N seconds" timer is **one BullMQ delayed job per campaign in deduplication/debounce mode**. On *any* activity (a `typing_start` heartbeat **or** a `player_message`), from any container, the server reschedules it. Reschedule placement: **after** the message is persisted+broadcast (so a reschedule failure never loses the message), and a reschedule failure is **logged at warn**, not silently swallowed like a malformed frame (so a sustained queue outage is observable, not a silent never-fires).

```ts
await dmTriggerQueue.add(
  'evaluate',
  { campaignId, firstUnrespondedAtMs }, // see max-wait ceiling below
  {
    deduplication: { id: `dm-trigger:${campaignId}`, replace: true, ttl: DEDUP_TTL_MS },
    delay: QUIET_WINDOW_MS, // e.g. 4000ms of required quiet
  },
)
```

**How it actually behaves (verified against BullMQ 5.76.8 Lua, corrected from the v1 draft):** the reset is **`replace`-driven** — on each `add`, BullMQ `ZREM`s the still-delayed job and re-adds a fresh one, resetting the countdown. `delay` sets the countdown; `ttl` keeps the dedup key alive across the window. `extend` is **inert** in the `replace` path and is **not** used (the v1 draft wrongly attributed the reset to an `extend`+`replace` combination). **`DEDUP_TTL_MS` MUST be > `QUIET_WINDOW_MS` + worker pickup latency** (e.g. `QUIET_WINDOW_MS + 4000`), so the dedup key never expires before the delayed job matures — otherwise a late activity pulse spawns a *second* independent debounce job and coalescing silently breaks.

**The maturity-boundary race (real, must be handled):** if an activity pulse arrives in the narrow window *after* the delayed job has promoted to `wait`/`active` but *before* the worker runs, the `ZREM` finds nothing and the new `add` is dropped (creates no new delayed job). The §4.3 re-validation guard catches the resulting too-early fire — **and on detecting it, the worker MUST re-arm the debounce** (`add` a fresh delayed job for the remaining quiet), not merely exit. A bare exit would strand the trigger until the next activity, silently swallowing a DM beat when the player then goes quiet.

**Max-wait ceiling (anti-starvation):** a single player who holds a typing indicator alive (idle in the compose box, laggy client) would otherwise reset the debounce forever and starve the whole table of any DM response. The server stamps `first-unresponded-at:{campaignId}` (ms) on the *first* activity after a turn (cleared at turn flush). The reschedule clamps the effective delay so the job matures no later than `firstUnrespondedAt + MAX_QUIET_EXTENSION_MS` (e.g. 30s) **regardless of ongoing typing**. This is the standard max-debounce cap.

**Rejected alternatives** (recorded so we don't revisit): Redis keyspace-expiry notifications (fire-and-forget pub/sub — a worker reconnect silently drops the fire; lazy expiry, not at T=0); in-instance `setTimeout` + lock-elected owner (hand-rolls exactly-once, owner death strands the timer). **Implementation note:** use the per-`add` `deduplication` option (or `job.changeDelay`), **never** `upsertJobScheduler` (a known-buggy recurring-scheduler surface — BullMQ #3430/#3063/#3378).

### 4.3 The `dm-trigger` worker

The new `dm-trigger` BullMQ worker (in `worker.ts`) has its own timing config — `lockDuration`, `stalledInterval`, `maxStalledCount` — plus a **per-call Haiku timeout strictly shorter than `lockDuration`** (consistent with the per-call LLM timeout shipped in myth-4omh), so a hung classifier call cannot outlive the job lock and get reclaimed-and-rerun (which would double-classify + double-enqueue). On classifier stall-exhaustion → fail-closed (no turn), per §9.

When the debounce job matures (sustained quiet), the worker:

1. **Re-validate quiet** — read `last-activity:{campaignId}`; if `now − lastActivity < QUIET_WINDOW_MS`, a reset landed in the promote→pickup window — **re-arm the debounce** (§4.2) and exit. (Explicit fast-path skips this — see §4.5.) *Clock note:* the stamp (server) and read (worker) are different Node clocks; the `QUIET_WINDOW_MS` margin (seconds) tolerates normal ECS skew. Documented assumption, not a precise guard.
2. **Determine mode & batch boundary.** Resolve the campaign's accepted-member count (§4.5) and the responded-seq watermark `last-responded-seq:{campaignId}` (0 if unset). Read player messages with `seq ∈ (lastRespondedSeq, currentMaxSeq]` from `repo.sessionMessages` (capped at `MAX_BATCH`), mapped to `TriggerMessage[]` (resolving `characterName`). **This same batch is both the classifier input and the turn's `triggerMessages`** — decision and execution can never diverge. Empty batch → exit (nothing to respond to).
3. **Decide:**
   - **Explicit pending** (`dm-trigger:{campaignId}:explicit` flag set by `@dm`/`dm_invoke`) → skip the classifier, force respond, clear the flag.
   - **Solo** (accepted members === 1) → skip the classifier, respond.
   - **Auto** (multiplayer) → call the Haiku classifier (§4.4) over the batch.
4. **Guard against an in-flight turn, then enqueue.** Check `dm_responding:{campaignId}` (set by the `session-turn` worker while a turn runs). **If a turn is in flight → do NOT enqueue** (the post-turn quiet re-fire drains it — §4.7). Else, **re-validate the active session as the last step** (`repo.sessions.getActiveByCampaign`; None → exit — guards the session-ended-mid-window race), then enqueue one `session-turn` job (§4.6).

### 4.4 The Haiku DM-trigger classifier (real)

A real Anthropic Haiku call — ZFC: the "should the DM respond, and how hard a turn is this" judgment is delegated to a model, never a heuristic.

- **Public-by-construction input type.** The classifier's input is a `DmTriggerContext` whose shape carries only public-tier material — the player-message batch (attributed to character names) + an optional **public** running-summary string. Modeled on `FtTurnContext` (MYT-66): **enforced ignorance is structural, not a convention** — a secret has nowhere to live on the type. The running summary is a classifier input **only if** it is guaranteed public-tier; while the ST is stubbed it is empty/public, and the type forbids wiring any ST/Scribe secret material in later. The classifier decides *whether* to respond, never *what* the response is.
- **Prompt template** `backend/src/llm/prompts/dm-trigger-classifier.txt` (file, not inline). The contract is specified here, not deferred: (a) the **complexity rubric** with exemplars (e.g. "order an ale" → low; "interrogate the captured NPC" → high — these map to the §17 skip-ST cost lever); (b) **confidence anchoring** so 0.8 means the same thing across calls (what high vs low confidence is pinned to); (c) the **last DM turn's output** is included so the model can distinguish "players are mid-side-conversation" from "players are waiting on the DM"; (d) **empty / all-addressed-to-other-players** batches → `shouldRespond:false`.
- **Zod schema** `backend/src/llm/schemas/dm-trigger-classification.ts`: `{ shouldRespond: boolean; complexity: 'low'|'high'; confidence: number; reason: string }`. Free-prose `reason` gets a `.min()` floor, no `.max()` (LLM-schema convention).
- **Repair posture:** the schema is trivially small, and §9 is fail-closed, so the classifier **skips the Sonnet repair** (`generateObject`'s default) — a malformed parse falls straight to the §9 fail-closed path (no DM this cycle, re-driven on next activity). This keeps the hot path Haiku-only and makes §4.4 and §9 consistent.
- **Routing** (spec §5): `shouldRespond=false` & `confidence>CONFIDENCE_FLOOR` → no turn. `true` & `low` & `>floor` → turn with a *skip-ST* hint. `true` & `high` → full ST→FT hint. `confidence<floor` → escalate (treat as high). The routing decision lives here; it is plumbed onto the turn payload (§4.6) and **consumed by MYT-68/69** — the MYT-66 stub conductor ignores it.
- Runs through the single Anthropic abstraction layer with the model from config (no hardcoded model name).

### 4.5 Trigger modes (server-side detection)

Mechanical/structural checks, ZFC-compliant (no semantic analysis):

- **Explicit:** a new `dm_invoke` client frame, or a `player_message` whose trimmed `text` starts with the literal `@dm`/`@DM`. → **fires the DM immediately — no quiet window, no classifier, no floor.** This is the "everyone be quiet, I have a question for the DM" gesture: it deliberately ices out the room, and the response must be as fast as we can make it. The server **bypasses the `dm-trigger` queue entirely** (no debounce hop): it allocates the `turnId`, **immediately broadcasts `dm_thinking{turnId}` to all clients** so every client greys its input *instantly* — the lock lands before any enqueue/lock latency — then builds the turn batch from the watermark (§4.3; frozen at invoke — since input is now locked, nothing contaminates it) and enqueues the `session-turn` directly (the dev `fire-turn` path already enqueues directly). If a turn is already in flight (`dm_responding` set), it instead sets the `…:explicit` flag, drained **immediately** after the current turn (no quiet window — §4.7); input is already locked by the in-flight turn. The worker's own later `dm_thinking` for the same `turnId` is a client no-op (dedup on `turnId`). **Rate-limited** per campaign + per user (the first WS frame that triggers real spend; an unbounded `@dm` is a cost + griefing surface — policy enforcement, a legitimate ZFC exception). The actual input *lock* is the frontend greying on `dm_thinking` (Frontend milestone); the backend keeps persisting any message that races the lock (never lost — it feeds the next turn's batch), it just never contaminates the in-flight explicit answer.
- **Solo:** decided in the worker (§4.3) from the **accepted**-member count — `invite_accepted = true` only (a pending invite does NOT make a solo game multiplayer). Add/usе a `countActiveMembers` repo method with that predicate; do not use the unfiltered `listMembers().length`.
- **Auto:** the default — reschedule the debounce with `delay: QUIET_WINDOW_MS`.

### 4.6 `session-turn` payload extension

`TurnJobPayload` (MYT-66) gains trigger metadata; **no dedup id is added — H10 stands** (§4.7):

```ts
interface TurnJobPayload {
  // … existing: campaignId, sessionId, turnId, triggerMessages
  trigger: {
    kind: 'explicit' | 'solo' | 'auto'
    classification?: { complexity: 'low' | 'high'; confidence: number } // present for 'auto'
  }
}
```

`triggerMessages` is the `(lastRespondedSeq, maxSeq]` batch the worker built (§4.3) — so a deferred/follow-up turn always carries the freshly-derived batch, never a stale replay. `reason` is **not** plumbed onto the payload (it is debug-only, §4.9) — MYT-68/69 authors should not expect it here. MYT-68/69 read `trigger.classification` for the skip-ST routing. The dev `fire-turn` route sets `kind: 'explicit'`. Additive + backward-compatible; the stub conductor ignores it.

### 4.7 Collision & drain (lock-only; H10 preserved)

Invariant: **at most one `session-turn` in flight per campaign** (MYT-66 lock), and triggers arriving during a turn produce **at most one coherent follow-up** on the accumulated context — never a backlog of stale replies, never a lost meaningful trigger.

Mechanism — **the `session-turn` queue keeps MYT-66's no-dedup contract (H10); the lock is the mutex.** The v1 draft's `session-turn:{campaignId}` dedup id is **removed** — it contradicted H10, and (verified against BullMQ Lua) would either drop legitimate sequential turns or, with `keepLastIfActive`, replay stale context. Coordination moves to where MYT-66/runtime-§6 already put it:

- The `session-turn` worker sets a `dm_responding:{campaignId}` flag (TTL ≈ lock TTL, heartbeat-refreshed) while a turn runs, and **records `last-responded-seq:{campaignId}` = the max consumed `seq` at flush**, then clears `dm_responding` + `first-unresponded-at` on release.
- The `dm-trigger` worker checks `dm_responding` before enqueuing (§4.3 step 4). **In flight → it does not enqueue.** New player activity during the turn reschedules the debounce job; after the turn (flag cleared) and a fresh quiet window, the debounce matures → the worker builds the batch from the *new* watermark → enqueues one follow-up. If players were quiet during the turn, no follow-up fires (correct — nothing new to say).
- This is runtime-spec §6 step 1 ("if lock held: queue trigger") + step 6 ("drain queue"), realized as: the debounce *is* the queued trigger, and the post-turn re-mature *is* the drain. The lock serializes any residual race (two enqueues slipping past the flag check); the loser returns `{ran:false}` and is re-driven by the debounce, not by blind BullMQ `attempts`.
- **Explicit during an in-flight turn is the exception that drains *immediately*** (not via the quiet window): the `…:explicit` flag set by the server is checked by the `session-turn` worker on release — if set, it enqueues the explicit follow-up turn right away (clearing the flag), so the summon is honored the instant the current turn ends. Input stays locked across the brief turn boundary.

### 4.8 Terminal `turn_error` via `QueueEvents` (closes `myth-tvnb`)

MYT-66's `worker.on('failed')` JS listener fires for the throw-then-`attempts`-exhausted terminal but **not** the `maxStalledCount`-exhaustion terminal (BullMQ emits only a broker-side event). MYT-67 adds a `QueueEvents('session-turn')` subscriber that listens for the broker `failed` event and publishes the terminal `turn_error`. Concretely:

- **Dedicated connection.** `QueueEvents` `BRPOP`s a stream — it gets its **own** `duplicate()`d ioredis connection (like the hub), never the BullMQ Worker's connection (blocking-command contention).
- **Cross-container idempotency.** Both publishers (the in-process JS `failed` listener and the broker-side `QueueEvents` — which fires on *every* worker container) guard on a shared `SET NX` latch `turn-error-published:{turnId}` (short TTL) before publishing, so exactly one `turn_error` goes out per terminal regardless of which path or how many containers fire.
- **Shutdown.** The subscriber is added to `worker.ts`'s `closeWithDeadline` set so its blocking connection is closed on SIGTERM (no leaked connection per deploy).

### 4.9 Debug observability — dev-only channel, NOT the player transport

The trigger decision is surfaced for debugging, but **not** on the player WebSocket. The shipped hub fans every published frame to *all* registered player sockets with no audience filter — so a `dm_trigger` frame on that channel would broadcast the classifier's `reason`/`confidence` to players (machinery they must not see; and the §10 smoke would falsely pass while leaking). Therefore:

- The trigger decision is emitted as a **structured pino log** (always) and on a **dedicated dev-only pub/sub channel** the dev-tool subscribes to — **not** the per-campaign player channel, and `dm_trigger` is **not** added to the player-facing `ServerFrame` union.
- Shape: `{ kind, shouldRespond, complexity?, confidence?, reason?, campaignId, at }`.
- The §10 dev-tool smoke asserts on this dev channel / the logs, plus the player-visible `dm_thinking` (the turn actually fired).

## 5. Wire contract changes (`contract/session-events.ts`)

- **Add `dm_invoke`** to `CLIENT_FRAME_TYPES` and the client payload union: `{ type: 'dm_invoke' }` (no fields). Any campaign member may summon; bounded by the §4.5 rate limit.
- `typing_start` / `typing_stop` already exist (MYT-65). No shape change; MYT-67 changes server-side *handling*.
- **Do NOT add `dm_trigger` to the player-facing `ServerFrame` union** — it rides the dev-only channel (§4.9).
- `dm_thinking` / `text_delta` / `turn_end` / `turn_error` already exist (MYT-66) and bracket a turn for the frontend's input-greying.

## 6. Redis keys & data model

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `…session:typing:{campaignId}:{userId}` | `"1"` | `TYPING_TTL_S` (8) | Per-member typing display; expiry = authoritative stop |
| `…session:last-activity:{campaignId}` | ms epoch | few × window | Maturity re-validation guard (§4.3) |
| `…session:first-unresponded-at:{campaignId}` | ms epoch | until flush | Max-wait ceiling anchor (§4.2) |
| `…session:last-responded-seq:{campaignId}` | int | session-lived | Batch watermark (§4.3/§4.7); set at turn flush |
| `…session:dm-trigger:{campaignId}:explicit` | flag | ≥ window | Explicit summon pending → skip classifier |
| `…session:dm_responding:{campaignId}` | flag | ≈ lock TTL, refreshed | "A turn is in flight" → drain guard (§4.7) |
| `…turn-error-published:{turnId}` | flag | short | `SET NX` idempotency latch (§4.8) |

All ephemeral; none persisted to Postgres. BullMQ dedup state lives in the queue's Redis structures.

## 7. Config constants (shared module, tunable)

A single config module imported by **both** `ws-session.ts` (server) and `dm-trigger-worker.ts` (worker) — added to the §14 file map — so the `delay` and the re-validation guard can never drift. (The frontend must later use the same numbers — the canonical "all clients share one timeout" rule; deferred to the Frontend milestone.)

| Constant | Default | Notes |
|---|---|---|
| `TYPING_HEARTBEAT_S` | 3 | client refresh cadence |
| `TYPING_TTL_S` | 8 | > 2× heartbeat; crash self-heal |
| `QUIET_WINDOW_MS` | 4000 | room-to-type (auto/solo); tune to feel. Explicit bypasses it entirely (§4.5). |
| `DEDUP_TTL_MS` | `QUIET_WINDOW_MS + 4000` | **must exceed window + pickup** (§4.2) |
| `MAX_QUIET_EXTENSION_MS` | 30000 | anti-starvation ceiling (§4.2) |
| `MAX_BATCH` | (plan) | classifier/turn batch cap |
| dm-trigger worker `lockDuration`/`stalledInterval`/`maxStalledCount` | (plan) | > Haiku timeout (§4.3) |
| `HAIKU_CLASSIFY_TIMEOUT_MS` | < `lockDuration` | per-call timeout |
| `DM_TRIGGER_CLASSIFIER_MODEL` | Haiku (config) | tiered inference |
| `CONFIDENCE_FLOOR` | 0.8 | §5 escalation threshold |

**Latency budget — two distinct numbers** (the v1 "~5s" conflated them): *time-to-acknowledge* (`dm_thinking` reaches clients) ≈ `QUIET_WINDOW + Haiku + enqueue + lock-acquire`; *time-to-first-prose* adds the conductor (trivial while stubbed; real in MYT-68/69). Both are tuned against feel; the quiet window is the dominant, deliberate term. A message *send* clears the sender's typing key, so the common path starts the window immediately on send.

## 8. Data flow

**Auto (multiplayer):** `player_message`/`typing_start` (any container) → server: refresh typing state; stamp last-activity + first-unresponded; reschedule debounce → [repeated reschedules while typing] → [quiet for window, bounded by ceiling] → debounce matures → dm-trigger worker: re-validate (re-arm if late-reset) → build `(lastRespondedSeq, max]` batch → Haiku classify → shouldRespond & not `dm_responding` & active session → enqueue `session-turn{kind:'auto', classification}` → session-turn worker (MYT-66): lock → set `dm_responding` → `dm_thinking` → stub conductor → record `last-responded-seq` at flush → `turn_end` → clear flag + release.

**Solo:** as auto; worker sees accepted-members===1 → skip classifier.

**Explicit:** frame → server: rate-limit → if no turn in flight: allocate `turnId`, **broadcast `dm_thinking{turnId}` immediately** (input locks everywhere), build batch from the watermark, enqueue `session-turn{kind:'explicit'}` **directly** (bypass the dm-trigger queue) → worker runs it. If a turn is in flight: set the `…:explicit` flag → the `session-turn` worker drains it **immediately** on release (§4.7).

**In-flight drain:** activity during a turn reschedules the debounce; the worker's enqueue is gated by `dm_responding`; after the turn + quiet, the debounce matures → one follow-up on the fresh watermark (§4.7).

## 9. Error handling

- **Classifier failure** (timeout/transient/auth/malformed): catch → *no trigger* this cycle (fail-closed) + a structured-log/metric **distinguishable** from a normal `shouldRespond:false`, so a transient/auth blip is diagnosable. Re-driven on next activity. There is **no fail-open fallback**: a *sustained* Haiku failure is an Anthropic-API outage, in which case the FT/ST turn the classifier would trigger is down too (same API) — failing "open" would only enqueue a turn that immediately fails into `turn_error`. The per-cycle fail-closed + the existing `turn_error` path are the whole story; the metric exists for diagnosis, not a fallback.
- **No active session:** worker exits (§4.3 step 4, re-validated last).
- **Dropped/crashed client mid-typing:** typing key TTL + `handleDisconnect` clear; max-wait ceiling bounds a stuck typer (§4.2); cannot wedge the trigger.
- **Lock contention:** the loser returns `{ran:false}` and is re-driven by the debounce (§4.7), not blind retry.
- **Queue/Redis unavailable at ingestion:** reschedule sits after persist+broadcast and logs at warn on failure (§4.2) — the message is never lost, and the outage is observable.
- **Combat mode:** out of scope (MYT-75); trigger assumes exploration mode.

## 10. Testing strategy

- **Unit (mocked):** mode detection (`@dm` prefix, `dm_invoke`, accepted-member count incl. the pending-invite case); classifier Zod schema; routing thresholds (the §5 matrix); the public-by-construction `DmTriggerContext` type (a secret field must not compile onto it); fail-closed-skips-repair.
- **Real Redis (`mythrun_test`, per the session-test convention):** typing-state set/refresh/clear/expiry; the watermark + `dm_responding` flag lifecycle.
- **The failure-mode cases round 1 surfaced (explicit regression tests):**
  - debounce: N activity pulses < window apart → fires **once** at last-pulse+window (pin the BullMQ version);
  - **worker-restart mid-window** → the delayed job survives in Redis and still matures once (validates the "no in-process timers" claim);
  - **maturity-boundary race**: activity in `[delay, delay+pickup]` → guard re-arms, no swallowed trigger;
  - **in-flight drain**: activity during a turn → exactly one follow-up on the fresh watermark, none if quiet;
  - **max-wait ceiling**: sustained typing → fires by `firstUnresponded + MAX_QUIET_EXTENSION_MS`;
  - **`QueueEvents` double-publish**: JS-listener path + broker path → exactly one `turn_error` via the SET-NX latch;
  - **classifier-job stall/reclaim**: a hung Haiku does not double-enqueue.
- **dev-tool E2E wire smoke (required):** drive the real WS — `typing_start` heartbeats then a `player_message`, assert (a) the debounce holds while "typing", (b) on quiet the **real Haiku classifier** runs (assert via the dev channel/logs) and `dm_thinking` appears, (c) `@dm` fires on the floor, (d) solo fires without a classifier. Assert observable end-state, not "no errors".

## 11. Scope boundary

**In (backend, MYT-67):** typing-state tracking; the debounce timer + max-wait ceiling; the `dm-trigger` queue + worker (+ its timing config); the real Haiku classifier (public-by-construction input, prompt + schema + routing); the `dm_invoke` frame + explicit rate limit; explicit/solo/auto detection; the watermark + `dm_responding` flag; the session-turn payload extension; collision/drain (lock-only); the `QueueEvents` terminal `turn_error` (+ idempotency latch + dedicated connection); the dev-only `dm_trigger` debug channel; a dev-tool panel; the shared config module.

**Out (Frontend milestone):** local keystroke→`typing_start`/`typing_stop` detection + heartbeat throttle; the cosmetic "DM responding in…" countdown; greying input on `dm_thinking`. MYT-67 exposes the signals (MYT-65/66 frames). Typing indicators are exercised at the **wire level** here.

**Still stubbed / deferred:** the conductor ST/FT/Scribe (MYT-66 stubs). The classification routing is plumbed but dormant until MYT-68/69. The runtime spec's **"ST every 5 turns" floor** is *not* implemented here (the conductor is stubbed); MYT-68/69 will need a per-session turn counter not introduced in this issue — noted so it isn't lost.

## 12. Amendments to the Multiplayer Session Runtime spec (on ship)

- **§5 (Debounce):** replace "wait 3s of silence, then classify" with the typing-gated quiet-window model + max-wait ceiling; record the canonical-pattern rationale.
- **§5 (Solo):** solo keeps the quiet window (room-to-type), skipping only the classifier.
- **§6 (steps 1/6):** the trigger queues via the `dm-trigger` debounce; the lock is the mutex (H10 preserved); "drain" is the post-turn re-mature (§4.7).
- **§15:** add `dm_invoke` (client). `dm_trigger` is dev-only (not a player frame).

## 13. Resolved at the review gate (2026-06-08)

- **Explicit semantics → immediate preempt** (Miklos): `@dm`/`dm_invoke` fires the DM instantly and ices out the room — the "everyone be quiet, I have a question" gesture. No floor; response as fast as possible; input locked the instant the invoke lands via an immediate server-side `dm_thinking` (§4.5).
- **Sustained classifier outage → no fallback** (Miklos): a Haiku outage is an Anthropic outage; the turn would fail anyway, so failing "open" is pointless. Keep only the distinguishable error metric for diagnosis (§9).
- **Tuning constants** (`QUIET_WINDOW_MS` 4s, `MAX_QUIET_EXTENSION_MS` 30s, `MAX_BATCH`, dm-trigger worker timing): ship the defaults, tune to feel — confirmed.

## 14. File-level change map (informs the plan)

**New:**
- `backend/src/session/typing-state.ts` — Redis typing keys: set/refresh/clear/listActive.
- `backend/src/session/dm-trigger-queue.ts` — queue name, payload, `rescheduleDebounce` / `fireExplicit` producers.
- `backend/src/session/dm-trigger-worker.ts` — maturity → re-validate/re-arm → batch → mode → classify/skip → drain-guard → enqueue.
- `backend/src/session/dm-trigger-classifier.ts` — the Haiku call (through the LLM abstraction; skip-repair).
- `backend/src/llm/schemas/dm-trigger-classification.ts` — Zod schema.
- `backend/src/llm/prompts/dm-trigger-classifier.txt` — prompt template (rubric + anchoring + last-turn + empty-batch).
- `backend/src/session/dm-trigger-config.ts` — the shared config constants (§7).
- `backend/src/session/turn-batch.ts` — shared `(lastRespondedSeq, maxSeq]` → `TriggerMessage[]` builder, used by both the dm-trigger worker (auto/solo) and the server explicit path.
- `backend/src/session/session-turn-queue-events.ts` — `QueueEvents` subscriber (dedicated connection + SET-NX latch).
- `backend/dev-tool/src/components/dm-trigger-panel.ts` — dev-tool panel (built by the verifier).

**Modified:**
- `backend/src/contract/session-events.ts` — `dm_invoke` (client). (No `dm_trigger` on the player union.)
- `backend/src/routes/ws-session.ts` — inbound handler: typing-state writes, debounce reschedule (after persist, log-on-fail) for auto/solo, explicit detection + rate limit + immediate `dm_thinking` + direct `session-turn` enqueue (or set explicit-pending if a turn is in flight), disconnect clear.
- `backend/src/session/turn-queue.ts` — `TurnJobPayload.trigger` field. **No dedup id (H10).**
- `backend/src/session/turn-worker.ts` — read `trigger` (plumb); set/clear `dm_responding`; record `last-responded-seq` at flush; **drain the `…:explicit` flag immediately on release** (§4.7); SET-NX latch in `publishTerminalTurnError`; re-drive (not blind retry) on lock loss.
- `backend/src/routes/dev-fire-turn.ts` — set `trigger.kind='explicit'`.
- `backend/src/server-queues.ts` / `app-deps.ts` / `server.ts` — wire the `dm-trigger` queue producer into the WS route deps.
- `backend/src/worker.ts` — register the `dm-trigger` worker (5th) + the `QueueEvents` subscriber (+ its connection in shutdown).
- `backend/dev-tool/verify-registry.ts` — register the dm-trigger panel.

## 15. Non-negotiables check

- **ZFC:** the should-respond/complexity judgment is a real Haiku call; structural triggers (`@dm` literal, `dm_invoke`, member count, rate limit) are mechanical/policy carve-outs. ✓
- **Enforced ignorance:** the classifier input is public-by-construction (§4.4); the debug `reason` never reaches a player (§4.9). ✓
- **LLM never rolls dice:** no RNG in this path. ✓

## 16. Round-1 blind-review resolutions (Mythological creatures)

0 strict SHOWSTOPPERS; all findings NIT, fixed inline. Key changes from v1: **dropped the `session-turn` dedup id** (kept H10; coordination via the `dm_responding` flag — §4.7); **specified the message-batch watermark** (§4.3/§4.7); **moved the `dm_trigger` debug frame off the player transport** (§4.9); **typed the classifier input public-by-construction** (§4.4); **fixed the solo predicate** to accepted-members (§4.5); **added the max-wait anti-starvation ceiling** (§4.2); **re-arm on the maturity-boundary race** (§4.2/§4.3); **`QueueEvents` idempotency latch + dedicated connection + shutdown** (§4.8); **dm-trigger worker timing + per-call Haiku timeout** (§4.3); **corrected the BullMQ mechanics** (`replace`-driven, `ttl > delay`; `extend` dropped — §4.2); **explicit rate limit** (§4.5); **fail-closed observability** (§9); **shared config module** (§7); plus the smaller doc/operability nits.

**Post-gate refinements (2026-06-08, §13):** explicit invoke is an **immediate hard preempt** — the server emits `dm_thinking` instantly and enqueues the `session-turn` directly, bypassing the dm-trigger queue (drained immediately if a turn is in flight); no floor. The sustained-outage **fail-open fallback was dropped** (an Anthropic outage breaks the turn too — metric-only).
