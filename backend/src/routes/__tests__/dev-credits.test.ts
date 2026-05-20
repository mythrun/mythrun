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
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { bypassPlugin } from '../../auth/bypass-plugin.js'
import { devCreditsRoutes } from '../dev-credits.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

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
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    // Sibling repo tests share the same DB; reset to a clean slate so
    // foreign-key chains line up with the fresh migration baseline.
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
    scope = makeTestScope('dev-credits')
  })

  afterAll(async () => {
    // myth-5jdo: cleanup only this scope's rows; seeded dev users +
    // system user survive for the next test file.
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    // myth-5jdo: scoped cleanup replaces the blanket DELETEs from prior
    // iteration. credit_ledger goes first because its user_id FK is
    // RESTRICT against users (handled inside cleanupTestScope).
    await cleanupTestScope(pool, scope)
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
      const sub = scope.userSub(0)
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId, sub, scope.displayName(0), scope.username(0)],
      )

      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/credits/grant',
          headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': sub },
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
      const bypassSub = scope.userSub(0)
      const otherSub = scope.userSub(1)
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [bypassUserId, bypassSub, scope.displayName(0), scope.username(0)],
      )
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [otherUserId, otherSub, scope.displayName(1), scope.username(1)],
      )

      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/credits/grant',
          headers: {
            'content-type': 'application/json',
            'x-mythrun-dev-sub': otherSub,
          },
          payload: { creditType: 'session', amount: 3 },
        })
        expect(res.statusCode).toBe(201)

        // Credits land on the header-pointed user, NOT on the first sub.
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
      const sub = scope.userSub(0)
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId, sub, scope.displayName(0), scope.username(0)],
      )
      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/credits/grant',
          headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': sub },
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
      const sub = scope.userSub(0)
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId, sub, scope.displayName(0), scope.username(0)],
      )
      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/credits/grant',
          headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': sub },
          payload: { creditType: 'world_gen', amount: 101 },
        })
        expect(res.statusCode).toBe(400)
      } finally {
        await app.close()
      }
    })

    it('400 on non-integer amount', async () => {
      const userId = uuidv7()
      const sub = scope.userSub(0)
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId, sub, scope.displayName(0), scope.username(0)],
      )
      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/credits/grant',
          headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': sub },
          payload: { creditType: 'world_gen', amount: 1.5 },
        })
        expect(res.statusCode).toBe(400)
      } finally {
        await app.close()
      }
    })

    it('400 on missing fields', async () => {
      const userId = uuidv7()
      const sub = scope.userSub(0)
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId, sub, scope.displayName(0), scope.username(0)],
      )
      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/credits/grant',
          headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': sub },
          payload: { amount: 5 }, // missing creditType
        })
        expect(res.statusCode).toBe(400)
      } finally {
        await app.close()
      }
    })

    it('400 on unknown creditType', async () => {
      const userId = uuidv7()
      const sub = scope.userSub(0)
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId, sub, scope.displayName(0), scope.username(0)],
      )
      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/dev/credits/grant',
          headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': sub },
          payload: { creditType: 'mystery_credit', amount: 5 },
        })
        expect(res.statusCode).toBe(400)
      } finally {
        await app.close()
      }
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/dev/credits/me — balance + recent ledger entries
  // -------------------------------------------------------------------------

  describe('GET /api/dev/credits/me', () => {
    beforeEach(() => {
      vi.stubEnv('AUTH_MODE', 'bypass')
      vi.stubEnv('NODE_ENV', 'test')
    })

    it('200 with zero balances + empty recent when the user has no ledger entries', async () => {
      const userId = uuidv7()
      const sub = scope.userSub(0)
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId, sub, scope.displayName(0), scope.username(0)],
      )
      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/dev/credits/me',
          headers: { 'x-mythrun-dev-sub': sub },
        })
        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({
          sub,
          balances: { world_gen: 0, session: 0 },
          recent: [],
        })
      } finally {
        await app.close()
      }
    })

    it('200 sums non-expired balances per credit_type and returns recent entries newest-first', async () => {
      const userId = uuidv7()
      const sub = scope.userSub(0)
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId, sub, scope.displayName(0), scope.username(0)],
      )
      // Three world_gen grants (15 total) + one session grant (10).
      // Plus one expired world_gen grant (-5) that should be ignored.
      await pool.query(
        `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type, granted_at)
         VALUES ($1, $2, 'world_gen',  5, 'admin', now() - interval '3 minutes'),
                ($3, $2, 'world_gen',  5, 'admin', now() - interval '2 minutes'),
                ($4, $2, 'world_gen',  5, 'admin', now() - interval '1 minute'),
                ($5, $2, 'session',   10, 'admin', now())`,
        [uuidv7(), userId, uuidv7(), uuidv7(), uuidv7()],
      )
      await pool.query(
        `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type, granted_at, expires_at)
         VALUES ($1, $2, 'world_gen', 999, 'admin', now() - interval '1 hour', now() - interval '1 minute')`,
        [uuidv7(), userId],
      )

      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/dev/credits/me',
          headers: { 'x-mythrun-dev-sub': sub },
        })
        expect(res.statusCode).toBe(200)
        const body = res.json<{
          sub: string
          balances: { world_gen: number; session: number }
          recent: { amount: number; creditType: string; sourceType: string }[]
        }>()
        expect(body.sub).toBe(sub)
        // Expired row excluded; non-expired sum to 15 world_gen + 10 session.
        expect(body.balances).toEqual({ world_gen: 15, session: 10 })
        // Newest first by granted_at. Most recent is the session grant.
        expect(body.recent.length).toBeGreaterThanOrEqual(4)
        expect(body.recent[0]?.creditType).toBe('session')
        expect(body.recent[0]?.amount).toBe(10)
      } finally {
        await app.close()
      }
    })

    it('honors x-mythrun-dev-sub — returns balance for the header-pointed user, not the first sub', async () => {
      const bypassUserId = uuidv7()
      const otherUserId = uuidv7()
      const bypassSub = scope.userSub(0)
      const otherSub = scope.userSub(1)
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES
           ($1, $2, $3, $4), ($5, $6, $7, $8)`,
        [
          bypassUserId, bypassSub, scope.displayName(0), scope.username(0),
          otherUserId, otherSub, scope.displayName(1), scope.username(1),
        ],
      )
      // Grant on bypass-user only — the header-pointed user has nothing.
      await pool.query(
        `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type)
         VALUES ($1, $2, 'world_gen', 42, 'admin')`,
        [uuidv7(), bypassUserId],
      )
      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/dev/credits/me',
          headers: { 'x-mythrun-dev-sub': otherSub },
        })
        expect(res.statusCode).toBe(200)
        const body = res.json<{ sub: string; balances: { world_gen: number; session: number } }>()
        expect(body.sub).toBe(otherSub)
        expect(body.balances).toEqual({ world_gen: 0, session: 0 })
      } finally {
        await app.close()
      }
    })

    it('400 unknown_dev_sub when the header points at a non-seeded user', async () => {
      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/dev/credits/me',
          headers: { 'x-mythrun-dev-sub': 'never-seeded' },
        })
        expect(res.statusCode).toBe(400)
        expect(res.json()).toEqual({ code: 'unknown_dev_sub', sub: 'never-seeded' })
      } finally {
        await app.close()
      }
    })

    it('does NOT register when AUTH_MODE!=bypass', async () => {
      vi.stubEnv('AUTH_MODE', 'real')
      const app = Fastify({ logger: false })
      await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
      await app.register(devCreditsRoutes, { pool })
      await app.ready()
      try {
        const res = await app.inject({ method: 'GET', url: '/api/dev/credits/me' })
        expect(res.statusCode).toBe(404)
      } finally {
        await app.close()
      }
    })

    it('caps recent entries at 20 even when more exist', async () => {
      const userId = uuidv7()
      const sub = scope.userSub(0)
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId, sub, scope.displayName(0), scope.username(0)],
      )
      // Seed 25 ledger entries spread across the last 25 minutes.
      const values: string[] = []
      const params: unknown[] = []
      let p = 1
      for (let i = 0; i < 25; i++) {
        values.push(`($${String(p++)}, $${String(p++)}, 'world_gen', 1, 'admin', now() - interval '${String(i)} minutes')`)
        params.push(uuidv7(), userId)
      }
      await pool.query(
        `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type, granted_at)
         VALUES ${values.join(',')}`,
        params,
      )
      const app = await buildTestApp(pool)
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/dev/credits/me',
          headers: { 'x-mythrun-dev-sub': sub },
        })
        expect(res.statusCode).toBe(200)
        const body = res.json<{ recent: unknown[]; balances: { world_gen: number } }>()
        expect(body.recent).toHaveLength(20)
        // All 25 still counted in the balance — the cap is on the recent list only.
        expect(body.balances.world_gen).toBe(25)
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
      const sub = scope.userSub(0)
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId, sub, scope.displayName(0), scope.username(0)],
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
              'x-mythrun-dev-sub': sub,
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
            'x-mythrun-dev-sub': sub,
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
