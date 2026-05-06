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

vi.mock('../../repo/billing-history.js', () => ({
  billingHistory: {
    listByUser: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// Import mocked modules after the vi.mock declarations.
// ---------------------------------------------------------------------------

import { createRepo } from '../../repo/index.js'
import { userSubscriptions } from '../../repo/user-subscriptions.js'
import { billingHistory } from '../../repo/billing-history.js'
import type { BillingHistoryRow } from '../../repo/billing-history.js'

const mockCreateRepo = vi.mocked(createRepo)
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
