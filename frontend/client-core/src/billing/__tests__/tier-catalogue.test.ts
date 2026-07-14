import { describe, it, expect } from 'vitest'
import type { SkuListing } from '@mythrun/contract/rest'
import { subscriptionTiers, aLaCarteSkus, tierRank } from '../tier-catalogue.ts'

// The tier catalogue derives the ordered subscription tiers, the à-la-carte SKUs,
// and a tier's price-rank from the raw /api/billing/skus listing. The three tier
// names (Wayfarer / Sojourner / Mythwright, spec §11) are SERVER DATA carried
// through verbatim; the catalogue adds NO "best value" / "recommended" marker.

function sku(over: Partial<SkuListing> & Pick<SkuListing, 'lookup_key' | 'type'>): SkuListing {
  return {
    displayName: over.lookup_key,
    sessionsGranted: 0,
    worldsGranted: 0,
    price: { unit_amount_cents: 0, currency: 'usd' },
    ...over,
  }
}

// Deliberately scrambled input order (price is NOT insertion order) so the sort is
// load-bearing, and the two à-la-carte SKUs are interleaved with the tiers.
const WAYFARER = sku({
  lookup_key: 'tier_wayfarer',
  displayName: 'Wayfarer',
  type: 'recurring',
  price: { unit_amount_cents: 1200, currency: 'usd' },
})
const SOJOURNER = sku({
  lookup_key: 'tier_sojourner',
  displayName: 'Sojourner',
  type: 'recurring',
  price: { unit_amount_cents: 2400, currency: 'usd' },
})
const MYTHWRIGHT = sku({
  lookup_key: 'tier_mythwright',
  displayName: 'Mythwright',
  type: 'recurring',
  price: { unit_amount_cents: 4800, currency: 'usd' },
})
const SESSION_PACK = sku({
  lookup_key: 'sku_session',
  displayName: 'Session',
  type: 'one_time',
  price: { unit_amount_cents: 500, currency: 'usd' },
})
const WORLD_PACK = sku({
  lookup_key: 'sku_world',
  displayName: 'World',
  type: 'one_time',
  price: { unit_amount_cents: 800, currency: 'usd' },
})
const CATALOGUE: readonly SkuListing[] = [MYTHWRIGHT, SESSION_PACK, WAYFARER, WORLD_PACK, SOJOURNER]

const BEST_VALUE_KEYS = ['bestValue', 'best_value', 'recommended', 'featured', 'popular'] as const

describe('subscriptionTiers', () => {
  it('returns only recurring tiers, ascending by price (Wayfarer → Sojourner → Mythwright)', () => {
    const tiers = subscriptionTiers(CATALOGUE)
    expect(tiers.map((t) => t.displayName)).toEqual(['Wayfarer', 'Sojourner', 'Mythwright'])
    expect(tiers.map((t) => t.lookup_key)).toEqual([
      'tier_wayfarer',
      'tier_sojourner',
      'tier_mythwright',
    ])
    expect(tiers.every((t) => t.type === 'recurring')).toBe(true)
  })

  it('carries no "best value" / "recommended" marker on any tier (spec §11)', () => {
    for (const tier of subscriptionTiers(CATALOGUE)) {
      for (const flag of BEST_VALUE_KEYS) {
        expect(flag in tier).toBe(false)
      }
    }
  })
})

describe('aLaCarteSkus', () => {
  it('returns only one_time SKUs (no subscription tiers)', () => {
    const packs = aLaCarteSkus(CATALOGUE)
    expect(packs.map((p) => p.lookup_key)).toEqual(['sku_session', 'sku_world'])
    expect(packs.every((p) => p.type === 'one_time')).toBe(true)
  })
})

describe('tierRank', () => {
  it('gives 0 / 1 / 2 for the three tiers ascending by price', () => {
    expect(tierRank(CATALOGUE, 'tier_wayfarer')).toBe(0)
    expect(tierRank(CATALOGUE, 'tier_sojourner')).toBe(1)
    expect(tierRank(CATALOGUE, 'tier_mythwright')).toBe(2)
  })

  it('is undefined for a non-tier SKU', () => {
    expect(tierRank(CATALOGUE, 'sku_session')).toBeUndefined()
  })

  it('is undefined for an unknown lookup key', () => {
    expect(tierRank(CATALOGUE, 'tier_nonexistent')).toBeUndefined()
  })
})
