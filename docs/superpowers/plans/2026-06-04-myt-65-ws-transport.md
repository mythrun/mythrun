# MYT-65 — Multiplayer WS Transport, Session Lifecycle & Redis State — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (this repo's flow is plan → beads → subagent-driven). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two clients connect to a session over WebSocket and exchange server-ordered, replayable messages; a reconnect replays cleanly from `lastSeq`. The DM loop is entirely absent (MYT-66+).

**Architecture:** A new `@fastify/websocket` route authenticates via the existing single-use ws-ticket, registers the socket in a WS-specific `SessionHub` (modeled on the SSE `pipeline-subscriber`: a dedicated Redis subscriber on `session:campaign:*` + a `Map<campaignId, Map<userId, WebSocket>>` registry). Inbound `player_message` is sequenced (`INCR`), persisted to `session_messages` (persist-then-broadcast), then published for cross-container fan-out. Session lifecycle (`/start`, suspend, end, crash-recovery) lives in `routes/sessions.ts` + a BullMQ delayed suspend job. Only the transport-relevant Redis keys are created here.

**Tech Stack:** Fastify 5 + `@fastify/websocket` (new dep), ioredis (pub/sub), BullMQ (suspend job), Postgres (`pg` + the repo binder pattern), Vitest. Design + hardening: `docs/superpowers/specs/2026-06-04-myt-65-ws-transport-design.md`.

---

## File structure

**New files:**
- `backend/migrations/023_session_messages_unique_seq.sql` — `UNIQUE(session_id, seq)`.
- `backend/src/contract/session-events.ts` — WS wire contract (client→server + server→client unions, allowlists, classify tripwire).
- `backend/src/repo/session-messages.ts` — `sessionMessagesNs(c)`: `append`, `listAfterSeq`.
- `backend/src/repo/session-participants.ts` — `sessionParticipantsNs(c)`: `join`, `leave`, `list`.
- `backend/src/redis/session-state.ts` — seq (`INCR` + reseed-from-`MAX`), `:state`, TTL-presence (`addPresence`/`dropPresence`/`countPresence`), checkpoint helpers.
- `backend/src/ws/session-hub.ts` — `SessionHub` (subscriber + registry + `broadcast` + presence + inbound dispatch + resync-close).
- `backend/src/routes/ws-session.ts` — the `@fastify/websocket` route + preHandler.
- `backend/src/session/session-suspend.ts` — suspend queue name + schedule/cancel + idempotent processor.
- Tests colocated under each dir's `__tests__/`.

**Modified files:**
- `backend/package.json` — add `@fastify/websocket@^11`.
- `backend/src/repo/types.ts` — `SessionMessage`, `SessionParticipant`, input types.
- `backend/src/repo/index.ts` — register both binders in `bindTx`.
- `backend/src/routes/sessions.ts` — add `POST /:campaignId/start`, `GET /:campaignId/active`, `GET /:sessionId/messages`.
- `backend/src/server-queues.ts` — add the `session-suspend` queue.
- `backend/src/app.ts` — register the WS route, decorate the hub, close it in `createShutdown` (decoration pattern, like `mythrunProseSubscriber`).
- `backend/src/server.ts` — build the hub + the suspend worker; thread into `buildApp` + shutdown.

Dependency order: `1 → 2 → {3,4} → 5 → 6 → 7 → 8 → 9 → 10 → 11`. Each task ends green (`pnpm --filter @mythrun/backend test <file>`) and commits.

---

## Task 1: Add the WS dependency + the unique-seq migration

**Files:**
- Modify: `backend/package.json`
- Create: `backend/migrations/023_session_messages_unique_seq.sql`

- [ ] **Step 1: Add the dependency.** Add `"@fastify/websocket": "^11.0.0"` to `backend/package.json` dependencies (the v11 major targets Fastify ^5). Run `pnpm install`. Verify the resolved version supports Fastify 5 (`pnpm --filter @mythrun/backend why @fastify/websocket`).
- [ ] **Step 2: Write the migration.** `backend/migrations/023_session_messages_unique_seq.sql`:
  ```sql
  -- A re-used seq must fail loudly (caught -> re-INCR), never silently corrupt replay.
  CREATE UNIQUE INDEX idx_session_messages_session_seq_unique
    ON session_messages (session_id, seq);
  ```
  (The existing non-unique `idx_session_messages_session_seq` in `002_indexes.sql` can stay — the unique one supersedes it for lookups; optionally drop the old one in the same file.)
- [ ] **Step 3: Apply + verify.** `pnpm --filter @mythrun/backend db:migrate:test` then confirm with `\d session_messages` (psql against `mythrun_test`) that the unique index exists. The migration runner globs `backend/migrations/*.sql` (`db/migrate.ts`).
- [ ] **Step 4: Commit.** `git add backend/package.json backend/pnpm-lock.yaml backend/migrations/023_session_messages_unique_seq.sql && git commit -m "feat(MYT-65): add @fastify/websocket + UNIQUE(session_id,seq) migration"`

---

## Task 2: WS wire contract (`session-events.ts`)

**Files:**
- Create: `backend/src/contract/session-events.ts`
- Test: `backend/src/contract/__tests__/session-events.test.ts`

Mirror `contract/pipeline-events.ts`: a `readonly string[]` allowlist + a discriminated union + a `classify*` tripwire. Two directions.

- [ ] **Step 1: Failing test.**
  ```ts
  import { describe, it, expect } from 'vitest'
  import { CLIENT_FRAME_TYPES, SERVER_FRAME_TYPES, classifyClientFrame } from '../session-events.js'

  describe('session-events contract', () => {
    it('client frames are the MYT-65 subset only (no DM-turn types)', () => {
      expect(CLIENT_FRAME_TYPES).toEqual(['player_message', 'typing_start', 'typing_stop'])
      expect(CLIENT_FRAME_TYPES).not.toContain('dm_invoke') // MYT-66+
    })
    it('server frames include join/left/ready/reconnect, not text_delta', () => {
      expect(SERVER_FRAME_TYPES).toContain('session_reconnect')
      expect(SERVER_FRAME_TYPES).not.toContain('text_delta') // MYT-66+
    })
    it('classifyClientFrame rejects unknown/DM types', () => {
      expect(classifyClientFrame('player_message')).toBe(true)
      expect(classifyClientFrame('dm_invoke')).toBe(false)
      expect(classifyClientFrame('garbage')).toBe(false)
    })
  })
  ```
- [ ] **Step 2: Run → FAIL** (`pnpm --filter @mythrun/backend test session-events` → module not found).
- [ ] **Step 3: Implement.** Define `CLIENT_FRAME_TYPES = ['player_message','typing_start','typing_stop'] as const` and `SERVER_FRAME_TYPES = ['session_ready','session_reconnect','player_joined','player_left','player_message','typing_start','typing_stop','error'] as const`. Export discriminated-union types `ClientFrame` / `ServerFrame` (each variant a `{ type: ... }` object — `player_message` carries `text`; server `player_message` adds `seq,userId,displayName,characterName`; `session_reconnect` carries `messages[],participants[],mode`). `classifyClientFrame(t: string): boolean` = `(CLIENT_FRAME_TYPES as readonly string[]).includes(t)`. **Only these client types may originate a persisted/broadcast frame** (the allowlist is the tripwire — comment this, citing `pipeline-events.ts`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `git commit -m "feat(MYT-65): WS wire contract (session-events) with classify tripwire"`

---

## Task 3: `session_messages` repo binder

**Files:**
- Create: `backend/src/repo/session-messages.ts`
- Modify: `backend/src/repo/types.ts`, `backend/src/repo/index.ts`
- Test: `backend/src/repo/__tests__/session-messages.test.ts`

Mirror `repo/sessions.ts` (`sessionsNs(c: ClientLike)` returning methods that capture the client). Register in `bindTx`.

- [ ] **Step 1: Failing test** (uses `createTestPool` + a scoped fixture; create a session row first):
  ```ts
  // append assigns nothing — caller passes seq; listAfterSeq returns ordered rows > afterSeq
  const m1 = await repo.sessionMessages.append({ sessionId, seq: 1, userId, messageType: 'player_message', content: 'hello' })
  await repo.sessionMessages.append({ sessionId, seq: 2, userId, messageType: 'player_message', content: 'world' })
  const after = await repo.sessionMessages.listAfterSeq(sessionId, 1)
  expect(after.map(r => r.seq)).toEqual([2])
  // unique(session_id,seq): a duplicate seq throws (caught upstream -> re-INCR)
  await expect(repo.sessionMessages.append({ sessionId, seq: 2, userId, messageType: 'player_message', content: 'dup' })).rejects.toThrow()
  ```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `sessionMessagesNs(c)`: `append(input)` → `INSERT INTO session_messages (id, session_id, seq, user_id, message_type, content) VALUES (uuidv7(), $1..$5)` returning the row; `listAfterSeq(sessionId, afterSeq)` → `SELECT … WHERE session_id=$1 AND seq>$2 ORDER BY seq ASC`. Add `SessionMessage` + `AppendMessageInput` to `types.ts`. Register `sessionMessages: sessionMessagesNs(c)` in `bindTx` (`repo/index.ts`) so it serves `repo.*` and `tx.*`. Do NOT add a duplicate-seq retry here — the caller (Task 5/7) owns re-INCR on conflict.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `git commit -m "feat(MYT-65): session_messages repo binder (append, listAfterSeq)"`

---

## Task 4: `session_participants` repo binder (with character resolution)

**Files:**
- Create: `backend/src/repo/session-participants.ts`
- Modify: `backend/src/repo/types.ts`, `backend/src/repo/index.ts`
- Test: `backend/src/repo/__tests__/session-participants.test.ts`

**Hardening (Zambezi C1):** `session_participants.character_id` is `NOT NULL REFERENCES characters(id)`. `join` resolves the joiner's character from `repo.characters` (campaign + user); the campaign is `active` so the character is integrated.

- [ ] **Step 1: Failing test** (seed a campaign + an integrated character for `userId`):
  ```ts
  const p = await repo.sessionParticipants.join({ sessionId, campaignId, userId })
  expect(p.characterId).toBe(seededCharacterId)        // resolved, not passed in
  const list = await repo.sessionParticipants.list(sessionId)
  expect(list.map(x => x.userId)).toContain(userId)
  await repo.sessionParticipants.leave(sessionId, userId)
  expect((await repo.sessionParticipants.list(sessionId)).length).toBe(0)
  // joining a user with no character in the campaign throws a typed error (not a raw FK violation)
  await expect(repo.sessionParticipants.join({ sessionId, campaignId, userId: strangerId })).rejects.toThrow(/no character/i)
  ```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `join({sessionId, campaignId, userId})`: look up the character via the existing characters repo (campaign + user) → if none, throw a typed `NoCharacterForParticipantError` (add to `repo/sessions-errors.ts` or a new errors file) → else `INSERT INTO session_participants (id, session_id, user_id, character_id) VALUES (...) ON CONFLICT (session_id, user_id) DO NOTHING RETURNING *` (the table has `UNIQUE(session_id,user_id)`). `leave(sessionId, userId)` → DELETE. `list(sessionId)` → SELECT. Add types + register in `bindTx`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `git commit -m "feat(MYT-65): session_participants binder with character resolution"`

---

## Task 5: Redis session-state helpers (seq, state, presence, checkpoint)

**Files:**
- Create: `backend/src/redis/session-state.ts`
- Test: `backend/src/redis/__tests__/session-state.test.ts` (ioredis-mock for the counter/state logic; real-Redis for nothing here — pure key ops)

**Hardening:** seq reseed-from-`MAX` (Danube C2 / Zambezi I1); **crash-safe TTL presence** instead of a bare counter (Danube C1).

- [ ] **Step 1: Failing test** (ioredis-mock):
  ```ts
  const r = new IoRedisMock()
  const ss = makeSessionState(r, 'test:use1:')
  // seq: monotonic INCR
  expect(await ss.nextSeq(cId)).toBe(1); expect(await ss.nextSeq(cId)).toBe(2)
  // reseed from a known max (crash recovery): seq continues above max, never below
  await ss.reseedSeq(cId, 5); expect(await ss.nextSeq(cId)).toBe(6)
  // presence: add two, count 2; drop one, count 1; TTL set so a dead presence lapses
  await ss.addPresence(cId, 'cont1', 'userA'); await ss.addPresence(cId, 'cont1', 'userB')
  expect(await ss.countPresence(cId)).toBe(2)
  await ss.dropPresence(cId, 'cont1', 'userA'); expect(await ss.countPresence(cId)).toBe(1)
  ```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Keys under `${prefix}session:{cId}:…`. `nextSeq(cId)` = `INCR :seq`. `reseedSeq(cId, max)` = `SET :seq max` only if current `< max` (Lua or GET-then-SET-if-greater) — callers pass `MAX(session_messages.seq)`. `addPresence(cId, containerId, userId)` = `SET :conn:{containerId}:{userId} 1 EX <PRESENCE_TTL=60>` (refreshed on ping); `dropPresence` = `DEL`; `countPresence(cId)` = `SCAN`/`KEYS :conn:*` count (bounded per session — fine; or maintain a per-session presence SET with per-member TTL via a sorted-set of expiries — choose SCAN for simplicity, document it). `getState`/`setState(cId, {participants,mode,status})` = JSON on `:state`. `refreshTtls(cId)` bumps `:state`/`:seq` TTL (2h). `checkpoint(cId, pool)` writes `:state` + `MAX(session_messages.seq)` to the `sessions`/checkpoint row — **never the raw `:seq` counter** (Danube I2).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `git commit -m "feat(MYT-65): redis session-state (seq reseed-from-MAX, TTL presence, checkpoint)"`

---

## Task 6: `SessionHub` (subscriber + registry + broadcast + resync-close)

**Files:**
- Create: `backend/src/ws/session-hub.ts`
- Test: `backend/src/ws/__tests__/session-hub.test.ts` (**real Redis**, per `sse/__tests__/pipeline-subscriber.test.ts` — unique key prefix per run, separate publisher + subscriber clients)

Mirror `sse/pipeline-subscriber.ts`: a dedicated `redisRealtime.duplicate()` client `PSUBSCRIBE ${prefix}session:campaign:*`; `Map<campaignId, Map<userId, WSLike>>` registry; on `pmessage`, fan out to that campaign's local sockets. Add WS-specific bits: `register`/`deregister`, `publish(campaignId, frame)`, and **resync-close** (on the dedicated client's reconnect, close registered sockets with a `redis-resync-required` reason — different teardown than SSE sinks; Danube I4).

- [ ] **Step 1: Failing test** (real Redis; use a `WSLike` stub recording sent frames):
  ```ts
  const hub = await createSessionHub({ redis, keyPrefix })
  const a = fakeSocket(), b = fakeSocket()
  hub.register(campaignId, 'userA', a); hub.register(campaignId, 'userB', b)
  await hub.publish(campaignId, { type: 'player_message', seq: 1, userId: 'userA', text: 'hi' })
  await waitFor(() => a.sent.length === 1 && b.sent.length === 1)   // both local sockets see it via pub/sub round-trip
  expect(b.sent[0]).toMatchObject({ type: 'player_message', seq: 1 })
  hub.deregister(campaignId, 'userA')
  await hub.publish(campaignId, { type: 'player_message', seq: 2, userId: 'userB', text: 'yo' })
  await waitFor(() => b.sent.length === 2 && a.sent.length === 1)   // a no longer receives
  ```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `createSessionHub({redis, keyPrefix})` returns `{ register, deregister, publish, close, hasLocal }`. `publish` = `redis.publish('${prefix}session:campaign:${cId}', JSON.stringify(frame))`. The dedicated subscriber (`redis.duplicate()`) `PSUBSCRIBE`s `${prefix}session:campaign:*`; on `pmessage`, parse campaignId from the channel, look up the local `Map`, `socket.send(payload)` to each. On the subscriber's `'ready'`-after-disconnect, iterate all registered sockets and close them with code 1011 + reason `redis-resync-required` (clients reconnect + replay). `close()` quits the subscriber + clears the registry. Mirror `pipeline-subscriber.ts:55-169` structurally.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `git commit -m "feat(MYT-65): SessionHub (pub/sub fan-out + registry + resync-close)"`

---

## Task 7: WS route + preHandler auth + connect/inbound/disconnect

**Files:**
- Create: `backend/src/routes/ws-session.ts`
- Test: `backend/src/routes/__tests__/ws-session.test.ts` (real Redis + test pool + a real WS client against an ephemeral Fastify instance)

**Hardening (Mekong I3/I4):** preHandler asserts `ticket.sessionId === params.sessionId`; derives `campaignId` from the **loaded session row** (single source); membership re-check uses `member?.inviteAccepted === true`.

- [ ] **Step 1: Failing test.**
  ```ts
  // bad/missing ticket -> upgrade rejected, no socket
  await expect(connect(`/ws/session/${sessionId}?ticket=bogus`)).rejects.toMatchObject({ code: 401 })
  // ticket bound to a DIFFERENT session -> rejected (sessionId binding)
  const t = await mintTicket({ userId, sessionId: otherSessionId, campaignId })
  await expect(connect(`/ws/session/${sessionId}?ticket=${t}`)).rejects.toMatchObject({ code: 401 })
  // valid ticket -> session_ready, player_joined broadcast, presence incremented
  const t2 = await mintTicket({ userId, sessionId, campaignId })
  const ws = await connect(`/ws/session/${sessionId}?ticket=${t2}`)
  expect(await ws.next()).toMatchObject({ type: 'session_ready' })
  expect(await countPresence(campaignId)).toBe(1)
  // inbound player_message -> seq assigned, persisted, echoed in order
  ws.send({ type: 'player_message', text: 'hello' })
  expect(await ws.next()).toMatchObject({ type: 'player_message', seq: 1, text: 'hello' })
  expect((await repo.sessionMessages.listAfterSeq(sessionId, 0)).length).toBe(1)  // persisted BEFORE broadcast
  ```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Register `app.get('/ws/session/:sessionId', { websocket: true, config: { auth: 'public' }, preHandler: [wsSessionAuth] }, handler)`. `wsSessionAuth(req, reply)`: read `?ticket` → `consumeWsTicket` → `null` ⇒ `reply.code(401).send()`; assert `payload.sessionId === req.params.sessionId` (else 401); load the session row (`sessionsNs.getById`) → not found/`!= 'active'` ⇒ 404/409; `getMembership(session.campaignId, payload.userId)` → `!member?.inviteAccepted` ⇒ 403; stash `{ userId: payload.userId, campaignId: session.campaignId }` on `req`. Handler: `addPresence` + `hub.register(campaignId, userId, socket)` + `refreshTtls` + broadcast `player_joined` (via `hub.publish`) + send `session_ready` (or reconnect — Task 8). On inbound: parse + `classifyClientFrame` (drop unknown); for `player_message` → **persist-then-broadcast**: `seq = await nextSeq(cId)` → `sessionMessages.append({...})` (on unique-violation, re-`nextSeq` + retry once) → `hub.publish(cId, {type:'player_message', seq, userId, ...})`; `typing_*` → `hub.publish` with **no seq, no persist**. `ping`/`pong`: 30s ping, terminate on 10s no-pong. `close`: `dropPresence` + `hub.deregister` + broadcast `player_left` + if `countPresence(cId)===0` schedule suspend (Task 10).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `git commit -m "feat(MYT-65): WS route, preHandler auth (ticket binding + inviteAccepted), connect/inbound/disconnect"`

---

## Task 8: Reconnection replay (`session_reconnect`)

**Files:**
- Modify: `backend/src/routes/ws-session.ts`
- Test: extend `ws-session.test.ts`

**Hardening (Danube I3):** ordering is subscribe-first (register in hub) → then read `session_messages` after `lastSeq` → client seq-dedup drops overlap.

- [ ] **Step 1: Failing test.**
  ```ts
  // client saw up to seq 2, drops, reconnects with lastSeq=2 -> replay only seq>2
  // (produce 3 messages, disconnect at lastSeq=2, reconnect)
  const ws2 = await connect(`/ws/session/${sessionId}?ticket=${t3}&lastSeq=2`)
  const first = await ws2.next()
  expect(first.type).toBe('session_reconnect')
  expect(first.messages.map(m => m.seq)).toEqual([3])   // only after lastSeq
  expect(first.participants.map(p => p.userId)).toContain(userId)
  ```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** In the handler, when `?lastSeq` is present: register in the hub FIRST (so live frames queue/arrive), THEN `messages = await sessionMessages.listAfterSeq(sessionId, lastSeq)` + `participants = await sessionParticipants.list(sessionId)` + `mode` from `:state`; send a single `session_reconnect` frame `{ messages, participants, mode }`. The client's existing seq-dedup (parent §12) drops any overlap between the replay batch and a live frame. (No `inFlightResponse` in MYT-65 — no DM stream.)
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `git commit -m "feat(MYT-65): session_reconnect replay (subscribe-first ordering)"`

---

## Task 9: Lifecycle routes — `/start`, `/active`, `/messages`

**Files:**
- Modify: `backend/src/routes/sessions.ts`
- Test: `backend/src/routes/__tests__/sessions-start.test.ts`

**Hardening (Mekong C1/C2, Zambezi I2):** order = **gen sessionId → INSERT session row → debit with sessionId as idempotency sourceId → init Redis**; `idx_sessions_one_active` is the enforcing guard (catch the unique-violation → map to 409, not 500); orphan-debit recovery via the idempotency key + active-session pre-check on retry.

- [ ] **Step 1: Failing test.**
  ```ts
  // happy path: member + active campaign + prep exists + owner has credits -> 200 {sessionId}, one debit
  const res = await app.inject({ method: 'POST', url: `/api/sessions/${campaignId}/start`, headers: authHeaders(owner) })
  expect(res.statusCode).toBe(200); const { sessionId } = res.json()
  expect(await creditBalance(ownerUserId)).toBe(startBalance - 1)
  // second concurrent/duplicate start -> 409 (one-active guard), NO second debit
  const res2 = await app.inject({ method: 'POST', url: `/api/sessions/${campaignId}/start`, headers: authHeaders(owner) })
  expect(res2.statusCode).toBe(409)
  expect(await creditBalance(ownerUserId)).toBe(startBalance - 1)   // not charged twice
  // preconditions: non-member 403; campaign not active 409; no prep 409; no credits 402
  ```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `POST /:campaignId/start` (preHandler `requireCampaignMember`): check campaign `status==='active'` (else 409); check session prep exists for next number (else 409); pre-check no active session (`sessionsNs.getActiveByCampaign` → 409); generate `sessionId = uuidv7()`; `INSERT` the session row inside try/catch — on `idx_sessions_one_active` unique-violation map to 409 (closes the race); then `tryDebitForSession(ownerUserId, sessionId)` (its own pool tx; idempotent on sessionId) — on insufficient credits → delete the just-created session row + 402; then `initState`/`reseedSeq(0)`/presence-zero; return `{ sessionId }`. `GET /:campaignId/active` → active session or `null`. `GET /:sessionId/messages?afterSeq=N` (preHandler member) → `sessionMessages.listAfterSeq`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `git commit -m "feat(MYT-65): session lifecycle routes (/start atomicity, /active, /messages)"`

---

## Task 10: Suspend job (idempotent, self-validating)

**Files:**
- Create: `backend/src/session/session-suspend.ts`
- Modify: `backend/src/server-queues.ts`
- Test: `backend/src/session/__tests__/session-suspend.test.ts`

**Hardening (Danube C1/C3):** the processor **re-reads live presence on fire** and suspends only if genuinely zero — this neutralizes both the counter-leak and the BullMQ jobId-dedup footgun (`server-queues.ts:29-32`). jobId = `suspend:{sessionId}`; reconnect removes it; never treat removal as atomic.

- [ ] **Step 1: Failing test.**
  ```ts
  // schedule, then presence returns >0 on fire -> NO suspend (self-validating)
  await scheduleSuspend(queue, sessionId, campaignId)
  await runDelayedJobNow(queue)  // test helper drains the delayed job
  // with presence still 1, session stays 'active' and Redis keys remain
  expect((await repo.sessions.getById(sessionId)).status).toBe('active')
  // presence == 0 on fire -> flush + keys-held; status stays 'active' (suspend != end)
  await dropAllPresence(campaignId); await scheduleSuspend(...); await runDelayedJobNow(queue)
  expect(await checkpointExists(sessionId)).toBe(true)
  // reschedule with same jobId after a cancel works (no silent no-op)
  await cancelSuspend(queue, sessionId); await scheduleSuspend(queue, sessionId, campaignId)
  expect(await queue.getDelayedCount()).toBe(1)
  ```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Add a `session-suspend` queue in `server-queues.ts` (follow the existing queue setup; set `removeOnComplete`/`removeOnFail` so a `suspend:{sessionId}` jobId can be re-added without dedupe collision — verify against the `server-queues.ts:29-32` note). `scheduleSuspend(queue, sessionId, campaignId)` = `queue.add('suspend', {sessionId, campaignId}, { delay: 5*60_000, jobId: 'suspend:'+sessionId })`; `cancelSuspend` = remove that jobId. Processor: re-read `countPresence(campaignId)` → if `> 0`, return (no-op); else `checkpoint(cId, pool)` + leave `status='active'` + refresh Redis TTL to ~1h. (End — status `ended` — is the `end_session` path in Task 7's close/an explicit frame; suspend ≠ end.)
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `git commit -m "feat(MYT-65): idempotent self-validating suspend job"`

---

## Task 11: Wiring + end-to-end integration

**Files:**
- Modify: `backend/src/app.ts`, `backend/src/server.ts`
- Test: `backend/src/routes/__tests__/ws-session.integration.test.ts`

**Hardening (Zambezi C2):** decorate the hub on the instance + close it via `if (app.<hub>)` inside `createShutdown` (the `mythrunProseSubscriber` pattern), NOT the fixed `ShutdownClients` struct.

- [ ] **Step 1: Failing integration test** — the issue's "done when": start a session, **two** WS clients connect, exchange messages (assert both see server-assigned seq order), one disconnects + reconnects with `lastSeq` (assert `session_reconnect` replays only newer messages), and assert `session_messages` rows + presence are consistent. Real Redis + test pool.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement wiring.** In `buildApp`: `await app.register(fastifyWebsocket)`; construct the `SessionHub`; `app.decorate('mythrunSessionHub', hub)` (+ module augmentation); `await app.register(wsSessionRoutes, { hub, repo, redisRealtime, ... })`. In `createShutdown`: add `if (app.mythrunSessionHub) await app.mythrunSessionHub.close()` before `app.close()`. In `server.ts main`: build the suspend worker (own `createBullmqRedisClient` + `waitFor`, like the prep worker) and thread shutdown. Confirm boot probes unchanged.
- [ ] **Step 4: Run → PASS** + full gate: `pnpm --filter @mythrun/backend typecheck && pnpm --filter @mythrun/backend lint && pnpm --filter @mythrun/backend test`.
- [ ] **Step 5: Commit.** `git commit -m "feat(MYT-65): wire WS route + SessionHub + suspend worker; two-client integration"`

---

## Self-review

- **Spec coverage:** transport (T6/T7), sequencing (T5/T7), persistence (T3/T7), reconnection (T8), lifecycle/start (T9), suspend (T10), Redis-state subset (T5), contract (T2), wiring (T11). Hardening: unique-seq (T1/T3), seq-from-MAX (T5), TTL presence + self-validating suspend (T5/T10), `/start` atomicity (T9), ticket binding + inviteAccepted (T7), participants character_id (T4), `@fastify/websocket` dep (T1), createShutdown decoration (T11), resync-close (T6), no-seq typing + allowlist (T2/T7). All covered.
- **Out-of-scope honored:** no `ft_history`/`summary`/`combat`/lock; no DM-turn frames; no post-session analysis.
- **Type consistency:** `nextSeq`/`reseedSeq`/`countPresence`/`addPresence`/`dropPresence` (T5) used consistently in T7/T9/T10; `sessionMessages.append`/`listAfterSeq` (T3) in T7/T8/T9; `hub.register`/`deregister`/`publish`/`close` (T6) in T7/T11.

## Execution handoff

Per this repo's flow, the next step is **decompose into beads** (`bd create` one bead per task, `bd dep` per the dependency order `1 → 2 → {3,4} → 5 → 6 → 7 → 8 → 9 → 10 → 11`), then **superpowers:subagent-driven-development** with the controller staging+committing each task serially after the two-stage review. Tasks 3 and 4 are the only parallelizable pair (independent files).
