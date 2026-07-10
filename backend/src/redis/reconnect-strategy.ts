// Shared Redis reconnection strategy for all long-lived runtime clients.
//
// The bug this fixes: runtime ioredis clients were constructed with
// `retryStrategy: () => null` — no reconnection, EVER. One ElastiCache
// blip/failover permanently severed BullMQ + realtime for every ECS task until
// a manual rollover. This strategy reconnects with bounded exponential backoff
// + equal jitter and NEVER gives up (cap the delay, not the attempt count — a
// worker keeps trying indefinitely on transient loss) while logging each
// attempt at warn so an outage is VISIBLE in CloudWatch.
//
// Config-vs-transient split: this strategy is for the RUNTIME path only. The
// BOOT probe stays fail-loud via boot/wait-for.ts (bounded attempts + a
// per-attempt timeout) so a genuine misconfig (wrong host/auth) crash-loops
// rather than reconnecting forever silently. A never-null retryStrategy does
// NOT defeat boot fail-loud: the API client's `enableOfflineQueue: false` makes
// its probe ping reject promptly while disconnected, and the BullMQ client's
// buffered probe is bounded by wait-for's per-attempt timeout.

/** Base backoff before jitter — the delay for the first reconnect attempt. */
export const REDIS_RECONNECT_BASE_MS = 200
/** Maximum backoff delay. We cap the DELAY, never the attempt count. */
export const REDIS_RECONNECT_CAP_MS = 10_000

/** Minimal pino-compatible surface the strategy logs through. */
export interface ReconnectLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void
}

/**
 * Capped exponential backoff for a 1-based attempt number (ioredis passes
 * `times` starting at 1). `min(base * 2^(attempt-1), cap)`. Pure + deterministic.
 */
export function cappedBackoffMs(attempt: number): number {
  return Math.min(REDIS_RECONNECT_BASE_MS * 2 ** (attempt - 1), REDIS_RECONNECT_CAP_MS)
}

/**
 * Equal jitter (AWS "equal jitter"): keep half the delay as a floor to avoid a
 * thundering herd at zero, randomize the other half. Result is in
 * `[capped/2, capped]` — never exceeds the cap. `rng` is injectable for tests.
 */
export function applyEqualJitter(capped: number, rng: () => number): number {
  const half = Math.floor(capped / 2)
  return half + Math.floor(rng() * (half + 1))
}

/** Compose capped backoff with equal jitter. Never returns null. */
export function reconnectDelayMs(attempt: number, rng: () => number = Math.random): number {
  return applyEqualJitter(cappedBackoffMs(attempt), rng)
}

/**
 * Build an ioredis `retryStrategy` closure: computes the jittered backoff for
 * the attempt, logs a structured warn line (so the outage is visible), and
 * returns the delay. NEVER returns null — the client keeps reconnecting
 * indefinitely on transient loss.
 */
export function makeReconnectStrategy(opts: {
  label: string
  logger: ReconnectLogger
  rng?: () => number
}): (times: number) => number {
  const rng = opts.rng ?? Math.random
  return (times: number): number => {
    const delayMs = reconnectDelayMs(times, rng)
    opts.logger.warn(
      { event: 'redis.reconnecting', label: opts.label, attempt: times, delayMs },
      'redis reconnecting',
    )
    return delayMs
  }
}
