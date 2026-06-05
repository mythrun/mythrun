// backend/src/session/session-lock.ts
//
// MYT-66 Task 3 — per-session distributed lock. One container at a time
// drives a campaign's turn loop; this lock is how containers coordinate that
// hand-off across the cluster. Keyed by campaignId, one lock per live session:
//
//   session:lock:{cId}   token (randomUUID) holder, with a PX expiry
//
// Key prefixing follows `${MYTHRUN_ENV}:${REGION_PREFIX}:` (config/env.ts
// `redisKeyPrefix`), with this module appending `session:lock:{cId}` — the
// same convention session-state.ts uses for `session:{cId}:…`.
//
// The lock is COORDINATION, not safety-critical (§4): the turn loop is also
// guarded by the server-ordered `:seq` and Postgres row uniqueness, so a
// brief two-holder window during a network partition degrades to a
// double-render, never data corruption. That's why a simple single-instance
// SET-NX-PX lock (not Redlock) is sufficient here.

import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'

export interface SessionLockHandle {
  /** The randomUUID token written under the lock key. Compared on every
   *  extend/release so a handle can only ever touch ITS OWN lock. */
  readonly token: string
  /** Refreshes the PX expiry IFF we still hold the lock. Returns false when
   *  the lock was lost (token mismatch — expired and re-acquired by another
   *  holder). The caller should then stop driving the turn loop. */
  extend(): Promise<boolean>
  /** Compare-and-delete: drops the lock IFF the token still matches, so a
   *  stale handle can never delete a SUCCESSOR's lock (H12.c). No-op
   *  otherwise. */
  release(): Promise<void>
}

export interface SessionLock {
  /** Acquires the lock for `campaignId`, or returns null if already held.
   *  Atomic via SET NX — two racing containers never both win. */
  tryAcquire(campaignId: string): Promise<SessionLockHandle | null>
}

// Compare-and-extend. The EVAL body runs ATOMICALLY on the Redis server, so
// the GET-then-PEXPIRE is not a check-then-act race: no other client can slip
// between the token check and the expiry refresh. Returns 1 on refresh, 0 on
// token mismatch.
const EXTEND_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end"

// Compare-and-delete. Same atomicity guarantee as EXTEND_LUA: the token check
// and the DEL are one indivisible step, so this can only ever delete OUR lock,
// never a successor's. Returns 1 on delete, 0 on token mismatch.
const RELEASE_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end"

export function createSessionLock(redis: Redis, keyPrefix: string, ttlMs: number): SessionLock {
  const lockKey = (campaignId: string): string => `${keyPrefix}session:lock:${campaignId}`

  const makeHandle = (key: string, token: string): SessionLockHandle => ({
    token,
    extend: async () => {
      const result = await redis.eval(EXTEND_LUA, 1, key, token, ttlMs)
      return result === 1
    },
    release: async () => {
      await redis.eval(RELEASE_LUA, 1, key, token)
    },
  })

  return {
    tryAcquire: async (campaignId) => {
      const key = lockKey(campaignId)
      const token = randomUUID()
      // SET NX PX is atomic: only the first racer gets 'OK'; the rest get null.
      const result = await redis.set(key, token, 'PX', ttlMs, 'NX')
      return result === 'OK' ? makeHandle(key, token) : null
    },
  }
}
