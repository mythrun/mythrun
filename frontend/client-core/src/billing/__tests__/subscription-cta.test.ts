import { describe, it, expect } from 'vitest'
import type { ActiveSubscriptionSummary, SkuListing } from '@mythrun/contract/rest'
import { subscriptionCta } from '../subscription-cta.ts'

// subscriptionCta gates the per-tier CTA so an ALREADY-SUBSCRIBED user can never
// reach plain subscription checkout (Stripe would happily create a second
// subscription — the double-subscribe bug the blind review flagged as the
// showstopper, spec §4 required acceptance criterion). `subscribe` is returned
// ONLY when there is no active subscription; every other state routes to
// `upgrade` (higher tier) or `manage` (same/lower/unresolvable → Customer Portal).

function tier(lookupKey: SkuListing['lookup_key'], unitAmountCents: number): SkuListing {
  return {
    lookup_key: lookupKey,
    displayName: lookupKey,
    type: 'recurring',
    sessionsGranted: 4,
    worldsGranted: 1,
    price: { unit_amount_cents: unitAmountCents, currency: 'usd' },
  }
}

// Ascending by price → tierRank 0 / 1 / 2. Order deliberately scrambled so the
// gate depends on price-rank, not array position.
const WAYFARER = tier('tier_wayfarer', 1200)
const SOJOURNER = tier('tier_sojourner', 2400)
const MYTHWRIGHT = tier('tier_mythwright', 4800)
const SESSION_PACK: SkuListing = {
  lookup_key: 'sku_session',
  displayName: 'Session',
  type: 'one_time',
  sessionsGranted: 1,
  worldsGranted: 0,
  price: { unit_amount_cents: 500, currency: 'usd' },
}
const SKUS: readonly SkuListing[] = [MYTHWRIGHT, SESSION_PACK, WAYFARER, SOJOURNER]

const TIER_KEYS = ['tier_wayfarer', 'tier_sojourner', 'tier_mythwright'] as const

function activeSub(tierLookupKey: string): ActiveSubscriptionSummary {
  return {
    tier_lookup_key: tierLookupKey,
    current_period_end: '2026-08-01T00:00:00.000Z',
    cancel_at_period_end: false,
    status: 'active',
  }
}

describe('subscriptionCta', () => {
  it('with no active subscription → EVERY tier is a plain subscribe', () => {
    for (const key of TIER_KEYS) {
      expect(subscriptionCta({ activeSubscription: null, targetTierLookupKey: key, skus: SKUS })).toEqual({
        cta: 'subscribe',
        isCurrent: false,
      })
    }
  })

  // THE PIN (required acceptance criterion): for an active subscription, NO
  // (currentTier × targetTier) pair may ever yield `subscribe`. This is the test
  // that structurally forbids the double-subscribe path.
  it('THE PIN — an active subscription NEVER yields subscribe, for any current×target tier pair', () => {
    for (const current of TIER_KEYS) {
      for (const target of TIER_KEYS) {
        const decision = subscriptionCta({
          activeSubscription: activeSub(current),
          targetTierLookupKey: target,
          skus: SKUS,
        })
        expect(decision.cta).not.toBe('subscribe')
      }
    }
  })

  // Property-style extension of the pin: even with an unresolvable current tier
  // (a retired sub no longer in the catalogue) OR an unresolvable target key, an
  // active subscription still never reaches subscribe.
  it('THE PIN extends to unresolvable current/target tiers — still never subscribe', () => {
    const currents = [...TIER_KEYS, 'tier_retired']
    const targets = [...TIER_KEYS, 'tier_retired', 'sku_session', 'tier_unknown']
    for (const current of currents) {
      for (const target of targets) {
        const decision = subscriptionCta({
          activeSubscription: activeSub(current),
          targetTierLookupKey: target,
          skus: SKUS,
        })
        expect(decision.cta).not.toBe('subscribe')
      }
    }
  })

  it('active + target priced HIGHER → upgrade (not current)', () => {
    expect(
      subscriptionCta({
        activeSubscription: activeSub('tier_wayfarer'),
        targetTierLookupKey: 'tier_mythwright',
        skus: SKUS,
      }),
    ).toEqual({ cta: 'upgrade', isCurrent: false })
  })

  it('active + target === current tier → manage, isCurrent true', () => {
    expect(
      subscriptionCta({
        activeSubscription: activeSub('tier_sojourner'),
        targetTierLookupKey: 'tier_sojourner',
        skus: SKUS,
      }),
    ).toEqual({ cta: 'manage', isCurrent: true })
  })

  it('active + target priced LOWER → manage, isCurrent false (downgrade via Portal)', () => {
    expect(
      subscriptionCta({
        activeSubscription: activeSub('tier_mythwright'),
        targetTierLookupKey: 'tier_wayfarer',
        skus: SKUS,
      }),
    ).toEqual({ cta: 'manage', isCurrent: false })
  })

  it('active + target tier absent from the catalogue → manage, never subscribe', () => {
    expect(
      subscriptionCta({
        activeSubscription: activeSub('tier_wayfarer'),
        targetTierLookupKey: 'tier_unknown',
        skus: SKUS,
      }),
    ).toEqual({ cta: 'manage', isCurrent: false })
  })

  it('active subscription whose OWN tier is retired (absent) → manage, never subscribe', () => {
    expect(
      subscriptionCta({
        activeSubscription: activeSub('tier_retired'),
        targetTierLookupKey: 'tier_sojourner',
        skus: SKUS,
      }),
    ).toEqual({ cta: 'manage', isCurrent: false })
  })
})
