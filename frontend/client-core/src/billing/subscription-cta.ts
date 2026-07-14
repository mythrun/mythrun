// Subscription-tier CTA gating. This is the structural guard behind the
// showstopper acceptance criterion (spec §4): an already-subscribed user must be
// UNABLE to reach plain subscription checkout, because Stripe would happily
// create a second subscription. `subscribe` is returned ONLY when there is no
// active subscription; every other state routes to `upgrade` (a higher tier) or
// `manage` (same/lower/unresolvable → the Stripe Customer Portal). Ordering is
// read off the shared price-rank (tier-catalogue) so this layer never re-sums
// prices. Platform-independent BRAIN (R1): no React/DOM.

import type { ActiveSubscriptionSummary, SkuListing } from '@mythrun/contract/rest'
import { tierRank } from './tier-catalogue.ts'

/** The gated action for a subscription-tier CTA. `subscribe` is ONLY ever
 *  returned when there is NO active subscription — an already-subscribed user
 *  can never reach plain subscription checkout (the double-subscribe bug the
 *  spec §4 pins as a required acceptance criterion). */
export type SubscriptionCta = 'subscribe' | 'upgrade' | 'manage'

export interface TierCtaDecision {
  readonly cta: SubscriptionCta
  /** True when this tier IS the active tier (display marker; action is `manage`). */
  readonly isCurrent: boolean
}

export function subscriptionCta(args: {
  readonly activeSubscription: ActiveSubscriptionSummary | null
  readonly targetTierLookupKey: string
  readonly skus: readonly SkuListing[]
}): TierCtaDecision {
  const { activeSubscription, targetTierLookupKey, skus } = args
  // No active sub → a fresh subscribe (checkout mode:subscription).
  if (activeSubscription === null) return { cta: 'subscribe', isCurrent: false }

  const currentRank = tierRank(skus, activeSubscription.tier_lookup_key)
  const targetRank = tierRank(skus, targetTierLookupKey)
  // Defensive: an unresolvable tier with an active sub routes to Portal — NEVER
  // to a second subscribe. This is the guard that keeps the pin total.
  if (currentRank === undefined || targetRank === undefined) return { cta: 'manage', isCurrent: false }

  if (targetRank > currentRank) return { cta: 'upgrade', isCurrent: false }
  // Same tier or lower → Customer Portal (downgrade / cancel / payment method).
  return { cta: 'manage', isCurrent: targetRank === currentRank }
}
