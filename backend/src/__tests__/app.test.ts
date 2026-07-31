import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

// requireOnboarded looks up the users row via getByCognitoSubWithTimeout.
// In these tests the Pool is a stub, so we mock the users repo via a
// configurable resolver — tests can flip `usersRepoOnboarded` to false
// to exercise the 403 username_required path. Default true so existing
// tests that just want a working onboarded user keep working.
let usersRepoOnboarded = true
// getByCognitoSubWithTimeout is the self-managing users method requireOnboarded
// calls; the rest of the users surface is unused by these buildApp smoke tests.
// The real createRepo (imported below) composes usersNs ∪ selfManagingUsers, so
// the mock must expose all three named exports index.ts now imports.
const stubOnboardedLookup = () =>
  Promise.resolve(
    usersRepoOnboarded
      ? {
          id: 'stub-user-id',
          cognitoSub: 'bypass:dev-1',
          username: 'bypass',
          displayName: 'Bypass',
          suspendedAt: null,
        }
      : null,
  )
vi.mock('../repo/users.js', () => ({
  usersNs: () => ({}),
  selfManagingUsers: () => ({
    getByCognitoSubWithTimeout: vi.fn().mockImplementation(stubOnboardedLookup),
  }),
  createUsersRepo: () => ({
    getByCognitoSubWithTimeout: vi.fn().mockImplementation(stubOnboardedLookup),
  }),
}))

import Fastify from 'fastify'
import { buildApp } from '../app.js'
import type { AppDeps } from '../app-deps.js'
import type { Pool } from 'pg'
import IoredisMock from 'ioredis-mock'
import { createRepo } from '../repo/index.js'
import { _resetSkuCacheForTests } from '../billing/sku-cache.js'
import { registerPublicRouteAllowlistHook } from '../auth/public-route-allowlist.js'
import { makeStubEnv } from './helpers/stub-env.js'
import { noopSessionSuspendQueue, noopSessionTurnQueue, noopDmTriggerQueue, noopSessionReconcileQueue } from './helpers/stub-deps.js'

const makeStubDeps = (): AppDeps => {
  const mockPool = {} as Pool
  return {
    pg: mockPool,
    redisRealtime: new IoredisMock(),
    redisBatch: new IoredisMock(),
    redisKeyPrefix: 'test:use1:',
    repo: createRepo(mockPool),
    // MYT-51 T12: AppDeps now carries the world-gen queue. None of these
    // tests exercise the enqueue path — a no-op queue satisfies the type
    // contract; tests that DO drive enqueue (routes/__tests__/campaigns-*)
    // build their own spy with assertion hooks.
    worldGenQueue: {
      add: (): Promise<unknown> => Promise.resolve(undefined),
      getJobCounts: (): Promise<Record<string, number>> => Promise.resolve({}),
      getJob: (): Promise<null> => Promise.resolve(null),
    },
    sessionPrepQueue: { add: (): Promise<unknown> => Promise.resolve(undefined), getJob: () => Promise.resolve(null) },
    sessionSuspendQueue: noopSessionSuspendQueue(),
    sessionTurnQueue: noopSessionTurnQueue(),
    dmTriggerQueue: noopDmTriggerQueue(),
    sessionReconcileQueue: noopSessionReconcileQueue(),
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
    globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
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

  // CORS (cross-origin SPA → API). Prod topology is a separate api.mythrun.com
  // with real CORS (not a proxy), so the browser preflights non-simple requests
  // and the API must echo Access-Control-Allow-Origin for the SPA origin. That
  // origin IS config.frontendBaseUrl (stubConfig → http://localhost:5173) — the
  // same validated value loadEnv host-allowlists; no parallel CORS allowlist.
  it('reflects the frontend origin (config.frontendBaseUrl) on a simple request', async () => {
    app = await buildApp(makeStubDeps(), { mode: 'bypass' }, stubConfig())
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    })
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
  })

  it('answers a CORS preflight (OPTIONS) for an API route', async () => {
    app = await buildApp(makeStubDeps(), { mode: 'bypass' }, stubConfig())
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/campaigns/mine',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    })
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    expect(res.headers['access-control-allow-methods']).toContain('GET')
  })

  it('does not authorize a foreign origin', async () => {
    app = await buildApp(makeStubDeps(), { mode: 'bypass' }, stubConfig())
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://evil.example.com' },
    })
    expect(res.headers['access-control-allow-origin']).not.toBe('http://evil.example.com')
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

  it('returns 404 JSON for an unmatched route via setNotFoundHandler', async () => {
    // Exercises app.ts:173-175 — Fastify's default 404 is HTML-ish;
    // buildApp installs a stable JSON shape.
    app = await buildApp(makeStubDeps(), { mode: 'bypass' }, stubConfig())
    const res = await app.inject({ method: 'GET', url: '/this/route/does/not/exist' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Not Found' })
  })

  it('registers the bypass /api/auth/refresh probe stub → 200 null (MYT-102)', async () => {
    // The real auth routes are authMode=real-only; under bypass a 200-null
    // /refresh stub answers the SPA's on-load session probe so it never 404s.
    app = await buildApp(makeStubDeps(), { mode: 'bypass' }, stubConfig())
    const res = await app.inject({ method: 'POST', url: '/api/auth/refresh' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('null')
  })

  it('skips devCreditsRoutes when authMode !== "bypass"', async () => {
    // Exercises the `if (config.env.authMode === 'bypass')` gate at
    // app.ts:297. With authMode='real' the route block is skipped —
    // `/api/dev/credits` should 404 because it was never registered.
    app = await buildApp(
      makeStubDeps(),
      { mode: 'bypass' }, // RegisterAuthOptions still bypass for boot ease
      {
        frontendBaseUrl: 'http://localhost:5173',
        // authMode='real' also drives the MYT-84 auth-route registration, which
        // needs Cognito config (buildApp fail-loud guards undefined); stubs suffice
        // — no network at construction, and this test only checks /api/dev/credits.
        env: makeStubEnv({
          authMode: 'real',
          cognitoHostedUiDomain: 'stub.auth.us-east-1.amazoncognito.com',
          cognitoAppClientId: 'stub-client-id',
        }),
      },
    )
    const res = await app.inject({ method: 'POST', url: '/api/dev/credits' })
    // 404 (not 405/401/403) proves the route was never registered — the
    // dev-credits plugin's `app.post('/api/dev/credits', ...)` block
    // didn't run at all in this configuration.
    expect(res.statusCode).toBe(404)
  })

  it('fails loud when authMode="real" but Cognito config is absent (app.ts:307-309)', async () => {
    // The real-mode BFF session block requires hostedUiDomain + clientId to
    // construct the CognitoOAuthClient. makeStubEnv defaults authMode='bypass'
    // and never sets the cognito fields, so `{ authMode: 'real' }` alone leaves
    // both undefined and trips the fail-loud guard before any registration.
    await expect(
      buildApp(
        makeStubDeps(),
        { mode: 'bypass' },
        {
          frontendBaseUrl: 'http://localhost:5173',
          env: makeStubEnv({ authMode: 'real' }),
        },
      ),
    ).rejects.toThrow(
      'buildApp: authMode=real requires cognitoHostedUiDomain + cognitoAppClientId',
    )
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
