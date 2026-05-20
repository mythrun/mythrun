// MYT-45 per-sub key derivation test for POST /api/users/register.
//
// Under bypass auth every request carries the same sub (`bypass:dev-1`),
// so once the register route's keyGenerator returns `req.user.sub` the
// rate-limit counter is shared across all source IPs for that sub.
//
// This test burns 5 register POSTs from one IP (the configured max=5/min),
// then sends a 6th POST from a DIFFERENT IP and asserts 429. With per-IP
// keying (pre-fix), the 6th would have count=0 and would not 429.
//
// Why we don't assert specific status codes on the priming 5:
//   - The register handler creates a users row + grants a trial credit;
//     the first call may 201, subsequent calls may collide on cognitoSub
//     and 200 (idempotent re-register) or 409 (different username).
//     Profanity classifier is mocked so it never blocks. The point is
//     rate-limit fires BEFORE the handler body — every priming call
//     increments the counter regardless of its eventual status.
//
// The classifyProfanity mock must precede the buildApp import chain so
// the route picks up the stub.
//
// Mirrors the boot pattern in rate-limit-cross-worker.test.ts (decd772).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'

vi.mock('../llm/profanity.js', () => ({
  classifyProfanity: vi.fn().mockResolvedValue({ profane: false }),
}))

import { buildApp } from '../app.js'
import { createPgPool } from '../db/postgres.js'
import { createRedisClient } from '../redis/client.js'
import { guardTestDatabase } from '../db/__tests__/guard-db.js'
import { createRepo } from '../repo/index.js'
import type { AppDeps } from '../app-deps.js'
import { makeStubEnv } from './helpers/stub-env.js'
import { noopWorldGenQueue } from './helpers/stub-deps.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const FRONTEND_BASE_URL = 'http://localhost:5173'

describe('rate-limit per-sub key derivation (POST /api/users/register)', () => {
  let pool: Pool
  let redis: Redis
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })

    const redisUrl = process.env.REDIS_REALTIME_URL ?? 'redis://127.0.0.1:6379'
    redis = createRedisClient(redisUrl)
    await redis.connect()

    const repo = createRepo(pool)
    const deps: AppDeps = {
      pg: pool,
      redisRealtime: redis,
      redisBatch: {
        ping: () => Promise.resolve('PONG'),
        quit: () => Promise.resolve('OK'),
      } as unknown as Redis,
      redisKeyPrefix: `test:rl-sub-${String(Date.now())}:`,
      repo,
      worldGenQueue: noopWorldGenQueue(),
    }
    app = await buildApp(
      deps,
      { mode: 'bypass' },
      {
        frontendBaseUrl: FRONTEND_BASE_URL,
        env: makeStubEnv({ frontendBaseUrl: FRONTEND_BASE_URL }),
      },
    )
  })

  afterAll(async () => {
    // The register POSTs above insert a user row with cognito_sub
    // 'bypass:dev-1' (plus a trial credit_ledger row). Without per-file
    // DROP SCHEMA, that row persists across test files and trips
    // assertions elsewhere (e.g. campaigns-list's "default bypass user
    // is NOT onboarded → 403"). Wipe by sub.
    await pool.query(`DELETE FROM credit_ledger WHERE user_id IN
      (SELECT id FROM users WHERE cognito_sub = 'bypass:dev-1')`)
    await pool.query(`DELETE FROM users WHERE cognito_sub = 'bypass:dev-1'`)
    await app.close()
    await redis.quit()
    await pool.end()
  })

  it('per-sub limit enforced regardless of source IP', async () => {
    // Bypass auth always returns sub `bypass:dev-1`. With per-sub keying,
    // all 6 requests below share one counter even across IPs.
    const IP_A = '198.51.100.180'
    const IP_B = '198.51.100.181'

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-forwarded-for': IP_A, 'content-type': 'application/json' },
        payload: { username: `subtest_${String(i)}`, displayName: `Subtest ${String(i)}` },
      })
      // 201 (first time), 200/409 (collisions on cognitoSub for the same
      // bypass user) are all fine. The point is rate-limit didn't yet fire.
      expect(res.statusCode).not.toBe(429)
    }

    // 6th request from a FRESH IP. Same bypass sub → keyGenerator key
    // matches the prior 5 counter → returns 429. With per-IP keying
    // (pre-fix), IP_B has count=0 and would return some non-429 code.
    const res = await app.inject({
      method: 'POST',
      url: '/api/users/register',
      headers: { 'x-forwarded-for': IP_B, 'content-type': 'application/json' },
      payload: { username: 'subtest_last', displayName: 'Subtest Last' },
    })
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
  })
})
