// backend/src/routes/ws-session.ts
/* eslint-disable max-lines -- The full WS connection lifecycle (pre-upgrade
 * auth handshake, connect + reconnect-replay, heartbeat, per-frame inbound
 * routing, disconnect cleanup) lives in one plugin module by design: one
 * registration site, shared module-scope helpers (ConnCtx, persistMessage,
 * parseClientFrame) and a single error-boundary contract. MYT-67 added the
 * inbound DM-trigger branching; the heavier trigger ACTIONS were extracted to
 * ws-trigger-actions.ts, but the per-frame branch logic + the WsSessionDeps
 * surface are the route's irreducible core. Mirrors billing.ts / campaigns.ts. */
//
// MYT-65 Task 7 — the multiplayer WebSocket session transport route.
//
//   GET /ws/session/:sessionId  (websocket upgrade)
//
// This is the ENFORCED-IGNORANCE BOUNDARY'S ENTRY POINT: the `wsSessionAuth`
// preHandler is the only thing standing between an unauthenticated socket and
// the live session's pub/sub fan-out. It runs BEFORE the upgrade completes
// (@fastify/websocket v11 invokes preHandler pre-upgrade), so any
// `reply.code(...).send()` it issues rejects the handshake with NO socket
// opening. The handshake validates the single-use ws-ticket, binds it to the
// path's sessionId, loads the (active) session row, and re-checks campaign
// membership — the campaignId the handler trusts comes from the LOADED SESSION
// ROW, never the ticket's claimed value (design spec §"Hardening": never trust
// the ticket's claimed campaignId against a different URL session).
//
// On connect the handler: resolves + writes the participant row, records
// presence, registers the socket with the SessionHub, cancels any pending
// suspend, broadcasts `player_joined`, and sends `session_ready`.
// (session_reconnect / lastSeq replay is Task 8 — not implemented here.)
//
// Inbound chat is PERSIST-THEN-BROADCAST: a server-assigned monotonic `seq`
// (Redis INCR), an append to `session_messages`, then a fan-out via the hub.
// A unique-violation on the (session_id, seq) index (a reseed race) triggers
// ONE re-INCR + retry. `typing_*` frames broadcast with no seq, no persist.
//
// On the LAST player's disconnect the handler schedules a delayed suspend
// (Task 10's BullMQ producer); a returning player cancels it on connect.
//
// This plugin defines its deps interface + the route; Task 11 passes the real
// instances and registers it into the app. It is NOT wired into app.ts here.
//
// Spec: docs/superpowers/specs/2026-06-04-myt-65-ws-transport-design.md

import { randomUUID } from 'node:crypto'
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify'
import type { Redis } from 'ioredis'
import type { Repo } from '../repo/index.js'
import { isSeqUniqueViolation } from '../repo/session-messages.js'
import { NoCharacterForParticipantError } from '../repo/session-participants-errors.js'
import type { CombatStateBlob, SessionState } from '../redis/session-state.js'
import type { SessionHub } from '../ws/session-hub.js'
import type { SuspendQueueLike } from '../session/session-suspend.js'
import type { TriggerState } from '../session/trigger-state.js'
import type { TurnPublisher } from '../session/turn-publisher.js'
import type { DmTriggerQueueLike } from '../session/dm-trigger-queue.js'
import type { TurnQueueLike } from '../session/turn-queue.js'
import type { ReconcileQueueLike } from '../session/session-reconcile.js'
import type { SessionLock } from '../session/session-lock.js'
import { consumeWsTicket } from '../auth/ws-ticket.js'
import { scheduleSuspend, cancelSuspend } from '../session/session-suspend.js'
import { endSession } from '../session/session-end.js'
import { resolveWorldId } from '../session/turn-context.js'
import { DEPARTED_AUTHOR_NAME } from '../session/attribution.js'
import { rowToReplayFrame } from '../session/replay-frames.js'
import {
  isExplicitText,
  rescheduleQuietWindow,
  runExplicitTrigger,
} from './ws-trigger-actions.js'
import {
  classifyClientFrame,
  type ClientFrame,
  type ParticipantSummary,
  type ServerFrame,
  type SessionProgress,
} from '../contract/session-events.js'

/** The raw inbound-message payload `ws` hands the 'message' listener. `ws`
 *  isn't a direct dependency of this package (it's the @fastify/websocket
 *  peer), so — like session-hub.ts's `WSLike` — we model the subset we use
 *  rather than importing the `ws` types. This matches `ws`'s `RawData`. */
type WsRawData = Buffer | ArrayBuffer | Buffer[]

/**
 * The subset of the `ws` WebSocket the connection handler uses. The real
 * @fastify/websocket socket satisfies this structurally; modeling it locally
 * (rather than importing `ws`) mirrors session-hub.ts's `WSLike` and keeps the
 * package free of a direct `ws` dependency. Extends `WSLike`'s send/close with
 * the heartbeat surface (`ping`/`terminate`) + the event listeners this route
 * binds. Assignable to `WSLike` (send + close) for `hub.register`.
 */
interface WsSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate(): void
  ping(): void
  on(event: 'message', listener: (data: WsRawData) => void): void
  on(event: 'pong' | 'close', listener: () => void): void
}

/** Dependencies the route composes. Task 11 supplies the real instances. */
export interface WsSessionDeps {
  readonly repo: Repo
  readonly sessionState: SessionState
  readonly hub: SessionHub
  readonly suspendQueue: SuspendQueueLike
  /** This API process's container identity — keys the per-connection presence
   *  key so a crashed container's presence lapses via TTL (crash-safe). */
  readonly containerId: string
  /** The realtime Redis client — the ws-ticket store lives on this client.
   *  Mirrors routes/sessions.ts (the MINT side), whose `consumeWsTicket`
   *  counterpart (`mintWsTicket`) takes the same `redisRealtime`. The minimal
   *  deps list in the task is augmented here because the ticket CONSUME can't
   *  function without it; sessionState/hub encapsulate their own clients and
   *  don't expose one. */
  readonly redisRealtime: Redis
  /** Per-environment+region key prefix (trailing colon). The route appends the
   *  `ws:ticket:` sub-prefix to address the ticket store — identical to the
   *  mint route's `${redisKeyPrefix}ws:ticket:` keying. */
  readonly redisKeyPrefix: string
  /** MYT-67 §4.2: the DM-trigger debounce producer. On any inbound activity
   *  (typing heartbeat / player_message in the auto+solo path) the inbound
   *  handler reschedules the per-campaign quiet-window debounce on this queue —
   *  after the message is persisted+broadcast, so a reschedule failure never
   *  loses the message (it logs at WARN, doesn't throw). */
  readonly dmTriggerQueue: DmTriggerQueueLike
  /** MYT-67 §4.5: the session-turn producer. The EXPLICIT path (`@dm` /
   *  `dm_invoke`) enqueues a turn DIRECTLY here, bypassing the dm-trigger
   *  debounce queue — the summon ices out the room and fires immediately. */
  readonly sessionTurnQueue: TurnQueueLike
  /** MYT-67: all the DM-trigger Redis state (typing keys, last-activity,
   *  first-unresponded anchor, responded-seq watermark, dm_responding flag,
   *  explicit-pending flag). The inbound handler writes the activity/typing
   *  keys and reads the watermark + responding flag on the explicit path. */
  readonly triggerState: TriggerState
  /** MYT-67 §4.5: the cross-process turn-frame publisher. The EXPLICIT path
   *  broadcasts `dm_thinking{turnId}` IMMEDIATELY (before any enqueue/lock
   *  latency) so every client greys its input the instant the summon lands. */
  readonly turnPublisher: TurnPublisher
  /** MYT-74a T11: the end-of-session reconcile producer. The `end_session` frame
   *  (and T12's budget auto-end) fires the T10 reconcile worker through this —
   *  `enqueueReconcile` uses a per-session jobId so a double-trigger collapses to
   *  one job. Typed as the minimal ReconcileQueueLike (add only); the raw BullMQ
   *  Queue is closed at shutdown in server.ts. */
  readonly reconcileQueue: ReconcileQueueLike
  /** MYT-74a T11: the per-session distributed lock. The end flow acquires it to
   *  QUIESCE the in-flight turn (fence the final render) before flipping the row
   *  to 'ended'. The SAME lock the turn worker (MYT-66) + the reconcile worker
   *  (MYT-74a T10) coordinate on, constructed over the realtime Redis. */
  readonly lock: SessionLock
}

/** Heartbeat: ping every 30s; a socket that hasn't ponged 10s after a ping is
 *  terminated (a dead peer that stopped reading). */
const PING_INTERVAL_MS = 30_000
const PONG_GRACE_MS = 10_000

/** WS close code for a server-initiated heartbeat-timeout / defensive close.
 *  1011 = internal error / unexpected condition; the client reconnects + replays. */
const SERVER_CLOSE_CODE = 1011

/** myth-mnik3: a TYPED, EXPECTED connect rejection — the member has no integrated
 *  character in this campaign (NoCharacterForParticipantError). Closed with a
 *  private-range code (4000-4999, app-defined per RFC 6455) + a machine-readable
 *  reason so the client renders "you don't have a character in this campaign yet"
 *  instead of treating a generic 1011 connect-failed as ambient quiet. Distinct
 *  from SERVER_CLOSE_CODE, which every OTHER connect failure keeps. */
const NO_CHARACTER_CLOSE_CODE = 4404
const NO_CHARACTER_CLOSE_REASON = 'no_character'

/** Max chars of a player_message `text` we persist + broadcast. This is
 *  UNTRUSTED CLIENT INPUT (stored in session_messages.content, fanned out to
 *  every peer) — a transport-layer sanity cap, distinct from the LLM-prose
 *  "no max on generated output" rule. A few KB is generous for chat. An
 *  oversized `text` is dropped (logged) at parse time. */
const MAX_MESSAGE_TEXT_LEN = 4_000

/** Hard byte ceiling on any inbound WS frame. `maxPayload` is a SERVER-level
 *  `ws` option set when `@fastify/websocket` is registered — which Task 11 owns
 *  (this plugin doesn't register the WS plugin), so this constant is EXPORTED
 *  for Task 11 to pass as `app.register(websocket, { options: { maxPayload:
 *  WS_MAX_PAYLOAD_BYTES } })`. It's the library-level first line of defense
 *  (oversized frame rejected before our handler runs); the per-message `text`
 *  cap below (MAX_MESSAGE_TEXT_LEN) is the in-handler defense that holds
 *  regardless of how the WS plugin was registered. Sized above
 *  MAX_MESSAGE_TEXT_LEN to leave room for the JSON envelope + multibyte UTF-8. */
export const WS_MAX_PAYLOAD_BYTES = 16 * 1024

declare module 'fastify' {
  interface FastifyRequest {
    /** Stashed by `wsSessionAuth` for the websocket handler. `campaignId` is
     *  the LOADED-SESSION-ROW value (the single source of truth), never the
     *  ticket's claimed value. Optional because only the ws route sets it. */
    wsSessionAuth?: { userId: string; campaignId: string }
  }
}

// FastifyPluginAsync requires an async shape; the body registers routes
// synchronously (no top-level await), matching routes/sessions.ts.
// eslint-disable-next-line @typescript-eslint/require-await
export const wsSessionRoutes: FastifyPluginAsync<WsSessionDeps> = async (app, deps) => {
  // The connection lifecycle helpers (handleConnection / heartbeat / inbound /
  // disconnect) live at module scope and take this context, so the plugin body
  // stays thin (preHandler + route registration) — mirrors routes/sessions.ts
  // extracting handleSessionStart out of its plugin shell.
  const ctx: ConnCtx = { app, deps }

  app.get<{ Params: { sessionId: string }; Querystring: { ticket?: string; lastSeq?: string } }>(
    '/ws/session/:sessionId',
    {
      websocket: true,
      config: { auth: 'public' },
      preHandler: [(request, reply) => wsSessionAuth(deps, request, reply)],
    },
    (socket, request) => {
      // The preHandler stashed auth; if it's somehow absent the upgrade should
      // never have completed. Defensive close (post-upgrade we can't issue an
      // HTTP reply) rather than a throw.
      const auth = request.wsSessionAuth
      /* c8 ignore start — unreachable: wsSessionAuth either rejects pre-upgrade
         or sets request.wsSessionAuth. Keeps the type narrow. */
      if (!auth) {
        socket.close(SERVER_CLOSE_CODE, 'auth-missing')
        return
      }
      /* c8 ignore stop */
      // handleConnection self-guards (its own try/catch closes the socket on a
      // connect failure). The outer .catch is a belt-and-suspenders net so NO
      // rejection from the void-dispatched async handler can float up to the
      // process-level unhandledRejection handler (which escalates to
      // process.exit on the API container) — see boot/process-error-handlers.
      void handleConnection(
        ctx,
        socket,
        auth.userId,
        auth.campaignId,
        request.params.sessionId,
        parseLastSeq(request.query.lastSeq),
      ).catch((err: unknown) => {
        app.log.error({ err }, 'ws-session handleConnection escaped its own guard')
        try {
          socket.close(SERVER_CLOSE_CODE, 'connect-failed')
        } catch {
          /* socket already torn down — nothing more to do */
        }
      })
    },
  )
}

/** Shared context the module-scope connection helpers close over. */
interface ConnCtx {
  readonly app: FastifyInstance
  readonly deps: WsSessionDeps
}

/**
 * Pre-upgrade auth handshake. Runs as a preHandler — BEFORE @fastify/websocket
 * completes the upgrade — so a `reply.code(...).send()` here rejects the
 * handshake with no socket. Every failure mode returns a typed code body.
 */
async function wsSessionAuth(
  deps: WsSessionDeps,
  request: FastifyRequest<{ Params: { sessionId: string }; Querystring: { ticket?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const { repo } = deps
  const ticketKeyPrefix = `${deps.redisKeyPrefix}ws:ticket:`
  const ticket = request.query.ticket
  // 1. No ticket → 401. Empty string is treated as absent.
  if (!ticket) {
    await reply.code(401).send({ code: 'ws_ticket_missing' })
    return
  }
  // A `null` return = consumed / expired / missing ticket → 401 (auth failure).
  // A THROW = transient Redis fault (the GETDEL itself failed) → 503, so the
  // operator can distinguish "client sent a stale ticket" from "Redis is
  // wobbling" rather than collapsing both into a generic 500. Either way the
  // handshake fails CLOSED — no socket opens (arch overview §5.2 step 7).
  let payload: Awaited<ReturnType<typeof consumeWsTicket>>
  try {
    payload = await consumeWsTicket({ redis: deps.redisRealtime, keyPrefix: ticketKeyPrefix }, ticket)
  } catch (err) {
    request.log.error({ err, sessionId: request.params.sessionId }, 'ws-session ticket consume failed')
    await reply.code(503).send({ code: 'ws_ticket_store_unavailable' })
    return
  }
  if (!payload) {
    await reply.code(401).send({ code: 'ws_ticket_invalid' })
    return
  }
  // 2. The ticket is bound to ONE session — reject a ticket replayed against
  //    a different session's socket.
  if (payload.sessionId !== request.params.sessionId) {
    await reply.code(401).send({ code: 'ws_ticket_session_mismatch' })
    return
  }
  // 3. Load the session row. Not found → 404; not active → 409.
  const session = await repo.sessions.getById(request.params.sessionId)
  if (!session) {
    await reply.code(404).send({ code: 'session_not_found' })
    return
  }
  if (session.status !== 'active') {
    await reply.code(409).send({ code: 'session_not_active' })
    return
  }
  // 4. Re-check membership against the SESSION-ROW campaignId (not the
  //    ticket's claim). Replicates requireCampaignMember's exact predicate:
  //    a pending (not-accepted) invite is NOT a member.
  const member = await repo.campaigns.getMembership(session.campaignId, payload.userId)
  if (!member?.inviteAccepted) {
    await reply.code(403).send({ code: 'not_campaign_member' })
    return
  }
  // 5. myth-ficc — the suspension gate, same 403 `account_suspended` the HTTP
  //    surface answers (requireOnboarded). It cannot be inherited from the mint
  //    route: a ticket minted while the player was in good standing stays valid
  //    for its 30s TTL, so without a check HERE a just-banned player still gets
  //    a socket. `isSuspended` fails CLOSED on a missing row, and a THROW (pg
  //    fault) propagates to the route error handler → 500 → no upgrade, so
  //    every non-"definitely allowed" outcome ends without a socket. This is
  //    also what keeps the permanently-suspended SYSTEM user (demo-world owner,
  //    1970 sentinel) off the transport.
  if (await repo.users.isSuspended(payload.userId)) {
    await reply.code(403).send({ code: 'account_suspended' })
    return
  }
  // 6. Stash for the handler. campaignId is the SESSION ROW's value.
  request.wsSessionAuth = { userId: payload.userId, campaignId: session.campaignId }
}

/** The full connection lifecycle for one authenticated socket.
 *
 *  The whole connect body is guarded: a throw AFTER the upgrade (e.g.
 *  `sessionParticipants.join` → NoCharacterForParticipantError when a member
 *  has no integrated character, or a transient Redis fault on addPresence) must
 *  NOT leave the socket open + hanging with no session_ready, and must NOT
 *  float to the process unhandledRejection handler. On failure we run
 *  best-effort cleanup (deregister + dropPresence, undoing any partial
 *  registration) and close the socket with 1011. */
async function handleConnection(
  ctx: ConnCtx,
  socket: WsSocket,
  userId: string,
  campaignId: string,
  sessionId: string,
  lastSeq: number | null,
): Promise<void> {
  const { repo, sessionState, hub, suspendQueue, containerId } = ctx.deps
  // Per-connection identity (myth-wat0m). A user may hold several concurrent
  // sockets (multiple tabs / devices); each gets its own connId so the hub
  // registry and the presence keys are keyed per-CONNECTION, not per-user — a
  // second tab never evicts the first, and closing one tab never drops the
  // user's presence to zero while another tab is live. Minted before the guarded
  // body so it's in scope for the failure-cleanup + close.
  const connId = randomUUID()
  try {
    // Resolve the participant's character + write the participant row, then
    // resolve display + character names for the broadcast frames. These names
    // are stable for the socket's lifetime, captured once here.
    await repo.sessionParticipants.join({ sessionId, campaignId, userId })
    const [user, character] = await Promise.all([
      repo.users.getById(userId),
      repo.characters.findUserCharacterForCampaign(userId, campaignId),
    ])
    const displayName = user?.displayName ?? ''
    const characterName = character?.name ?? ''

    // Was this user ALREADY present via another live connection BEFORE this one?
    // Gates the player_joined broadcast (myth-wat0m: no rejoin spam when a
    // second tab opens). Read BEFORE addPresence so this socket's own key is not
    // yet counted. A Redis fault here fails the connect like any other connect-
    // time Redis fault (the guard closes the socket; the client reconnects).
    const alreadyPresent = (await sessionState.userConnectionCount(campaignId, userId)) > 0

    // Record presence + register the socket BEFORE the player_joined broadcast
    // so this socket is in the registry when the fan-out comes back round.
    // ORDERING (load-bearing for reconnect): hub.register MUST run before the
    // session_reconnect replay's session_messages read below — any frame
    // published live during that DB read is then delivered to this socket, and
    // the client's seq-dedup drops the overlap with the replay batch. A
    // read-then-register would drop that gap.
    await sessionState.addPresence(campaignId, containerId, userId, connId)
    hub.register(campaignId, userId, connId, socket)
    await sessionState.refreshTtls(campaignId)
    // A returning player cancels any pending all-disconnected suspend.
    await cancelSuspend(suspendQueue, sessionId)

    // myth-rf5rn follow-up (caught by the post-fix live smoke): after a long
    // idle the campaign `:seq` counter expires and INCR restarts at 1. When
    // this session's durable rows start HIGH (the counter is campaign-scoped,
    // carried across sessions), those low seqs DON'T collide — they persist
    // silently BEFORE the session opening, corrupting transcript order, and
    // the trigger debounce reads new messages as old (the DM goes permanently
    // silent). The collision heal can't see the non-colliding case, so raise
    // the counter to the durable floor at the write-window entry. reseedSeq
    // never lowers a live counter, so the healthy-counter case is a no-op.
    await sessionState.reseedSeq(campaignId, await repo.sessionMessages.maxSeq(sessionId))

    // MYT-68: the FT's prompt roster is NOT maintained here. The worker derives
    // it per turn from session_participants (`join` above wrote this player's
    // row), in deterministic order — the racy `:state.participants` RMW this
    // path used to do lost a name to last-write-wins when two players joined at
    // once (the normal session-start case; caught live in the MYT-68 smoke).

    if (lastSeq !== null) {
      // Reconnect: send the replay frame DIRECTLY (synchronous socket.send)
      // BEFORE broadcasting player_joined. The direct send is guaranteed to
      // reach this socket ahead of the join frame (which only arrives after a
      // Redis pub/sub round-trip), so the client's FIRST frame is deterministic.
      const reconnect = await buildReconnectFrame(ctx, sessionId, campaignId, lastSeq)
      socket.send(JSON.stringify(reconnect))
      // player_joined only on the user's FIRST connection — a second tab
      // reconnecting must not re-announce a user who is already present
      // (myth-wat0m). The reconnect replay above still reaches THIS socket.
      if (!alreadyPresent) {
        await hub.publish(campaignId, { type: 'player_joined', userId, displayName, characterName })
      }
    } else {
      // Fresh connect: player_joined is a seq-LESS out-of-band presence frame
      // (like typing_*): ONLY player_message advances `:seq` (arch overview
      // §5.2 lists no seq on presence frames). Join/left aren't persisted to
      // session_messages and are absent from reconnect replay, so they must
      // never carry a seq a client could gap-detect on. The first
      // player_message is therefore seq 1. Broadcast only on the FIRST
      // connection (an extra tab still gets its own session_ready below).
      if (!alreadyPresent) {
        await hub.publish(campaignId, { type: 'player_joined', userId, displayName, characterName })
      }
      // myth-nu0hm — carry the session-progress floor on the first frame so a
      // joining client renders the real fraction immediately instead of sitting
      // at empty until the next turn completes. Read-only (the floor is raised
      // by the turn worker alone) and OMITTED on 0 / on any read failure, since
      // an absent field means "no statement" and a fresh session has nothing to
      // say yet. Own guard: session_ready is the frame that opens the socket —
      // a progress hiccup must never cost the player their connection.
      //
      // ⚠️ IF YOUR BREAKPOINT HERE NEVER HITS, THAT IS EXPECTED: this whole
      // `else` arm is UNREACHABLE for the shipped web client. `useSession`
      // connects with `{ seedLastSeq: 0 }` (client-core session/use-session.ts),
      // `buildWsUrl` only omits the param when the seq is `null` (`0 !== null`),
      // so the upgrade URL always carries `lastSeq=0`; `parseLastSeq` below
      // accepts 0 as a valid seq, and `handleConnect` takes the RECONNECT branch
      // instead. Only a client that never seeds — the ws-transport smoke script,
      // curl — lands here. The progress carrier that reaches real players is the
      // one on `session_reconnect` in buildReconnectFrame; keep the two in sync.
      let progress: SessionProgress | undefined
      try {
        const fraction = await sessionState.progressFraction(campaignId)
        if (fraction > 0) progress = { fraction }
      } catch (err) {
        ctx.app.log.error({ err, campaignId }, 'failed to read session progress for session_ready')
      }
      socket.send(
        JSON.stringify({ type: 'session_ready', ...(progress !== undefined ? { progress } : {}) }),
      )
    }

    startHeartbeat(ctx, socket, campaignId, userId, connId)

    // Both lifecycle dispatches self-guard (their own try/catch), and the outer
    // .catch is a second net so a void-dispatched rejection can't escape to the
    // process handler. handleInbound NEVER throws (keeps the socket alive on a
    // bad frame); handleDisconnect is best-effort throughout.
    socket.on('message', (raw: WsRawData) => {
      void handleInbound(ctx, userId, campaignId, sessionId, raw, displayName, characterName).catch(
        (err: unknown) => {
          ctx.app.log.error({ err, campaignId, userId }, 'ws-session handleInbound escaped its guard')
        },
      )
    })

    socket.on('close', () => {
      void handleDisconnect(ctx, userId, campaignId, sessionId, connId).catch((err: unknown) => {
        ctx.app.log.error({ err, campaignId, userId }, 'ws-session handleDisconnect escaped its guard')
      })
    })
  } catch (err) {
    ctx.app.log.error(
      { err, campaignId, userId, sessionId },
      'ws-session connect failed — closing socket',
    )
    // Best-effort: undo any partial registration so a failed connect doesn't
    // leak a registry entry or a presence key. Each step is independently
    // swallowed; we already hold the close as the user-visible outcome. Both
    // undo THIS connection's connId only (a no-op if it never registered).
    hub.deregister(campaignId, connId)
    await sessionState.dropPresence(campaignId, containerId, userId, connId).catch(() => undefined)
    // myth-mnik3: a member with no integrated character is a TYPED, EXPECTED
    // rejection — close with the distinct 4404 'no_character' so the client can
    // tell the player they have no character yet, rather than rendering a generic
    // connect-failed as ambient quiet. Every OTHER failure keeps 1011.
    try {
      if (err instanceof NoCharacterForParticipantError) {
        socket.close(NO_CHARACTER_CLOSE_CODE, NO_CHARACTER_CLOSE_REASON)
      } else {
        socket.close(SERVER_CLOSE_CODE, 'connect-failed')
      }
    } catch {
      /* socket already torn down */
    }
  }
}

/** Parse `?lastSeq` from the upgrade query. A non-negative integer is a
 *  reconnect request (replay everything after it). Absent, empty, negative,
 *  or non-integer (NaN / float / out-of-range) is a fresh connect → null, and
 *  the connect path sends session_ready unchanged. Structural validation at
 *  the transport boundary (ZFC structural exception), mirroring
 *  parseClientFrame's drop-on-malformed posture.
 *
 *  NOTE (myth-nu0hm) — ZERO IS A VALID SEQ, and that has a bigger consequence
 *  than it looks: the shipped web client seeds `lastSeqForUrl` with 0, so every
 *  real connection (first join included) arrives as `lastSeq=0` and takes the
 *  RECONNECT branch. `session_ready` is effectively dead code in production —
 *  only a never-seeding client (the ws-transport smoke, curl) reaches it. Any
 *  per-connect payload must therefore ride `session_reconnect` to reach players;
 *  putting it only on `session_ready` looks correct and silently ships nothing. */
function parseLastSeq(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) return null
  return n
}

/**
 * Build the `session_reconnect` replay frame for a reconnecting socket.
 *
 *   - `messages`: every persisted player_message with seq > lastSeq, each
 *     reconstructed into a `player_message` ServerFrame. (Only player_message
 *     rows are persisted; join/left/typing were never written, so the replay
 *     is a pure player_message stream.) Author display/character names are
 *     resolved through an O(N) in-memory map built ONCE from the campaign-wide
 *     reads below — NO per-message DB lookups. An author who has since left the
 *     campaign (no row in either map) falls back to a stable placeholder rather
 *     than an extra per-row lookup; their prose history still replays intact.
 *   - `participants`: the current session participants, each resolved to a
 *     ParticipantSummary via the same two maps.
 *   - `mode`: the live `:state` blob's mode, defaulting to 'exploration' when
 *     no state has been written yet (MYT-65 only exercises exploration).
 *
 * Three campaign/session-scoped reads (participants list + member display
 * names + campaign characters) plus the seq-windowed message read — all
 * bounded, none per-row.
 */
async function buildReconnectFrame(
  ctx: ConnCtx,
  sessionId: string,
  campaignId: string,
  lastSeq: number,
): Promise<Extract<ServerFrame, { type: 'session_reconnect' }>> {
  const { repo, sessionState } = ctx.deps
  // myth-nu0hm — the session-progress floor joins the existing parallel fan-out
  // (no added round-trip depth on the connect path). This is the arm that
  // actually reaches players: the shipped client always sends `lastSeq=0`, so
  // every real join lands here rather than on `session_ready`. Fail-soft to 0 so
  // a progress hiccup can never cost a reconnecting player their replay.
  const [rows, participantRows, members, characters, state, progressFraction] = await Promise.all([
    repo.sessionMessages.listAfterSeq(sessionId, lastSeq),
    repo.sessionParticipants.list(sessionId),
    repo.campaigns.listMembers(campaignId),
    repo.characters.listForCampaign(campaignId),
    sessionState.getState(campaignId),
    sessionState.progressFraction(campaignId).catch((err: unknown) => {
      ctx.app.log.error({ err, campaignId }, 'failed to read session progress for session_reconnect')
      return 0
    }),
  ])

  // userId -> displayName / characterName. Campaign-wide, built once.
  const displayByUser = new Map(members.map((m) => [m.userId, m.displayName]))
  const characterByUser = new Map(characters.map((c) => [c.userId, c.name]))

  const participants: ParticipantSummary[] = participantRows.map((p) => ({
    userId: p.userId,
    displayName: displayByUser.get(p.userId) ?? DEPARTED_AUTHOR_NAME,
    characterName: characterByUser.get(p.userId) ?? '',
  }))

  // §3.7 reconnect replay: each persisted row → its ServerFrame. player_message
  // rows map by author (MYT-65); the MYT-68 DM-turn mechanical rows (dm_text /
  // skill_check / dice_roll) reconstruct from their JSON content. A row that
  // doesn't map (unknown messageType, or a corrupt DM-row blob) yields null and
  // is dropped — replay degrades GRACEFULLY (drop one frame, keep the rest).
  const messages: ServerFrame[] = rows.flatMap((row) =>
    rowToReplayFrame(row, displayByUser, characterByUser, ctx.app.log),
  )

  const mode = state?.mode ?? 'exploration'

  // MYT-75 T8 — combat-mode reconnect. The combat frames (combat_started /
  // combat_resolved) are intra-turn control frames: they are NOT persisted to
  // session_messages, so a member reconnecting into a session that is SITTING in
  // combat would otherwise see a blank combat screen. Read the live `:combat`
  // blob and append a synthetic, turn-LESS frame so the reconnect carries the
  // current state — the resolved result (the common case: a single-shot fight
  // awaiting `resume_combat`) or, if still resolving, the roster + initiative.
  if (mode === 'combat') {
    const combat = await ctx.deps.sessionState.getCombatState(campaignId)
    const combatFrame = combat ? buildCombatReconnectFrame(combat) : null
    if (combatFrame) messages.push(combatFrame)
  }

  return {
    type: 'session_reconnect',
    messages,
    participants,
    mode,
    // Omitted at 0 (a session that has published no progress yet) — absence is
    // "no statement", a 0 would be a claim.
    ...(progressFraction > 0 ? { progress: { fraction: progressFraction } } : {}),
  }
}

/** Build the synthetic combat replay frame for a combat-mode reconnect. A
 *  RESOLVED fight → a `combat_resolved` frame from the blob's `result.summary`
 *  (narration = the close-out `outcomeDescription`, plus outcome / casualties /
 *  HP deltas). A still-RESOLVING fight (or a resolved blob with a null result,
 *  defensively) → a `combat_started` frame from the enemies + initiative the
 *  fight was entered with. Both are turn-LESS (no seq; an empty turnId — these
 *  are synthesized at reconnect, not replayed from a persisted row). */
function buildCombatReconnectFrame(
  combat: CombatStateBlob,
): Extract<ServerFrame, { type: 'combat_resolved' | 'combat_started' }> {
  if (combat.status === 'resolved' && combat.result) {
    const summary = combat.result.summary
    return {
      type: 'combat_resolved',
      turnId: '',
      narration: summary.outcomeDescription,
      outcome: summary.outcome,
      casualties: summary.casualties.map((c) => ({ name: c.name, type: c.type, fate: c.fate })),
      hpChanges: summary.hpChanges.map((h) => ({
        combatant: h.combatant,
        hpBefore: h.hpBefore,
        hpAfter: h.hpAfter,
        maxHp: h.maxHp,
      })),
    }
  }
  return {
    type: 'combat_started',
    turnId: '',
    enemies: combat.enemies.map((e) => ({ name: e.name, description: e.description, count: e.count })),
    initiative: combat.initiative.map((i) => ({ combatant: i.combatant, roll: i.roll })),
  }
}


/**
 * Ping every 30s; if the prior ping went un-ponged within the 10s grace,
 * terminate the socket. Refresh presence on each ping so a live connection's
 * TTL never lapses. The timers are cleared on 'close'.
 */
function startHeartbeat(
  ctx: ConnCtx,
  socket: WsSocket,
  campaignId: string,
  userId: string,
  connId: string,
): void {
  const { sessionState, containerId } = ctx.deps
  let pongTimer: NodeJS.Timeout | undefined
  const pingTimer = setInterval(() => {
    socket.ping()
    // Best-effort TTL refresh of THIS connection's presence key; a failure is
    // logged-and-swallowed (the next ping retries, and the presence TTL has
    // headroom over the 30s cadence).
    void sessionState.addPresence(campaignId, containerId, userId, connId).catch((err: unknown) => {
      ctx.app.log.warn({ err, campaignId, userId }, 'ws-session presence refresh failed')
    })
    // Arm the pong deadline: no pong within 10s → dead peer → terminate.
    pongTimer = setTimeout(() => {
      socket.terminate()
    }, PONG_GRACE_MS)
  }, PING_INTERVAL_MS)

  socket.on('pong', () => {
    if (pongTimer) clearTimeout(pongTimer)
  })
  socket.on('close', () => {
    clearInterval(pingTimer)
    if (pongTimer) clearTimeout(pongTimer)
  })
}

/**
 * myth-ficc — the per-frame suspension gate for an ALREADY-OPEN socket. Returns
 * true when the frame must be dropped (and tears the user's sockets down on the
 * way out).
 *
 * The handshake check (wsSessionAuth step 5) only covers connect-time; a
 * suspension can land on a socket that is already open, and "a suspended user
 * must not be able to act" has to survive that.
 *
 * It is a per-frame DB read rather than a pushed kill-signal because there is
 * no in-app suspend action to push FROM — an operator sets `suspended_at`
 * directly in Postgres, so the socket only learns about the ban by asking.
 * (When the admin surface lands, a `user:{id}:suspend` pub/sub message calling
 * this same `hub.closeUser` makes termination immediate; this read then stays
 * as the backstop that does NOT fail open when a message is missed, when Redis
 * is down, or when the suspension was made out-of-band. Spec
 * 2026-04-13-auth-users.md §6.4.) The cost is one indexed PK lookup per inbound
 * frame — alongside the two Redis reads the drop-gates already do — and it is
 * paid at most once per suspended socket, since the socket dies here.
 *
 * `isSuspended` fails CLOSED on a missing row. A THROW (pg fault) propagates to
 * handleInbound's per-frame boundary, which drops the frame: the ACTION still
 * does not happen, the socket merely survives and the next frame re-checks.
 */
async function rejectIfSuspended(
  ctx: ConnCtx,
  userId: string,
  campaignId: string,
  sessionId: string,
): Promise<boolean> {
  if (!(await ctx.deps.repo.users.isSuspended(userId))) return false
  ctx.app.log.warn(
    { event: 'ws.suspended_user_frame_dropped', campaignId, sessionId, userId },
    'dropped an inbound frame from a suspended user and closed their sockets',
  )
  ctx.deps.hub.closeUser(userId)
  return true
}

/** Parse + route one inbound client frame. Unknown / non-client types drop.
 *
 *  This handler is the per-frame error boundary: a single bad or throwing frame
 *  (malformed JSON, a transient Redis fault on persist/publish, an oversized
 *  payload) must DROP that frame and KEEP THE SOCKET ALIVE — it must never kill
 *  the connection or float a rejection to the process handler. So the whole
 *  body is try/catch'd; the worst case is one lost message, logged. */
export async function handleInbound(
  ctx: ConnCtx,
  userId: string,
  campaignId: string,
  sessionId: string,
  raw: WsRawData,
  displayName: string,
  characterName: string,
): Promise<void> {
  const { hub, triggerState, sessionState } = ctx.deps
  // One clock read per frame: the typing/activity stamps, the max-wait clamp,
  // and the explicit-path batch boundary must all reason about the same `now`.
  const now = Date.now()
  try {
    const frame = parseClientFrame(raw, ctx.app.log)
    if (!frame) return

    // myth-ficc — the SUSPENSION gate (see rejectIfSuspended). Placed BEFORE
    // the ending/combat gates so it applies to EVERY frame type, end_session
    // included: a ban is not a way to end play.
    if (await rejectIfSuspended(ctx, userId, campaignId, sessionId)) return

    // MYT-74a T11 — the END drop-gate. Once a session is ending, no inbound
    // frame may start a new turn or mutate state: an in-flight end has already
    // fenced the turn loop, flipped the row, and fired reconcile. We DROP every
    // inbound frame EXCEPT a redundant end_session (which is idempotent at the
    // SET-NX flag, so letting it through costs nothing and keeps the branch
    // uniform). The flag is the cheap realtime-Redis read the budget auto-end
    // (T12) and the explicit frame both set. A read failure is swallowed by the
    // outer catch (fail-open keeps the socket alive on a transient Redis blip;
    // the reconcile worker's own §4 gate is the durable interlock regardless).
    if (frame.type !== 'end_session' && (await sessionState.isEnding(campaignId))) {
      return
    }

    // MYT-75 T8 — the COMBAT drop-gate + resume. While a session sits in `combat`
    // mode (the single-shot fight resolved and is awaiting a `resume_combat`
    // summon), no inbound frame may start a NEW exploration turn: a normal
    // player_message / dm_invoke / typing frame all (re-)arm the dm-trigger
    // debounce, which would fire a DM turn mid-combat. We DROP every inbound
    // frame EXCEPT `resume_combat` (the flip back) and `end_session` (a member
    // may end a session that is sitting in combat). One `:state` read serves both
    // the gate and the resume branch (no double round-trip). A read failure is
    // swallowed by the outer catch (fail-open keeps the socket alive on a Redis
    // blip; the resume is idempotent via the `tryMarkResumed` interlock).
    const state = await sessionState.getState(campaignId)
    if (
      state?.mode === 'combat' &&
      frame.type !== 'resume_combat' &&
      frame.type !== 'end_session'
    ) {
      return
    }

    if (frame.type === 'resume_combat') {
      // Nothing to resume unless the session is actually sitting in combat.
      if (state?.mode !== 'combat') return
      // Once-only interlock: the FIRST summon flips; a racing second summon
      // (another member clicking resume at the same instant) loses the SET-NX and
      // short-circuits, so the flip + clear + broadcast happen exactly once.
      if (!(await sessionState.tryMarkResumed(campaignId))) return
      // Flip the live mode back to exploration (carry the rest of the blob), drop
      // the `:combat` blob (+ release the resume interlock so a later fight can
      // claim it), and broadcast the turn-LESS mode_change so every client leaves
      // the combat result screen and re-enables exploration input.
      await sessionState.setState(campaignId, { ...state, mode: 'exploration' })
      await sessionState.clearCombatState(campaignId)
      await hub.publish(campaignId, {
        type: 'mode_change',
        from: 'combat',
        to: 'exploration',
        reason: 'resume',
      })
      return
    }

    if (frame.type === 'end_session') {
      // MYT-74b §1 — BEGIN the end. Resolve the worldId (blob-cached campaign→
      // world, reusing the turn worker's resolver) and thread it onto the farewell
      // payload, then enqueue the player-less send-off turn. The turn worker runs
      // the unconditional finalize (flip + reconcile + analysis + session_end)
      // AFTER the farewell renders, so the live send-off precedes session_end.
      const worldId = await resolveWorldId(
        { sessionState, repo: ctx.deps.repo },
        campaignId,
        sessionId,
      )
      await endSession(
        {
          sessionState,
          suspendQueue: ctx.deps.suspendQueue,
          turnQueue: ctx.deps.sessionTurnQueue,
          respondedSeq: (cId) => ctx.deps.triggerState.respondedSeq(cId),
          logger: ctx.app.log,
        },
        { campaignId, sessionId, worldId },
      )
      return
    }

    if (frame.type === 'typing_start') {
      // §4.1 typing display + §4.2 quiet-window reschedule. The typing key is
      // the "someone's still composing" gate; arming first-unresponded + the
      // debounce reschedule starts/extends the quiet window. The reschedule
      // runs AFTER the typing/activity writes; a queue failure logs at WARN and
      // never throws (a sustained outage is observable, not silently swallowed).
      await triggerState.markTyping(campaignId, userId)
      await triggerState.stampActivity(campaignId, now)
      await triggerState.armFirstUnresponded(campaignId, now)
      await rescheduleQuietWindow(ctx.deps, ctx.app.log, campaignId, now)
      await hub.publish(campaignId, { type: frame.type, userId, displayName })
      return
    }

    if (frame.type === 'typing_stop') {
      // A best-effort fast-path "done composing" (§4.1); the authoritative stop
      // is the typing key's TTL expiry. No reschedule — a stop is not activity.
      await triggerState.clearTyping(campaignId, userId)
      await hub.publish(campaignId, { type: frame.type, userId, displayName })
      return
    }

    if (frame.type === 'dm_invoke') {
      // §4.5 EXPLICIT summon (carries no text — never persisted/broadcast as a
      // chat message). Fires the DM immediately, bypassing the debounce queue.
      await runExplicitTrigger(ctx.deps, ctx.app.log, userId, campaignId, sessionId)
      return
    }

    // player_message — PERSIST-THEN-BROADCAST with a server-assigned seq.
    const text = frame.text
    const seq = await persistMessage(ctx, sessionId, campaignId, userId, text)
    await hub.publish(campaignId, {
      type: 'player_message',
      seq,
      userId,
      displayName,
      characterName,
      text,
    })

    // §4.1/§4.2: a send implies "done typing" (clear the key), then stamp the
    // activity + arm the max-wait anchor. An `@dm`-prefixed message is the
    // EXPLICIT gesture (same as `dm_invoke`); everything else reschedules the
    // quiet-window debounce. All trigger writes run AFTER persist+broadcast so a
    // queue/Redis failure never loses the message.
    await triggerState.clearTyping(campaignId, userId)
    await triggerState.stampActivity(campaignId, now)
    await triggerState.armFirstUnresponded(campaignId, now)
    if (isExplicitText(text)) {
      await runExplicitTrigger(ctx.deps, ctx.app.log, userId, campaignId, sessionId)
    } else {
      await rescheduleQuietWindow(ctx.deps, ctx.app.log, campaignId, now)
    }
  } catch (err) {
    // Drop the frame, keep the socket alive. A persisted-but-not-broadcast
    // message (publish threw after append succeeded) is recoverable: the client
    // gap-detects the missing seq and REST-backfills via GET …/messages.
    ctx.app.log.error(
      { err, campaignId, userId, sessionId },
      'ws-session inbound frame failed — dropped, socket kept alive',
    )
  }
}

/**
 * Assign a seq, persist the message, and return the seq actually used. On a
 * unique-violation on (session_id, seq) — a reseed race where another writer
 * already took our number — re-INCR ONCE and retry. A second collision
 * re-throws (a pathological state the caller's error path surfaces).
 */
async function persistMessage(
  ctx: ConnCtx,
  sessionId: string,
  campaignId: string,
  userId: string,
  text: string,
): Promise<number> {
  const { repo, sessionState } = ctx.deps
  const append = (seq: number): Promise<unknown> =>
    repo.sessionMessages.append({
      sessionId,
      seq,
      userId,
      messageType: 'player_message',
      content: text,
    })

  const seq = await sessionState.nextSeq(campaignId)
  try {
    await append(seq)
    return seq
  } catch (err) {
    if (!isSeqUniqueViolation(err)) throw err
    // myth-rf5rn — a collision means the Redis counter is BEHIND the durable
    // rows. Two ways that happens: a one-off reseed race (another writer took
    // our number) or the `:seq` key EXPIRING after a >2h idle stretch, which
    // restarts INCR at 1 and makes every blind re-INCR collide again — the
    // old retry silently ate every message until the counter crawled past the
    // durable MAX. Heal exactly: raise the counter to MAX(seq) (reseedSeq
    // never lowers a live counter, so the race case degrades to a no-op),
    // then take the next number. A second collision after the heal is
    // pathological and propagates to the caller's drop-and-log path.
    await sessionState.reseedSeq(campaignId, await repo.sessionMessages.maxSeq(sessionId))
    const retrySeq = await sessionState.nextSeq(campaignId)
    await append(retrySeq)
    return retrySeq
  }
}

/** Disconnect cleanup for ONE connection: deregister this socket, drop its
 *  presence, and — only if it was the user's LAST connection — signal a
 *  departure (clear typing + broadcast player_left). Schedule a suspend if this
 *  drained the last connection of the last user.
 *
 *  myth-wat0m: keyed per-connection. A user closing ONE of several tabs must NOT
 *  read as leaving — `deregister` evicts only this connId (a sibling tab stays
 *  registered + receiving), and the player_left / clearTyping fire only when the
 *  user has no other live connection. The suspend gate (`countPresence === 0`,
 *  distinct users) is unchanged: it fires only when nobody is present at all.
 *
 *  EACH step is independently best-effort: one transient Redis error must not
 *  skip the others (especially `scheduleSuspend`, the load-bearing cleanup —
 *  skipping it strands an empty session never-suspended) and must not feed the
 *  process unhandledRejection escalation. `deregister` (in-memory, can't throw)
 *  always runs. `dropPresence` failing is self-healing (presence keys carry a
 *  TTL). If `userConnectionCount` throws we treat the user as DEPARTED (the
 *  pre-myth-wat0m always-signal behavior), so a genuine last-disconnect never
 *  silently lingers. If `countPresence` itself throws, we FAIL SAFE and schedule
 *  the suspend anyway — the suspend processor re-reads presence on fire and bails
 *  if anyone's actually connected, so an over-schedule is inert, while an
 *  under-schedule would leak a live-forever empty session. */
async function handleDisconnect(
  ctx: ConnCtx,
  userId: string,
  campaignId: string,
  sessionId: string,
  connId: string,
): Promise<void> {
  const { sessionState, hub, suspendQueue, containerId, triggerState } = ctx.deps
  const log = ctx.app.log

  // Socket-identity-safe: evict ONLY this connection (never a sibling tab).
  hub.deregister(campaignId, connId)

  // Drop THIS connection's presence key first, so the last-connection check
  // below doesn't count the socket that's leaving.
  await sessionState.dropPresence(campaignId, containerId, userId, connId).catch((err: unknown) => {
    log.warn({ err, campaignId, userId }, 'ws-session dropPresence failed (TTL will reap)')
  })

  // Was that the user's LAST connection? Only then is this a real departure.
  // On a count-read failure, fall back to treating them as departed (the
  // pre-myth-wat0m always-signal behavior) so a genuine leave never lingers.
  let userDeparted: boolean
  try {
    userDeparted = (await sessionState.userConnectionCount(campaignId, userId)) === 0
  } catch (err) {
    log.warn({ err, campaignId, userId }, 'ws-session userConnectionCount failed — treating as departed')
    userDeparted = true
  }

  if (userDeparted) {
    // §4.1: clear the user's typing key on their LAST disconnect (best-effort).
    // The key carries a TTL so an un-cleared key self-heals; this is the
    // fast-path so the indicator doesn't linger until expiry. Skipped when
    // another tab is still live (that tab's activity owns the typing state).
    await triggerState.clearTyping(campaignId, userId).catch((err: unknown) => {
      log.warn({ err, campaignId, userId }, 'ws-session clearTyping on disconnect failed (TTL will reap)')
    })

    // player_left is a seq-LESS presence frame (see the player_joined note):
    // system events don't advance the player_message seq stream.
    await hub.publish(campaignId, { type: 'player_left', userId }).catch((err: unknown) => {
      log.warn({ err, campaignId, userId }, 'ws-session player_left publish failed')
    })
  }

  // Fail safe: a countPresence throw → treat as 0 → schedule the suspend.
  let empty: boolean
  try {
    empty = (await sessionState.countPresence(campaignId)) === 0
  } catch (err) {
    log.warn({ err, campaignId }, 'ws-session countPresence failed — scheduling suspend fail-safe')
    empty = true
  }
  if (empty) {
    await scheduleSuspend(suspendQueue, sessionId, campaignId).catch((err: unknown) => {
      log.error({ err, campaignId, sessionId }, 'ws-session scheduleSuspend failed')
    })
  }
}

/** Decode a `ws` RawData payload to UTF-8 text. `ws` delivers a Buffer for
 *  text frames; the Buffer[] (fragmented) + ArrayBuffer shapes are handled for
 *  completeness so the JSON.parse always sees a real string (never the
 *  `[object ArrayBuffer]` default stringification). */
function rawToString(raw: WsRawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8')
  // ArrayBuffer → view it as bytes before decoding.
  return Buffer.from(new Uint8Array(raw)).toString('utf8')
}

/** Parse a raw inbound frame to a typed ClientFrame, or null to DROP it.
 *  Non-JSON, non-object, missing-type, or non-allowlisted types all drop —
 *  structural validation at the transport boundary (ZFC structural exception).
 *  An oversized player_message `text` (untrusted input) is dropped + logged.
 *  `log` is the per-connection logger so a dropped-for-size frame is
 *  diagnosable (the other drops are benign garbage; size is worth a breadcrumb). */
export function parseClientFrame(raw: WsRawData, log: FastifyBaseLogger): ClientFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawToString(raw))
  } catch {
    return null
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { type?: unknown }).type !== 'string'
  ) {
    return null
  }
  const type = (parsed as { type: string }).type
  if (!classifyClientFrame(type)) return null
  // MYT-67: the explicit "@DM button" summon carries no payload fields, so the
  // allowlist pass is the whole validation — accept it as-is.
  if (type === 'dm_invoke') return { type: 'dm_invoke' }
  // MYT-74a: the explicit session-end summon likewise carries no payload fields
  // — return a clean bare frame (strip any client-supplied extras).
  if (type === 'end_session') return { type: 'end_session' }
  // MYT-75 T8: the combat-resume summon — a bare frame too (strip extras).
  if (type === 'resume_combat') return { type: 'resume_combat' }
  if (type === 'player_message') {
    const text = (parsed as { text?: unknown }).text
    // A player_message must carry a string `text`; a malformed one drops.
    if (typeof text !== 'string') return null
    // Transport cap on untrusted input — drop + log (don't persist/broadcast a
    // multi-KB blob, and don't kill the socket over it).
    if (text.length > MAX_MESSAGE_TEXT_LEN) {
      log.warn({ len: text.length, max: MAX_MESSAGE_TEXT_LEN }, 'ws-session dropped oversized player_message')
      return null
    }
  }
  return parsed as ClientFrame
}

// isSeqUniqueViolation moved to repo/session-messages.ts (myth-rf5rn) — shared
// with the SessionController's persistTurn heal.
