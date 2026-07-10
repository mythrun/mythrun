import { Redis, type RedisOptions } from 'ioredis'
import { logger as defaultPinoLogger } from '../llm/logger.js'
import { makeReconnectStrategy } from './reconnect-strategy.js'

/** Minimal pino-compatible surface the Redis client wiring logs through. */
export interface RedisClientLogger {
  info: (obj: Record<string, unknown>, msg: string) => void
  warn: (obj: Record<string, unknown>, msg: string) => void
  error: (obj: Record<string, unknown>, msg: string) => void
  debug: (obj: Record<string, unknown>, msg: string) => void
}

/** The shared LLM-layer pino instance, used when a caller supplies no logger. */
export const defaultRedisLogger: RedisClientLogger = defaultPinoLogger

export interface CreateRedisClientOptions {
  /** Human-readable name for this client in structured logs (e.g. "redis-realtime"). */
  readonly label?: string
  /** Logger for lifecycle + reconnect lines. Defaults to the LLM-layer pino instance. */
  readonly logger?: RedisClientLogger
}

/**
 * Attach lifecycle logging to a long-lived runtime client so an outage +
 * recovery is VISIBLE in CloudWatch. The 'error' listener is ALSO the guard
 * that stops a transient connection error from surfacing as an "Unhandled error
 * event"; it logs at debug (not warn) because ioredis emits one 'error' per
 * failed connect attempt during an outage — the loud, visible signal is the
 * reconnect-strategy's per-attempt warn plus the 'ready' recovery info.
 */
export function attachRedisLifecycleLogging(
  client: Redis,
  label: string,
  logger: RedisClientLogger,
): void {
  client.on('ready', () => {
    logger.info({ event: 'redis.ready', label }, 'redis connection ready')
  })
  client.on('end', () => {
    // With a never-null reconnect strategy, 'end' fires only on an intentional
    // quit()/disconnect() (graceful shutdown) — not a give-up — so log at info,
    // NOT error, to avoid false alarms on every deploy's shutdown.
    logger.info({ event: 'redis.end', label }, 'redis connection closed')
  })
  client.on('error', (err: Error) => {
    logger.debug({ event: 'redis.error', label, err }, 'redis connection error')
  })
}

/**
 * API / request-path ioredis client. FAST-FAIL command semantics
 * (`enableOfflineQueue: false`, `maxRetriesPerRequest: 1`): a command issued
 * while disconnected rejects promptly rather than buffering a stale realtime
 * publish. This is deliberate — a realtime PUBLISH during an outage should drop
 * fast, and the SSE / WS subscribers force a resync on reconnect.
 *
 * RECONNECTION: unlike the old `retryStrategy: () => null` (which severed the
 * client permanently on the first blip — the P1 bug), the strategy now
 * reconnects with bounded exponential backoff + jitter and NEVER gives up, so
 * one ElastiCache failover no longer kills realtime for the task's lifetime.
 *
 * BOOT FAIL-LOUD is preserved: with `enableOfflineQueue: false` the boot-probe
 * ping rejects promptly while disconnected, so `waitFor` still bounds boot and
 * a genuine misconfig (wrong host/auth) crash-loops instead of retrying
 * forever. (Verified empirically: a never-null strategy + offline-queue-off
 * still fails loud on a wrong port.)
 */
export function createRedisClient(url: string, opts: CreateRedisClientOptions = {}): Redis {
  const label = opts.label ?? 'redis'
  const logger = opts.logger ?? defaultRedisLogger
  const options: RedisOptions = {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: makeReconnectStrategy({ label, logger }),
  }
  const client = new Redis(url, options)
  attachRedisLifecycleLogging(client, label, logger)
  return client
}
