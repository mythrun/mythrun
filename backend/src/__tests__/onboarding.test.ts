// Onboarding-route integration tests. Real Postgres + bypass auth.
//
// Phase-4 wave-4d (myth-oehx): migrated from resetData() to scoped
// fixtures. Each test sends a unique sub via the `x-mythrun-dev-sub`
// header (the bypass-plugin override) so the per-sub rate-limit on
// /api/users/register can't collapse onto one bucket and so the
// scope-cleanup can target only this file's rows.
//
// Tests register literal usernames (`alice`, `bob`, etc.) via the
// route; those literals live as `users.username` values and would
// collide between tests under shared-DB if we didn't switch to
// scope-derived usernames. The scope-prefixed `scope.username(n)`
// values are short (<= 28 chars) alphanumeric → satisfy the route's
// username regex without further escaping.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import IoredisMock from 'ioredis-mock'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'

vi.mock('../llm/profanity.js', () => ({
  classifyProfanity: vi.fn(),
}))

import { createPgPool } from '../db/postgres.js'
import { runMigrations } from '../db/migrate.js'
import { guardTestDatabase } from '../db/__tests__/guard-db.js'
import {
  cleanupTestScope,
  makeTestScope,
  type ScopedSub,
} from '../repo/__tests__/_helpers/test-scope.js'
import { buildApp } from '../app.js'
import type { AppDeps } from '../app-deps.js'
import { createRepo } from '../repo/index.js'
import { classifyProfanity } from '../llm/profanity.js'
import { makeStubEnv } from './helpers/stub-env.js'
import { noopWorldGenQueue } from './helpers/stub-deps.js'

const classifyProfanityMock = vi.mocked(classifyProfanity)

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: (): void => {
      // discard log output
    },
  }
  return pino({ base: { component: 'migrate' } }, sink)
}

describe('onboarding routes (integration)', () => {
  let pool: Pool
  let app: Awaited<ReturnType<typeof buildApp>>
  const scope = makeTestScope('onbd')
  // Each test gets a unique remoteAddress so the in-memory rate-limit
  // store (keyed by request.ip) doesn't bleed between tests. Per-route
  // caps are 5/min and 10/min, so multiple tests on the default
  // 127.0.0.1 bucket would 429 each other after a few calls.
  let testIpCounter = 0
  let currentTestIp = ''
  let currentTestSub: ScopedSub = scope.userSub(0)

  function inject(opts: InjectOptions): Promise<LightMyRequestResponse> {
    // x-mythrun-dev-sub overrides the bypass plugin's fixed sub per test.
    // MYT-45's per-sub rate-limit keying on /api/users/register would
    // otherwise collapse every test in this file onto one counter and
    // 429 the suite after the 5th register call.
    return app.inject({
      ...opts,
      remoteAddress: currentTestIp,
      headers: { ...(opts.headers ?? {}), 'x-mythrun-dev-sub': currentTestSub },
    })
  }

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })

    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('COGNITO_USER_POOL_ID', '')
    vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
    vi.stubEnv('COGNITO_ISSUER_URL', '')
    vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
    globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))

    const deps: AppDeps = {
      pg: pool,
      redisRealtime: new IoredisMock(),
      redisBatch: new IoredisMock(),
      redisKeyPrefix: 'test:use1:',
      repo: createRepo(pool),
      worldGenQueue: noopWorldGenQueue(),
    }
    app = await buildApp(
      deps,
      { mode: 'bypass' },
      { frontendBaseUrl: 'http://localhost:5173', env: makeStubEnv() },
    )
  })

  afterAll(async () => {
    await app.close()
    // credit_ledger has RESTRICT-FK to users; cleanupTestScope already
    // deletes it before users. No purchases / billing_history are
    // created in this file (register grants a trial-credit row whose
    // source_purchase_id / source_billing_history_id are NULL), so no
    // additional satellite cleanup is required.
    await cleanupTestScope(pool, scope)
    await pool.end()
    vi.unstubAllEnvs()
  })

  beforeEach(() => {
    testIpCounter += 1
    // Spread across /16 to avoid colliding with rate-limit's /24 bucketing
    // even if more than 256 tests ever run in this file.
    currentTestIp = `10.0.${String(Math.floor(testIpCounter / 256))}.${String(testIpCounter % 256)}`
    // Per-test unique sub via x-mythrun-dev-sub. Each test reserves
    // testIpCounter * 4 and the three following indices so tests that
    // seed multiple subs (e.g. username-collision) don't collide
    // across tests.
    currentTestSub = scope.userSub(testIpCounter * 4)
    // Default: clean. Tests that exercise the rejection path override
    // with mockResolvedValueOnce / mockResolvedValue below.
    classifyProfanityMock.mockReset()
    classifyProfanityMock.mockResolvedValue({ profane: false })
  })

  describe('POST /api/users/register', () => {
    it('happy path — 201 with user + Location header', async () => {
      const username = scope.username(testIpCounter * 4)
      const displayName = scope.displayName(testIpCounter * 4)
      const res = await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username, displayName },
      })
      expect(res.statusCode).toBe(201)
      expect(res.headers.location).toBe('/api/users/me')
      const body = res.json<{ user: { username: string; displayName: string }; created: boolean }>()
      expect(body.user.username).toBe(username)
      expect(body.user.displayName).toBe(displayName)
      expect(body.created).toBe(true)
    })

    it('invalid format → 400 username_invalid format', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username: '_leading', displayName: 'X' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'username_invalid', reason: 'format' })
    })

    it('impersonation username → 400 username_invalid impersonation', async () => {
      classifyProfanityMock.mockResolvedValueOnce({ profane: true, reason: 'impersonation' })
      const res = await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username: 'admin', displayName: 'X' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'username_invalid', reason: 'impersonation' })
    })

    it('offensive username → 400 username_invalid offensive', async () => {
      classifyProfanityMock.mockResolvedValueOnce({ profane: true, reason: 'offensive' })
      const res = await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username: 'shitstorm', displayName: 'X' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'username_invalid', reason: 'offensive' })
    })

    it('idempotent replay (same sub+username) → 200 created:false', async () => {
      const username = scope.username(testIpCounter * 4)
      const displayName = scope.displayName(testIpCounter * 4)
      const first = await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username, displayName },
      })
      expect(first.statusCode).toBe(201)
      const second = await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username, displayName },
      })
      expect(second.statusCode).toBe(200)
      expect(second.headers['content-location']).toBe('/api/users/me')
      const body = second.json<{ created: boolean }>()
      expect(body.created).toBe(false)
    })

    it('username already taken (different sub) → 409 username_taken with suggestion', async () => {
      // Register under sub A.
      const subA = currentTestSub
      const username = scope.username(testIpCounter * 4)
      const resA = await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username, displayName: scope.displayName(testIpCounter * 4) },
      })
      expect(resA.statusCode).toBe(201)

      // Switch to a different sub and try to register the same username
      // again. The DB's UNIQUE(LOWER(username)) constraint trips → 23505 →
      // handleRegisterUniqueViolation classifies as users_username_lower_key
      // → 409 username_taken with a fresh suggestion.
      currentTestSub = scope.userSub(testIpCounter * 4 + 1)
      const resB = await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username, displayName: scope.displayName(testIpCounter * 4 + 1) },
      })
      expect(resB.statusCode).toBe(409)
      const body = resB.json<{ code: string; suggestion: string }>()
      expect(body.code).toBe('username_taken')
      expect(typeof body.suggestion).toBe('string')
      expect(body.suggestion.length).toBeGreaterThan(0)
      // restore for cleanliness
      currentTestSub = subA
    })

    it('already onboarded under different name → 409 already_onboarded', async () => {
      const firstUsername = scope.username(testIpCounter * 4)
      const secondUsername = scope.username(testIpCounter * 4 + 1)
      await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username: firstUsername, displayName: scope.displayName(testIpCounter * 4) },
      })
      const res = await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username: secondUsername, displayName: scope.displayName(testIpCounter * 4 + 1) },
      })
      expect(res.statusCode).toBe(409)
      const body = res.json<{ code: string; currentUsername: string; requestedUsername: string }>()
      expect(body.code).toBe('already_onboarded')
      expect(body.currentUsername).toBe(firstUsername)
      expect(body.requestedUsername).toBe(secondUsername)
    })

    it('display_name offensive → 400 display_name_invalid', async () => {
      // First call (username clean) → second classifyProfanity call
      // (displayName) is offensive.
      classifyProfanityMock.mockReset()
      classifyProfanityMock.mockResolvedValueOnce({ profane: false })
      classifyProfanityMock.mockResolvedValueOnce({ profane: true, reason: 'offensive' })
      const res = await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username: scope.username(testIpCounter * 4), displayName: 'shitstorm' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'display_name_invalid', reason: 'offensive' })
    })
  })

  describe('GET /api/users/check-username', () => {
    it('valid + available → {available:true}', async () => {
      const res = await inject({
        method: 'GET',
        url: `/api/users/check-username?username=${scope.username(testIpCounter * 4)}`,
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ available: true })
    })

    it('format invalid → {available:false, reason:format}', async () => {
      const res = await inject({ method: 'GET', url: '/api/users/check-username?username=ab' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ available: false, reason: 'format' })
    })

    it('impersonation → {available:false, reason:impersonation}', async () => {
      classifyProfanityMock.mockResolvedValueOnce({ profane: true, reason: 'impersonation' })
      const res = await inject({ method: 'GET', url: '/api/users/check-username?username=admin' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ available: false, reason: 'impersonation' })
    })

    it('taken → {available:false, reason:taken}', async () => {
      const taken = scope.username(testIpCounter * 4)
      await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username: taken, displayName: scope.displayName(testIpCounter * 4) },
      })
      const res = await inject({
        method: 'GET',
        url: `/api/users/check-username?username=${taken}`,
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ available: false, reason: 'taken' })
    })
  })

  describe('GET /api/users/me', () => {
    it('before register → 403 username_required', async () => {
      const res = await inject({ method: 'GET', url: '/api/users/me' })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ code: 'username_required' })
    })

    it('after register → 200 with user', async () => {
      const username = scope.username(testIpCounter * 4)
      await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username, displayName: scope.displayName(testIpCounter * 4) },
      })
      const res = await inject({ method: 'GET', url: '/api/users/me' })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ user: { username: string } }>()
      expect(body.user.username).toBe(username)
    })
  })
})
