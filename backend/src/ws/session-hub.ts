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
//   (a) a WRITABLE per-user registry Map<campaignId, Map<userId, WSLike>>
//       (not a Set of read-only SSE sinks), and
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

export interface SessionHub {
  /** Attach a connected socket for (campaign, user). Overwrites any prior socket for that user. */
  register(campaignId: string, userId: string, ws: WSLike): void
  /** Detach a user's socket from a campaign. Drops the inner map when empty. */
  deregister(campaignId: string, userId: string): void
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
  // campaignId -> (userId -> socket). Writable registry, one socket per user.
  const registry = new Map<string, Map<string, WSLike>>()
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

  /* c8 ignore start — reconnecting is an ioredis lifecycle signal with no
   * action of its own; the resync logic lives in the 'ready' handler. */
  sub.on('reconnecting', () => {
    logger.warn({ pattern }, 'session-hub redis subscriber reconnecting')
  })
  /* c8 ignore stop */

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
      for (const users of registry.values()) {
        for (const ws of [...users.values()]) {
          try {
            ws.close(RESYNC_CLOSE_CODE, RESYNC_CLOSE_REASON)
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
    const users = registry.get(campaignId)
    if (!users || users.size === 0) return
    // Send the raw payload string — it's already the JSON-stringified frame.
    // Iterate over a snapshot so a deregister-during-iteration is safe.
    for (const [userId, ws] of [...users]) {
      try {
        ws.send(payload)
      } catch (err) {
        // Stale socket: drop it so one broken socket can't wedge the others.
        logger.warn(
          { err, campaignId, userId },
          'session-hub ws.send threw — evicting dead socket from registry',
        )
        users.delete(userId)
      }
    }
  })

  function register(campaignId: string, userId: string, ws: WSLike): void {
    let users = registry.get(campaignId)
    if (!users) {
      users = new Map()
      registry.set(campaignId, users)
    }
    users.set(userId, ws)
  }

  function deregister(campaignId: string, userId: string): void {
    const users = registry.get(campaignId)
    if (!users) return
    users.delete(userId)
    if (users.size === 0) registry.delete(campaignId)
  }

  function hasLocal(campaignId: string): boolean {
    const users = registry.get(campaignId)
    return users !== undefined && users.size > 0
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
