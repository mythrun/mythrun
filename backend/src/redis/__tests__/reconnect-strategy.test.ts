// Unit tests for the shared Redis reconnection strategy. The pure delay math
// (capped exponential backoff + equal jitter) is deterministic under an
// injected rng; the strategy factory additionally logs a structured warn per
// attempt and NEVER returns null (indefinite reconnection — cap the delay, not
// the attempt count).

import { describe, expect, it, vi } from 'vitest'
import {
  REDIS_RECONNECT_BASE_MS,
  REDIS_RECONNECT_CAP_MS,
  applyEqualJitter,
  cappedBackoffMs,
  makeReconnectStrategy,
  reconnectDelayMs,
} from '../reconnect-strategy.js'

describe('cappedBackoffMs', () => {
  it('doubles from the base per 1-based attempt', () => {
    expect(cappedBackoffMs(1)).toBe(REDIS_RECONNECT_BASE_MS) // 200
    expect(cappedBackoffMs(2)).toBe(REDIS_RECONNECT_BASE_MS * 2) // 400
    expect(cappedBackoffMs(3)).toBe(REDIS_RECONNECT_BASE_MS * 4) // 800
    expect(cappedBackoffMs(4)).toBe(REDIS_RECONNECT_BASE_MS * 8) // 1600
  })

  it('clamps at the cap and never exceeds it, no matter how large the attempt', () => {
    expect(cappedBackoffMs(100)).toBe(REDIS_RECONNECT_CAP_MS)
    expect(cappedBackoffMs(1000)).toBe(REDIS_RECONNECT_CAP_MS)
    // Monotonic non-decreasing up to the cap.
    for (let n = 1; n < 40; n++) {
      expect(cappedBackoffMs(n)).toBeLessThanOrEqual(REDIS_RECONNECT_CAP_MS)
      expect(cappedBackoffMs(n + 1)).toBeGreaterThanOrEqual(cappedBackoffMs(n))
    }
  })
})

describe('applyEqualJitter', () => {
  it('returns the lower half when rng() is 0', () => {
    expect(applyEqualJitter(1000, () => 0)).toBe(500)
  })

  it('returns (almost) the full value when rng() approaches 1', () => {
    // half=500; 500 + floor(0.999*501) = 500 + 500 = 1000
    expect(applyEqualJitter(1000, () => 0.999)).toBe(1000)
  })

  it('stays within [capped/2, capped] for any rng in [0,1)', () => {
    const capped = 800
    for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.9999]) {
      const d = applyEqualJitter(capped, () => r)
      expect(d).toBeGreaterThanOrEqual(capped / 2)
      expect(d).toBeLessThanOrEqual(capped)
    }
  })
})

describe('reconnectDelayMs', () => {
  it('composes capped backoff with equal jitter and never exceeds the cap', () => {
    // attempt 1, rng 0 -> half of base
    expect(reconnectDelayMs(1, () => 0)).toBe(REDIS_RECONNECT_BASE_MS / 2)
    // large attempt is bounded by the cap even at full jitter
    expect(reconnectDelayMs(999, () => 0.9999)).toBe(REDIS_RECONNECT_CAP_MS)
    expect(reconnectDelayMs(999, () => 0)).toBe(REDIS_RECONNECT_CAP_MS / 2)
  })
})

describe('makeReconnectStrategy', () => {
  it('returns a positive delay (never null) and logs a structured warn per attempt', () => {
    const warn = vi.fn()
    const logger = { warn }
    const strategy = makeReconnectStrategy({ label: 'redis-realtime', logger, rng: () => 0 })
    const delay = strategy(3)
    expect(typeof delay).toBe('number')
    expect(delay).toBeGreaterThan(0)
    expect(delay).not.toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'redis.reconnecting',
        label: 'redis-realtime',
        attempt: 3,
        delayMs: delay,
      }),
      expect.any(String),
    )
  })

  it('keeps returning a bounded number at very high attempt counts (indefinite retry)', () => {
    const strategy = makeReconnectStrategy({ label: 'x', logger: { warn: vi.fn() }, rng: () => 0.5 })
    for (const n of [1, 10, 100, 10_000]) {
      const d = strategy(n)
      expect(d).toBeGreaterThan(0)
      expect(d).toBeLessThanOrEqual(REDIS_RECONNECT_CAP_MS)
    }
  })

  it('defaults rng to Math.random when none is injected (still bounded)', () => {
    const strategy = makeReconnectStrategy({ label: 'x', logger: { warn: vi.fn() } })
    const d = strategy(2)
    expect(d).toBeGreaterThanOrEqual(cappedBackoffMs(2) / 2)
    expect(d).toBeLessThanOrEqual(cappedBackoffMs(2))
  })
})
