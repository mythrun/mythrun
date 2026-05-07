// backend/src/routes/__tests__/billing.test.ts
/* eslint-disable max-lines -- Tests for all seven MYT-42 billing handlers
 * are colocated in one suite (matches the single-plugin shape of
 * routes/billing.ts and shares fixtures across describe blocks). */
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
//
// Task 28 — GET /api/billing/history:
//   1. Happy path empty: user with no rows → { events: [], nextCursor: null }
//   2. Single page: 30 rows → 30 events + nextCursor: null
//   3. Multi-page: 51 rows → page 1 returns 50 + non-null cursor; page 2 returns 1 + null
//   4. Invalid cursor: malformed base64 → 400 invalid_cursor
//   5. Unauthenticated: 401

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import type { default as Stripe } from 'stripe'
import type { Env } from '../../config/env.js'
import {
  setSkuCache,
  _resetSkuCacheForTests,
  type SkuCache,
  type SkuInternalEntry,
  type SkuPublicListing,
} from '../../billing/sku-cache.js'
import type { LookupKey } from '../../billing/lookup-keys.js'
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

vi.mock('../../repo/billing-history.js', () => ({
  billingHistory: {
    listByUser: vi.fn(),
  },
}))

// Stripe client + find-or-create customer are mocked at the module boundary
// so /checkout tests can drive them without a live Stripe SDK or pg pool.
// `getStripeClient` returns a stub whose .checkout.sessions.create and
// .customers.create methods are individually swappable per test.
vi.mock('../../billing/stripe-client.js', () => ({
  getStripeClient: vi.fn(),
}))

vi.mock('../../billing/customer.js', () => ({
  findOrCreateStripeCustomer: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Import mocked modules after the vi.mock declarations.
// ---------------------------------------------------------------------------

import { createRepo } from '../../repo/index.js'
import { userSubscriptions } from '../../repo/user-subscriptions.js'
import { billingHistory } from '../../repo/billing-history.js'
import type { BillingHistoryRow } from '../../repo/billing-history.js'
import { getStripeClient } from '../../billing/stripe-client.js'
import { findOrCreateStripeCustomer } from '../../billing/customer.js'

const mockCreateRepo = vi.mocked(createRepo)
const mockedGetStripeClient = vi.mocked(getStripeClient)
const mockedFindOrCreateStripeCustomer = vi.mocked(findOrCreateStripeCustomer)
// Store a reference to the mocked userSubscriptions object. Individual tests
// call .getActiveForUser.mockResolvedValue(...) inline via this reference to
// avoid triggering @typescript-eslint/unbound-method on destructured methods.
const mockedUserSubscriptions = vi.mocked(userSubscriptions)
const mockedBillingHistory = vi.mocked(billingHistory)

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

// Stub Env for routes that need env (POST /api/billing/checkout pulls
// `getStripeClient(env)`; that call is mocked at the module boundary so
// the env field values here don't have to be production-shaped — they
// only need to be non-empty enough to satisfy the route's pass-through.
function stubEnv(): Env {
  return Object.freeze({
    databaseUrl: 'postgresql://stub/db',
    redisRealtimeUrl: 'redis://stub:6379',
    redisBatchUrl: 'redis://stub:6379',
    port: 0,
    authMode: 'bypass',
    frontendBaseUrl: 'http://localhost:5173',
    stripeSecretKey: 'rk_test_stub_for_billing_route_tests',
    stripeWebhookSecret: 'whsec_test_stub',
    anthropicApiKey: 'sk-ant-stub-for-billing-route-tests',
  })
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
  await app.register(billingRoutes, { pool: stubPool(), env: stubEnv() })
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
  await app.register(billingRoutes, { pool: stubPool(), env: stubEnv() })
  await app.ready()
  return app
}

async function buildPublicTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  registerPublicRouteAllowlistHook(app)
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(billingRoutes, { pool: stubPool(), env: stubEnv() })
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

// ===========================================================================
// Task 28: GET /api/billing/history
// ===========================================================================

/**
 * Build a minimal BillingHistoryRow fixture. Only fields required by the
 * response mapper are populated; the rest are set to sensible defaults.
 */
function makeHistoryRow(overrides: Partial<BillingHistoryRow> = {}): BillingHistoryRow {
  return {
    id: '018e2b3c-0000-7000-8000-000000000010',
    user_id: BYPASS_USER_ID,
    kind: 'purchase',
    source_id_stripe: 'pi_test_default',
    stripe_payment_intent_id: null,
    lookup_key: null,
    amount_cents: 499,
    currency: 'usd',
    status: 'completed',
    expires_at: null,
    occurred_at: new Date('2026-05-01T12:00:00.000Z'),
    created_at: new Date('2026-05-01T12:00:00.000Z'),
    ...overrides,
  }
}

/** Build `count` distinct history rows with unique ids and source_id_stripe. */
function makeHistoryRows(count: number): BillingHistoryRow[] {
  return Array.from({ length: count }, (_, idx) => {
    const idxStr = String(idx).padStart(3, '0')
    return makeHistoryRow({
      id: `018e2b3c-0000-7000-8000-0000000000${idxStr}`,
      source_id_stripe: `pi_test_${idxStr}`,
    })
  })
}

interface HistoryEvent {
  id: string
  kind: string
  occurred_at: string
  amount_cents: number
  currency: string
  lookup_key: string | null
  status: string
  source_id_stripe: string
}

interface HistoryResponseBody {
  events: HistoryEvent[]
  nextCursor: string | null
}

// eslint-disable-next-line max-lines-per-function
describe('billingRoutes — GET /api/billing/history (MYT-42 Task 28)', () => {
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

  it('returns 200 with events: [] and nextCursor: null when user has no rows', async () => {
    mockCreateRepo.mockReturnValue(makeMockRepo())
    mockedBillingHistory.listByUser.mockResolvedValue({ rows: [], nextCursor: null })
    app = await buildAuthedTestApp()

    const res = await app.inject({ method: 'GET', url: '/api/billing/history' })

    expect(res.statusCode).toBe(200)
    const body = res.json<HistoryResponseBody>()
    expect(body.events).toEqual([])
    expect(body.nextCursor).toBeNull()
  })

  it('returns 200 with 30 events and nextCursor: null for a single page', async () => {
    mockCreateRepo.mockReturnValue(makeMockRepo())
    const rows = makeHistoryRows(30)
    mockedBillingHistory.listByUser.mockResolvedValue({ rows, nextCursor: null })
    app = await buildAuthedTestApp()

    const res = await app.inject({ method: 'GET', url: '/api/billing/history' })

    expect(res.statusCode).toBe(200)
    const body = res.json<HistoryResponseBody>()
    expect(body.events).toHaveLength(30)
    expect(body.nextCursor).toBeNull()
    // Spot-check shape of first event.
    const first = body.events[0]
    expect(first).toBeDefined()
    if (first === undefined) throw new Error('first event unexpectedly undefined')
    expect(first).toHaveProperty('id')
    expect(first).toHaveProperty('kind', 'purchase')
    expect(first).toHaveProperty('occurred_at', '2026-05-01T12:00:00.000Z')
    expect(first).toHaveProperty('amount_cents', 499)
    expect(first).toHaveProperty('currency', 'usd')
    expect(first).toHaveProperty('lookup_key', null)
    expect(first).toHaveProperty('status', 'completed')
    expect(first).toHaveProperty('source_id_stripe')
  })

  it('paginates correctly: 51 rows yields page 1 of 50 + cursor, page 2 of 1 + null', async () => {
    mockCreateRepo.mockReturnValue(makeMockRepo())
    const page1Rows = makeHistoryRows(50)
    const lastRow = page1Rows[49]
    if (lastRow === undefined) throw new Error('fixture error: expected 50 rows')
    const repoNextCursor = JSON.stringify({
      t: lastRow.occurred_at.toISOString(),
      i: lastRow.id,
    })
    mockedBillingHistory.listByUser
      .mockResolvedValueOnce({ rows: page1Rows, nextCursor: repoNextCursor })
      .mockResolvedValueOnce({ rows: makeHistoryRows(1), nextCursor: null })
    app = await buildAuthedTestApp()

    // Page 1 — no cursor.
    const res1 = await app.inject({ method: 'GET', url: '/api/billing/history' })
    expect(res1.statusCode).toBe(200)
    const body1 = res1.json<HistoryResponseBody>()
    expect(body1.events).toHaveLength(50)
    expect(body1.nextCursor).not.toBeNull()

    // Verify cursor round-trips correctly (decode → same t + i).
    const wireNextCursor = body1.nextCursor
    if (wireNextCursor === null) throw new Error('nextCursor unexpectedly null')
    const decoded = JSON.parse(Buffer.from(wireNextCursor, 'base64url').toString('utf8')) as {
      t: string
      i: string
    }
    expect(decoded.t).toBe(lastRow.occurred_at.toISOString())
    expect(decoded.i).toBe(lastRow.id)

    // Page 2 — pass cursor.
    const res2 = await app.inject({
      method: 'GET',
      url: `/api/billing/history?cursor=${wireNextCursor}`,
    })
    expect(res2.statusCode).toBe(200)
    const body2 = res2.json<HistoryResponseBody>()
    expect(body2.events).toHaveLength(1)
    expect(body2.nextCursor).toBeNull()
  })

  it('returns 400 with code invalid_cursor for a malformed cursor', async () => {
    mockCreateRepo.mockReturnValue(makeMockRepo())
    app = await buildAuthedTestApp()

    // Send a cursor string that is valid base64url but decodes to non-JSON.
    const invalidCursor = Buffer.from('not-valid-json!!!', 'utf8').toString('base64url')
    const res = await app.inject({
      method: 'GET',
      url: `/api/billing/history?cursor=${invalidCursor}`,
    })

    expect(res.statusCode).toBe(400)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('invalid_cursor')
  })

  it('returns 401 when request carries no JWT (no auth plugin registered)', async () => {
    mockCreateRepo.mockReturnValue(makeMockRepo())
    noAuthApp = await buildNoAuthTestApp()

    const res = await noAuthApp.inject({ method: 'GET', url: '/api/billing/history' })

    expect(res.statusCode).toBe(401)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('unauthenticated')
  })
})

// ===========================================================================
// Task 29: POST /api/billing/checkout
// ===========================================================================

interface CheckoutCreateCall {
  readonly params: Stripe.Checkout.SessionCreateParams
}

/**
 * Helper to install the Stripe stub for checkout tests. The returned bag
 * exposes:
 *   - createCalls: every call to checkout.sessions.create captured for assertion
 *   - createImpl:  swap out the per-test impl (default: returns a fake session)
 */
interface StripeStubBag {
  readonly createCalls: CheckoutCreateCall[]
  setCreateImpl(
    impl: (params: Stripe.Checkout.SessionCreateParams) => Promise<Stripe.Checkout.Session>,
  ): void
}

function installStripeStub(): StripeStubBag {
  const createCalls: CheckoutCreateCall[] = []
  // Default impl: returns a fake Checkout Session. Tests override via
  // setCreateImpl when they need to drive errors or specific session IDs.
  // The argument is captured by reference in createCalls, not consumed
  // here — drop it from the arrow's signature.
  let createImpl: (
    params: Stripe.Checkout.SessionCreateParams,
  ) => Promise<Stripe.Checkout.Session> = () => {
    const session = {
      id: 'cs_test_default_fixture',
      url: 'https://checkout.stripe.com/c/pay/cs_test_default_fixture',
    } as unknown as Stripe.Checkout.Session
    return Promise.resolve(session)
  }

  const stripeStub = {
    checkout: {
      sessions: {
        create: (params: Stripe.Checkout.SessionCreateParams): Promise<Stripe.Checkout.Session> => {
          createCalls.push({ params })
          return createImpl(params)
        },
      },
    },
    // .customers is not exercised here — findOrCreateStripeCustomer is
    // mocked separately, so the route never reaches into stripe.customers.
  } as unknown as Stripe

  mockedGetStripeClient.mockReturnValue(stripeStub)
  return {
    createCalls,
    setCreateImpl(impl): void {
      createImpl = impl
    },
  }
}

const FIXTURE_CHECKOUT_CACHE: SkuCache = (() => {
  const wayfarer: SkuInternalEntry = {
    lookup_key: 'tier_wayfarer',
    stripe_price_id: 'price_test_tier_wayfarer',
    displayName: 'Wayfarer',
    type: 'recurring',
    sessionsGranted: 4,
    worldsGranted: 1,
    price: { unit_amount_cents: 999, currency: 'usd' },
  }
  const sojourner: SkuInternalEntry = {
    lookup_key: 'tier_sojourner',
    stripe_price_id: 'price_test_tier_sojourner',
    displayName: 'Sojourner',
    type: 'recurring',
    sessionsGranted: 8,
    worldsGranted: 2,
    price: { unit_amount_cents: 1899, currency: 'usd' },
  }
  const session: SkuInternalEntry = {
    lookup_key: 'sku_session',
    stripe_price_id: 'price_test_sku_session',
    displayName: 'Session',
    type: 'one_time',
    sessionsGranted: 1,
    worldsGranted: 0,
    price: { unit_amount_cents: 499, currency: 'usd' },
  }
  const world: SkuInternalEntry = {
    lookup_key: 'sku_world',
    stripe_price_id: 'price_test_sku_world',
    displayName: 'World',
    type: 'one_time',
    sessionsGranted: 1,
    worldsGranted: 1,
    price: { unit_amount_cents: 799, currency: 'usd' },
  }
  const byLookupKey = new Map<LookupKey, SkuInternalEntry>()
  byLookupKey.set('tier_wayfarer', wayfarer)
  byLookupKey.set('tier_sojourner', sojourner)
  byLookupKey.set('sku_session', session)
  byLookupKey.set('sku_world', world)

  const byPriceId = new Map<string, SkuInternalEntry>()
  byPriceId.set(wayfarer.stripe_price_id, wayfarer)
  byPriceId.set(sojourner.stripe_price_id, sojourner)
  byPriceId.set(session.stripe_price_id, session)
  byPriceId.set(world.stripe_price_id, world)

  // Public listing strips stripe_price_id (defense in depth on the public route).
  const toPublic = (e: SkuInternalEntry): SkuPublicListing => ({
    lookup_key: e.lookup_key,
    displayName: e.displayName,
    type: e.type,
    sessionsGranted: e.sessionsGranted,
    worldsGranted: e.worldsGranted,
    price: e.price,
  })

  return {
    byLookupKey,
    byPriceId,
    publicListing: [wayfarer, sojourner, session, world].map(toPublic),
  }
})()

const SUCCESS_URL = 'http://localhost:5173/billing/success?session_id={CHECKOUT_SESSION_ID}'
const CANCEL_URL = 'http://localhost:5173/billing/cancel'

interface CheckoutSuccessBody {
  checkout_session_id: string
  url: string | null
}

// eslint-disable-next-line max-lines-per-function
describe('billingRoutes — POST /api/billing/checkout (MYT-42 Task 29)', () => {
  let app: FastifyInstance | undefined
  let stripe: StripeStubBag

  beforeEach(() => {
    _resetSkuCacheForTests()
    setSkuCache(FIXTURE_CHECKOUT_CACHE)
    vi.clearAllMocks()
    app = undefined
    mockCreateRepo.mockReturnValue(makeMockRepo())
    mockedFindOrCreateStripeCustomer.mockResolvedValue('cus_test_fixture_user')
    stripe = installStripeStub()
  })

  afterAll(async () => {
    if (app) await app.close()
    _resetSkuCacheForTests()
    vi.unstubAllEnvs()
  })

  it('creates a subscription-mode session for a tier-only cart (qty 1)', async () => {
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: { 'content-type': 'application/json' },
      payload: {
        items: [{ lookup_key: 'tier_wayfarer', quantity: 1 }],
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<CheckoutSuccessBody>()
    expect(body.checkout_session_id).toBe('cs_test_default_fixture')
    expect(body.url).toBe('https://checkout.stripe.com/c/pay/cs_test_default_fixture')

    expect(stripe.createCalls).toHaveLength(1)
    const call = stripe.createCalls[0]
    if (call === undefined) throw new Error('expected one create call')
    expect(call.params.mode).toBe('subscription')
    expect(call.params.customer).toBe('cus_test_fixture_user')
    expect(call.params.payment_method_types).toEqual(['card', 'link'])
    expect(call.params.success_url).toBe(SUCCESS_URL)
    expect(call.params.cancel_url).toBe(CANCEL_URL)
    expect(call.params.metadata).toEqual({ userId: BYPASS_USER_ID })
    expect(call.params.line_items).toEqual([
      { price: 'price_test_tier_wayfarer', quantity: 1 },
    ])
    // subscription_data carries the userId fallback for webhook customer-id misses.
    expect(call.params.subscription_data).toEqual({ metadata: { userId: BYPASS_USER_ID } })

    // Verified the find-or-create was called with the right userId.
    expect(mockedFindOrCreateStripeCustomer).toHaveBeenCalledTimes(1)
    expect(mockedFindOrCreateStripeCustomer).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      BYPASS_USER_ID,
    )
  })

  it('creates a payment-mode session for a multi-line à-la-carte cart', async () => {
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: { 'content-type': 'application/json' },
      payload: {
        items: [
          { lookup_key: 'sku_session', quantity: 3 },
          { lookup_key: 'sku_world', quantity: 1 },
        ],
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<CheckoutSuccessBody>()
    expect(body.checkout_session_id).toBe('cs_test_default_fixture')

    expect(stripe.createCalls).toHaveLength(1)
    const call = stripe.createCalls[0]
    if (call === undefined) throw new Error('expected one create call')
    expect(call.params.mode).toBe('payment')
    expect(call.params.line_items).toEqual([
      { price: 'price_test_sku_session', quantity: 3 },
      { price: 'price_test_sku_world', quantity: 1 },
    ])
    // subscription_data must NOT be set on payment-mode sessions.
    expect(call.params.subscription_data).toBeUndefined()
  })

  it('rejects a mixed cart (tier + à-la-carte) with mixed_cart', async () => {
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: { 'content-type': 'application/json' },
      payload: {
        items: [
          { lookup_key: 'tier_wayfarer', quantity: 1 },
          { lookup_key: 'sku_session', quantity: 1 },
        ],
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
      },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('mixed_cart')
    expect(stripe.createCalls).toHaveLength(0)
  })

  it('rejects a tier with quantity > 1 with tier_cart_shape', async () => {
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: { 'content-type': 'application/json' },
      payload: {
        items: [{ lookup_key: 'tier_wayfarer', quantity: 2 }],
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
      },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('tier_cart_shape')
    expect(stripe.createCalls).toHaveLength(0)
  })

  it('rejects a cart with two distinct tiers (items.length > 1) with tier_cart_shape', async () => {
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: { 'content-type': 'application/json' },
      payload: {
        items: [
          { lookup_key: 'tier_wayfarer', quantity: 1 },
          { lookup_key: 'tier_sojourner', quantity: 1 },
        ],
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
      },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('tier_cart_shape')
    expect(stripe.createCalls).toHaveLength(0)
  })

  it('rejects a duplicate lookup_key in items with duplicate_lookup_key', async () => {
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: { 'content-type': 'application/json' },
      payload: {
        items: [
          { lookup_key: 'sku_session', quantity: 1 },
          { lookup_key: 'sku_session', quantity: 2 },
        ],
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
      },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('duplicate_lookup_key')
    expect(stripe.createCalls).toHaveLength(0)
  })

  it('rejects an unknown lookup_key with unknown_lookup_key + the offending key in detail', async () => {
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: { 'content-type': 'application/json' },
      payload: {
        items: [{ lookup_key: 'sku_phantom', quantity: 1 }],
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
      },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json<{ code: string; lookup_key?: string }>()
    expect(body.code).toBe('unknown_lookup_key')
    expect(body.lookup_key).toBe('sku_phantom')
    expect(stripe.createCalls).toHaveLength(0)
  })

  it('returns 502 stripe_unavailable when checkout.sessions.create throws', async () => {
    stripe.setCreateImpl(() => Promise.reject(new Error('stripe-side 503: service unavailable')))
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: { 'content-type': 'application/json' },
      payload: {
        items: [{ lookup_key: 'sku_session', quantity: 1 }],
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
      },
    })

    expect(res.statusCode).toBe(502)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('stripe_unavailable')
  })

  it('returns 400 body_invalid for a malformed body (missing items)', async () => {
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: { 'content-type': 'application/json' },
      payload: {
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
      },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('body_invalid')
    expect(stripe.createCalls).toHaveLength(0)
  })
})

// ===========================================================================
// Task 30: POST /api/billing/portal
// ===========================================================================

/**
 * Helper to install the Stripe portal stub. The returned bag exposes:
 *   - createCalls: every call to billingPortal.sessions.create captured for assertion
 *   - setCreateImpl: swap out the per-test impl
 */
interface PortalCreateCall {
  readonly params: { customer: string; return_url: string }
}

interface PortalStubBag {
  readonly createCalls: PortalCreateCall[]
  setCreateImpl(
    impl: (params: { customer: string; return_url: string }) => Promise<{ url: string }>,
  ): void
}

function installPortalStub(): PortalStubBag {
  const createCalls: PortalCreateCall[] = []
  let createImpl: (params: { customer: string; return_url: string }) => Promise<{ url: string }> =
    (params) => {
      return Promise.resolve({ url: `https://billing.stripe.com/p/session_test?customer=${params.customer}` })
    }

  const stripeStub = {
    billingPortal: {
      sessions: {
        create: (params: { customer: string; return_url: string }): Promise<{ url: string }> => {
          createCalls.push({ params })
          return createImpl(params)
        },
      },
    },
  } as unknown as import('stripe').default

  mockedGetStripeClient.mockReturnValue(stripeStub)
  return {
    createCalls,
    setCreateImpl(impl): void {
      createImpl = impl
    },
  }
}

const PORTAL_RETURN_URL = 'http://localhost:5173/account'

// eslint-disable-next-line max-lines-per-function
describe('billingRoutes — POST /api/billing/portal (MYT-42 Task 30)', () => {
  let app: FastifyInstance | undefined
  let noAuthApp: FastifyInstance | undefined
  let portal: PortalStubBag

  beforeEach(() => {
    _resetSkuCacheForTests()
    vi.clearAllMocks()
    app = undefined
    noAuthApp = undefined
    mockCreateRepo.mockReturnValue(makeMockRepo())
    mockedFindOrCreateStripeCustomer.mockResolvedValue('cus_test_portal_user')
    portal = installPortalStub()
  })

  afterAll(async () => {
    if (app) await app.close()
    if (noAuthApp) await noAuthApp.close()
    _resetSkuCacheForTests()
    vi.unstubAllEnvs()
  })

  it('returns 200 with the portal session URL on happy path', async () => {
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/portal',
      headers: { 'content-type': 'application/json' },
      payload: { return_url: PORTAL_RETURN_URL },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ url: string }>()
    expect(body.url).toBe(`https://billing.stripe.com/p/session_test?customer=cus_test_portal_user`)

    expect(portal.createCalls).toHaveLength(1)
    const call = portal.createCalls[0]
    if (call === undefined) throw new Error('expected one create call')
    expect(call.params.customer).toBe('cus_test_portal_user')
    expect(call.params.return_url).toBe(PORTAL_RETURN_URL)

    expect(mockedFindOrCreateStripeCustomer).toHaveBeenCalledTimes(1)
    expect(mockedFindOrCreateStripeCustomer).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      BYPASS_USER_ID,
    )
  })

  it('returns 502 stripe_unavailable when billingPortal.sessions.create throws', async () => {
    portal.setCreateImpl(() => Promise.reject(new Error('stripe-side 503')))
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/portal',
      headers: { 'content-type': 'application/json' },
      payload: { return_url: PORTAL_RETURN_URL },
    })

    expect(res.statusCode).toBe(502)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('stripe_unavailable')
  })

  it('returns 401 when request carries no JWT (no auth plugin registered)', async () => {
    mockCreateRepo.mockReturnValue(makeMockRepo())
    noAuthApp = await buildNoAuthTestApp()

    const res = await noAuthApp.inject({
      method: 'POST',
      url: '/api/billing/portal',
      headers: { 'content-type': 'application/json' },
      payload: { return_url: PORTAL_RETURN_URL },
    })

    expect(res.statusCode).toBe(401)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('unauthenticated')
  })

  it('returns 400 body_invalid when return_url is missing', async () => {
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/portal',
      headers: { 'content-type': 'application/json' },
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('body_invalid')
    expect(portal.createCalls).toHaveLength(0)
  })

  it('returns 403 username_required when authenticated user has no users row', async () => {
    mockCreateRepo.mockReturnValue(makeMockRepo({ userFound: false }))
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/portal',
      headers: { 'content-type': 'application/json' },
      payload: { return_url: PORTAL_RETURN_URL },
    })

    expect(res.statusCode).toBe(403)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('username_required')
    expect(portal.createCalls).toHaveLength(0)
  })
})

// ===========================================================================
// Task 31: POST /api/billing/upgrade-tier
// ===========================================================================

interface SubscriptionsRetrieveCall {
  readonly id: string
  readonly opts: { expand?: string[] } | undefined
}

interface SubscriptionsUpdateCall {
  readonly id: string
  readonly params: Stripe.SubscriptionUpdateParams
  readonly opts: { idempotencyKey?: string } | undefined
}

interface UpgradeStripeStubBag {
  readonly retrieveCalls: SubscriptionsRetrieveCall[]
  readonly updateCalls: SubscriptionsUpdateCall[]
  setRetrieveImpl(impl: (id: string) => Promise<Stripe.Subscription>): void
  setUpdateImpl(impl: (id: string, params: Stripe.SubscriptionUpdateParams) => Promise<Stripe.Subscription>): void
}

/**
 * Build a fake Stripe.Subscription for the upgrade-tier tests. Only the
 * fields the route handler actually reads are populated; everything else is
 * undefined-by-omission. The cast through `unknown` is the standard Stripe
 * test-fixture pattern in this file (see installStripeStub on line 704+).
 */
function makeSubscriptionFixture(opts: {
  readonly id?: string
  readonly itemId?: string
  readonly priceId?: string
  readonly periodStart?: number
  readonly pendingUpdate?: { expires_at: number } | null
  readonly latestInvoice?: string | null
}): Stripe.Subscription {
  const id = opts.id ?? 'sub_test_fixture_01'
  const itemId = opts.itemId ?? 'si_test_item_1'
  const priceId = opts.priceId ?? 'price_test_tier_wayfarer'
  const periodStart = opts.periodStart ?? 1_780_000_000 // 2026-05-29 UTC-ish
  const sub = {
    id,
    object: 'subscription',
    items: {
      object: 'list',
      data: [
        {
          id: itemId,
          object: 'subscription_item',
          price: { id: priceId, object: 'price' },
          current_period_start: periodStart,
        },
      ],
    },
    pending_update: opts.pendingUpdate ?? null,
    latest_invoice: opts.latestInvoice ?? null,
  } as unknown as Stripe.Subscription
  return sub
}

function installUpgradeStripeStub(): UpgradeStripeStubBag {
  const retrieveCalls: SubscriptionsRetrieveCall[] = []
  const updateCalls: SubscriptionsUpdateCall[] = []
  let retrieveImpl: (id: string) => Promise<Stripe.Subscription> = (id) =>
    Promise.resolve(makeSubscriptionFixture({ id }))
  let updateImpl: (id: string, params: Stripe.SubscriptionUpdateParams) => Promise<Stripe.Subscription> = (id) =>
    Promise.resolve(makeSubscriptionFixture({ id, latestInvoice: 'in_test_proration_01' }))

  const stripeStub = {
    subscriptions: {
      retrieve: (
        id: string,
        opts?: { expand?: string[] },
      ): Promise<Stripe.Subscription> => {
        retrieveCalls.push({ id, opts })
        return retrieveImpl(id)
      },
      update: (
        id: string,
        params: Stripe.SubscriptionUpdateParams,
        opts?: { idempotencyKey?: string },
      ): Promise<Stripe.Subscription> => {
        updateCalls.push({ id, params, opts })
        return updateImpl(id, params)
      },
    },
  } as unknown as Stripe

  mockedGetStripeClient.mockReturnValue(stripeStub)
  return {
    retrieveCalls,
    updateCalls,
    setRetrieveImpl(impl): void {
      retrieveImpl = impl
    },
    setUpdateImpl(impl): void {
      updateImpl = impl
    },
  }
}

/**
 * Active subscription fixture used as the user's pre-upgrade state across
 * tier-upgrade tests. tier_lookup_key='tier_wayfarer' (999¢) — upgrades to
 * tier_sojourner (1899¢) or tier_mythwright. Reuses FIXTURE_SUB_ROW shape but
 * with a tier_lookup_key that exists in FIXTURE_CHECKOUT_CACHE.
 */
const FIXTURE_UPGRADE_ACTIVE_SUB = {
  ...FIXTURE_SUB_ROW,
  tier_lookup_key: 'tier_wayfarer',
}

// Mythwright is the top tier in the spec; add it to FIXTURE_CHECKOUT_CACHE-style
// resolution by reusing the existing fixture and grafting in a Mythwright
// entry. Encapsulated here so the upgrade-tier suite can flip between
// tier_sojourner and tier_mythwright as the target without polluting earlier
// describe blocks.
const FIXTURE_UPGRADE_CACHE: SkuCache = (() => {
  const mythwright: SkuInternalEntry = {
    lookup_key: 'tier_mythwright',
    stripe_price_id: 'price_test_tier_mythwright',
    displayName: 'Mythwright',
    type: 'recurring',
    sessionsGranted: 16,
    worldsGranted: 4,
    price: { unit_amount_cents: 4499, currency: 'usd' },
  }
  const byLookupKey = new Map<LookupKey, SkuInternalEntry>(FIXTURE_CHECKOUT_CACHE.byLookupKey)
  byLookupKey.set('tier_mythwright', mythwright)

  const byPriceId = new Map<string, SkuInternalEntry>(FIXTURE_CHECKOUT_CACHE.byPriceId)
  byPriceId.set(mythwright.stripe_price_id, mythwright)

  return {
    byLookupKey,
    byPriceId,
    publicListing: [
      ...FIXTURE_CHECKOUT_CACHE.publicListing,
      {
        lookup_key: mythwright.lookup_key,
        displayName: mythwright.displayName,
        type: mythwright.type,
        sessionsGranted: mythwright.sessionsGranted,
        worldsGranted: mythwright.worldsGranted,
        price: mythwright.price,
      },
    ],
  }
})()

// eslint-disable-next-line max-lines-per-function
describe('billingRoutes — POST /api/billing/upgrade-tier (MYT-42 Task 31)', () => {
  let app: FastifyInstance | undefined
  let noAuthApp: FastifyInstance | undefined
  let stripe: UpgradeStripeStubBag

  beforeEach(() => {
    _resetSkuCacheForTests()
    setSkuCache(FIXTURE_UPGRADE_CACHE)
    vi.clearAllMocks()
    app = undefined
    noAuthApp = undefined
    mockCreateRepo.mockReturnValue(makeMockRepo())
    mockedUserSubscriptions.getActiveForUser.mockResolvedValue({ ...FIXTURE_UPGRADE_ACTIVE_SUB })
    stripe = installUpgradeStripeStub()
  })

  afterAll(async () => {
    if (app) await app.close()
    if (noAuthApp) await noAuthApp.close()
    _resetSkuCacheForTests()
    vi.unstubAllEnvs()
  })

  it('returns 200 with invoice_id when items advance synchronously (happy path)', async () => {
    stripe.setUpdateImpl((id) =>
      Promise.resolve(
        makeSubscriptionFixture({
          id,
          pendingUpdate: null,
          latestInvoice: 'in_test_proration_42',
        }),
      ),
    )
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/upgrade-tier',
      headers: { 'content-type': 'application/json' },
      payload: { target_tier_lookup_key: 'tier_sojourner' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ invoice_id: string | null }>()
    expect(body.invoice_id).toBe('in_test_proration_42')

    expect(stripe.retrieveCalls).toHaveLength(1)
    expect(stripe.updateCalls).toHaveLength(1)
    const updateCall = stripe.updateCalls[0]
    if (updateCall === undefined) throw new Error('expected one update call')
    expect(updateCall.id).toBe(FIXTURE_UPGRADE_ACTIVE_SUB.stripe_subscription_id)
    expect(updateCall.params.payment_behavior).toBe('pending_if_incomplete')
    expect(updateCall.params.proration_behavior).toBe('always_invoice')
    expect(updateCall.params.proration_date).toBeTypeOf('number')
    expect(updateCall.params.items).toEqual([
      { id: 'si_test_item_1', price: 'price_test_tier_sojourner' },
    ])
  })

  it('returns 502 upgrade_payment_pending when the response carries pending_update', async () => {
    const expiresAtSec = 1_790_000_000
    stripe.setUpdateImpl((id) =>
      Promise.resolve(
        makeSubscriptionFixture({
          id,
          pendingUpdate: { expires_at: expiresAtSec },
          latestInvoice: 'in_test_pending_invoice_99',
        }),
      ),
    )
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/upgrade-tier',
      headers: { 'content-type': 'application/json' },
      payload: { target_tier_lookup_key: 'tier_sojourner' },
    })

    expect(res.statusCode).toBe(502)
    const body = res.json<{
      code: string
      detail: { pending_update_expires_at: string; latest_invoice_id: string | null }
    }>()
    expect(body.code).toBe('upgrade_payment_pending')
    expect(body.detail.pending_update_expires_at).toBe(new Date(expiresAtSec * 1000).toISOString())
    expect(body.detail.latest_invoice_id).toBe('in_test_pending_invoice_99')
  })

  it('returns 409 upgrade_already_pending when the live subscription has a pending_update', async () => {
    const expiresAtSec = 1_795_000_000
    stripe.setRetrieveImpl((id) =>
      Promise.resolve(
        makeSubscriptionFixture({
          id,
          pendingUpdate: { expires_at: expiresAtSec },
          latestInvoice: 'in_test_inflight_07',
        }),
      ),
    )
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/upgrade-tier',
      headers: { 'content-type': 'application/json' },
      payload: { target_tier_lookup_key: 'tier_sojourner' },
    })

    expect(res.statusCode).toBe(409)
    const body = res.json<{
      code: string
      detail: { pending_update_expires_at: string; latest_invoice_id: string | null }
    }>()
    expect(body.code).toBe('upgrade_already_pending')
    expect(body.detail.pending_update_expires_at).toBe(new Date(expiresAtSec * 1000).toISOString())
    expect(body.detail.latest_invoice_id).toBe('in_test_inflight_07')

    // The route MUST NOT call subscriptions.update when an in-flight
    // pending_update is already present.
    expect(stripe.updateCalls).toHaveLength(0)
  })

  it('returns 400 no_active_subscription when the user has no active sub', async () => {
    mockedUserSubscriptions.getActiveForUser.mockResolvedValue(null)
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/upgrade-tier',
      headers: { 'content-type': 'application/json' },
      payload: { target_tier_lookup_key: 'tier_sojourner' },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('no_active_subscription')
    expect(stripe.retrieveCalls).toHaveLength(0)
    expect(stripe.updateCalls).toHaveLength(0)
  })

  it('returns 400 tier_unchanged when target equals current', async () => {
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/upgrade-tier',
      headers: { 'content-type': 'application/json' },
      payload: { target_tier_lookup_key: 'tier_wayfarer' },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('tier_unchanged')
    expect(stripe.retrieveCalls).toHaveLength(0)
    expect(stripe.updateCalls).toHaveLength(0)
  })

  it('returns 400 not_an_upgrade when target price is below current', async () => {
    // Active sub at tier_sojourner (1899¢), target tier_wayfarer (999¢).
    mockedUserSubscriptions.getActiveForUser.mockResolvedValue({
      ...FIXTURE_UPGRADE_ACTIVE_SUB,
      tier_lookup_key: 'tier_sojourner',
    })
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/upgrade-tier',
      headers: { 'content-type': 'application/json' },
      payload: { target_tier_lookup_key: 'tier_wayfarer' },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('not_an_upgrade')
    expect(stripe.retrieveCalls).toHaveLength(0)
    expect(stripe.updateCalls).toHaveLength(0)
  })

  it('returns 400 unknown_lookup_key when target_tier_lookup_key is unknown', async () => {
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/upgrade-tier',
      headers: { 'content-type': 'application/json' },
      payload: { target_tier_lookup_key: 'tier_unobtanium' },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('unknown_lookup_key')
    expect(stripe.retrieveCalls).toHaveLength(0)
    expect(stripe.updateCalls).toHaveLength(0)
  })

  it('uses idempotencyKey shape upgrade:<userId>:<sub_id>:<target_tier> with NO period_start', async () => {
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/upgrade-tier',
      headers: { 'content-type': 'application/json' },
      payload: { target_tier_lookup_key: 'tier_sojourner' },
    })

    expect(res.statusCode).toBe(200)
    expect(stripe.updateCalls).toHaveLength(1)
    const updateCall = stripe.updateCalls[0]
    if (updateCall === undefined) throw new Error('expected one update call')
    const expectedKey = `upgrade:${BYPASS_USER_ID}:${FIXTURE_UPGRADE_ACTIVE_SUB.stripe_subscription_id}:tier_sojourner`
    expect(updateCall.opts?.idempotencyKey).toBe(expectedKey)
    // Belt-and-suspenders: the literal idempotency key MUST NOT contain the
    // period_start integer (per Petra I1 round 8 — see file-top spec ref).
    expect(updateCall.opts?.idempotencyKey).not.toContain(String(1_780_000_000))
  })

  it('returns 502 stripe_unavailable when subscriptions.update throws a network/5xx error', async () => {
    stripe.setUpdateImpl(() => Promise.reject(new Error('stripe-side 503: service unavailable')))
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/upgrade-tier',
      headers: { 'content-type': 'application/json' },
      payload: { target_tier_lookup_key: 'tier_sojourner' },
    })

    expect(res.statusCode).toBe(502)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('stripe_unavailable')
  })

  it('returns 502 stripe_unavailable when subscriptions.retrieve throws', async () => {
    stripe.setRetrieveImpl(() => Promise.reject(new Error('stripe-side network error')))
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/upgrade-tier',
      headers: { 'content-type': 'application/json' },
      payload: { target_tier_lookup_key: 'tier_sojourner' },
    })

    expect(res.statusCode).toBe(502)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('stripe_unavailable')
    expect(stripe.updateCalls).toHaveLength(0)
  })

  it('returns 400 body_invalid when target_tier_lookup_key is missing', async () => {
    app = await buildAuthedTestApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/upgrade-tier',
      headers: { 'content-type': 'application/json' },
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('body_invalid')
    expect(stripe.retrieveCalls).toHaveLength(0)
    expect(stripe.updateCalls).toHaveLength(0)
  })

  it('returns 401 when the request carries no JWT (no auth plugin registered)', async () => {
    mockCreateRepo.mockReturnValue(makeMockRepo())
    noAuthApp = await buildNoAuthTestApp()

    const res = await noAuthApp.inject({
      method: 'POST',
      url: '/api/billing/upgrade-tier',
      headers: { 'content-type': 'application/json' },
      payload: { target_tier_lookup_key: 'tier_sojourner' },
    })

    expect(res.statusCode).toBe(401)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('unauthenticated')
  })
})
