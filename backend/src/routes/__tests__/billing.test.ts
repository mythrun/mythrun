// backend/src/routes/__tests__/billing.test.ts
//
// MYT-42 Task 25 — GET /api/billing/skus route.
//
// Covers:
//   1. 200 + Cache-Control header + publicListing shape
//   2. No JWT required (public route)
//   3. Null cache → 503 with code 'sku_cache_unavailable'
//   4. Response excludes stripe_price_id at runtime (defense in depth)

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import {
  setSkuCache,
  _resetSkuCacheForTests,
  type SkuCache,
  type SkuPublicListing,
} from '../../billing/sku-cache.js'
import { billingRoutes } from '../billing.js'
import { registerPublicRouteAllowlistHook } from '../../auth/public-route-allowlist.js'

// ---------------------------------------------------------------------------
// Fixture — a structurally valid cache snapshot with one entry.
// publicListing intentionally does NOT include stripe_price_id; the type
// enforces this, but the fixture makes it explicit for test 4's runtime check.
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
  byLookupKey: new Map([
    [FIXTURE_PUBLIC_ENTRY.lookup_key, FIXTURE_INTERNAL_ENTRY],
  ]),
  byPriceId: new Map([
    ['price_1ABCxyz_internal_only', FIXTURE_INTERNAL_ENTRY],
  ]),
  publicListing: [FIXTURE_PUBLIC_ENTRY],
}

// ---------------------------------------------------------------------------
// App factory — minimal Fastify with rate-limit + allowlist hook + billing plugin.
// No auth registration needed because GET /api/billing/skus is public; the
// allowlist hook verifies the route is actually in the allowlist.
// ---------------------------------------------------------------------------

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  // The allowlist hook must be registered before any app.register() call.
  registerPublicRouteAllowlistHook(app)

  await app.register(rateLimit, {
    global: false,
    max: 1000,
    timeWindow: '1 minute',
  })

  await app.register(billingRoutes)
  await app.ready()
  return app
}

describe('billingRoutes — GET /api/billing/skus (MYT-42 Task 25)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    _resetSkuCacheForTests()
    setSkuCache(FIXTURE_CACHE)
    app = await buildTestApp()
  })

  afterAll(async () => {
    // Clean up module-level cache so other test files start fresh.
    _resetSkuCacheForTests()
    await app?.close()
  })

  // -----------------------------------------------------------------------
  // Test 1: 200 + Cache-Control + publicListing shape
  // -----------------------------------------------------------------------

  it('returns 200 with Cache-Control header and publicListing array', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/billing/skus',
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=300')

    const body: unknown = res.json()
    expect(Array.isArray(body)).toBe(true)
    const list = body as SkuPublicListing[]
    expect(list).toHaveLength(1)

    const entry = list[0]
    expect(entry).toBeDefined()
    // Verify all required public fields are present.
    expect(entry).toHaveProperty('lookup_key', FIXTURE_PUBLIC_ENTRY.lookup_key)
    expect(entry).toHaveProperty('displayName', FIXTURE_PUBLIC_ENTRY.displayName)
    expect(entry).toHaveProperty('type', FIXTURE_PUBLIC_ENTRY.type)
    expect(entry).toHaveProperty('sessionsGranted', FIXTURE_PUBLIC_ENTRY.sessionsGranted)
    expect(entry).toHaveProperty('worldsGranted', FIXTURE_PUBLIC_ENTRY.worldsGranted)
    expect(entry).toHaveProperty('price')
    const price = ((entry as unknown) as Record<string, unknown>)['price'] as Record<string, unknown>
    expect(price['unit_amount_cents']).toBe(499)
    expect(price['currency']).toBe('usd')
  })

  // -----------------------------------------------------------------------
  // Test 2: No JWT required (public route — works without Authorization header)
  // -----------------------------------------------------------------------

  it('returns 200 without an Authorization header (public route)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/billing/skus',
      // Deliberately no Authorization header.
    })

    expect(res.statusCode).toBe(200)
  })

  // -----------------------------------------------------------------------
  // Test 3: Null cache → 503 with code 'sku_cache_unavailable'
  // -----------------------------------------------------------------------

  it('returns 503 with code sku_cache_unavailable when cache is null', async () => {
    // Reset to null AFTER beforeEach set it, then re-build the app so the
    // route handler sees the null state on this request.
    _resetSkuCacheForTests()

    const res = await app.inject({
      method: 'GET',
      url: '/api/billing/skus',
    })

    expect(res.statusCode).toBe(503)
    const body = res.json<{ code: string }>()
    expect(body.code).toBe('sku_cache_unavailable')
  })

  // -----------------------------------------------------------------------
  // Test 4: Response excludes stripe_price_id at runtime (defense in depth)
  // -----------------------------------------------------------------------

  it('excludes stripe_price_id from the response payload', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/billing/skus',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<unknown[]>()
    expect(body).toHaveLength(1)
    const entry = body[0] as Record<string, unknown>
    // The internal SkuInternalEntry has stripe_price_id; publicListing must not.
    expect(entry).not.toHaveProperty('stripe_price_id')
  })
})
