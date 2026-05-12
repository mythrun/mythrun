import { Redis, type RedisOptions } from 'ioredis'

/**
 * BullMQ-compatible ioredis factory. The Worker / QueueEvents instances need
 * settings that diverge from the API's fast-fail Redis profile:
 *
 *   - maxRetriesPerRequest: null      // BullMQ throws if this is set; blocking commands MUST allow indefinite retry
 *   - enableOfflineQueue:  true       // default; Workers queue commands during reconnect
 *   - retryStrategy:       default exp-backoff (vs API's `() => null` which would disable reconnect)
 *
 * Used only by the worker process. The API process keeps using the existing
 * `createRedisClient` for its rate-limiter + future Queue enqueueing.
 */
export function createBullmqRedisClient(url: string): Redis {
  const options: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  }
  const client = new Redis(url, options)
  // Same error swallow as createRedisClient — real errors surface via
  // promise rejections.
  client.on('error', () => undefined)
  return client
}
