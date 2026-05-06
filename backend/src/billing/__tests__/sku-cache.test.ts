import { describe, it, expect, beforeEach } from 'vitest'
import {
  setSkuCache,
  getSkuCache,
  _resetSkuCacheForTests,
  type SkuCache,
  type SkuInternalEntry,
  type SkuPublicListing,
} from '../sku-cache.js'
import type { LookupKey } from '../lookup-keys.js'

beforeEach(() => {
  _resetSkuCacheForTests()
})

function makeEntry(lookup_key: LookupKey, stripe_price_id: string): SkuInternalEntry {
  return {
    lookup_key,
    stripe_price_id,
    displayName: 'Test SKU',
    type: 'one_time',
    sessionsGranted: 1,
    worldsGranted: 0,
    price: { unit_amount_cents: 500, currency: 'usd' },
  }
}

describe('sku-cache', () => {
  it('getSkuCache returns null before setSkuCache', () => {
    expect(getSkuCache()).toBeNull()
  })

  it('setSkuCache + getSkuCache round-trips byLookupKey, byPriceId, and publicListing', () => {
    const internal = makeEntry('sku_session', 'price_test_session')
    const { stripe_price_id: _omit, ...publicEntry } = internal
    const snapshot: SkuCache = {
      byLookupKey: new Map([[internal.lookup_key, internal]]),
      byPriceId: new Map([[internal.stripe_price_id, internal]]),
      publicListing: [publicEntry],
    }
    setSkuCache(snapshot)
    const got = getSkuCache()
    expect(got).not.toBeNull()
    expect(got?.byLookupKey.get('sku_session')).toEqual(internal)
    expect(got?.byPriceId.get('price_test_session')).toEqual(internal)
    expect(got?.publicListing).toHaveLength(1)
    expect(got?.publicListing[0]).toEqual(publicEntry)
  })

  it('SkuPublicListing excludes stripe_price_id (compile-time + runtime check)', () => {
    // Compile-time: this assertion fails to compile if SkuPublicListing
    // grows a stripe_price_id field. Runtime: the rest-omit pattern
    // strips it from the snapshot.
    const internal = makeEntry('sku_session', 'price_test_session')
    const { stripe_price_id: _omit, ...publicEntry } = internal
    const asPublic: SkuPublicListing = publicEntry
    expect(Object.keys(asPublic)).not.toContain('stripe_price_id')
    // Belt-and-suspenders: the type-level keys exposed by SkuPublicListing
    // should NOT contain any obviously-internal field name.
    type ForbiddenInPublic = Extract<keyof SkuPublicListing,
      'stripe_price_id' | 'userId' | 'email' | 'tenant' | 'internal' | 'env' | 'secret'>
    const _typecheck: ForbiddenInPublic extends never ? true : false = true
    expect(_typecheck).toBe(true)
  })

  it('setSkuCache twice replaces the snapshot (idempotency at boot)', () => {
    const a = makeEntry('sku_session', 'price_a')
    const b = makeEntry('sku_session', 'price_b')
    const snapA: SkuCache = {
      byLookupKey: new Map([[a.lookup_key, a]]),
      byPriceId: new Map([[a.stripe_price_id, a]]),
      publicListing: [],
    }
    const snapB: SkuCache = {
      byLookupKey: new Map([[b.lookup_key, b]]),
      byPriceId: new Map([[b.stripe_price_id, b]]),
      publicListing: [],
    }
    setSkuCache(snapA)
    setSkuCache(snapB)
    expect(getSkuCache()?.byPriceId.get('price_a')).toBeUndefined()
    expect(getSkuCache()?.byPriceId.get('price_b')).toEqual(b)
  })
})
