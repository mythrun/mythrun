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
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'

vi.mock('../llm/profanity.js', () => ({
  classifyProfanity: vi.fn().mockResolvedValue({ profane: false }),
}))

import { buildApp } from '../app.js'
import { createPgPool } from '../db/postgres.js'
import { createRedisClient } from '../redis/client.js'
import { runMigrations } from '../db/migrate.js'
import { guardTestDatabase } from '../db/__tests__/guard-db.js'
import { createRepo } from '../repo/index.js'
import type { AppDeps } from '../app-deps.js'
import { makeStubEnv } from './helpers/stub-env.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../migrations')
const FRONTEND_BASE_URL = 'http://localhost:5173'

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: (): void => {
      // discard log output
    },
  }
  return pino(
    { base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } },
    sink,
  )
}

describe('rate-limit per-sub key derivation (POST /api/users/register)', () => {
  let pool: Pool
  let redis: Redis
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })

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
