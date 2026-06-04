# MYT-65 — Multiplayer WS Transport, Session Lifecycle & Redis State (Design)

> **Issue:** MYT-65 (first issue of the Session Runtime + Combat L1 milestone).
> **Brainstormed:** 2026-06-04.
> **Parent spec:** `docs/specs/2026-04-13-multiplayer-session-runtime.md` — §2 lifecycle, §3 connection management, §11 Redis state, §12 sequencing, §13 reconnection, plus §17 design amendments.
> **Status:** design approved; ready for implementation planning (`writing-plans`).

## Goal

Two clients connect to a session over WebSocket and exchange **server-ordered, replayable** messages; a reconnect replays cleanly from `lastSeq`. The DM loop is **entirely absent/stubbed** — MYT-65 is the multiplayer *chat transport* with sequencing + reconnection + session lifecycle. The DM turn arrives in MYT-66.

## Scope

**In:**
- WS upgrade (consume ticket → re-check membership → session-active), the connection hub + `session:campaign:{id}` pub/sub channel, inbound `player_message` + typing handling, server-assigned `seq` (Redis `INCR`), append-only persist to `session_messages`, broadcast fan-out, ping/pong keepalive, disconnect + `connections` counter, reconnection (`session_reconnect` replay from `lastSeq` + REST gap backfill).
- Session lifecycle: `POST /:campaignId/start` (with preconditions), suspend (grace), `end_session`, crash-recovery.
- The **transport-relevant Redis state** only: `:state` (participants/mode/status), `:seq`, `:connections` — plus 5-min checkpointing.

**Out (→ MYT-66 and later):**
- The distributed lock + `dm_responding` (MYT-66 SessionController).
- The DM turn pipeline entirely — no `dm_thinking`/`text_delta`/`turn_end`. MYT-65 messages are player chat + system events only.
- LLM-tier Redis keys: `ft_history`, `summary` (MYT-66/69); `combat` (MYT-75). `usage` already exists via `session_usage`/`recordUsage`.
- Post-session analysis / handoff / wiki / transcript search (MYT-74).

## Decided approach

| Decision | Choice | Rationale |
|----------|--------|-----------|
| WS library | **`@fastify/websocket`** | Idiomatic for the all-Fastify backend; a route preHandler consumes the ticket + re-checks membership and **rejects pre-upgrade** (handshake-time auth); composes with existing hooks + `createShutdown` ordering. Uses `ws` under the hood. |
| Connection hub | **WS-specific `SessionHub`, modeled on `pipeline-subscriber.ts`** | Mirror the proven cross-container fan-out shape; don't prematurely DRY it (WS needs a writable per-user registry + inbound dispatch SSE lacks). |
| Message ordering | **Persist-then-broadcast** | A message is durable before any client sees it → reconnection replay (`GET afterSeq` from the DB) is always complete. One Postgres INSERT per persisted message; negligible at human chat rate (no DM streaming in MYT-65). |
| Suspend timer | **BullMQ delayed job** | Reuses existing BullMQ infra; durable if the scheduling container dies; cancelled/rescheduled on reconnect. |

## Components (new / changed)

- **`contract/session-events.ts`** *(new)* — WS wire contract. Server→client + client→server discriminated unions + string allowlists, mirroring `contract/pipeline-events.ts` (same classify-tripwire). MYT-65 subset only: `player_message`, `player_joined`, `player_left`, `typing_start`, `typing_stop`, `session_ready`, `session_reconnect`, `error`. (DM-turn event types are added by MYT-66+.)
- **`ws/session-hub.ts`** *(new)* — the `SessionHub`: a dedicated `redisRealtime.duplicate()` subscriber on `${prefix}session:campaign:*`; a `Map<campaignId, Map<userId, WebSocket>>` registry; `broadcast(campaignId, frame)`; add/remove connection; the cross-container `connections` counter; inbound dispatch. Mirrors `pipeline-subscriber.ts` including its redis-reconnect resync (`redis-resync-required`). Decorated on the Fastify instance in `buildApp`; closed inside `createShutdown` via an `if (app.<hub>)` check — the `mythrunProseSubscriber` decoration pattern (`app.ts:469`), **not** added to the fixed `ShutdownClients` struct (which is constructed at two `server.ts` call sites + the stub path).
- **`routes/ws-session.ts`** *(new)* — `GET /ws/session/:sessionId` via `@fastify/websocket`. preHandler: `consumeWsTicket` (atomic GETDEL) → `repo.campaigns.getMembership` re-check → session `active`? → reject pre-upgrade (401/403/404). Handler: register socket in the hub, `INCR connections`, refresh TTLs, broadcast `player_joined`, send `session_ready` — or `session_reconnect` (replay `session_messages` after `lastSeq`) when `?lastSeq=` is present. Wires ping/pong (30s/10s) and the close handler.
- **`repo/session-messages.ts` + `repo/session-participants.ts`** *(new)* — `xxxNs(ClientLike)` binders following `repo/sessions.ts`: messages `append` + `listAfterSeq`; participants `join`/`leave`/`list`. Registered in `repo/index.ts`'s `bindTx` so they serve both `repo.*` and `tx.*`. Types in `repo/types.ts`.
- **`routes/sessions.ts`** *(extend)* — add `POST /:campaignId/start` (preconditions: member, campaign `active`, session prep exists for next number, no active session, **atomic credit debit** on the owner → `sessionsNs.create` + init Redis state → `{ sessionId }`), `GET /:campaignId/active`, `GET /:sessionId/messages?afterSeq=N` (replay backfill). The `ws-ticket` mint route already exists here.
- **`redis/session-state.ts`** *(new)* — helpers for the MYT-65 Redis keys (`:state`, `:seq`, `:connections`), TTL refresh, and the 5-min checkpoint to Postgres.

## Data flow

- **Connect:** `POST /ws-ticket` (exists) → `wss://…/ws/session/:id?ticket=<nonce>&lastSeq=<N>` → preHandler validates (reject pre-upgrade on failure) → upgrade → register in hub registry, `INCR :connections`, refresh TTLs, broadcast `player_joined`, send `session_ready` (or `session_reconnect` with messages after `lastSeq`).
- **Inbound message:** `player_message` → `INCR :seq` → INSERT `session_messages` → `publish session:campaign:{id}` → hub fans out to every container's registry → clients render in seq order (200ms gap buffer → REST backfill via `GET …/messages?afterSeq`). `typing_*` broadcasts without persisting.
- **Disconnect:** close → remove from registry → `DECR :connections` → broadcast `player_left` → drop the local campaign entry if empty → if global `:connections == 0`, schedule the suspend check (BullMQ delayed job, 5-min).

## Lifecycle

- **Start:** preconditions above → create `sessions` row (`status='active'`) → init Redis `:state`/`:seq`/`:connections` → return `{ sessionId }`.
- **Suspend:** all-disconnected → 5-min grace (BullMQ delayed job; reconnect cancels it) → on fire, if still 0: flush Redis state to a Postgres checkpoint, keep `status='active'`, hold Redis keys ~1hr.
- **End** (`end_session` WS frame): flush → `status='ended'`, `ended_at=now()` → clean Redis keys → broadcast `session_end`. **No post-session analysis** (MYT-74).
- **Crash recovery:** session stays `active` in Postgres; next connect cold-starts from the latest checkpoint + `session_messages`.

## Redis state (MYT-65 subset)

| Key | Content |
|-----|---------|
| `session:{cId}:state` | participants, mode, status |
| `session:{cId}:seq` | monotonic sequence counter (`INCR`) |
| `session:{cId}:connections` | connected-client count across all containers |

TTLs refreshed on every interaction; state + (already-durable) transcript checkpointed every 5 min. `ft_history` / `summary` / `combat` / `lock` are **not** created here.

## Reuse map (already built — do not rebuild)

- **Ticket auth:** `auth/ws-ticket.ts` (`consumeWsTicket` / `mintWsTicket`); mint route `routes/sessions.ts`.
- **Pub/sub fan-out blueprint:** `sse/pipeline-subscriber.ts` (dedicated duplicate client, `Map<id, Set<sink>>`, reconnect-resync) + `worker/publishers.ts` (channel-naming convention).
- **Schema:** `migrations/001_initial_schema.sql` — `sessions`, `session_messages`, `session_participants`, `session_usage`, one-active-session index.
- **Repo pattern:** `repo/sessions.ts` (`sessionsNs`) + `repo/index.ts` (`bindTx`).
- **Redis clients / env / boot:** `redis/client.ts`, `config/env.ts`, `server.ts` (`waitFor` boot probes), `app.ts` (`buildApp` / `createShutdown`).

## Error handling

- Invalid / expired / consumed ticket → preHandler 401, **no socket opens**.
- Dead connection → ping/pong (30s ping, 10s pong window) → cleanup.
- Redis subscriber disconnect → on reconnect, close sockets with a resync signal (mirror SSE's `redis-resync-required`) → clients reconnect + replay.
- Partial Redis state on reconnect → rebuild from the Postgres checkpoint + `session_messages`.

## Testing

- **`ioredis-mock`** (per `auth/__tests__/ws-ticket.test.ts`) for hub-registry logic + ticket consume.
- **Real-Redis duplicate** (per `sse/__tests__/pipeline-subscriber.test.ts`, unique key prefix per run) for cross-client pub/sub fan-out.
- **Integration:** drive **two WS clients** through connect → ordered exchange → one disconnects/reconnects → `session_reconnect` replays from `lastSeq`.
- **`createTestPool`** for the `session_messages` / `session_participants` repo binders + the `/start` preconditions.

## Hardening decisions (round-1 blind review — Rivers)

A 3-lens blind review (distributed-correctness, enforced-ignorance/auth-billing, reuse-fidelity/scope) found **no showstoppers** but surfaced implementation specifics worth pinning before the plan. Resolutions:

**Sequencing durability.**
- New migration: `CREATE UNIQUE INDEX … ON session_messages(session_id, seq)` (the existing `idx_session_messages_session_seq` is non-unique). A re-used seq then fails loudly (caught → re-`INCR`) instead of silently corrupting replay.
- On any Redis `:seq` rebuild (crash recovery, eviction) seed it from `MAX(seq)` in `session_messages`, never the checkpoint blob. The 5-min checkpoint records `MAX(session_messages.seq)`, not the raw counter (which sits one ahead between `INCR` and INSERT).
- Reconnect ordering: subscribe to pub/sub **first** → then read `session_messages` after `lastSeq` → let client seq-dedup drop the overlap (not read-then-subscribe, which drops the gap).

**Connections counter + suspend (crash-safe).**
- `:connections` is **not** a bare `INCR`/`DECR` integer — a container crash skips `close` handlers (leak → never suspends), a double-`DECR` goes negative (also never suspends). Model it as **per-connection presence keys with TTL** (e.g. `session:{cId}:conn:{containerId}:{userId}`, refreshed on ping), counted/reaped by expiry so a dead container's presences lapse automatically. Disambiguate from the existing process-scoped `connection-counter.ts` (observability only — do NOT wire suspend to it).
- The suspend BullMQ job is **idempotent and self-validating**: on fire, re-read live presence and suspend only if genuinely zero. This neutralizes both the counter-leak and the BullMQ jobId-dedup footgun (`server-queues.ts:29-32` — a re-`add` with a live jobId silently no-ops). Define the per-session jobId scheme + this queue's `removeOnComplete` policy; never treat "reconnect cancelled it" as atomic.

**`/start` billing atomicity** (the debit helper `tryDebitForSession` is its own pool-managed transaction — it cannot compose into a tx with `create`; cf. `reference_transaction_scope_just_writes`):
- Order: **generate sessionId (uuidv7) → INSERT the `sessions` row → debit with that sessionId as the idempotency `sourceId` → init Redis state.** `idx_sessions_one_active` is the **enforcing** guard for one-active-session-per-campaign — catch its unique-violation and map it (not a 500), which also closes the two-concurrent-`/start` race.
- Orphan-debit recovery: a crash between INSERT and debit, or a retried `/start`, is recovered via the idempotency key + an active-session pre-check before debiting on retry. Pin the exact recovery in the plan.

**Auth binding** (the WS route is `auth: 'public'` — it does NOT inherit `requireCampaignMember`):
- preHandler asserts `ticket.payload.sessionId === request.params.sessionId`, and derives `campaignId` from the **loaded session row** (single source) for both the membership check and the hub key — never trust the ticket's claimed campaignId against a different URL session.
- Membership re-check replicates `requireCampaignMember` exactly: `member?.inviteAccepted === true`, not merely `getMembership(...) != null` (a pending invite is not a member).
- Hub registry + channel key on that derived `campaignId` (sessionId→campaignId is 1:1 via `idx_sessions_one_active`); route/REST paths key on `:sessionId`.

**`session_participants` rows:** `character_id` is `NOT NULL REFERENCES characters(id)`. On WS join, resolve the joiner's character via `repo.characters` (campaign + user; the campaign is `active`, so characters are integrated) and write it. `player_joined`/`player_left` are broadcast-only system events — **not** persisted to `session_messages`, so absent from reconnect replay (intended).

**New dependency:** `@fastify/websocket` is not in `package.json` — add it, version-matched to Fastify ^5.1 (the v11 major), and confirm at implementation that its `preHandler`/`preValidation` rejects pre-upgrade with a non-101 (the auth gate depends on this).

**Resync teardown:** the SessionHub mirrors `pipeline-subscriber`'s `redis-resync-required` behavior, but for **writable WS sockets** — close the socket with a resync reason so the client reconnects + replays from `lastSeq` (a different teardown than closing a read-only SSE sink).

**Message-type allowlist:** only the MYT-65 client→server subset may originate a persisted/broadcast frame; persisted `message_type` values draw from that allowlist (today only `player_message` persists), so MYT-66's later DM events don't retroactively widen what MYT-65 wrote. Typing frames carry **no** `seq` (clients must not advance `lastSeenSeq` on them).

## Done when

Two clients connect, chat with server-assigned ordering, and a reconnect replays cleanly from `lastSeq` — with the DM entirely absent. `pnpm typecheck` + `pnpm lint` + `pnpm test` green; the real-Redis pub/sub + two-client integration tests pass.
