// The balance view-model: shapes GET /api/billing/balance into what the Sessions &
// Billing settings screen renders. The two credit buckets (session, world_gen) are
// INDEPENDENT — this view passes each through unchanged and NEVER exposes a summed
// total (spec §4, two-bucket rule). The active subscription's tier display name is
// resolved from the SKU catalogue, falling back to the raw lookup key when the tier
// is no longer offered. Platform-independent BRAIN (R1): no React/DOM.

import type { BalanceResponse, SkuListing } from '@mythrun/contract/rest'

export interface BalanceView {
  /** Session credits — the play/session bucket. NEVER summed with worldGen. */
  readonly session: number
  /** World-gen credits — the world-creation bucket. NEVER summed with session. */
  readonly worldGen: number
  readonly subscription: {
    readonly tierLookupKey: string
    readonly tierDisplayName: string
    readonly cancelAtPeriodEnd: boolean
    readonly currentPeriodEnd: string
  } | null
}

export function balanceView(balance: BalanceResponse, skus: readonly SkuListing[]): BalanceView {
  const sub = balance.active_subscription
  const tier = sub === null ? undefined : skus.find((s) => s.lookup_key === sub.tier_lookup_key)
  return {
    session: balance.session,
    worldGen: balance.world_gen,
    subscription:
      sub === null
        ? null
        : {
            tierLookupKey: sub.tier_lookup_key,
            tierDisplayName: tier?.displayName ?? sub.tier_lookup_key,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            currentPeriodEnd: sub.current_period_end,
          },
  }
}
