// MYT-66 Task 3 — session-lock tests.
//
// The lock is the FIRST ioredis `eval` Lua in the codebase, and its
// correctness IS the compare-and-extend / compare-and-delete atomicity —
// which only exists against a real Redis, never ioredis-mock's partial Lua
// emulation. So this suite runs against the REAL realtime Redis (6379, the
// dev docker stack), a unique campaignId per test via `randomUUID()` so
// concurrent runs/tests never collide on the lock key, and `redis.quit()`
// in afterAll.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { createRedisClient } from '../../redis/client.js'
import { createSessionLock, type SessionLock } from '../session-lock.js'

const KEY_PREFIX = 'test:use1:'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('createSessionLock — real Redis SET-NX-PX + Lua extend/release', () => {
  let redis: Redis
  let lock: SessionLock

  beforeAll(async () => {
    redis = createRedisClient(process.env.REDIS_REALTIME_URL ?? 'redis://127.0.0.1:6379')
    // createRedisClient is lazyConnect — connect explicitly so the first
    // tryAcquire doesn't race the TCP handshake.
    await redis.connect()
    lock = createSessionLock(redis, KEY_PREFIX, 5_000)
  })

  afterAll(async () => {
    await redis.quit()
  })

  it('acquires, blocks a second acquire, and re-acquires after release', async () => {
    const campaignId = randomUUID()

    const a = await lock.tryAcquire(campaignId)
    if (a === null) throw new Error('expected initial lock acquisition to succeed')

    // Same campaignId while A holds it → contention → null.
    const b = await lock.tryAcquire(campaignId)
    expect(b).toBeNull()

    await a.release()

    // After release, a fresh acquire succeeds.
    const c = await lock.tryAcquire(campaignId)
    if (c === null) throw new Error('expected re-acquisition after release to succeed')
    await c.release()
  })

  it('extend returns true while held and false from a stale handle after release', async () => {
    const campaignId = randomUUID()

    const a = await lock.tryAcquire(campaignId)
    if (a === null) throw new Error('expected lock acquisition to succeed')

    // Still ours → extend succeeds.
    expect(await a.extend()).toBe(true)

    await a.release()

    // Released → the lock is gone, so our token no longer matches → false.
    expect(await a.extend()).toBe(false)
  })

  it('lets the lock expire when not extended, so a later acquire succeeds', async () => {
    const campaignId = randomUUID()
    const shortLock = createSessionLock(redis, KEY_PREFIX, 200)

    const a = await shortLock.tryAcquire(campaignId)
    if (a === null) throw new Error('expected lock acquisition to succeed')

    // No extend — let the PX window lapse.
    await sleep(300)

    const b = await shortLock.tryAcquire(campaignId)
    if (b === null) throw new Error('expected acquisition after expiry to succeed')
    await b.release()
  })

  it('release is compare-and-delete: a stale handle cannot delete a successor lock', async () => {
    const campaignId = randomUUID()
    const shortLock = createSessionLock(redis, KEY_PREFIX, 200)

    // Handle A acquires, then is left to expire.
    const a = await shortLock.tryAcquire(campaignId)
    if (a === null) throw new Error('expected handle A acquisition to succeed')
    await sleep(300)

    // Handle B acquires the now-free key — a different token.
    const b = await shortLock.tryAcquire(campaignId)
    if (b === null) throw new Error('expected handle B acquisition after expiry to succeed')

    // A's token no longer matches the live lock (B's), so A's extend cannot
    // refresh B's lock — proven self-containedly here (token-mismatch on a
    // LIVE successor, distinct from the released-lock case above).
    expect(await a.extend()).toBe(false)

    // A.release() must be a no-op: its token no longer matches B's lock.
    await a.release()

    // B is still the holder → its extend still succeeds.
    expect(await b.extend()).toBe(true)
    await b.release()
  })
})
