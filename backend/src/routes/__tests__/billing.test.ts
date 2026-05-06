// backend/src/routes/__tests__/billing.test.ts
//
// MYT-42 billing routes plugin.
//
// Task 25 — GET /api/billing/skus:
//   1. 200 + Cache-Control header + publicListing shape
//   2. No JWT required (public route)
//   3. Null cache → 503 with code 'sku_cache_unavailable'
//   4. Response excludes stripe_price_id at runtime (defense in depth)
//
// Task 26 — GET /api/billing/balance:
//   1. Happy path: user with credits + active sub → 200 with full shape
//   2. No active sub: user with no subscription row → 200 with active_subscription: null
//   3. Unauthenticated (no auth plugin): 401
//   4. User not found (JWT present, no users row): 403 username_required
//
// Task 27 — GET /api/billing/subscription:
//   1. Happy path: user with active sub → 200 with full subscription shape
//   2. No active sub: user with no subscription row → 200 with active_subscription: null
//   3. Unauthenticated (no auth plugin): 401
//   4. User not found (JWT present, no users row): 403 username_required

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import {
  setSkuCache,
  _resetSkuCacheForTests,
  type SkuCache,
  type SkuPublicListing,
} from '../../billing/sku-cache.js'
import { billingRoutes } from '../billing.js'
import { registerPublicRouteAllowlistHook } from '../../auth/public-route-allowlist.js'
import { bypassPlugin } from '../../auth/bypass-plugin.js'
import { requireOnboarded } from '../../auth/require-onboarded.js'

// ---------------------------------------------------------------------------
// Module-level mocks. vi.mock calls are hoisted before imports.
// ---------------------------------------------------------------------------

vi.mock('../../repo/index.js', () => ({
  createRepo: vi.fn(),
}))

vi.mock('../../repo/user-subscriptions.js', () => ({
  userSubscriptions: {
    getActiveForUser: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// Import mocked modules after the vi.mock declarations.
// ---------------------------------------------------------------------------

import { createRepo } from '../../repo/index.js'
import { userSubscriptions } from '../../repo/user-subscriptions.js'

const mockCreateRepo = vi.mocked(createRepo)
// Store a reference to the mocked userSubscriptions object. Individual tests
// call .getActiveForUser.mockResolvedValue(...) inline via this reference to
// avoid triggering @typescript-eslint/unbound-method on destructured methods.
const mockedUserSubscriptions = vi.mocked(userSubscriptions)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_PUBLIC_ENTRY: SkuPublicListing = {
  lookup_key: 'sku_session',
  displayName: 'Session',
  type: 'one_time',
  sessionsGranted: 1,
  worldsGranted: 0,
  price: { unit_amount_cents: 499, currency: 'usd' },
}

const FIXTURE_INTERNAL_ENTRY = {
  ...FIXTURE_PUBLIC_ENTRY,
  stripe_price_id: 'price_1ABCxyz_internal_only',
} as const

const FIXTURE_CACHE: SkuCache = {
  byLookupKey: new Map([[FIXTURE_PUBLIC_ENTRY.lookup_key, FIXTURE_INTERNAL_ENTRY]]),
  byPriceId: new Map([['price_1ABCxyz_internal_only', FIXTURE_INTERNAL_ENTRY]]),
  publicListing: [FIXTURE_PUBLIC_ENTRY],
}

const FIXTURE_SUB_ROW = {
  id: '018e2b3c-0000-7000-8000-000000000001',
  user_id: '018e2b3c-0000-7000-8000-000000000002',
  stripe_subscription_id: 'sub_test_fixture_01',
  tier_lookup_key: 'tier_adventurer',
  status: 'active',
  current_period_start: new Date('2026-05-01T00:00:00.000Z'),
  current_period_end: new Date('2026-06-01T00:00:00.000Z'),
  cancel_at_period_end: false,
  cancel_at: null as Date | null,
  cancellation_details: null,
  stripe_event_created_at: new Date('2026-05-01T00:00:00.000Z'),
  created_at: new Date('2026-05-01T00:00:00.000Z'),
  updated_at: new Date('2026-05-01T00:00:00.000Z'),
}

const BYPASS_USER_ID = '018e2b3c-0000-7000-8000-000000000002'
const BYPASS_SUB = 'bypass:dev-1' // matches bypass-plugin.ts BYPASS_USER.sub

// ---------------------------------------------------------------------------
// Mock repo factory
// ---------------------------------------------------------------------------

interface MockRepoOpts {
  userFound?: boolean
  sessionBalance?: number
  worldGenBalance?: number
}

function makeMockRepo(opts: MockRepoOpts = {}): ReturnType<typeof createRepo> {
  const { userFound = true, sessionBalance = 5, worldGenBalance = 2 } = opts

  return {
    users: {
      getByCognitoSub: vi.fn((sub: string) => {
        if (userFound && sub === BYPASS_SUB) {
          return Promise.resolve({
            id: BYPASS_USER_ID,
            cognitoSub: BYPASS_SUB,
            username: 'bypass',
            displayName: 'Bypass',
          })
        }
        return Promise.resolve(null)
      }),
    },
    credits: {
      balance: vi.fn((_userId: string, type: string) => {
        if (type === 'session') return Promise.resolve(sessionBalance)
        if (type === 'world_gen') return Promise.resolve(worldGenBalance)
        return Promise.resolve(0)
      }),
    },
  } as unknown as ReturnType<typeof createRepo>
}

// ---------------------------------------------------------------------------
// Stub pool — billingRoutes needs a Pool reference. The route logic accesses
// the pool only through getActiveForUser (mocked) and repo methods (mocked).
// If anything bypasses the mocks and reaches pool directly, we throw loudly.
// ---------------------------------------------------------------------------

function stubPool(): Pool {
  return {
    query: (): never => { throw new Error('stubPool: unexpected pool.query call') },
    connect: (): never => { throw new Error('stubPool: unexpected pool.connect call') },
  } as unknown as Pool
}

// ---------------------------------------------------------------------------
// App factories
// ---------------------------------------------------------------------------

async function buildAuthedTestApp(): Promise<FastifyInstance> {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('COGNITO_USER_POOL_ID', '')
  vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
  vi.stubEnv('COGNITO_ISSUER_URL', '')
  vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
  // Bypass plugin Layer 2b: make the ECS metadata probe fail (not on ECS).
  globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))

  const app = Fastify({ logger: false })
  registerPublicRouteAllowlistHook(app)
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(bypassPlugin)
  await app.register(billingRoutes, { pool: stubPool() })
  await app.ready()
  return app
}

// No-auth app: request.user is never set → requireOnboarded sends 401.
async function buildNoAuthTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  registerPublicRouteAllowlistHook(app)
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  // Pool stub that returns empty rows — the preHandler exits at !request.user.
  const noAuthPool = {
    query: (): Promise<{ rows: unknown[] }> => Promise.resolve({ rows: [] }),
    connect: (): Promise<{ query: () => Promise<{ rows: unknown[] }>; release: () => void }> =>
      Promise.resolve({ query: () => Promise.resolve({ rows: [] }), release: () => undefined }),
  } as unknown as Pool
  await app.register(requireOnboarded, { pool: noAuthPool })
  await app.register(billingRoutes, { pool: stubPool() })
  await app.ready()
  return app
}

async function buildPublicTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  registerPublicRouteAllowlistHook(app)
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(billingRoutes, { pool: stubPool() })
  await app.ready()
  return app
}

// ===========================================================================
// Task 25: GET /api/billing/skus
// ===========================================================================

// eslint-disable-next-line max-lines-per-function
describe('billingRoutes — GET /api/billing/skus (MYT-42 Task 25)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    _resetSkuCacheForTests()
    setSkuCache(FIXTURE_CACHE)
    mockCreateRepo.mockReturnValue(makeMockRepo())
    app = await buildPublicTestApp()
  })

  afterAll(async () => {
    _resetSkuCacheForTests()
    await app.close()
    vi.unstubAllEnvs()
  })

  it('returns 200 with Cache-Control header and publicListing array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/billing/skus' })

    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=300')

    const body: unknown = res.json()
    expect(Array.isArray(body)).toBe(true)
    const list = body as SkuPublicListing[]
    expect(list).toHaveLength(1)

    const entry = list[0]
    expect(entry).toBeDefined()
    expect(entry).toHaveProperty('lookup_key', FIXTURE_PUBLIC_ENTRY.lookup_key)
    expect(entry).toHaveProperty('displayName', FIXTURE_PUBLIC_ENTRY.displayName)
    expect(entry).toHaveProperty('type', FIXTURE_PUBLIC_ENTRY.type)
    expect(entry).toHaveProperty('sessionsGranted', FIXTURE_PUBLIC_ENTRY.sessionsGranted)
    expect(entry).toHaveProperty('worldsGranted', FIXTURE_PUBLIC_ENTRY.worldsGranted)
    expect(entry).toHaveProperty('price')
    // Access price via typed cast to avoid dot-notation violations on snake_case keys.
    const typedEntry = entry as { price: { unit_amount_cents: number; currency: string } }
    expect(typedEntry.price.unit_amount_cents).toBe(499)
    expect(typedEntry.price.currency).toBe('usd')
  })

  it('returns 200 without an Authorization header (public route)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/billing/skus' })
    expect(res.statusCode).toBe(200)
  })

  it('returns 503 with code sku_cache_unavailable when cache is null', async () => {
    _resetSkuCacheForTests()
    const res = await app.inject({ method: 'GET', url: '/api/billing/skus' })
    expect(res.statusCode).toBe(503)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('sku_cache_unavailable')
  })

  it('excludes stripe_price_id from the response payload', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/billing/skus' })
    expect(res.statusCode).toBe(200)
    const body = res.json<unknown[]>()
    expect(body).toHaveLength(1)
    const entry = body[0] as Record<string, unknown>
    expect(entry).not.toHaveProperty('stripe_price_id')
  })
})

// ===========================================================================
// Task 26: GET /api/billing/balance
// ===========================================================================

// eslint-disable-next-line max-lines-per-function
describe('billingRoutes — GET /api/billing/balance (MYT-42 Task 26)', () => {
  let app: FastifyInstance | undefined
  let noAuthApp: FastifyInstance | undefined

  beforeEach(() => {
    _resetSkuCacheForTests()
    vi.clearAllMocks()
    app = undefined
    noAuthApp = undefined
  })

  afterAll(async () => {
    if (app) await app.close()
    if (noAuthApp) await noAuthApp.close()
    vi.unstubAllEnvs()
  })

  it('returns 200 with credit balances and active_subscription when sub exists', async () => {
    mockCreateRepo.mockReturnValue(makeMockRepo({ sessionBalance: 3, worldGenBalance: 1 }))
    mockedUserSubscriptions.getActiveForUser.mockResolvedValue({ ...FIXTURE_SUB_ROW })
    app = await buildAuthedTestApp()

    const res = await app.inject({ method: 'GET', url: '/api/billing/balance' })

    expect(res.statusCode).toBe(200)
    const body = res.json<{
      session: number
      world_gen: number
      active_subscription: { tier_lookup_key: string; current_period_end: string; cancel_at_period_end: boolean; status: string } | null
    }>()
    expect(body.session).toBe(3)
    expect(body.world_gen).toBe(1)
    expect(body.active_subscription).not.toBeNull()
    // active_subscription is verified non-null above; direct access is safe.
    const sub = body.active_subscription
    if (sub === null) throw new Error('active_subscription unexpectedly null')
    expect(sub.tier_lookup_key).toBe('tier_adventurer')
    expect(sub.current_period_end).toBe('2026-06-01T00:00:00.000Z')
    expect(sub.cancel_at_period_end).toBe(false)
    expect(sub.status).toBe('active')
  })

  it('returns 200 with active_subscription: null when user has no subscription', async () => {
    mockCreateRepo.mockReturnValue(makeMockRepo())
    mockedUserSubscriptions.getActiveForUser.mockResolvedValue(null)
    app = await buildAuthedTestApp()

    const res = await app.inject({ method: 'GET', url: '/api/billing/balance' })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ session: number; world_gen: number; active_subscription: null }>()
    expect(body.session).toBe(5)
    expect(body.world_gen).toBe(2)
    expect(body.active_subscription).toBeNull()
  })

  it('returns 401 when request carries no JWT (no auth plugin registered)', async () => {
    mockCreateRepo.mockReturnValue(makeMockRepo())
    noAuthApp = await buildNoAuthTestApp()

    const res = await noAuthApp.inject({ method: 'GET', url: '/api/billing/balance' })

    expect(res.statusCode).toBe(401)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('unauthenticated')
  })

  it('returns 403 username_required when authenticated user has no users row', async () => {
    mockCreateRepo.mockReturnValue(makeMockRepo({ userFound: false }))
    mockedUserSubscriptions.getActiveForUser.mockResolvedValue(null)
    app = await buildAuthedTestApp()

    const res = await app.inject({ method: 'GET', url: '/api/billing/balance' })

    expect(res.statusCode).toBe(403)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('username_required')
  })
})

// ===========================================================================
// Task 27: GET /api/billing/subscription
// ===========================================================================

// eslint-disable-next-line max-lines-per-function
describe('billingRoutes — GET /api/billing/subscription (MYT-42 Task 27)', () => {
  let app: FastifyInstance | undefined
  let noAuthApp: FastifyInstance | undefined

  beforeEach(() => {
    _resetSkuCacheForTests()
    vi.clearAllMocks()
    app = undefined
    noAuthApp = undefined
  })

  afterAll(async () => {
    if (app) await app.close()
    if (noAuthApp) await noAuthApp.close()
    vi.unstubAllEnvs()
  })

  it('returns 200 with full subscription shape when active sub exists', async () => {
    mockCreateRepo.mockReturnValue(makeMockRepo())
    const subWithCancelAt = { ...FIXTURE_SUB_ROW, cancel_at: new Date('2026-06-01T00:00:00.000Z'), cancel_at_period_end: true }
    mockedUserSubscriptions.getActiveForUser.mockResolvedValue(subWithCancelAt)
    app = await buildAuthedTestApp()

    const res = await app.inject({ method: 'GET', url: '/api/billing/subscription' })

    expect(res.statusCode).toBe(200)
    const body = res.json<{
      active_subscription: {
        tier_lookup_key: string
        stripe_subscription_id: string
        status: string
        current_period_start: string
        current_period_end: string
        cancel_at_period_end: boolean
        cancel_at: string | null
      } | null
    }>()
    expect(body.active_subscription).not.toBeNull()
    const sub = body.active_subscription
    if (sub === null) throw new Error('active_subscription unexpectedly null')
    expect(sub.tier_lookup_key).toBe('tier_adventurer')
    expect(sub.stripe_subscription_id).toBe('sub_test_fixture_01')
    expect(sub.status).toBe('active')
    expect(sub.current_period_start).toBe('2026-05-01T00:00:00.000Z')
    expect(sub.current_period_end).toBe('2026-06-01T00:00:00.000Z')
    expect(sub.cancel_at_period_end).toBe(true)
    expect(sub.cancel_at).toBe('2026-06-01T00:00:00.000Z')
  })

  it('returns 200 with active_subscription: null when user has no subscription', async () => {
    mockCreateRepo.mockReturnValue(makeMockRepo())
    mockedUserSubscriptions.getActiveForUser.mockResolvedValue(null)
    app = await buildAuthedTestApp()

    const res = await app.inject({ method: 'GET', url: '/api/billing/subscription' })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ active_subscription: null }>()
    expect(body.active_subscription).toBeNull()
  })

  it('returns 401 when request carries no JWT (no auth plugin registered)', async () => {
    mockCreateRepo.mockReturnValue(makeMockRepo())
    noAuthApp = await buildNoAuthTestApp()

    const res = await noAuthApp.inject({ method: 'GET', url: '/api/billing/subscription' })

    expect(res.statusCode).toBe(401)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('unauthenticated')
  })

  it('returns 403 username_required when authenticated user has no users row', async () => {
    mockCreateRepo.mockReturnValue(makeMockRepo({ userFound: false }))
    mockedUserSubscriptions.getActiveForUser.mockResolvedValue(null)
    app = await buildAuthedTestApp()

    const res = await app.inject({ method: 'GET', url: '/api/billing/subscription' })

    expect(res.statusCode).toBe(403)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('username_required')
  })
})
