import { Redis, type RedisOptions } from 'ioredis'
import {
  attachRedisLifecycleLogging,
  defaultRedisLogger,
  type CreateRedisClientOptions,
} from './client.js'
import { makeReconnectStrategy } from './reconnect-strategy.js'

/**
 * BullMQ-compatible ioredis factory. The Worker / Queue / QueueEvents instances
 * need settings that diverge from the API's fast-fail Redis profile:
 *
 *   - maxRetriesPerRequest: null   // BullMQ throws if this is set; blocking commands MUST allow indefinite retry
 *   - enableOfflineQueue:  true    // default; Workers queue commands during reconnect so jobs get reclaimed after a blip
 *   - retryStrategy:       shared bounded-backoff-with-jitter (replaces ioredis's default exp-backoff) so reconnects are capped, jittered, and LOGGED
 *
 * RECONNECTION: this profile already reconnected (ioredis's default
 * retryStrategy is never-null); the shared strategy adds a delay cap, jitter,
 * and structured per-attempt logging so an outage is visible in CloudWatch.
 *
 * BOOT FAIL-LOUD: because `maxRetriesPerRequest: null` + offline-queue-on
 * BUFFERS a probe ping against an unreachable Redis indefinitely (it never
 * rejects), boot fail-loud does NOT come from the command rejecting — it comes
 * from `boot/wait-for.ts`'s per-attempt timeout (PROBE_ATTEMPT_TIMEOUT_MS),
 * which bounds each hung probe so a genuine misconfig still crash-loops. Every
 * boot probe against this client MUST go through `waitFor` (see the
 * ioredis/BullMQ ping-race reference).
 */
export function createBullmqRedisClient(url: string, opts: CreateRedisClientOptions = {}): Redis {
  const label = opts.label ?? 'redis-bullmq'
  const logger = opts.logger ?? defaultRedisLogger
  const options: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: makeReconnectStrategy({ label, logger }),
  }
  const client = new Redis(url, options)
  attachRedisLifecycleLogging(client, label, logger)
  return client
}
