import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'

vi.mock('../llm/profanity.js', () => ({
  classifyProfanity: vi.fn(),
}))

import { createPgPool } from '../db/postgres.js'
import { runMigrations } from '../db/migrate.js'
import { guardTestDatabase } from '../db/__tests__/guard-db.js'
import { resetData } from '../repo/__tests__/_helpers/reset-data.js'
import { buildApp } from '../app.js'
import type { AppDeps } from '../app-deps.js'
import { createRepo } from '../repo/index.js'
import { classifyProfanity } from '../llm/profanity.js'
import { makeStubEnv } from './helpers/stub-env.js'

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
  // Each test gets a unique remoteAddress so the in-memory rate-limit
  // store (keyed by request.ip) doesn't bleed between tests. Per-route
  // caps are 5/min and 10/min, so multiple tests on the default
  // 127.0.0.1 bucket would 429 each other after a few calls.
  let testIpCounter = 0
  let currentTestIp = ''

  function inject(opts: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject({ ...opts, remoteAddress: currentTestIp })
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
      redisRealtime: {
        ping: () => Promise.resolve('PONG'),
        quit: () => Promise.resolve('OK'),
      } as unknown as Redis,
      redisBatch: {
        ping: () => Promise.resolve('PONG'),
        quit: () => Promise.resolve('OK'),
      } as unknown as Redis,
      redisKeyPrefix: 'test:use1:',
      repo: createRepo(pool),
    }
    app = await buildApp(
      deps,
      { mode: 'bypass' },
      { frontendBaseUrl: 'http://localhost:5173', env: makeStubEnv() },
    )
  })

  afterAll(async () => {
    await app.close()
    await pool.end()
    vi.unstubAllEnvs()
  })

  beforeEach(async () => {
    testIpCounter += 1
    // Spread across /16 to avoid colliding with rate-limit's /24 bucketing
    // even if more than 256 tests ever run in this file.
    currentTestIp = `10.0.${String(Math.floor(testIpCounter / 256))}.${String(testIpCounter % 256)}`
    await resetData(pool)
    // Default: clean. Tests that exercise the rejection path override
    // with mockResolvedValueOnce / mockResolvedValue below.
    classifyProfanityMock.mockReset()
    classifyProfanityMock.mockResolvedValue({ profane: false })
  })

  describe('POST /api/users/register', () => {
    it('happy path — 201 with user + Location header', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username: 'alice', displayName: 'Alice' },
      })
      expect(res.statusCode).toBe(201)
      expect(res.headers.location).toBe('/api/users/me')
      const body = res.json<{ user: { username: string; displayName: string }; created: boolean }>()
      expect(body.user.username).toBe('alice')
      expect(body.user.displayName).toBe('Alice')
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
      const first = await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username: 'alice', displayName: 'Alice' },
      })
      expect(first.statusCode).toBe(201)
      const second = await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username: 'alice', displayName: 'Alice' },
      })
      expect(second.statusCode).toBe(200)
      expect(second.headers['content-location']).toBe('/api/users/me')
      const body = second.json<{ created: boolean }>()
      expect(body.created).toBe(false)
    })

    it('already onboarded under different name → 409 already_onboarded', async () => {
      await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username: 'alice', displayName: 'Alice' },
      })
      const res = await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username: 'bob', displayName: 'Bob' },
      })
      expect(res.statusCode).toBe(409)
      const body = res.json<{ code: string; currentUsername: string; requestedUsername: string }>()
      expect(body.code).toBe('already_onboarded')
      expect(body.currentUsername).toBe('alice')
      expect(body.requestedUsername).toBe('bob')
    })

    it('display_name offensive → 400 display_name_invalid', async () => {
      // First call (username 'alice') is clean; second call (displayName) is offensive.
      classifyProfanityMock.mockReset()
      classifyProfanityMock.mockResolvedValueOnce({ profane: false })
      classifyProfanityMock.mockResolvedValueOnce({ profane: true, reason: 'offensive' })
      const res = await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username: 'alice', displayName: 'shitstorm' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'display_name_invalid', reason: 'offensive' })
    })
  })

  describe('GET /api/users/check-username', () => {
    it('valid + available → {available:true}', async () => {
      const res = await inject({ method: 'GET', url: '/api/users/check-username?username=newname' })
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
      await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username: 'alice', displayName: 'Alice' },
      })
      const res = await inject({ method: 'GET', url: '/api/users/check-username?username=Alice' })
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
      await inject({
        method: 'POST',
        url: '/api/users/register',
        payload: { username: 'alice', displayName: 'Alice' },
      })
      const res = await inject({ method: 'GET', url: '/api/users/me' })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ user: { username: string } }>()
      expect(body.user.username).toBe('alice')
    })
  })
})
