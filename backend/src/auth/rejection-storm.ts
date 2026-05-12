// backend/src/auth/rejection-storm.ts
//
// Per-user rejection counter with a 1-hour sliding window, backed by Redis.
// POST /api/campaigns increments this on every 422 from the input gate. When
// the post-increment count exceeds REJECTION_STORM_THRESHOLD (3), the route
// surfaces a 429 with `code: 'rejection_storm_cooldown'` and a Retry-After
// header pointing at when the window expires.
//
// The counter is reset on a successful 201 from the same route — a user who
// proves they can produce a passing concept gets a clean slate.
//
// Spec: docs/superpowers/specs/2026-05-12-myt-51-world-gen-non-streaming-design.md
//   D5 + Kraken-C3 (per-sub Redis counter, 1h sliding window).
//
// Implementation:
//   - Key shape: `${redisKeyPrefix}rejection_storm:${userId}` — prefix is the
//     environment-pinned one (e.g. "production:use1:") so staging+prod sharing
//     a cluster don't collide.
//   - INCR + EXPIRE-NX (Redis 7+ flag): EXPIRE applies only when the key has
//     no TTL, so subsequent increments inside the window do NOT slide the
//     window forward. The window starts on the FIRST rejection and elapses
//     1h later regardless of how many additional rejections land inside it.
//   - retryAfterSeconds reads PTTL and rounds UP. Plain `floor(ms/1000)`
//     could return 0 while the cooldown is still active (e.g. PTTL=500ms),
//     so the user would be told "retry now" while still being blocked.

import type { Redis } from 'ioredis'

/** Post-increment count strictly greater than this trips the cooldown. The 4th
 *  rejection in a 1h window is what flips cooldownActive=true. */
export const REJECTION_STORM_THRESHOLD = 3

/** Window length in seconds. Sliding-window starts on the first increment of
 *  a fresh key; subsequent increments do not slide it. */
export const REJECTION_STORM_WINDOW_SECONDS = 3600

export interface RejectionStormResult {
  /** Count AFTER this increment. */
  readonly count: number
  /** True if `count > REJECTION_STORM_THRESHOLD`. */
  readonly cooldownActive: boolean
  /** Seconds remaining in the current 1h window. 0 when cooldown is not
   *  active. Always >= 1 when cooldown IS active (rounded up). */
  readonly retryAfterSeconds: number
}

export interface RejectionStormCounter {
  /** Increment the per-user counter, setting a 1h TTL on the FIRST increment
   *  (subsequent increments inside the window do not extend the TTL).
   *  Returns the post-increment state. */
  incrementAndCheck(userId: string): Promise<RejectionStormResult>
  /** Delete the counter key. Called on a successful 201 from
   *  POST /api/campaigns. No-op when the key does not exist. */
  reset(userId: string): Promise<void>
}

function counterKey(redisKeyPrefix: string, userId: string): string {
  return `${redisKeyPrefix}rejection_storm:${userId}`
}

/** Pre-increment count strictly greater than this trips the cooldown. The 4th
 *  rejection in a 1h window is what flips cooldownActive=true. */
export function createRejectionStormCounter(
  redis: Redis,
  redisKeyPrefix: string,
): RejectionStormCounter {
  async function incrementAndCheck(userId: string): Promise<RejectionStormResult> {
    const key = counterKey(redisKeyPrefix, userId)
    const count = await redis.incr(key)
    // EXPIRE NX (Redis 7+): sets TTL only when the key has no expiry. On the
    // first INCR (fresh key, no TTL) this anchors the 1h window; on every
    // subsequent INCR the NX guard makes it a no-op, preserving the sliding
    // window's start time. Ignoring the return value is intentional — the NX
    // failure (return 0) on subsequent increments is the expected path.
    await redis.expire(key, REJECTION_STORM_WINDOW_SECONDS, 'NX')

    const cooldownActive = count > REJECTION_STORM_THRESHOLD
    if (!cooldownActive) {
      return { count, cooldownActive: false, retryAfterSeconds: 0 }
    }

    // PTTL returns milliseconds remaining. Round UP so the caller never gets
    // retryAfterSeconds=0 while cooldown is still active — a Retry-After: 0
    // would tell the user to retry immediately even though the key still
    // exists. Floor + 1 (when pttl > 0) achieves the round-up.
    const pttlMs = await redis.pttl(key)
    const retryAfterSeconds = pttlMs > 0 ? Math.ceil(pttlMs / 1000) : REJECTION_STORM_WINDOW_SECONDS
    return { count, cooldownActive: true, retryAfterSeconds }
  }

  async function reset(userId: string): Promise<void> {
    await redis.del(counterKey(redisKeyPrefix, userId))
  }

  return { incrementAndCheck, reset }
}
