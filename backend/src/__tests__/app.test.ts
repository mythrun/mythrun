import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

// requireOnboarded looks up the users row via getByCognitoSubWithTimeout.
// In these tests the Pool is a stub, so we mock the users repo via a
// configurable resolver — tests can flip `usersRepoOnboarded` to false
// to exercise the 403 username_required path. Default true so existing
// tests that just want a working onboarded user keep working.
let usersRepoOnboarded = true
vi.mock('../repo/users.js', () => ({
  createUsersRepo: () => ({
    getByCognitoSubWithTimeout: vi.fn().mockImplementation(() =>
      Promise.resolve(
        usersRepoOnboarded
          ? {
              id: 'stub-user-id',
              cognitoSub: 'bypass:dev-1',
              username: 'bypass',
              displayName: 'Bypass',
            }
          : null,
      ),
    ),
  }),
}))

import Fastify from 'fastify'
import { buildApp } from '../app.js'
import type { AppDeps } from '../app-deps.js'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { createRepo } from '../repo/index.js'
import { _resetSkuCacheForTests } from '../billing/sku-cache.js'
import { registerPublicRouteAllowlistHook } from '../auth/public-route-allowlist.js'
import { makeStubEnv } from './helpers/stub-env.js'

const makeStubDeps = (): AppDeps => {
  const mockPool = {} as Pool
  return {
    pg: mockPool,
    redisRealtime: {} as Redis,
    redisBatch: {} as Redis,
    repo: createRepo(mockPool),
  }
}

const stubConfig = (): { frontendBaseUrl: string; env: ReturnType<typeof makeStubEnv> } => ({
  frontendBaseUrl: 'http://localhost:5173',
  env: makeStubEnv(),
})

describe('buildApp', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('COGNITO_USER_POOL_ID', '')
    vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
    vi.stubEnv('COGNITO_ISSUER_URL', '')
    vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
    // Force the bypass plugin's Layer 2b ECS task-metadata probe to fail
    // (i.e. "we are not on ECS"), so registration proceeds.
    globalThis.fetch = (): Promise<Response> =>
      Promise.reject(new Error('ECONNREFUSED'))
    // The SKU cache is module-level and sticky across tests in this file.
    // Reset before each test so /api/billing/skus tests start from a known
    // empty-cache state.
    _resetSkuCacheForTests()
    // Default the users repo mock to "onboarded user found"; tests that
    // need the null path flip this back to false.
    usersRepoOnboarded = true
  })

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
    vi.unstubAllEnvs()
    _resetSkuCacheForTests()
  })

  it('builds a Fastify instance with no side effects on import', async () => {
    app = await buildApp(makeStubDeps(), { mode: 'bypass' }, stubConfig())
    expect(app).toBeDefined()
  })

  it('/health returns {status:"ok"}', async () => {
    app = await buildApp(makeStubDeps(), { mode: 'bypass' }, stubConfig())
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('encapsulation: auth hook applies to parent-scope routes', async () => {
    app = await buildApp(makeStubDeps(), { mode: 'bypass' }, stubConfig())
    let attached: unknown = 'sentinel'
    app.get('/post-register-route', (request) => {
      attached = request.user
      return { ok: true }
    })
    const res = await app.inject({ method: 'GET', url: '/post-register-route' })
    expect(res.statusCode).toBe(200)
    expect(attached).toMatchObject({ sub: 'bypass:dev-1' })
  })

  // MYT-42 Task 33 smoke tests — the new wiring registers webhookRoutes,
  // billingRoutes, and the public-route allowlist hook in load-bearing
  // order. These tests pin the registration shape: each route exists
  // (NOT 404) and applies its expected gate.

  it('POST /webhooks/stripe is registered (returns 400 missing_signature, not 404)', async () => {
    app = await buildApp(makeStubDeps(), { mode: 'bypass' }, stubConfig())
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    })
    // 400 proves the route is registered AND the encapsulated raw-body
    // parser ran (the handler reached its stripe-signature header check).
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ code: 'missing_signature' })
  })

  it('GET /api/billing/skus is registered (503 sku_cache_unavailable on empty cache)', async () => {
    app = await buildApp(makeStubDeps(), { mode: 'bypass' }, stubConfig())
    const res = await app.inject({ method: 'GET', url: '/api/billing/skus' })
    // The boot probe normally populates the cache; in unit tests we don't
    // run it, so the route's defensive `if (cache === null)` branch fires
    // and returns 503. Distinguishes "route registered" from "route 404".
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ code: 'sku_cache_unavailable' })
  })

  it('GET /api/billing/balance is gated by requireOnboarded (403 without users row, NOT 404)', async () => {
    // Flip the mocked users repo to return null so requireOnboarded's
    // post-attach gate fails. The 403 (NOT 404) proves the route is
    // registered AND the auth chain is wired — the spec describes this
    // as the JWT-required surface; in bypass mode we exercise the
    // adjacent "no users row" branch which proves the same wiring.
    usersRepoOnboarded = false

    app = await buildApp(makeStubDeps(), { mode: 'bypass' }, stubConfig())
    const res = await app.inject({ method: 'GET', url: '/api/billing/balance' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'username_required' })
  })

  it('public-route allowlist hook rejects non-allowlisted public routes', async () => {
    // Side fastify instance: install the same hook the buildApp wiring
    // installs, then add a public route NOT in the allowlist. The hook
    // fires SYNCHRONOUSLY at route-registration time (not at ready()),
    // so the throw surfaces from the .get() call itself. This is the
    // load-bearing behavior: a misconfigured public route fails fast at
    // boot rather than silently shipping.
    const sideApp = Fastify({ logger: false })
    registerPublicRouteAllowlistHook(sideApp)
    expect(() => {
      sideApp.get('/api/forbidden-public', { config: { auth: 'public' } }, () => ({ ok: true }))
    }).toThrow(/auth: public used on non-allowlisted route: GET \/api\/forbidden-public/)

    await sideApp.close()
  })
})
