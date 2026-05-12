// MYT-51 T8 — Rejection-storm counter integration test.
//
// Drives a real ioredis client against the dev Redis (REDIS_REALTIME_URL or
// 127.0.0.1:6379 fallback). The counter is INCR + EXPIRE-NX semantics — those
// behaviors must hit a real server to validate against actual Redis, not a
// mock approximation. The 1-hour TTL plus the cooldown threshold of 3 are the
// product-relevant invariants; both are exercised here.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Redis } from 'ioredis'
import { createRedisClient } from '../../redis/client.js'
import { createRejectionStormCounter } from '../rejection-storm.js'

describe('rejection-storm counter', () => {
  let redis: Redis
  // Per-file-run unique prefix avoids cross-test and cross-run pollution. Each
  // it() also appends a unique tail to userId so within-file tests don't
  // interfere via a shared counter.
  const KEY_PREFIX = `test:rejection-storm-${String(Date.now())}-${String(process.pid)}:`
  let userIdCounter = 0

  beforeAll(async () => {
    const redisUrl = process.env.REDIS_REALTIME_URL ?? 'redis://127.0.0.1:6379'
    redis = createRedisClient(redisUrl)
    await redis.connect()
  })

  afterAll(async () => {
    // Sweep any keys this test-file authored. The unique prefix scopes the
    // scan tightly so we don't disturb other suites' keys on the dev Redis.
    const keys = await redis.keys(`${KEY_PREFIX}*`)
    if (keys.length > 0) {
      await redis.del(...keys)
    }
    await redis.quit()
  })

  beforeEach(() => {
    userIdCounter += 1
  })

  function freshUserId(): string {
    return `user-${String(userIdCounter)}`
  }

  it('first increment returns count=1 and cooldownActive=false', async () => {
    const counter = createRejectionStormCounter(redis, KEY_PREFIX)
    const result = await counter.incrementAndCheck(freshUserId())
    expect(result.count).toBe(1)
    expect(result.cooldownActive).toBe(false)
    expect(result.retryAfterSeconds).toBe(0)
  })

  it('counts 1..3 stay below threshold; 4th increment trips cooldown', async () => {
    const counter = createRejectionStormCounter(redis, KEY_PREFIX)
    const userId = freshUserId()

    const r1 = await counter.incrementAndCheck(userId)
    expect(r1.count).toBe(1)
    expect(r1.cooldownActive).toBe(false)

    const r2 = await counter.incrementAndCheck(userId)
    expect(r2.count).toBe(2)
    expect(r2.cooldownActive).toBe(false)

    const r3 = await counter.incrementAndCheck(userId)
    expect(r3.count).toBe(3)
    // Threshold is 3 — count > 3 (i.e. the 4th increment) trips cooldown. The
    // 3rd rejection itself is the boundary; users still get the rejection
    // copy, not the storm copy, until they cross it.
    expect(r3.cooldownActive).toBe(false)

    const r4 = await counter.incrementAndCheck(userId)
    expect(r4.count).toBe(4)
    expect(r4.cooldownActive).toBe(true)
    // The TTL was set to 3600s on first increment; 4 quick increments happen
    // well inside that window, so retryAfterSeconds should be close to 3600
    // and at most equal to it. Allow some slack for the rounding-up rule.
    expect(r4.retryAfterSeconds).toBeGreaterThan(3500)
    expect(r4.retryAfterSeconds).toBeLessThanOrEqual(3600)
  })

  it('reset clears the counter; next increment returns count=1', async () => {
    const counter = createRejectionStormCounter(redis, KEY_PREFIX)
    const userId = freshUserId()

    await counter.incrementAndCheck(userId)
    await counter.incrementAndCheck(userId)
    await counter.reset(userId)

    const post = await counter.incrementAndCheck(userId)
    expect(post.count).toBe(1)
    expect(post.cooldownActive).toBe(false)
    expect(post.retryAfterSeconds).toBe(0)
  })

  it('TTL is set on first increment and NOT reset on subsequent increments', async () => {
    const counter = createRejectionStormCounter(redis, KEY_PREFIX)
    const userId = freshUserId()
    const key = `${KEY_PREFIX}rejection_storm:${userId}`

    await counter.incrementAndCheck(userId)
    const pttlAfterFirst = await redis.pttl(key)
    // Brand new key with 1h TTL: PTTL must be a positive value close to
    // 3_600_000ms. Anything <= 0 means TTL wasn't set (key persistent or
    // missing), which would be the bug we're guarding against.
    expect(pttlAfterFirst).toBeGreaterThan(0)
    expect(pttlAfterFirst).toBeLessThanOrEqual(3_600_000)

    // Sleep a small interval so the PTTL meaningfully decreases. EXPIRE NX on
    // the second INCR must NOT reset the TTL — that's the sliding-window
    // invariant: the window starts on the FIRST rejection in the hour and
    // doesn't restart on each subsequent one.
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50))
    await counter.incrementAndCheck(userId)
    const pttlAfterSecond = await redis.pttl(key)

    expect(pttlAfterSecond).toBeLessThan(pttlAfterFirst)
    // Still positive — we didn't accidentally make the key persistent or
    // delete it. (Bound the lower side too: the key has plenty of TTL left.)
    expect(pttlAfterSecond).toBeGreaterThan(0)
  })

  it('two independent users do not share counters', async () => {
    const counter = createRejectionStormCounter(redis, KEY_PREFIX)
    const userA = freshUserId()
    userIdCounter += 1
    const userB = freshUserId()

    await counter.incrementAndCheck(userA)
    await counter.incrementAndCheck(userA)
    const a3 = await counter.incrementAndCheck(userA)
    expect(a3.count).toBe(3)

    const b1 = await counter.incrementAndCheck(userB)
    expect(b1.count).toBe(1)
    expect(b1.cooldownActive).toBe(false)
  })

  it('reset on a never-incremented user is a no-op', async () => {
    const counter = createRejectionStormCounter(redis, KEY_PREFIX)
    const userId = freshUserId()
    // Should not throw and should not affect a subsequent increment.
    await counter.reset(userId)
    const result = await counter.incrementAndCheck(userId)
    expect(result.count).toBe(1)
  })
})
