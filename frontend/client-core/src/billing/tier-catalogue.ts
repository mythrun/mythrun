// The tier catalogue: pure derivations over the raw GET /api/billing/skus listing
// that the settings screen renders against. The three subscription-tier names
// (Wayfarer / Sojourner / Mythwright, spec §11) are SERVER DATA carried through
// verbatim — this layer adds no "best value" / "recommended" marker (§11 register
// constraint). Platform-independent BRAIN (R1): no React/DOM.

import type { SkuListing } from '@mythrun/contract/rest'

/** Recurring subscription tiers, ascending by price (Wayfarer → Sojourner →
 *  Mythwright). Price rank — not insertion order — is authoritative. */
export function subscriptionTiers(skus: readonly SkuListing[]): SkuListing[] {
  return skus
    .filter((s) => s.type === 'recurring')
    .sort((a, b) => a.price.unit_amount_cents - b.price.unit_amount_cents)
}

/** À-la-carte SKUs (session / world packs) — the one_time purchases. */
export function aLaCarteSkus(skus: readonly SkuListing[]): SkuListing[] {
  return skus.filter((s) => s.type === 'one_time')
}

/** Price-rank of a recurring tier (0-based ascending); undefined for a non-tier
 *  SKU or an unknown key. The subscription-CTA gating (Task 5) reads this to
 *  order upgrade vs. manage without ever re-summing prices itself. */
export function tierRank(skus: readonly SkuListing[], lookupKey: string): number | undefined {
  const idx = subscriptionTiers(skus).findIndex((t) => t.lookup_key === lookupKey)
  return idx === -1 ? undefined : idx
}
