# Multiplayer Session Runtime Sub-Spec

> **Type**: Sub-spec (conforms to Production Architecture Overview)
> **Date**: 2026-04-13
> **Status**: Draft
> **Parent**: `2026-04-06-production-architecture-overview.md`
> **Depends on**: Backend Core (schema, repository), Auth & Users (JWT, WebSocket tickets, membership), Billing (session credit debit, token budget), Session Prep Pipeline (session prep generation — built before Session Runtime, invoked at session start)
> **Scope**: Live multiplayer game sessions — WebSocket connection management, transient SessionController, FastThinker/SlowThinker/Scribe for multiplayer, DM trigger system with tiered inference, Redis session state, message ordering, reconnection protocol, session lifecycle (start/play/suspend/end).
>
> **Amended 2026-06-04** — §17 (Design Amendments: Agentic Orchestration & Tool-Calling) records brainstorm decisions on turn orchestration, the tool-calling contract, the Rules Lawyer (out-of-combat rules adherence), and ST-gated world-knowledge lookups. These extend §4, §6, §7, §8, and §9; they will be folded into those sections once the full agentic design locks (only the Slow Thinker job scope remains, deferred to issue brainstorming).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Session Lifecycle](#2-session-lifecycle)
3. [WebSocket Connection Management](#3-websocket-connection-management)
4. [Transient SessionController](#4-transient-sessioncontroller)
5. [DM Trigger System](#5-dm-trigger-system)
6. [DM Response Flow](#6-dm-response-flow)
7. [FastThinker (Multiplayer)](#7-fastthinker-multiplayer)
8. [SlowThinker (Multiplayer)](#8-slowthinker-multiplayer)
9. [Scribe (Multiplayer)](#9-scribe-multiplayer)
10. [Skill Checks and Dice](#10-skill-checks-and-dice)
11. [Redis Session State](#11-redis-session-state)
12. [Message Ordering and Sequencing](#12-message-ordering-and-sequencing)
13. [Reconnection Protocol](#13-reconnection-protocol)
14. [Session End and Post-Session Analysis](#14-session-end-and-post-session-analysis)
15. [API Routes](#15-api-routes)
16. [Out of Scope](#16-out-of-scope)

---

## 1. Overview

The session runtime is the heart of Mythrun — it's where the actual game happens. This sub-spec covers everything from when a player clicks "Start Session" to when the session ends.

### What Changed From the Prototype

| Aspect | Prototype | Production |
|--------|-----------|-----------|
| Players | 1 | 2-5 |
| Session state | In-memory `Map<string, SessionController>` | Redis-backed, any container can serve |
| Controller | Long-lived object in process memory | Transient: created per DM turn, loads from Redis, flushes on completion |
| Turn model | 1:1 (player speaks → DM responds) | Multiplayer chat with hybrid DM trigger |
| WebSocket | One connection per session | Multiple connections per session, Redis pub/sub for cross-container routing |
| Message ordering | Implicit (one player, one server) | Server-assigned monotonic sequence numbers |
| Transcript | JSON blob rewritten every turn | Append-only `session_messages` table |
| Reconnection | Basic (reload history from DB) | Sequence-based replay with gap detection |

### Architecture Pattern

**Non-DM operations** (player messages, typing indicators, join/leave) are **stateless**: receive message → assign sequence number → publish to Redis pub/sub → all containers broadcast to their connected clients. No controller needed.

**DM operations** (generating a response) use a **transient controller**: acquire lock → create controller → load state from Redis → run ST/FT/Scribe → flush state to Redis → release lock → destroy controller. The controller exists for 10-60 seconds per DM turn.

---

## 2. Session Lifecycle

```
                    ┌─────────────┐
                    │   No Session │
                    └──────┬──────┘
                           │ POST /api/sessions/:campaignId/start
                           │ (debit session credit)
                           ▼
                    ┌─────────────┐
                    │    Active    │◄── players connect/reconnect
                    │              │
                    │  exploration │◄─► combat (mode switch)
                    │    mode      │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
       ┌──────────┐ ┌──────────┐ ┌──────────┐
       │ Suspended │ │  Ended   │ │ Crashed  │
       │ (all DC'd)│ │ (normal) │ │ (error)  │
       └──────┬───┘ └──────────┘ └──────┬───┘
              │                          │
              │ player reconnects        │ player reconnects
              ▼                          ▼
       ┌──────────┐              ┌──────────┐
       │  Active   │              │  Active   │
       │ (resumed) │              │(recovered)│
       └──────────┘              └──────────┘
```

### Starting a Session

1. Any campaign member calls `POST /api/sessions/:campaignId/start`
2. Server checks:
   - User is a campaign member
   - Campaign status is `'active'` (pipeline complete)
   - Session prep exists for the next session number
   - No active session already exists for this campaign
   - Campaign owner has session credits (atomic debit)
3. Creates a `sessions` row (status: `'active'`)
4. Creates Redis session state keys (see section 11)
5. Returns `{ sessionId }` — frontend then connects via WebSocket

### Ending a Session

1. Any member sends `end_session` via WebSocket
2. Server runs post-session analysis (section 14)
3. Flushes all Redis state to Postgres
4. Sets session status to `'ended'`
5. Cleans up Redis keys
6. Broadcasts `session_end` to all connected clients

### Suspending (All Players Disconnected)

If all players disconnect (close browser, lose internet):
1. Wait 5 minutes (grace period for reconnection)
2. If no one reconnects: flush Redis state to Postgres, keep session status `'active'`
3. Redis keys remain (with TTL refresh) for up to 1 hour
4. If a player reconnects within 1 hour: resume from Redis state
5. After 1 hour with no reconnection: checkpoint state to Postgres, clean Redis keys. Session remains `'active'` in the DB but requires a cold start on next connection (load from Postgres checkpoint)

---

## 3. WebSocket Connection Management

### Connection Flow

1. Client calls `POST /api/sessions/:id/ws-ticket` (sessionId in URL) → gets `{ticket, expiresAt}` with the ticket bound to `{userId, sessionId, campaignId}` (from Auth spec §7)
2. Client connects: `wss://api.mythrun.com/ws/session/:sessionId?ticket=<nonce>`
3. Server validates ticket via `consumeWsTicket` (atomic GETDEL) — returns the bound payload or null
4. Server re-validates campaign membership via `repo.campaigns.getMembership(payload.campaignId, payload.userId)` — the ticket alone proves membership at *mint time*, not upgrade time
5. Server checks session is active
6. Server subscribes to Redis channel `session:{campaignId}` (if not already subscribed for another client on this container)
7. Server sends `session_ready` (or `session_reconnect` if reconnecting)
8. Server broadcasts `player_joined` to all clients via pub/sub

### Connection Registry

Each API container maintains an in-memory map of WebSocket connections:

```typescript
// Per-container, not shared
type ConnectionRegistry = Map<string, Map<string, WebSocket>>
// campaignId → Map<userId → WebSocket>
```

When a message is published to `session:{campaignId}` via Redis pub/sub, each container iterates its local connection registry for that campaign and sends the message to each connected client.

### Disconnection

1. WebSocket `close` event fires
2. Remove from connection registry
3. Broadcast `player_left` via pub/sub
4. If no more local connections for this campaign: unsubscribe from Redis channel
5. If no connections remain on ANY container (check via `session:{campaignId}:connections` counter in Redis): start the 5-minute suspension timer

### Ping/Pong Keepalive

Server sends WebSocket `ping` frames every 30 seconds. If no `pong` response within 10 seconds, the connection is considered dead and cleaned up. This prevents ghost connections from accumulating.

### Periodic Token Re-validation

Every 30 minutes, the server sends a custom `auth_check` message. The client responds with a fresh JWT. If validation fails (expired, revoked user), the server closes the connection with `session_end { reason: 'auth_expired' }`.

---

## 4. Transient SessionController

### Design Pattern

The controller is a **transient object** created on-demand for each DM response. It is NOT long-lived. Its lifecycle:

1. DM trigger fires → acquire distributed lock
2. **Create** controller: load all session state from Redis in one bulk read
3. **Process**: run ST eval → FT streaming → Scribe extraction (all in memory)
4. **Flush**: write all updated state to Redis in one bulk write
5. **Destroy** controller: release lock, let GC collect

For non-DM operations (player messages, typing), no controller is created. Those are stateless pub/sub.

### Controller Interface

```typescript
interface SessionController {
  // Lifecycle
  loadFromRedis(): Promise<void>
  flushToRedis(): Promise<void>

  // DM turn processing
  processDmTurn(triggerMessages: PlayerMessage[]): Promise<void>

  // State access (in-memory during turn)
  getFtHistory(): ConversationMessage[]
  getRunningSummary(): string
  getParticipants(): SessionParticipant[]
  getSessionMode(): 'exploration' | 'combat'
  getTokenUsage(): { input: number; output: number }
}
```

### What the Controller Holds In-Memory

| State | Size | Source |
|-------|------|--------|
| FT message history | 50-200KB | `session:{campaignId}:ft_history` |
| Running summary | 1-5KB | `session:{campaignId}:summary` |
| Session metadata (participants, mode, session number) | 1-2KB | `session:{campaignId}:state` |
| Token usage counters | <1KB | `session:{campaignId}:usage` |
| Combat state (if in combat) | 5-50KB | `session:{campaignId}:combat` |

Total: ~100-250KB per controller. At 20 concurrent DM turns per container: ~5MB.

### Crash Recovery

If the container crashes mid-DM-turn:
- The controller never flushed → Redis state is unchanged (pre-turn state)
- The lock expires after 30 seconds (via `dm_responding` flag) or 120 seconds (lock TTL)
- Another container retries the turn from clean state
- The player may have seen partial streaming text — on reconnect, they see "DM response interrupted" and the turn is retried

---

## 5. DM Trigger System

### Two Trigger Modes

**Explicit trigger** (stateless, no classifier needed):
- Player sends `dm_invoke` message type (clicked the @DM button)
- Player message text starts with `@dm` or `@DM` (literal prefix match — this is a UI command, not semantic analysis, ZFC-compliant)
- In solo play (1 player campaign): every player message triggers the DM automatically

**Auto-trigger** (Haiku classifier with debounce):
- After the debounce window (2-3 seconds of silence after the last player message), the server sends the recent message batch to a Haiku classifier
- The classifier returns a structured response (per tiered inference pattern):

```typescript
interface DmTriggerClassification {
  shouldRespond: boolean
  complexity: 'low' | 'high'
  confidence: number  // 0-1
  reason: string  // for logging/debugging
}
```

- If `shouldRespond = false` and `confidence > 0.8`: no DM response
- If `shouldRespond = true` and `complexity = 'low'` and `confidence > 0.8`: skip ST, go straight to FT (cost/latency optimization)
- If `shouldRespond = true` and `complexity = 'high'`: full ST → FT flow
- If `confidence < 0.8` on any classification: escalate to full ST → FT flow (low confidence = high complexity by default)

### Debounce Implementation

```
Player A sends message ──→ start 3-second timer
                              │
Player B sends message ──→ reset timer to 3 seconds
                              │
                         (3 seconds of silence)
                              │
                         fire classifier ──→ trigger DM (or not)
```

If new messages arrive while the classifier is in-flight: cancel the classifier, restart the debounce timer.

### Solo Play Shortcut

If the campaign has exactly 1 member, every player message triggers the DM directly (no classifier, no debounce). This preserves the responsive 1:1 feel of the prototype.

---

## 6. DM Response Flow

The complete flow from trigger to turn_end:

```
1. TRIGGER
   ├── Acquire distributed lock (session:{campaignId}:lock)
   │   ├── Set dm_responding flag (30s TTL, heartbeat every 15s)
   │   ├── If lock already held: queue trigger, process after current turn
   │   └── If dm_responding expired but lock held: break stale lock
   │
   ├── Broadcast dm_thinking to all clients
   │
   └── Create transient SessionController
       └── Bulk load from Redis (history, summary, participants, usage, combat state)

2. SLOW THINKER EVALUATION (skip if low-complexity + high-confidence)
   ├── Build context: sd_playbook, running_summary, recent_exchanges, trigger_messages
   ├── Call Haiku/Sonnet/Opus based on tiered inference
   ├── Result: { intervene, direction, summary_update }
   ├── Broadcast st_evaluation (debug) to all clients
   └── Append summary_update to running summary (in-memory)

3. FAST THINKER RESPONSE
   ├── Add trigger messages to FT history with stage direction (if ST intervened)
   │   Messages attributed to player character names (not usernames)
   ├── Call streamConversation() with tools
   │   ├── Text deltas broadcast to all clients as text_delta events
   │   ├── Tool calls (roll_skill_check, roll_dice) handled inline
   │   │   ├── Skill check: resolveSkillCheck() → broadcast skill_check event
   │   │   ├── Dice roll: rollDice() → broadcast dice_roll event
   │   │   └── Set waitingForRoll → buffer subsequent text deltas
   │   └── Tool results fed back to FT for continued streaming
   ├── Add assistant response to FT history (in-memory)
   └── Broadcast turn_end to all clients

4. SCRIBE (async, non-blocking)
   ├── Call Haiku classifier: "Any notable world-state changes?" (tiered inference)
   │   ├── If no: skip full Scribe extraction
   │   └── If yes: run full Scribe extraction (Sonnet)
   ├── Process entity matches, new entities, fact updates, relationships
   ├── Broadcast scribe_result (debug) to all clients
   └── Errors caught and logged — never blocks the turn

5. FLUSH
   ├── Bulk write to Redis: updated history, summary, usage counters
   ├── Checkpoint to Postgres if 5+ minutes since last checkpoint
   ├── Release distributed lock
   ├── Clear dm_responding flag
   └── Destroy controller

6. DRAIN QUEUE
   └── If queued triggers arrived during this turn, process the next one
```

### Roll Animation Flow (Unchanged From Prototype)

When a tool call produces a skill check or dice roll:
1. The `skill_check` or `dice_roll` event is sent immediately
2. `waitingForRoll` is set on the controller
3. Subsequent `text_delta` events are buffered
4. ANY player sends `roll_complete` → flush buffered events, clear `waitingForRoll`
5. In multiplayer, the first player to acknowledge unblocks the flow for everyone

---

## 7. FastThinker (Multiplayer)

### Changes From Prototype

The FastThinker is fundamentally the same — it generates player-facing DM prose under enforced ignorance. The multiplayer changes:

1. **Multiple player messages per turn**: The trigger may collect messages from multiple players. These are formatted as:
   ```
   [STAGE] direction text [/STAGE]
   
   ---
   
   Arin (Player 1): "I walk up to the merchant and ask about the missing shipment."
   Kael (Player 2): "While Arin talks, I check the alley behind the shop."
   ```
   Player messages are attributed to **character names**, not usernames.

2. **NPC seed consumption**: Seeds are consumed in order across ALL players' turns (the same as single-player, just shared).

3. **Prompt caching**: The system prompt + world context are heavily cached. In multiplayer, caching is even more valuable because multiple turns may happen in quick succession.

4. **Tool calls**: Skill checks target a specific player's character. The FT must specify which character is rolling via the tool call's `context` field. The controller resolves the character by name matching against the participant list.

### System Prompt

Same `ft-system.txt` template with one addition: a note that multiple players are present, with character name → player mapping. The FT should address characters by name and handle scenes where multiple characters act simultaneously.

---

## 8. SlowThinker (Multiplayer)

### Changes From Prototype

1. **Multiple player messages**: The ST evaluates a batch of player messages, not a single one. Its context includes messages from all players since the last DM response.

2. **Multi-character awareness**: The ST knows all PC names, backgrounds, and their current narrative threads. Its directions may reference specific characters: "Arin's questioning is getting close to the truth — have the merchant deflect to Kael's character specifically."

3. **Running summary**: Now tracks multiple characters' arcs and positions, not just one.

### ST-Skip (Tiered Inference)

Low-complexity turns (classified by the Haiku trigger): skip ST entirely. The FT responds directly. Examples of low-complexity: "I order an ale," casual NPC small talk, simple movement descriptions.

High-complexity or low-confidence: full ST evaluation. Examples: NPC interrogation scenes, plot-adjacent actions, multi-character interactions.

The ST also runs **every 5 turns minimum** regardless of complexity classification, to maintain narrative oversight.

---

## 9. Scribe (Multiplayer)

### Changes From Prototype

1. **Tiered inference**: Before running the full Scribe extraction (Sonnet), a Haiku triage call classifies whether the DM's response contains any noteworthy world-state changes. Many turns ("the barkeep refills your mug") don't need extraction.

2. **Entity resolution**: Per ZFC, entity resolution is done by the Scribe's LLM call, not by string matching code. The Scribe sees the known entity list and identifies which entities were referenced and whether any are new.

3. **Multiple PC actions**: The Scribe may need to extract state changes for multiple characters in a single turn (e.g., Arin learned a fact, Kael was injured).

4. **Write scope**: Scribe writes are applied to the campaign's forked world. They're persisted to Postgres directly (not via the controller's Redis flush — Scribe is async and non-blocking).

---

## 10. Skill Checks and Dice

### Multiplayer Skill Check Flow

1. FT calls `roll_skill_check` tool with `{ skill, context, character_name }`
2. Controller resolves character by name from participant list
3. Loads character stats from Redis cache (or Postgres if not cached)
4. Calls `resolveSkillCheck()` (Haiku for DC, deterministic roll — same as prototype)
5. Broadcasts `skill_check` event to ALL clients (everyone sees the result)
6. Sets `waitingForRoll` — all clients see the roll animation
7. First `roll_complete` from any client unblocks the flow

### Multi-Character Checks

The FT can request checks for multiple characters in sequence (e.g., "everyone make a Perception check"). Each check is a separate tool call, resolved sequentially. The FT sees each result before deciding the next action.

Group checks (where everyone rolls and the majority determines success) are handled by the FT making multiple tool calls and the DM narrating the collective outcome.

---

## 11. Redis Session State

### Key Schema

| Key | Type | TTL | Content |
|-----|------|-----|---------|
| `session:{cId}:state` | Hash | Refreshed on interaction | `{ sessionId, campaignId, worldId, sessionNumber, status, mode, participants[] }` |
| `session:{cId}:ft_history` | String (JSON) | Refreshed on interaction | FastThinker message history array |
| `session:{cId}:summary` | String | Refreshed on interaction | ST running summary text |
| `session:{cId}:combat` | String (JSON) | Refreshed on interaction | CombatState (null if not in combat) |
| `session:{cId}:usage` | Hash | Refreshed on interaction | `{ input_tokens, output_tokens }` |
| `session:{cId}:seq` | Integer | Refreshed on interaction | Monotonic message sequence counter |
| `session:{cId}:lock` | String | 120s base + heartbeat | Distributed lock for DM responses |
| `session:{cId}:dm_responding` | String | 30s + heartbeat | Stale lock detection flag |
| `session:{cId}:connections` | Integer | No TTL (managed explicitly) | Count of connected clients across all containers |
| `session:{cId}:trigger_queue` | List | Refreshed on interaction | Queued DM triggers waiting for current turn to complete |

### TTL Strategy

- All state keys are refreshed (TTL reset) on every interaction (player message, DM response, ping/pong)
- Base TTL: 2 hours (covers a long session with brief idle periods)
- If all players disconnect: state remains for 1 hour, then is cleaned up
- Checkpoint to Postgres: every 5 minutes during active play

### Redis Memory Policy

The real-time Redis instance uses `maxmemory-policy: noeviction`. If memory is full, writes fail (handled gracefully) rather than silently evicting session state.

---

## 12. Message Ordering and Sequencing

### Sequence Number Assignment

Every message (player, DM, system) gets a server-assigned sequence number:

```typescript
const seq = await redis.incr(`session:${campaignId}:seq`)
```

This happens:
- When a player message is received (before pub/sub broadcast)
- When a DM text_delta begins (first delta gets a seq, subsequent deltas share it)
- When a skill_check, dice_roll, turn_end, or any other event is created

### Client-Side Ordering

Clients maintain:
- `lastSeenSeq`: the highest sequence number rendered
- `buffer`: messages received out of order

When a message arrives:
1. If `msg.seq === lastSeenSeq + 1`: render immediately, increment `lastSeenSeq`
2. If `msg.seq > lastSeenSeq + 1`: buffer the message, wait up to 200ms for the gap to fill
3. If gap persists >200ms: request missing messages from server (`GET /api/sessions/:id/messages?afterSeq=N`)
4. If `msg.seq <= lastSeenSeq`: discard (duplicate)

### Sequence Numbers During Streaming

DM streaming (`text_delta` events) poses a special case: many events in rapid succession. The approach:
- The `dm_thinking` message gets a sequence number
- All `text_delta` events for one DM response share the SAME sequence number (they're fragments of one message)
- The `turn_end` message gets the next sequence number
- This means a DM response is: seq N = dm_thinking, seq N = text_delta (many), seq N+1 = turn_end

The client treats all events with the same seq as part of one atomic message.

---

## 13. Reconnection Protocol

### Step-by-Step Flow

1. Client detects WebSocket disconnect (close event or missed pong)
2. Client shows "Reconnecting..." overlay
3. Client attempts reconnection with exponential backoff: 1s, 2s, 4s, 8s, max 30s
4. On each attempt:
   a. Get a new WS ticket (`POST /api/sessions/:id/ws-ticket`)
   b. Connect to `wss://.../ws/session/:sessionId?ticket=<nonce>&lastSeq=<N>` where N is the client's `lastSeenSeq`
5. Server validates ticket and checks session state:
   - **Redis state exists**: load session metadata, send `session_reconnect` with messages after `lastSeq`
   - **Redis state missing, Postgres checkpoint exists**: load from checkpoint, rebuild Redis state, send `session_reconnect` (may be missing last few minutes of messages)
   - **No state anywhere**: send `error { message: 'Session not found' }`
6. Client receives `session_reconnect`:
   ```json
   {
     "type": "session_reconnect",
     "messages": [ /* ordered by seq, all messages after lastSeq */ ],
     "participants": [ /* current participant list */ ],
     "mode": "exploration" | "combat",
     "combatState": { /* if in combat */ },
     "inFlightResponse": { "text": "string", "seq": 0 } | null
   }
   ```
7. Client replays messages in order, deduplicates against its buffer
8. If `inFlightResponse` is non-null, the client renders the accumulated text and then resumes receiving live `text_delta` events from pub/sub. The client does NOT deduplicate text_deltas against the `inFlightResponse` by sequence number — instead, it uses a character-offset to avoid rendering duplicate text.
9. Client shows "Reconnected" briefly, then resumes normal UI
9. Server broadcasts `player_joined` (so other clients know this player is back)

### Partial Redis State

If some Redis keys are missing but others exist (e.g., `ft_history` evicted but `state` present):
1. Check which keys are present
2. For missing keys, attempt Postgres checkpoint recovery
3. If `ft_history` is missing: load from last checkpoint. The controller will work with a slightly stale history (missing the last few turns). The ST's running summary provides continuity.
4. If `state` is missing: the session must be restarted from the Postgres session row. Send `session_reconnect` with full history from `session_messages` table.

---

## 14. Session End and Post-Session Analysis

### Normal End

1. Any player sends `end_session`
2. Server broadcasts `dm_thinking` (the DM gives a farewell)
3. Controller runs a final FT call: "The session is ending. Provide a brief narrative wrap-up and describe where each character is."
4. Stream the farewell to all clients
5. Run post-session analysis (Slow Thinker, Opus):
   - Input: full transcript (from `session_messages`), SD playbook, running summary
   - Output: `{ summary, emerging_threads[], faction_updates[], handoff: SessionHandoff }`
6. Persist to session row: `summary`, `handoff` (JSON)
7. Set session status to `'ended'`, `ended_at = now()`
8. Flush all Redis state to Postgres, clean Redis keys
9. Broadcast `session_end { reason: 'normal', summary, emerging_threads, faction_updates }`
10. Close all WebSocket connections

### Token Budget Exhaustion

At 90% of token budget:
- ST receives wind-down instruction
- **Normal sessions**: ST guides to a narratively satisfying pause ("the party finds a safe place to rest")
- **Free trial sessions**: ST creates a narrative cliffhanger (hook or cliffhanger, per UX spec)

At 100%: forced end via the normal end flow above.

### Crash Recovery

If the session was never properly ended (server crash, Redis loss):
- Session status remains `'active'` in Postgres
- On next connection attempt, the server detects the active session and resumes from the latest checkpoint
- Post-session analysis runs on the next session end (not retroactively for the crashed session)

---

## 15. API Routes

### Session Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/sessions/:campaignId/start` | Member | Start or resume a session (debit credit) |
| GET | `/api/sessions/:campaignId/active` | Member | Get active session info (or null) |
| GET | `/api/sessions/:campaignId/list` | Member | List all sessions for campaign |
| GET | `/api/sessions/:sessionId` | Member | Get session details |
| GET | `/api/sessions/:sessionId/messages` | Member | Get messages (with `?afterSeq=N` for replay) |
| GET | `/api/sessions/:sessionId/recap` | **Public** | Shareable session recap (from UX spec) |
| DELETE | `/api/sessions/:sessionId` | Owner | Delete a session |
| POST | `/api/sessions/:sessionId/regenerate-handoff` | Owner | Re-run post-session analysis |

### WebSocket Message Types

See the architecture overview spec section 5.2 for the complete message type tables. Key additions from this sub-spec:

**Server → Client (new):**

| Type | Fields | Purpose |
|------|--------|---------|
| `auth_check` | (none) | Periodic re-validation request (every 30 min) |

**Client → Server (new):**

| Type | Fields | Purpose |
|------|--------|---------|
| `auth_response` | `token` | Fresh JWT in response to auth_check |

---

## 16. Out of Scope

| Feature | Deferred To |
|---------|------------|
| Combat mode (combat state, rules engine, map) | Combat Engine sub-spec |
| Voice chat / WebRTC | Future |
| Session recording / replay | Future |
| Spectator mode (watch without participating) | Future |
| DM override (human DM takes over from AI) | Future |
| Session scheduling / calendar integration | Future |
| In-session private messaging between players | Future (architecture supports via pub/sub channels, but no UI) |
| Between-session world observer | Future |

---

## 17. Design Amendments — Agentic Orchestration & Tool-Calling (2026-06-04)

> Captured during a Session Runtime design brainstorm. These decisions extend, and where noted amend, §4, §6, §7, §8, and §9. They will be folded into those sections once the full agentic design is locked — only the Slow Thinker job scope remains, deferred to issue brainstorming (see §17.8). Dating follows the World & Campaign Pipeline amendment convention.

### 17.1 Turn orchestration: deterministic conductor, specialist tiers

A DM turn is **conducted by deterministic code** (the SessionController), never by an LLM. ZFC: orchestration is code; reasoning is delegated. The cognitive tiers are bounded specialists — each does one job and hands back:

- The SessionController runs the fixed macro sequence (trigger → ST eval, if not skipped → FT render → Scribe).
- No LLM decides "what happens this turn." The **only** autonomy is the FT's bounded in-stream tool loop (§17.2): the FT decides *which mechanical tools it needs mid-prose*, not *what the turn is about*.
- Rejected: ST-as-director (an LLM orchestrates the turn) and FT-as-autonomous-agent (the ignorant tier steers) — both hand the baton to an LLM and break ZFC, cost discipline, and the ignorance posture.

### 17.2 Tool-calling contract

**Constraint-injection principle (generalizes §10 / Principle #5 to the whole tool belt):** a tool is the authoritative source of mechanical / factual / legal truth. It returns its result as a **constraint**; the FT writes prose *informed by* the constraint but never *decides* the outcome. Failed check → the FT narrates *how* it fails, not a success. No spell slot → no spell, only the grasp for one. The resolver owns the outcome; the FT owns the telling.

**Interleaved tool loop:** a turn is a multi-step generation. The FT streams prose until it needs a mechanical truth, emits a tool call, the conductor resolves it and feeds the result back, the FT continues (text → call → resolve → text → …). Resolve-before-narrate falls out for free. This is the prototype's validated `streamFtTurn` shape.

**Hard per-turn iteration cap:** unlike the prototype (whose tool loop was unbounded), production caps tool-call iterations per turn (target 4–5) — a deterministic policy guard bounding worst-case round-trips and cost.

**The tool belt** (all FT-called):

| Tool | Resolver | Cost |
|------|----------|------|
| `roll_dice` | pure code (deterministic RNG) | ~0 |
| `cast_spell` | Rules Lawyer (pure code): validate known + slot, decrement | ~0 |
| `spend_resource` | Rules Lawyer (pure code): gold / consumable / limited feature-use — validate + decrement | ~0 |
| `initiate_combat` | flip session to combat mode (initiative rolled mechanically) | ~0 |
| `resolve_combat_round` | combat L1 debug shell (parse structured outcome) | ~0 |
| `roll_skill_check` | 1 Haiku DC-table call → deterministic roll → matched outcome tier as constraint (§10) | 1 Haiku |
| `world_fact_lookup` | gated retrieval routed through the ST (§17.4) | heavy, rare |

Five of seven resolve in pure code (no LLM, no meaningful latency). Only `roll_skill_check` (cheap Haiku) and `world_fact_lookup` (heavy, deliberately rare) involve a model. The interleaved loop's real cost is *extra FT inference passes*, heavily blunted by prompt caching on the static payload — so the honest tax is latency, not dollars, and four of the likely calls resolve instantly in code.

### 17.3 Rules Lawyer — out-of-combat rules adherence

Players use spells, abilities, items, and gold outside combat. A **Rules Lawyer** enforces this — as a **deterministic, server-authoritative service, NOT a new LLM tier.** (ZFC: resource math is mechanical computation, like dice and movement — code, not AI. "Enough gold? subtract it" is subtraction, not judgment.)

- **Interpretation** (intent → structured action) is LLM work, but it is the **FT's tool call** — the FT already interprets all player intent — e.g. `{cast: fireball, slot: 3}`. Not a separate agent.
- **Adjudication + mutation** (legality + state change) is the deterministic Rules Lawyer service: validate against the character sheet, mutate on success, or return a structured constraint the FT narrates around on failure.
- **In-turn synchronous** (validate → FT narrates informed by the result) — not async like the Scribe. Mirrors the combat rules engine's "pure functions, server-authoritative, AI narrates" pattern. The Rules Lawyer is effectively the **exploration-mode sibling of the combat rules engine.**
- **Shared live character ledger:** the Rules Lawyer (exploration) and the combat engine read/write **one** live per-character mechanical-state record (HP, spell slots, gold, inventory, limited-feature uses, conditions), so resources carry seamlessly across the exploration↔combat switch. This ledger is a **new session-state component** the current spec lacks (§4 / §11 track FT history, summary, combat, usage — but no exploration-time character ledger); it is persisted to Postgres on checkpoint/end like other session state.

### 17.4 World-knowledge lookups — unified, ST-gated retrieval

The FT runs on a curated prep slice (`ft_context`); the full world (entities, facts tagged by `access_level`, relationships) lives in Postgres. A `world_fact_lookup` is **on-demand retrieval from that store** — the bridge from working memory (the prep) to long-term memory (the world store). Rare and costly by design; used only when a player directly queries world state the FT cannot answer from context. Neither thinker is omniscient: the FT works from `ft_context`, the ST from `sd_playbook` (secret-inclusive but still a slice); the store is the source of truth, and a lookup augments a tier's context on demand.

**Unified flow (boundary maintained, no sensitivity pre-guessing):**

1. Player asks about knowledge not in context but possibly in the store, and **passes the gating skill check** (§17.5). A failed check skips the lookup entirely (avoids the cost) — the FT narrates the blank.
2. The FT emits `world_fact_lookup`.
3. A **resolver searches the world store** for relevant knowledge (mechanism in §17.6). Because of step 4, the resolver may over-pull freely, secrets included; it must find what is *relevant*, not what is *safe*.
4. The retrieved knowledge **in its entirety, including secret-tier facts (marked as secret), is given to the ST** — never to the FT.
5. The **ST makes the judgment call** on what (if anything) to surface, and returns it as a **stage direction** to the FT. On a **miss** (nothing relevant in the store), the ST **invents** a tone/thread-consistent answer instead (the play-is-canon loop) — same path.
6. The FT responds to the player, informed by the ST's relay.

**Why this is the boundary:** the FT is *structurally* never on the receiving end of a retrieval — it only ever gets the ST's vetted relay (via the existing ST→FT direction channel). There is no tier filter on the retrieval to misconfigure; the single gate is the ST, which is *allowed* secrets. The FT's inbound channels stay at exactly two (player messages + ST direction). Mechanically it fits the interleaved loop: the `world_fact_lookup` resolver runs search→ST internally and returns the ST's relay as the `tool_result`; the FT does not know an ST was in the loop.

**Channel-semantics widening (amends §8.2):** §8.2 frames the ST `direction` as *behavior, not information*. The lookup flow adds a second, sanctioned mode — when a player has asked a direct question and **earned the answer via a passed check**, the ST may relay **vetted information** ("yes, a fishing town two days north"), not just behavior. The Haiku leak-check (§8.2) still bounds it: the ST cannot relay more than it decided to surface. This widening is a deliberate decision, not drift.

**Cost note:** the ST is invoked on *every* lookup (Opus, mid-turn). Acceptable because lookups are skill-gated and rare. A principled future optimization — skip the ST when the retrieved set is *provably* all-non-secret (a known fact post-retrieval, not a guess) — is held in reserve, not adopted, to preserve the single-path boundary.

### 17.5 The two lookup channels

A world-knowledge query resolves through one of two channels, each gated by an appropriate skill check rolled *before* the lookup (so a failed check avoids the cost):

- **Ask the DM (narrator) directly** — the PC tries to recall or deduce. Check against the PC's relevant skill (History / Arcana / Religion / etc.); obscurity sets the DC. The relayed answer is *objective* world truth (from the store, or invented on a miss) → canonized as fact.
- **Ask an NPC** — the PC asks a character who may or may not know. Check against the **NPC's** scores (fabricated on the fly if the NPC has no stat block yet — acceptable). The player is told only that the NPC *succeeded or failed* a check, **without revealing the roll**. The answer is *what the NPC conveys* (bounded by the NPC's knowledge per the playbook; may be partial or wrong) → canonized as "the NPC claimed X," not necessarily ground truth. *(Exact claim-vs-canon write semantics is an open Piece-1 nuance — see §17.6.)*

### 17.6 The world-knowledge resolver (mechanism)

The resolver behind `world_fact_lookup` (§17.4) is a **small family of curated, parameterized retrieval tools the FT picks from** — e.g. `search_lore(topic)`, `locations_near(place, radius)`, `characters_known_to(character, name?)`. Routing is the FT's reasoning (which tool + args); execution is deterministic SQL that cannot hallucinate a column. This is §17.2's constraint-injection applied to retrieval, and the TAG (Table-Augmented Generation) division of labor: the database does the exact filtering / counting / joining; the LLM only interprets and narrates ("how many gods in the pantheon" is `COUNT(*)`, never the model's vibe).

**Two orthogonal axes shape a lookup:**

- **Substrate** (what kind of query) — selects the retrieval mechanism.
- **Channel** (who is asked: DM vs NPC, §17.5) — selects the gating skill check and the truth semantics of the answer.

**Three substrates, one Postgres instance:**

- `pgvector` — semantic lore ("what's known about the gods"); the only true vector-RAG component.
- Recursive CTEs / `ltree` — relationship traversal ("does X know anyone named Y," faction trees); no external graph DB for one world's social graph.
- Coordinate math / PostGIS — spatial ("settlements near here").

**Curated tools are the primary path; raw text-to-SQL is a sandboxed escape hatch only** (read-only role, statement timeout, row caps, a restricted view — never base tables), reserved for genuinely long-tail queries the curated set didn't anticipate. Never the default for correctness-sensitive work — real-world text-to-SQL accuracy on joins/filters is too low to trust by default.

**No tier-filtering on the resolver.** Because every result funnels to the ST (§17.4 step 4), the resolver queries *across all tiers freely* — it must find what is *relevant*, not what is *safe*. The permission boundary is the ST gate, not the query. (Row-level security stays available as optional defense-in-depth; it is not the boundary.)

**Empty ≠ invent.** A zero-row result is a legitimate "none" (no settlements near an isolated city), not an automatic trigger to fabricate. The ST arbitrates genuine emptiness (relay "none") vs. a real gap worth inventing (the play-is-canon path, §17.4 step 5).

**Read and write share this resolver.** The Scribe reuses these same tools at write time for entity resolution (match-vs-mint against canon via name + `pgvector` similarity) — see §17.7.

### 17.7 The write-authority map

Four things now mutate game state — the Rules Lawyer, the Scribe, the combat engine, and the play-is-canon loop. They sort cleanly by one organizing principle: **timing follows dependency.** State the *next action* depends on is written synchronously and authoritatively; state that only matters for *future continuity* is written async. That yields three classes.

**Class 1 — Mechanical character state (in-turn, synchronous, deterministic code).** HP, spell slots, gold, inventory, limited-feature uses, conditions. Written by the **Rules Lawyer** (exploration) and the **combat engine** (combat) to **one shared live character ledger**, the instant an action resolves — because the next tool call may depend on it (you cannot async-debit a slot and then let the FT cast from it again). No LLM in this path: deterministic validation + mutation. The ledger is new session state (§4 / §11 lack it) and is persisted on checkpoint/end.

**Class 2 — Narrative world state (proposed in-turn, reconciled at session end).** Entities, facts, relationships. Two proposal sources: the FT's **lightweight fact delta** (incidental named things it introduced in prose — public by construction) and **ST injections** (lookup inventions, sanctioned reveals — tier set by the ST). Both land in an ephemeral **session working set**, not durable canon. The FT and the §17.6 resolver read **working-set ∪ canon**, so a fact invented in turn 5 is visible in turn 6 with no read-after-write gap; intra-session entity resolution is small-scope and cheap. The **Scribe is a reconciler, not an extractor** (amends §9): the heavy pass — cross-canon entity resolution (match-vs-mint via the §17.6 resolver), contradiction handling, and the multi-substrate commit (relational row + relationship edges + `pgvector` embedding + coordinates) — runs **once at session end** with full context (B1). Nothing in-session needs durable canon (see the wiki note), so deferral costs nothing and buys better resolution + lower per-turn cost. The working set rides the existing 5-min checkpoint (raw facts) for crash durability.

**Class 3 — Conflict adjudication (the ST, gated — the play-is-canon decision, formalized).** When a proposed fact contradicts canon, the ST adjudicates on a graduated, tier-aware ladder:

- minor / peripheral → **absorb** (canonize the improvised version);
- brushes a secret but no hard break → **steer** (nudge future narration away);
- *fundamentally breaks a core secret* → **retcon**.

A **retcon** is an open, in-fiction correction the FT delivers ("earlier I said X — correction, it's actually Z; from there…"). Its *form* is the player-facing DM voice (terse, honest, not jokey); its *content* is **ST-authored and secret-preserving** — Z removes the contradiction without revealing the secret (the FT still never learns it; an early reveal only if revelation conditions already allow). It is recorded in the append-only log as a new event superseding X, so history and "why is this canon" stay intact — which is much of *why* the log is append-only.

**Prompt detection of the dangerous case.** Most reconciliation defers to session end, but core-secret breaks can't wait — a retcon's blast radius grows with every turn the false fact sits. So a **cheap per-turn secret tripwire** (the existing Haiku triage, repurposed) checks each turn's assertions against the **session prep's core secrets** (exactly what is "in play" and breakable, per §17.4); a hit escalates to the ST → retcon within a turn or two, a miss costs almost nothing. Net per-turn Scribe cost goes *down* versus the old §9 design — no per-turn Sonnet extraction, just a Haiku tripwire + a working-set append.

**The player wiki + transcript search.** The wiki (sidebar, *known* facts per entity) **updates at session end**, off the hot path — so it never exposes half-reconciled or about-to-be-retconned canon. In-session lookback is a **search over the player-facing transcript** (FT prose + player messages + skill/dice/combat events — explicitly *not* the debug `st_evaluation` / `scribe_result` stream). That corpus is public by construction, so search **cannot leak a secret** (there is nothing to filter), and it is the better fit for "what did X say / what happened with Y" recall anyway. The end-of-session reconciliation produces both outputs from one pass: the wiki refresh **and** the next-session prep handoff. (Touches the UX spec: wiki cadence + the search feature.)

This map amends §6 (step 4 — the per-turn Scribe becomes tripwire + working-set append), §9 (Scribe = reconciler), §11 (checkpoint the working set), and §14 (the heavy reconciliation + wiki refresh + handoff all run at session end).

### 17.8 Open (deferred to issue brainstorming)

- **Slow Thinker job scope** — one monolithic director vs. a family of privileged Opus calls (evaluate-turn / lookup-gate / invent-missing-fact / adjudicate-conflict-and-author-retcon). A decomposition-time decision; the tier and its inputs are settled, only the call-shape is open.
- **NPC-claim vs. objective-canon write semantics (§17.5)** — whether an NPC's conveyed answer is written as a belief/claim or as ground truth. A write-path detail for the Scribe issue.
