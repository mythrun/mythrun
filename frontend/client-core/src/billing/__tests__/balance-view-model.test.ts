import { describe, it, expect } from 'vitest'
import type { BalanceResponse, SkuListing } from '@mythrun/contract/rest'
import { balanceView } from '../balance-view-model.ts'

// balanceView shapes GET /api/billing/balance into the settings-screen view-model.
// The two credit buckets (session, world_gen) are INDEPENDENT and pass through
// unchanged — the view NEVER exposes a summed total (spec §4, two-bucket rule).
// The active subscription's tier display name is resolved from the SKU catalogue,
// falling back to the raw lookup key when the tier is absent.

function tier(lookupKey: string, displayName: string): SkuListing {
  return {
    lookup_key: lookupKey as SkuListing['lookup_key'],
    displayName,
    type: 'recurring',
    sessionsGranted: 4,
    worldsGranted: 1,
    price: { unit_amount_cents: 2400, currency: 'usd' },
  }
}

const SKUS: readonly SkuListing[] = [
  tier('tier_wayfarer', 'Wayfarer'),
  tier('tier_sojourner', 'Sojourner'),
  tier('tier_mythwright', 'Mythwright'),
]

function balance(over: Partial<BalanceResponse> = {}): BalanceResponse {
  return {
    session: 7,
    world_gen: 3,
    active_subscription: null,
    ...over,
  }
}

describe('balanceView', () => {
  it('passes the two buckets through independently and exposes no summed total', () => {
    const view = balanceView(balance({ session: 7, world_gen: 3 }), SKUS)
    expect(view.session).toBe(7)
    expect(view.worldGen).toBe(3)
    // No-conflation pin: no key holds the sum, and no field is named like a total.
    expect(Object.keys(view)).not.toContain('total')
    expect(Object.values(view)).not.toContain(10)
  })

  it('is subscription:null when there is no active subscription', () => {
    expect(balanceView(balance({ active_subscription: null }), SKUS).subscription).toBeNull()
  })

  it('resolves the tier display name from the catalogue for an active subscription', () => {
    const view = balanceView(
      balance({
        active_subscription: {
          tier_lookup_key: 'tier_sojourner',
          current_period_end: '2026-08-01T00:00:00.000Z',
          cancel_at_period_end: true,
          status: 'active',
        },
      }),
      SKUS,
    )
    expect(view.subscription).toEqual({
      tierLookupKey: 'tier_sojourner',
      tierDisplayName: 'Sojourner',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: '2026-08-01T00:00:00.000Z',
    })
  })

  it('falls back to the raw lookup key when the tier is absent from the catalogue', () => {
    const view = balanceView(
      balance({
        active_subscription: {
          tier_lookup_key: 'tier_retired',
          current_period_end: '2026-08-01T00:00:00.000Z',
          cancel_at_period_end: false,
          status: 'active',
        },
      }),
      SKUS,
    )
    expect(view.subscription?.tierDisplayName).toBe('tier_retired')
    expect(view.subscription?.cancelAtPeriodEnd).toBe(false)
  })
})
