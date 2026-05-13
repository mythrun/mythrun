// backend/src/routes/__tests__/dev-credits.test.ts
//
// MYT-51 Task 11. Integration tests for the dev-only POST
// /api/dev/credits/grant route. Uses real Postgres (so the
// `source_type='admin'` schema constraint introduced by migration 012 is
// genuinely exercised) and a small standalone Fastify app rather than
// the full `buildApp` — this keeps the test surface tight on the route
// + repo helper that T11 actually delivers.
//
// Spec: docs/superpowers/specs/2026-05-12-myt-51-world-gen-non-streaming-design.md
// D13 (revised after Roc-C1).

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
import { uuidv7 } from '../../repo/uuidv7.js'
import { bypassPlugin } from '../../auth/bypass-plugin.js'
import { devCreditsRoutes } from '../dev-credits.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

const BYPASS_DEV_SUB = 'bypass:dev-1'

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: (): void => {
      // discard log output
    },
  }
  return pino({ base: { component: 'migrate' } }, sink)
}

// Builds a minimal Fastify app: rate-limit (in-memory; sufficient for
// per-process route tests) + bypassPlugin + devCreditsRoutes. Mirrors
// `buildAuthedTestApp` in billing.test.ts but trimmed to the surface
// this route needs.
async function buildTestApp(pool: Pool): Promise<FastifyInstance> {
  // bypassPlugin's Layer 2b probes the ECS task-metadata endpoint and
  // requires it to FAIL. Replace `fetch` with a guaranteed-reject stub
  // so the probe failure happens deterministically inside the test
  // (matches billing.test.ts).
  globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))

  const app = Fastify({
    logger: false,
    // Trust the X-Forwarded-For header so per-IP rate-limit keys can be
    // controlled from app.inject without spinning up a real listener.
    trustProxy: 1,
  })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(bypassPlugin)
  await app.register(devCreditsRoutes, { pool })
  await app.ready()
  return app
}

describe('POST /api/dev/credits/grant (MYT-51 T11)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    // Sibling repo tests share the same DB; reset to a clean slate so
    // foreign-key chains line up with the fresh migration baseline.
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

  beforeEach(async () => {
    // Clean credit_ledger + non-system users between tests. credit_ledger
    // first because its user_id FK is RESTRICT against users (migration
    // 004 commentary).
    await pool.query('DELETE FROM credit_ledger')
    await pool.query("DELETE FROM users WHERE cognito_sub != 'system:mythrun'")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // -------------------------------------------------------------------------
  // AUTH_MODE gating
  // -------------------------------------------------------------------------

  describe('AUTH_MODE gating', () => {
    it('registers the route when AUTH_MODE=bypass', async () => {
      vi.stubEnv('AUTH_MODE', 'bypass')
      vi.stubEnv('NODE_ENV', 'test')
      const app = await buildTestApp(pool)
      try {
        // 404 from setNotFoundHandler vs a route hit — easiest signal
        // that registration happened. We send an empty body so the
        // handler short-circuits on Zod 400; the *non-404* status is
        // the assertion.
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/credits/grant',
          headers: { 'content-type': 'application/json' },
          payload: {},
        })
        expect(res.statusCode).not.toBe(404)
      } finally {
        await app.close()
      }
    })

    it('does NOT register the route when AUTH_MODE!=bypass', async () => {
      // The plugin is a no-op when AUTH_MODE is not 'bypass'. We can't
      // build the FULL stack here (bypassPlugin's Layer 2a throws when
      // NODE_ENV is production) — instead, register ONLY the rate-limit
      // plugin + devCreditsRoutes against the 'real' AUTH_MODE and
      // assert the POST 404s.
      vi.stubEnv('AUTH_MODE', 'real')
      vi.stubEnv('NODE_ENV', 'test')
      const app = Fastify({ logger: false })
      await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
      await app.register(devCreditsRoutes, { pool })
      await app.ready()
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/credits/grant',
          headers: { 'content-type': 'application/json' },
          payload: { creditType: 'world_gen', amount: 1 },
        })
        expect(res.statusCode).toBe(404)
      } finally {
        await app.close()
      }
    })
  })

  // -------------------------------------------------------------------------
  // Happy path + body validation
  // -------------------------------------------------------------------------

  describe('body validation + happy path', () => {
    beforeEach(() => {
      vi.stubEnv('AUTH_MODE', 'bypass')
      vi.stubEnv('NODE_ENV', 'test')
    })

    it('201 with ledgerId + newBalance for a valid body', async () => {
      const userId = uuidv7()
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId, BYPASS_DEV_SUB, 'BypassDev1', 'bypassdev1'],
      )

      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/credits/grant',
          headers: { 'content-type': 'application/json' },
          payload: { creditType: 'world_gen', amount: 5 },
        })
        expect(res.statusCode).toBe(201)
        const body = res.json<{ ledgerId: string; newBalance: number }>()
        expect(body.ledgerId).toMatch(/^[0-9a-f-]{36}$/)
        expect(body.newBalance).toBe(5)

        // Verify the ledger row has the right shape: source_type='admin',
        // both FKs NULL, source_id NULL.
        const rows = await pool.query<{
          source_type: string
          source_id: string | null
          source_purchase_id: string | null
          source_billing_history_id: string | null
          amount: number
        }>(
          `SELECT source_type, source_id, source_purchase_id,
                  source_billing_history_id, amount
             FROM credit_ledger WHERE id = $1`,
          [body.ledgerId],
        )
        expect(rows.rows).toHaveLength(1)
        const row = rows.rows[0]
        if (!row) throw new Error('row missing')
        expect(row.source_type).toBe('admin')
        expect(row.source_id).toBeNull()
        expect(row.source_purchase_id).toBeNull()
        expect(row.source_billing_history_id).toBeNull()
        expect(row.amount).toBe(5)
      } finally {
        await app.close()
      }
    })

    it('honors x-mythrun-dev-sub — credits land on the active dev sub', async () => {
      const bypassUserId = uuidv7()
      const otherUserId = uuidv7()
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [bypassUserId, BYPASS_DEV_SUB, 'BypassDev1', 'bypassdev1'],
      )
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [otherUserId, 'dev-user-2', 'Other', 'other2'],
      )

      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/credits/grant',
          headers: {
            'content-type': 'application/json',
            'x-mythrun-dev-sub': 'dev-user-2',
          },
          payload: { creditType: 'session', amount: 3 },
        })
        expect(res.statusCode).toBe(201)

        // Credits land on the header-pointed user, NOT on bypass:dev-1.
        const bypassBalance = await pool.query<{ balance: string }>(
          `SELECT COALESCE(SUM(amount), 0)::text AS balance
             FROM credit_ledger WHERE user_id = $1 AND credit_type = 'session'`,
          [bypassUserId],
        )
        const otherBalance = await pool.query<{ balance: string }>(
          `SELECT COALESCE(SUM(amount), 0)::text AS balance
             FROM credit_ledger WHERE user_id = $1 AND credit_type = 'session'`,
          [otherUserId],
        )
        expect(Number(bypassBalance.rows[0]?.balance ?? 0)).toBe(0)
        expect(Number(otherBalance.rows[0]?.balance ?? 0)).toBe(3)
      } finally {
        await app.close()
      }
    })

    it('400 unknown_dev_sub when the header points at a non-existent user', async () => {
      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/credits/grant',
          headers: {
            'content-type': 'application/json',
            'x-mythrun-dev-sub': 'never-seeded',
          },
          payload: { creditType: 'world_gen', amount: 1 },
        })
        expect(res.statusCode).toBe(400)
        expect(res.json()).toEqual({ code: 'unknown_dev_sub', sub: 'never-seeded' })
      } finally {
        await app.close()
      }
    })

    it('400 on negative amount', async () => {
      const userId = uuidv7()
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId, BYPASS_DEV_SUB, 'BypassDev1', 'bypassdev1'],
      )
      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/credits/grant',
          headers: { 'content-type': 'application/json' },
          payload: { creditType: 'world_gen', amount: -1 },
        })
        expect(res.statusCode).toBe(400)
        const body = res.json<{ code: string }>()
        expect(body.code).toBe('invalid_body')
      } finally {
        await app.close()
      }
    })

    it('400 on amount > 100', async () => {
      const userId = uuidv7()
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId, BYPASS_DEV_SUB, 'BypassDev1', 'bypassdev1'],
      )
      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/credits/grant',
          headers: { 'content-type': 'application/json' },
          payload: { creditType: 'world_gen', amount: 101 },
        })
        expect(res.statusCode).toBe(400)
      } finally {
        await app.close()
      }
    })

    it('400 on non-integer amount', async () => {
      const userId = uuidv7()
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId, BYPASS_DEV_SUB, 'BypassDev1', 'bypassdev1'],
      )
      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/credits/grant',
          headers: { 'content-type': 'application/json' },
          payload: { creditType: 'world_gen', amount: 1.5 },
        })
        expect(res.statusCode).toBe(400)
      } finally {
        await app.close()
      }
    })

    it('400 on missing fields', async () => {
      const userId = uuidv7()
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId, BYPASS_DEV_SUB, 'BypassDev1', 'bypassdev1'],
      )
      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/credits/grant',
          headers: { 'content-type': 'application/json' },
          payload: { amount: 5 }, // missing creditType
        })
        expect(res.statusCode).toBe(400)
      } finally {
        await app.close()
      }
    })

    it('400 on unknown creditType', async () => {
      const userId = uuidv7()
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId, BYPASS_DEV_SUB, 'BypassDev1', 'bypassdev1'],
      )
      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/credits/grant',
          headers: { 'content-type': 'application/json' },
          payload: { creditType: 'mystery_credit', amount: 5 },
        })
        expect(res.statusCode).toBe(400)
      } finally {
        await app.close()
      }
    })
  })

  // -------------------------------------------------------------------------
  // Rate limit
  // -------------------------------------------------------------------------

  describe('rate limit', () => {
    beforeEach(() => {
      vi.stubEnv('AUTH_MODE', 'bypass')
      vi.stubEnv('NODE_ENV', 'test')
    })

    it('429 after 30 req/hour from the same IP', async () => {
      const userId = uuidv7()
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId, BYPASS_DEV_SUB, 'BypassDev1', 'bypassdev1'],
      )

      const app = await buildTestApp(pool)
      try {
        const IP = '198.51.100.50'

        for (let i = 0; i < 30; i++) {
          const res = await app.inject({
            method: 'POST',
            url: '/api/dev/credits/grant',
            headers: {
              'content-type': 'application/json',
              'x-forwarded-for': IP,
            },
            payload: { creditType: 'world_gen', amount: 1 },
          })
          // Within the 30/hour budget — 201 every time (or 400 if the
          // body were bad; ours is fine).
          expect(res.statusCode).not.toBe(429)
        }

        const overflow = await app.inject({
          method: 'POST',
          url: '/api/dev/credits/grant',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': IP,
          },
          payload: { creditType: 'world_gen', amount: 1 },
        })
        expect(overflow.statusCode).toBe(429)
      } finally {
        await app.close()
      }
    })
  })
})
