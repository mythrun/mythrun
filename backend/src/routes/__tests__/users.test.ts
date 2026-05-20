// backend/src/routes/__tests__/users.test.ts
//
// Integration tests for routes/users.ts:
//   - POST /api/users/register: happy path, format-invalid body shapes,
//     profanity rejection on username + displayName, uniqueness handling
//     (already_onboarded same/different, username_taken), 401 on missing
//     auth.
//   - GET /api/users/check-username: valid/format-invalid/profane/taken
//     branches.
//   - GET /api/users/me: 401 missing auth, 403 onboarded missing, 200
//     happy path.
//
// Real Postgres so the unique-constraint paths fire genuinely. The
// Anthropic-backed `classifyProfanity` is mocked at the module boundary;
// each test overrides per-call behavior.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

vi.mock('../../llm/profanity.js', () => ({
  classifyProfanity: vi.fn(),
}))

import { classifyProfanity } from '../../llm/profanity.js'
import { usersRoutes } from '../users.js'

const classifyProfanityMock = vi.mocked(classifyProfanity)

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

interface FakeAuthUser {
  readonly sub: string
}

// Synthetic auth plugin: sets request.user from a per-request header so we
// can drive different subs in the SAME test app without re-registering.
function fakeAuthPlugin() {
  return fp(
    // eslint-disable-next-line @typescript-eslint/require-await
    async (app) => {
      // eslint-disable-next-line @typescript-eslint/require-await
      app.addHook('onRequest', async (request) => {
        const sub = request.headers['x-test-sub']
        if (typeof sub === 'string' && sub.length > 0) {
          ;(request as unknown as { user: FakeAuthUser }).user = Object.freeze({ sub })
        }
      })
    },
    { fastify: '5.x', name: 'fake-auth' },
  )
}

async function buildApp(pool: Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(fakeAuthPlugin())
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(usersRoutes, { pool })
  await app.ready()
  return app
}

describe('usersRoutes', () => {
  let pool: Pool
  let app: FastifyInstance
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
    scope = makeTestScope('users')
  })

  afterAll(async () => {
    // myth-5jdo: cleanup only this scope's rows; the seeded dev users +
    // system user + demo world remain intact for the next test file.
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    classifyProfanityMock.mockReset()
    classifyProfanityMock.mockResolvedValue({ profane: false })
    // myth-5jdo: scoped cleanup replaces the blanket DELETEs from prior
    // iteration. credit_ledger goes first (RESTRICT FK against users)
    // and is handled inside cleanupTestScope.
    await cleanupTestScope(pool, scope)
    app = await buildApp(pool)
  })

  afterEach(async () => {
    await app.close()
  })

  // ----------------------------------------------------------------------
  // POST /api/users/register
  // ----------------------------------------------------------------------

  describe('POST /api/users/register', () => {
    it('201 with user + created=true on happy path; grants 1 session credit and flips free_trial_used', async () => {
      const sub = scope.userSub(0)
      const username = scope.username(0)
      const displayName = scope.displayName(0)
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': sub, 'content-type': 'application/json' },
        payload: { username, displayName },
      })
      expect(res.statusCode).toBe(201)
      expect(res.headers.location).toBe('/api/users/me')
      const body = res.json<{
        created: boolean
        user: { username: string; displayName: string; freeTrialUsed: boolean }
      }>()
      expect(body.created).toBe(true)
      expect(body.user.username).toBe(username)
      expect(body.user.displayName).toBe(displayName)
      expect(body.user.freeTrialUsed).toBe(true)

      // Trial credit row landed.
      const ledger = await pool.query<{ amount: string; credit_type: string; source_type: string }>(
        `SELECT amount::text AS amount, credit_type, source_type
           FROM credit_ledger WHERE user_id = (
             SELECT id FROM users WHERE cognito_sub = $1
           )`,
        [sub],
      )
      expect(ledger.rows).toHaveLength(1)
      expect(ledger.rows[0]?.credit_type).toBe('session')
      expect(ledger.rows[0]?.source_type).toBe('trial')
      expect(Number(ledger.rows[0]?.amount)).toBe(1)
    })

    it('401 unauthenticated when no auth header is set', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'content-type': 'application/json' },
        payload: { username: scope.username(0), displayName: scope.displayName(0) },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ code: 'unauthenticated' })
    })

    it('400 username_invalid/format on too-short username', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': scope.userSub(0), 'content-type': 'application/json' },
        payload: { username: 'ab', displayName: scope.displayName(0) },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'username_invalid', reason: 'format' })
    })

    it('400 username_invalid/format on too-long username', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': scope.userSub(0), 'content-type': 'application/json' },
        payload: { username: 'a'.repeat(21), displayName: scope.displayName(0) },
      })
      expect(res.statusCode).toBe(400)
    })

    it('400 username_invalid/format on regex mismatch (leading underscore)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': scope.userSub(0), 'content-type': 'application/json' },
        payload: { username: '_alice', displayName: scope.displayName(0) },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'username_invalid', reason: 'format' })
    })

    it('400 username_invalid/format on missing displayName', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': scope.userSub(0), 'content-type': 'application/json' },
        payload: { username: scope.username(0) },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'username_invalid', reason: 'format' })
    })

    it('400 username_invalid/format on non-object body (JSON array)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': scope.userSub(0), 'content-type': 'application/json' },
        // Arrays are typeof 'object' but parseRegisterBody treats them as
        // "no fields" → returns null → 400 username_invalid/format.
        payload: [],
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'username_invalid', reason: 'format' })
    })

    it('400 username_invalid/format on non-string username (typeof check)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': scope.userSub(0), 'content-type': 'application/json' },
        // username is a number → parseRegisterBody rejects on typeof check.
        payload: { username: 12345, displayName: scope.displayName(0) },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'username_invalid', reason: 'format' })
    })

    it('400 username_invalid/format on non-string displayName (typeof check)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': scope.userSub(0), 'content-type': 'application/json' },
        payload: { username: scope.username(0), displayName: 12345 },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'username_invalid', reason: 'format' })
    })

    it('400 username_invalid/<reason> when classifyProfanity flags the USERNAME', async () => {
      // First call (username) → profane; we don't need to seed a second response
      // because the route returns before the displayName check.
      classifyProfanityMock.mockResolvedValueOnce({ profane: true, reason: 'offensive' })
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': scope.userSub(0), 'content-type': 'application/json' },
        payload: { username: scope.username(0), displayName: scope.displayName(0) },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'username_invalid', reason: 'offensive' })
    })

    it('400 username_invalid/offensive when classifyProfanity returns profane with no reason (fallback)', async () => {
      classifyProfanityMock.mockResolvedValueOnce({ profane: true })
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': scope.userSub(0), 'content-type': 'application/json' },
        payload: { username: scope.username(0), displayName: scope.displayName(0) },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'username_invalid', reason: 'offensive' })
    })

    it('400 display_name_invalid/<reason> when classifyProfanity flags the DISPLAY NAME', async () => {
      // First call (username) → clean; second (display) → profane.
      classifyProfanityMock
        .mockResolvedValueOnce({ profane: false })
        .mockResolvedValueOnce({ profane: true, reason: 'impersonation' })
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': scope.userSub(0), 'content-type': 'application/json' },
        payload: { username: scope.username(0), displayName: 'Mythrun Staff' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'display_name_invalid', reason: 'impersonation' })
    })

    it('400 display_name_invalid/offensive when classifyProfanity returns profane with no reason (fallback)', async () => {
      classifyProfanityMock
        .mockResolvedValueOnce({ profane: false })
        .mockResolvedValueOnce({ profane: true })
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': scope.userSub(0), 'content-type': 'application/json' },
        payload: { username: scope.username(0), displayName: 'BadDisplay' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'display_name_invalid', reason: 'offensive' })
    })

    it('200 already_onboarded_same: same sub + same username re-register → returns existing row', async () => {
      const sub = scope.userSub(0)
      const username = scope.username(0)
      // First registration.
      await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': sub, 'content-type': 'application/json' },
        payload: { username, displayName: scope.displayName(0) },
      })
      // Second attempt — same sub, same username.
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': sub, 'content-type': 'application/json' },
        payload: { username, displayName: scope.displayName(1) },
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-location']).toBe('/api/users/me')
      const body = res.json<{ created: boolean; user: { username: string } }>()
      expect(body.created).toBe(false)
      expect(body.user.username).toBe(username)
    })

    it('409 already_onboarded when same sub re-registers with a DIFFERENT username', async () => {
      const sub = scope.userSub(0)
      const firstUsername = scope.username(0)
      const secondUsername = scope.username(1)
      await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': sub, 'content-type': 'application/json' },
        payload: { username: firstUsername, displayName: scope.displayName(0) },
      })
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': sub, 'content-type': 'application/json' },
        payload: { username: secondUsername, displayName: scope.displayName(1) },
      })
      expect(res.statusCode).toBe(409)
      const body = res.json<{
        code: string
        currentUsername: string
        requestedUsername: string
      }>()
      expect(body.code).toBe('already_onboarded')
      expect(body.currentUsername).toBe(firstUsername)
      expect(body.requestedUsername).toBe(secondUsername)
    })

    it('409 username_taken when DIFFERENT sub requests an existing username; suggestion is non-profane', async () => {
      // Seed an existing row.
      const ownerSub = scope.userSub(0)
      const otherSub = scope.userSub(1)
      // The suggestion format is `${base}\d{3}` — the route appends 3
      // digits to the requested username. Base + 3 digits must satisfy
      // the 20-char username cap, so we use a short scoped marker that
      // leaves the 3-digit headroom.
      const taken = `${scope.id.replace(/-/g, '').slice(0, 13)}p`
      await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': ownerSub, 'content-type': 'application/json' },
        payload: { username: taken, displayName: scope.displayName(0) },
      })
      // New sub asks for the same username.
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': otherSub, 'content-type': 'application/json' },
        payload: { username: taken, displayName: scope.displayName(1) },
      })
      expect(res.statusCode).toBe(409)
      const body = res.json<{ code: string; suggestion: string }>()
      expect(body.code).toBe('username_taken')
      // suggestion = base + 3 digits.
      expect(body.suggestion).toMatch(new RegExp(`^${taken}\\d{3}$`))
    })

    it('username_taken: suggestion retries when first generated suggestion is profane', async () => {
      // Seed an existing row.
      const ownerSub = scope.userSub(0)
      const otherSub = scope.userSub(1)
      const taken = `${scope.id.replace(/-/g, '').slice(0, 13)}p`
      await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': ownerSub, 'content-type': 'application/json' },
        payload: { username: taken, displayName: scope.displayName(0) },
      })
      // For the conflict-driven re-registration:
      //   1st classify call → username profanity check (clean)
      //   2nd classify call → display name profanity check (clean)
      //   3rd classify call → FIRST suggestion (profane — forces retry)
      //   4th classify call → SECOND suggestion (clean)
      classifyProfanityMock.mockReset()
      classifyProfanityMock
        .mockResolvedValueOnce({ profane: false })
        .mockResolvedValueOnce({ profane: false })
        .mockResolvedValueOnce({ profane: true, reason: 'offensive' })
        .mockResolvedValue({ profane: false })

      const res = await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': otherSub, 'content-type': 'application/json' },
        payload: { username: taken, displayName: scope.displayName(1) },
      })
      expect(res.statusCode).toBe(409)
      const body = res.json<{ code: string; suggestion: string }>()
      expect(body.code).toBe('username_taken')
      expect(body.suggestion).toMatch(new RegExp(`^${taken}\\d{3}$`))
    })
  })

  // ----------------------------------------------------------------------
  // GET /api/users/check-username
  // ----------------------------------------------------------------------

  describe('GET /api/users/check-username', () => {
    it('available=true for a clean, unseeded username', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/users/check-username?username=${scope.username(0)}`,
        headers: { 'x-test-sub': scope.userSub(0) },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ available: true })
    })

    it('available=false/format when the query is missing the username param', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/users/check-username',
        headers: { 'x-test-sub': scope.userSub(0) },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ available: false, reason: 'format' })
    })

    it('available=false/format when the username fails the regex', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/users/check-username?username=_bad',
        headers: { 'x-test-sub': scope.userSub(0) },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ available: false, reason: 'format' })
    })

    it('available=false/<reason> when profanity is flagged', async () => {
      classifyProfanityMock.mockResolvedValueOnce({ profane: true, reason: 'offensive' })
      const res = await app.inject({
        method: 'GET',
        url: `/api/users/check-username?username=${scope.username(0)}`,
        headers: { 'x-test-sub': scope.userSub(0) },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ available: false, reason: 'offensive' })
    })

    it('available=false/offensive when profanity returns no reason (fallback)', async () => {
      classifyProfanityMock.mockResolvedValueOnce({ profane: true })
      const res = await app.inject({
        method: 'GET',
        url: `/api/users/check-username?username=${scope.username(0)}`,
        headers: { 'x-test-sub': scope.userSub(0) },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ available: false, reason: 'offensive' })
    })

    it('available=false/taken when the username already exists', async () => {
      // Seed an existing row.
      const ownerSub = scope.userSub(0)
      const otherSub = scope.userSub(1)
      const taken = scope.username(0)
      await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': ownerSub, 'content-type': 'application/json' },
        payload: { username: taken, displayName: scope.displayName(0) },
      })
      const res = await app.inject({
        method: 'GET',
        url: `/api/users/check-username?username=${taken}`,
        headers: { 'x-test-sub': otherSub },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ available: false, reason: 'taken' })
    })
  })

  // ----------------------------------------------------------------------
  // GET /api/users/me
  // ----------------------------------------------------------------------

  describe('GET /api/users/me', () => {
    it('401 unauthenticated when no auth header is set', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/users/me' })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ code: 'unauthenticated' })
    })

    it('403 username_required when authenticated user has no row yet', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/users/me',
        headers: { 'x-test-sub': scope.userSub(0) },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ code: 'username_required' })
    })

    it('200 returns the caller users row', async () => {
      // Seed via register so the row + trial credit are in place.
      const sub = scope.userSub(0)
      const username = scope.username(0)
      const displayName = scope.displayName(0)
      await app.inject({
        method: 'POST',
        url: '/api/users/register',
        headers: { 'x-test-sub': sub, 'content-type': 'application/json' },
        payload: { username, displayName },
      })
      const res = await app.inject({
        method: 'GET',
        url: '/api/users/me',
        headers: { 'x-test-sub': sub },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ user: { username: string; displayName: string } }>()
      expect(body.user.username).toBe(username)
      expect(body.user.displayName).toBe(displayName)
    })
  })
})
