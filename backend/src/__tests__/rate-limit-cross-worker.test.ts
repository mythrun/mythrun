// MYT-45 cross-worker rate-limit enforcement test.
//
// Boots TWO `buildApp()` instances against the SAME dev Redis with the same
// nameSpace prefix. Sends 10 GETs to /api/users/check-username on appA from
// a single IP (the route caps at 10/min, per-IP), then the 11th GET on appB
// from that same IP must return 429 — proving the rate-limit counter is
// shared across processes via Redis, not local to each Fastify instance.
//
// With the previous in-memory store, appB's counter for the IP would be 0
// and the 11th request would return 200.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'

// /api/users/check-username calls classifyProfanity (Haiku) on every hit.
// We don't want the test to depend on Anthropic API availability or a real
// key — mock the classifier to a deterministic "clean" response. Mock must
// precede the buildApp import chain so the route picks up the stub.
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
import {
  noopWorldGenQueue,
  noopSessionPrepQueue,
  noopSessionSuspendQueue,
} from './helpers/stub-deps.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const FRONTEND_BASE_URL = 'http://localhost:5173'

describe('rate-limit cross-worker enforcement', () => {
  let pool: Pool
  let redisA: Redis
  let redisB: Redis
  let appA: Awaited<ReturnType<typeof buildApp>>
  let appB: Awaited<ReturnType<typeof buildApp>>

  // Unique per-file IP base. fileParallelism=false in vitest.config.ts so
  // sequential file execution avoids cross-file IP collisions; the
  // increment-per-test keeps within-file tests isolated.
  const IP_BASE = '198.51.100.'
  let ipCounter = 50

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })

    // Real ioredis clients against the dev Redis. The plugin's INCR/EXPIRE
    // operations must hit a real server to prove cross-worker semantics.
    // Each app instance gets its own ioredis connection — mirrors prod where
    // each ECS task holds its own connection but they all hit the same
    // ElastiCache cluster.
    const redisUrl = process.env.REDIS_REALTIME_URL ?? 'redis://127.0.0.1:6379'
    redisA = createRedisClient(redisUrl)
    redisB = createRedisClient(redisUrl)
    await redisA.connect()
    await redisB.connect()

    const repo = createRepo(pool)

    // Unique nameSpace per test-file run so re-runs don't carry counters
    // from a prior run. The redisKeyPrefix is consumed as `${prefix}rl:`
    // by the plugin (see app.ts).
    const uniquePrefix = `test:rl-cross-${String(Date.now())}:`

    const depsA: AppDeps = {
      pg: pool,
      redisRealtime: redisA,
      redisBatch: {
        ping: () => Promise.resolve('PONG'),
        quit: () => Promise.resolve('OK'),
      } as unknown as Redis,
      redisKeyPrefix: uniquePrefix,
      repo,
      worldGenQueue: noopWorldGenQueue(),
      sessionPrepQueue: noopSessionPrepQueue(),
      sessionSuspendQueue: noopSessionSuspendQueue(),
    }
    const depsB: AppDeps = { ...depsA, redisRealtime: redisB }

    appA = await buildApp(
      depsA,
      { mode: 'bypass' },
      {
        frontendBaseUrl: FRONTEND_BASE_URL,
        env: makeStubEnv({ frontendBaseUrl: FRONTEND_BASE_URL }),
      },
    )
    appB = await buildApp(
      depsB,
      { mode: 'bypass' },
      {
        frontendBaseUrl: FRONTEND_BASE_URL,
        env: makeStubEnv({ frontendBaseUrl: FRONTEND_BASE_URL }),
      },
    )
  })

  afterAll(async () => {
    await appA.close()
    await appB.close()
    await redisA.quit()
    await redisB.quit()
    await pool.end()
  })

  beforeEach(() => {
    ipCounter += 1
  })

  it('hitting per-IP limit on appA produces 429 on appB for the same IP', async () => {
    const ip = `${IP_BASE}${String(ipCounter)}`
    // /api/users/check-username has max: 10/min, per-IP (default keyGenerator).
    // Send 10 successful GETs at appA from this IP.
    for (let i = 0; i < 10; i++) {
      const res = await appA.inject({
        method: 'GET',
        url: '/api/users/check-username?username=foo',
        headers: { 'x-forwarded-for': ip },
      })
      expect(res.statusCode).toBe(200)
    }

    // The 11th request at appB for the same IP must be 429 — proves the
    // Redis store is shared between the two app instances. With the
    // in-memory store, appB has count=0 for this IP and would return 200.
    const res = await appB.inject({
      method: 'GET',
      url: '/api/users/check-username?username=foo',
      headers: { 'x-forwarded-for': ip },
    })
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
  })
})
