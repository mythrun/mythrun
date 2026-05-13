// backend/src/routes/__tests__/dev-credits-edge.test.ts
//
// Edge-case tests for routes/dev-credits.ts that the primary
// dev-credits.test.ts doesn't reach:
//   - Line 100-103: 401 no_dev_identity on POST /api/dev/credits/grant
//     when request.user is undefined.
//   - Line 140-143: 401 no_dev_identity on GET /api/dev/credits/me
//     when request.user is undefined.
//
// To trigger the 401, we register devCreditsRoutes with AUTH_MODE=bypass
// but WITHOUT the bypassPlugin (so request.user is never set).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { devCreditsRoutes } from '../dev-credits.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: (): void => {
      // discard log output
    },
  }
  return pino({ base: { component: 'migrate' } }, sink)
}

// Builds devCreditsRoutes WITHOUT bypassPlugin → request.user stays
// undefined → the route's `typeof sub !== 'string'` check fires.
async function buildNoIdentityApp(pool: Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(devCreditsRoutes, { pool })
  await app.ready()
  return app
}

describe('dev-credits routes — no_dev_identity defensive branches', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(() => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'test')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('POST /api/dev/credits/grant → 401 no_dev_identity when request.user is undefined', async () => {
    const app = await buildNoIdentityApp(pool)
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/dev/credits/grant',
        headers: { 'content-type': 'application/json' },
        payload: { creditType: 'world_gen', amount: 1 },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ code: 'no_dev_identity' })
    } finally {
      await app.close()
    }
  })

  it('GET /api/dev/credits/me → 401 no_dev_identity when request.user is undefined', async () => {
    const app = await buildNoIdentityApp(pool)
    try {
      const res = await app.inject({ method: 'GET', url: '/api/dev/credits/me' })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ code: 'no_dev_identity' })
    } finally {
      await app.close()
    }
  })
})
