// backend/src/auth/ws-ticket.ts
//
// Single-use WebSocket ticket store. mintWsTicket stores a
// {userId, sessionId, campaignId} payload under a 30-second TTL Redis
// key with a 256-bit hex nonce. consumeWsTicket reads + deletes
// atomically via GETDEL — single round-trip, no GET-then-DEL race.
// Framework-agnostic; both the Fastify mint route and the future WS
// upgrade handler call these directly.
//
// Spec: docs/superpowers/specs/2026-05-08-myt-39-access-control-ws-ticket-design.md §5

import { randomBytes } from 'node:crypto'
import type { Redis } from 'ioredis'

export const WS_TICKET_TTL_SECONDS = 30

export interface WsTicketPayload {
  readonly userId: string
  readonly sessionId: string
  readonly campaignId: string
}

export interface MintedTicket {
  readonly ticket: string
  /** ISO-8601. Informational only — Node-side wall-clock projection,
   *  biased later than the Redis-side TTL by network round-trip and
   *  cross-host clock skew. The WS upgrade's accept/reject is the
   *  ground truth; clients treat this as a soft upper bound. */
  readonly expiresAt: string
}

export interface WsTicketDeps {
  readonly redis: Redis
  /** Includes trailing colon, e.g. "production:use1:ws:ticket:". Pinned
   *  per environment+region per docs/specs/2026-04-10-infrastructure-devops.md
   *  because staging+prod share one ElastiCache cluster. */
  readonly keyPrefix: string
}

export async function mintWsTicket(
  deps: WsTicketDeps,
  payload: WsTicketPayload,
): Promise<MintedTicket> {
  const ticket = randomBytes(32).toString('hex')
  const value = JSON.stringify(payload)
  await deps.redis.set(`${deps.keyPrefix}${ticket}`, value, 'EX', WS_TICKET_TTL_SECONDS)
  const expiresAt = new Date(Date.now() + WS_TICKET_TTL_SECONDS * 1000).toISOString()
  return { ticket, expiresAt }
}

export async function consumeWsTicket(
  deps: WsTicketDeps,
  ticket: string,
): Promise<WsTicketPayload | null> {
  // ioredis 5.x typed redis.getdel — atomic read+delete in one round-trip.
  // GET-then-DEL would race: two concurrent consumers could both read
  // before either deleted, both succeed, ticket used twice.
  const value = await deps.redis.getdel(`${deps.keyPrefix}${ticket}`)
  if (value === null) return null
  if (typeof value !== 'string') {
    // Defensive: ioredis returns Buffer if the connection is in
    // Buffer-mode. The shared realtime client today is string-mode
    // (backend/src/redis/client.ts); this guard catches a future
    // config regression rather than silently treating Buffers as
    // misses-with-truthy-data.
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { userId?: unknown }).userId !== 'string' ||
    typeof (parsed as { sessionId?: unknown }).sessionId !== 'string' ||
    typeof (parsed as { campaignId?: unknown }).campaignId !== 'string'
  ) {
    return null
  }
  // Forward-compat: extra fields are ignored (not rejected) so the WS
  // server can add fields later without breaking the validator on
  // tickets minted by older code.
  const { userId, sessionId, campaignId } = parsed as WsTicketPayload
  return { userId, sessionId, campaignId }
}
