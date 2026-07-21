// backend/src/ws/session-hub.ts
//
// Cross-container fan-out engine for the multiplayer chat transport. One
// DEDICATED PSUBSCRIBE'd Redis client per API process (a duplicate() of
// deps.redisRealtime — once a client enters subscriber mode it rejects
// almost all commands, so it must not share the realtime client used by
// publish/rate-limit). When a player message is published, every API
// container fans it out to its locally-connected WebSocket clients for
// that campaign.
//
// Structurally this mirrors sse/pipeline-subscriber.ts, with two
// WS-specific differences:
//   (a) a WRITABLE per-CONNECTION registry Map<campaignId, Map<connId,
//       {userId, ws}>> (not a Set of read-only SSE sinks): a user may hold
//       several concurrent sockets (multiple tabs / devices), each keyed by its
//       own connId, so a second tab never evicts the first and a deregister
//       drops EXACTLY one socket identity (myth-wat0m), and
//   (b) resync teardown CLOSES the writable WS socket (close(1011, …)),
//       not an SSE sink. Clients reconnect + replay history.
//
// The channel format (pattern, per-campaign channel, campaignId extraction)
// is owned by contract/session-channel.ts — the turn worker publishes to the
// exact channel this hub subscribes to, so both derive it from there.
// Extraction is suffix-slice, NOT split-on-':' (the prefix contains colons).

import type { Redis } from 'ioredis'
import type pino from 'pino'
import type { ServerFrame } from '../contract/session-events.js'
import { makeReconnectStrategy } from '../redis/reconnect-strategy.js'
import {
  campaignIdFromChannel,
  sessionChannel,
  sessionChannelPattern,
} from '../contract/session-channel.js'

/**
 * The subset of `ws`'s WebSocket the hub uses. The real `@fastify/websocket`
 * socket satisfies this; tests supply a fake. `close`'s args mirror the WS
 * close-frame contract (code + reason).
 */
export interface WSLike {
  send(data: string): void
  close(code?: number, reason?: string): void
}

/** One registered connection: the owning userId (carried for fan-out failure
 *  logging) plus its socket. The registry keys these by a per-connection id, so
 *  a user's multiple concurrent sockets each get their own entry. */
interface RegisteredConn {
  readonly userId: string
  readonly ws: WSLike
}

export interface SessionHub {
  /** Attach a connected socket for (campaign, user) under a per-connection id.
   *  A user may hold MANY concurrent connections (multiple tabs / devices); each
   *  registers under its own connId and independently receives published frames.
   *  A second connection NEVER evicts an earlier one (the pre-myth-wat0m
   *  per-user map overwrote it). */
  register(campaignId: string, userId: string, connId: string, ws: WSLike): void
  /** Detach ONE connection (by connId) from a campaign. Socket-identity-safe: it
   *  removes only the named connection, never a sibling/newer socket for the same
   *  user (a stale close can't evict a live tab). Drops the inner map when the
   *  campaign's last connection leaves. */
  deregister(campaignId: string, connId: string): void
  /** Publish a server frame to the campaign's channel (cross-container fan-out). */
  publish(campaignId: string, frame: ServerFrame): Promise<void>
  /** Whether any socket is registered locally for this campaign. */
  hasLocal(campaignId: string): boolean
  /** Tear down: PUNSUBSCRIBE + QUIT the dedicated subscriber + clear the registry. */
  close(): Promise<void>
}

export interface CreateSessionHubDeps {
  /** The realtime Redis client. The hub duplicate()s it for its subscriber. */
  readonly redis: Redis
  /** Key prefix for the session pub/sub channel (contains colons). */
  readonly keyPrefix: string
  /** Pino logger; T11 passes the app instance. No silent catches. */
  readonly logger: pino.Logger
}

const RESYNC_CLOSE_CODE = 1011 // WS 1011 = internal error; client reconnects + replays.
const RESYNC_CLOSE_REASON = 'redis-resync-required'

export async function createSessionHub({
  redis,
  keyPrefix,
  logger,
}: CreateSessionHubDeps): Promise<SessionHub> {
  // Dedicated subscriber client. duplicate() inherits URL/AUTH/TLS. Cast
  // through `as unknown` because ioredis's duplicate() typing doesn't
  // include the options-override overload.
  const sub = (
    redis as unknown as { duplicate: (opts: Record<string, unknown>) => Redis }
  ).duplicate({
    // Shared bounded-backoff-with-jitter reconnect strategy (unit-tested; logs
    // each attempt at warn). The 'ready'-after-disconnect handler drives resync.
    retryStrategy: makeReconnectStrategy({ label: 'session-hub', logger }),
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
  })

  const pattern = sessionChannelPattern(keyPrefix)
  // campaignId -> (connId -> {userId, socket}). Writable registry, keyed
  // per-CONNECTION so a user's multiple tabs coexist (myth-wat0m).
  const registry = new Map<string, Map<string, RegisteredConn>>()
  let closed = false
  // The first 'ready' is the initial connect, not a reconnect — registered
  // sockets haven't missed any messages yet. Subsequent 'ready' events
  // follow a disconnect and DO need a resync teardown.
  let everReady = false

  sub.on('error', (err: Error) => {
    // Warn-and-continue: ioredis auto-reconnects. The 'ready'-after-disconnect
    // handler drives the resync teardown.
    logger.error({ err, pattern }, 'session-hub redis subscriber error')
  })

  // (No 'reconnecting' handler: the shared reconnect strategy already warns
  // per attempt with the client label — a second line here was pure noise.)

  sub.on('ready', () => {
    if (closed) return
    /* c8 ignore start — re-PSUBSCRIBE-on-ready rejection: ioredis queues the
     * command until connect; a synchronous rejection is an internal client
     * error. Defense-in-depth. */
    sub.psubscribe(pattern).catch((err: unknown) => {
      logger.error({ err, pattern }, 'session-hub psubscribe failed on ready')
    })
    /* c8 ignore stop */
    if (!everReady) {
      everReady = true
      return
    }
    // After a reconnect, registered sockets may have missed messages. Force
    // a resync close so clients reconnect + replay history (session_reconnect).
    if (registry.size > 0) {
      logger.warn(
        { campaigns: registry.size },
        'session-hub reconnected — closing registered sockets with redis-resync-required',
      )
      for (const conns of registry.values()) {
        for (const conn of [...conns.values()]) {
          try {
            conn.ws.close(RESYNC_CLOSE_CODE, RESYNC_CLOSE_REASON)
          } catch (err) {
            logger.warn({ err }, 'session-hub failed to close socket on resync')
          }
        }
      }
      registry.clear()
    }
  })

  sub.on('pmessage', (_pattern: string, channel: string, payload: string) => {
    // sessionChannel(keyPrefix, '') is the bare `{prefix}session:campaign:`
    // prefix; reject anything that doesn't start with it. (PSUBSCRIBE already
    // filters to the pattern, so this is belt-and-suspenders.)
    if (!channel.startsWith(sessionChannel(keyPrefix, ''))) return
    const campaignId = campaignIdFromChannel(keyPrefix, channel)
    const conns = registry.get(campaignId)
    if (!conns || conns.size === 0) return
    // Send the raw payload string — it's already the JSON-stringified frame.
    // Fan out to EVERY connection (all of a user's tabs, all users). Iterate a
    // snapshot so a deregister-during-iteration is safe.
    for (const [connId, conn] of [...conns]) {
      try {
        conn.ws.send(payload)
      } catch (err) {
        // Stale socket: drop it so one broken socket can't wedge the others.
        logger.warn(
          { err, campaignId, userId: conn.userId, connId },
          'session-hub ws.send threw — evicting dead socket from registry',
        )
        conns.delete(connId)
      }
    }
  })

  function register(campaignId: string, userId: string, connId: string, ws: WSLike): void {
    let conns = registry.get(campaignId)
    if (!conns) {
      conns = new Map()
      registry.set(campaignId, conns)
    }
    conns.set(connId, { userId, ws })
  }

  function deregister(campaignId: string, connId: string): void {
    const conns = registry.get(campaignId)
    if (!conns) return
    // Delete BY connId: only the leaving socket identity goes. A user's other
    // tabs (different connIds) stay registered, and a stale close for an
    // already-replaced connId can't evict a newer sibling.
    conns.delete(connId)
    if (conns.size === 0) registry.delete(campaignId)
  }

  function hasLocal(campaignId: string): boolean {
    const conns = registry.get(campaignId)
    return conns !== undefined && conns.size > 0
  }

  async function publish(campaignId: string, frame: ServerFrame): Promise<void> {
    await redis.publish(sessionChannel(keyPrefix, campaignId), JSON.stringify(frame))
  }

  async function close(): Promise<void> {
    closed = true
    try {
      await sub.punsubscribe(pattern)
    } catch (err) {
      logger.warn({ err }, 'session-hub punsubscribe failed during close')
    }
    registry.clear()
    try {
      await sub.quit()
    } catch (err) {
      logger.warn({ err }, 'session-hub quit failed during close')
    }
  }

  // Wait for the initial PSUBSCRIBE to be acknowledged before returning, so a
  // publish() immediately after createSessionHub() is reliably delivered.
  // `everReady` is driven by the 'ready' event (which fires on connect, before
  // this command's ack) — NOT set here — so the FIRST 'ready' is treated as
  // the initial connect (no resync) and only a later reconnect tears sockets
  // down. Mirrors sse/pipeline-subscriber.ts's everReady semantics.
  await sub.psubscribe(pattern)

  return { register, deregister, publish, hasLocal, close }
}
