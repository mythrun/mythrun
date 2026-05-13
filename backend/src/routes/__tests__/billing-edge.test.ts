// backend/src/routes/__tests__/billing-edge.test.ts
//
// Edge-case coverage for routes/billing.ts:
//   - resolveUpgradeTiers: `target.type !== 'recurring' || current.type !==
//     'recurring'` → 400 not_an_upgrade (line 665-667).
//   - handleUpgradeTier defensive `item === undefined` → 502
//     stripe_unavailable (line 733-743) when subscriptions.retrieve returns
//     an empty items array.
//   - resolveUpgradeTiers sku_cache_unavailable branches (line 650-651,
//     654-657, 660-661) — fired by `tier_lookup_key` on the live sub being
//     an unrecognized string.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
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
} from '../../billing/sku-cache.js'
import type { LookupKey } from '../../billing/lookup-keys.js'
import { billingRoutes } from '../billing.js'
import { registerPublicRouteAllowlistHook } from '../../auth/public-route-allowlist.js'
import { bypassPlugin } from '../../auth/bypass-plugin.js'

// Module-level mocks (mirrors billing.test.ts).
vi.mock('../../repo/index.js', () => ({
  createRepo: vi.fn(),
}))
vi.mock('../../repo/user-subscriptions.js', () => ({
  userSubscriptions: {
    getActiveForUser: vi.fn(),
  },
}))
vi.mock('../../billing/stripe-client.js', () => ({
  getStripeClient: vi.fn(),
}))
vi.mock('../../billing/customer.js', () => ({
  findOrCreateStripeCustomer: vi.fn(),
}))

import { createRepo } from '../../repo/index.js'
import { userSubscriptions } from '../../repo/user-subscriptions.js'
import { getStripeClient } from '../../billing/stripe-client.js'
import { findOrCreateStripeCustomer } from '../../billing/customer.js'

const mockCreateRepo = vi.mocked(createRepo)
const mockedGetStripeClient = vi.mocked(getStripeClient)
const mockedFindOrCreateStripeCustomer = vi.mocked(findOrCreateStripeCustomer)
const mockedUserSubscriptions = vi.mocked(userSubscriptions)

const BYPASS_USER_ID = '018e2b3c-0000-7000-8000-000000000002'
const BYPASS_SUB = 'bypass:dev-1'

function makeMockRepo(): ReturnType<typeof createRepo> {
  return {
    users: {
      getByCognitoSub: vi.fn((sub: string) => {
        if (sub === BYPASS_SUB) {
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
      balance: vi.fn(() => Promise.resolve(0)),
    },
  } as unknown as ReturnType<typeof createRepo>
}

function stubPool(): Pool {
  return {
    query: (): never => {
      throw new Error('stubPool: unexpected pool.query call')
    },
    connect: (): never => {
      throw new Error('stubPool: unexpected pool.connect call')
    },
  } as unknown as Pool
}

function stubEnv(): Env {
  return Object.freeze({
    databaseUrl: 'postgresql://stub/db',
    redisRealtimeUrl: 'redis://stub:6379',
    redisBatchUrl: 'redis://stub:6379',
    redisKeyPrefix: 'test:use1:',
    mythrunEnv: 'development',
    port: 0,
    authMode: 'bypass',
    frontendBaseUrl: 'http://localhost:5173',
    stripeSecretKey: 'rk_test_stub',
    stripeWebhookSecret: 'whsec_test_stub',
    anthropicApiKey: 'sk-ant-stub',
  })
}

// Build a SkuCache where:
//   - tier_wayfarer is recurring (current sub uses this)
//   - tier_sojourner is recurring (real upgrade target)
//   - sku_session is one_time (used to drive the type !== 'recurring' branch)
function buildEdgeCache(): SkuCache {
  const wayfarer: SkuInternalEntry = {
    lookup_key: 'tier_wayfarer',
    stripe_price_id: 'price_tier_wayfarer',
    displayName: 'Wayfarer',
    type: 'recurring',
    sessionsGranted: 4,
    worldsGranted: 1,
    price: { unit_amount_cents: 999, currency: 'usd' },
  }
  const sojourner: SkuInternalEntry = {
    lookup_key: 'tier_sojourner',
    stripe_price_id: 'price_tier_sojourner',
    displayName: 'Sojourner',
    type: 'recurring',
    sessionsGranted: 8,
    worldsGranted: 2,
    price: { unit_amount_cents: 1899, currency: 'usd' },
  }
  const session: SkuInternalEntry = {
    lookup_key: 'sku_session',
    stripe_price_id: 'price_sku_session',
    displayName: 'Session',
    type: 'one_time',
    sessionsGranted: 1,
    worldsGranted: 0,
    price: { unit_amount_cents: 499, currency: 'usd' },
  }
  const byLookupKey = new Map<LookupKey, SkuInternalEntry>()
  byLookupKey.set('tier_wayfarer', wayfarer)
  byLookupKey.set('tier_sojourner', sojourner)
  byLookupKey.set('sku_session', session)
  const byPriceId = new Map<string, SkuInternalEntry>([
    [wayfarer.stripe_price_id, wayfarer],
    [sojourner.stripe_price_id, sojourner],
    [session.stripe_price_id, session],
  ])
  return {
    byLookupKey,
    byPriceId,
    publicListing: [wayfarer, sojourner, session].map((e) => ({
      lookup_key: e.lookup_key,
      displayName: e.displayName,
      type: e.type,
      sessionsGranted: e.sessionsGranted,
      worldsGranted: e.worldsGranted,
      price: e.price,
    })),
  }
}

const FIXTURE_SUB_ROW = {
  id: '018e2b3c-0000-7000-8000-000000000001',
  user_id: BYPASS_USER_ID,
  stripe_subscription_id: 'sub_test_edge_01',
  tier_lookup_key: 'tier_wayfarer',
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

async function buildAuthedApp(): Promise<FastifyInstance> {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('COGNITO_USER_POOL_ID', '')
  vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
  vi.stubEnv('COGNITO_ISSUER_URL', '')
  vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
  globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))

  const app = Fastify({ logger: false })
  registerPublicRouteAllowlistHook(app)
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(bypassPlugin)
  await app.register(billingRoutes, { pool: stubPool(), env: stubEnv() })
  await app.ready()
  return app
}

describe('billing edge cases — upgrade-tier defensive branches', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => {
    _resetSkuCacheForTests()
    setSkuCache(buildEdgeCache())
    vi.clearAllMocks()
    mockCreateRepo.mockReturnValue(makeMockRepo())
    mockedFindOrCreateStripeCustomer.mockResolvedValue('cus_test')
    app = undefined
  })

  afterEach(async () => {
    if (app) await app.close()
  })

  afterAll(() => {
    _resetSkuCacheForTests()
    vi.unstubAllEnvs()
  })

  it('400 not_an_upgrade when target lookup key resolves to a one_time SKU', async () => {
    // Active sub is tier_wayfarer (recurring); target is sku_session
    // (one_time). resolveUpgradeTiers's `target.type !== 'recurring'`
    // branch fires → 400 not_an_upgrade.
    mockedUserSubscriptions.getActiveForUser.mockResolvedValue({ ...FIXTURE_SUB_ROW })
    app = await buildAuthedApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/upgrade-tier',
      headers: { 'content-type': 'application/json' },
      payload: { target_tier_lookup_key: 'sku_session' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ code: 'not_an_upgrade' })
  })

  it('400 not_an_upgrade when CURRENT lookup key resolves to a one_time SKU (defensive)', async () => {
    // Active sub somehow has `tier_lookup_key='sku_session'` — defensive
    // case where the user_subscriptions row was upserted with a non-tier
    // lookup key. The route's resolver fires the `current.type !==
    // 'recurring'` branch → 400 not_an_upgrade. (Mirrors line 665-667.)
    mockedUserSubscriptions.getActiveForUser.mockResolvedValue({
      ...FIXTURE_SUB_ROW,
      tier_lookup_key: 'sku_session',
    })
    app = await buildAuthedApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/upgrade-tier',
      headers: { 'content-type': 'application/json' },
      payload: { target_tier_lookup_key: 'tier_sojourner' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ code: 'not_an_upgrade' })
  })

  it('503 sku_cache_unavailable when current tier_lookup_key is NOT a recognized LookupKey', async () => {
    mockedUserSubscriptions.getActiveForUser.mockResolvedValue({
      ...FIXTURE_SUB_ROW,
      tier_lookup_key: 'tier_phantom_unknown',
    })
    app = await buildAuthedApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/upgrade-tier',
      headers: { 'content-type': 'application/json' },
      payload: { target_tier_lookup_key: 'tier_sojourner' },
    })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ code: 'sku_cache_unavailable' })
  })

  it('502 stripe_unavailable when subscriptions.retrieve returns a subscription with empty items', async () => {
    // Defensive `item === undefined` branch at billing.ts:733-743.
    // The retrieve call returns a subscription whose items.data is [].
    mockedUserSubscriptions.getActiveForUser.mockResolvedValue({ ...FIXTURE_SUB_ROW })

    const emptyItemsSub = {
      id: 'sub_test_edge_01',
      object: 'subscription',
      items: { object: 'list', data: [] },
      pending_update: null,
      latest_invoice: null,
    } as unknown as Stripe.Subscription

    const stripeStub = {
      subscriptions: {
        retrieve: (_id: string): Promise<Stripe.Subscription> => Promise.resolve(emptyItemsSub),
        update: (): Promise<Stripe.Subscription> => {
          throw new Error('update should not be reached')
        },
      },
    }
    mockedGetStripeClient.mockReturnValue(stripeStub as unknown as ReturnType<typeof getStripeClient>)

    app = await buildAuthedApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/upgrade-tier',
      headers: { 'content-type': 'application/json' },
      payload: { target_tier_lookup_key: 'tier_sojourner' },
    })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ code: 'stripe_unavailable' })
  })

  it('503 sku_cache_unavailable on /api/billing/upgrade-tier when SKU cache has been reset', async () => {
    // Reset the cache after the sub-active mock — the route's
    // resolveUpgradeTiers will short-circuit at `cache === null`.
    mockedUserSubscriptions.getActiveForUser.mockResolvedValue({ ...FIXTURE_SUB_ROW })
    _resetSkuCacheForTests()
    app = await buildAuthedApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/upgrade-tier',
      headers: { 'content-type': 'application/json' },
      payload: { target_tier_lookup_key: 'tier_sojourner' },
    })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ code: 'sku_cache_unavailable' })
  })
})
