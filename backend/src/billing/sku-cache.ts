/**
 * Module-level SKU cache populated by the boot probe (§13 of probe.ts).
 *
 * The cache is set ONCE after a successful probe pass and is read by:
 *   - GET /api/billing/skus  → publicListing (route-layer serialization)
 *   - webhook handlers       → byPriceId    (reverse-lookup price.id → lookup_key)
 *   - amount validation      → byLookupKey  (forward lookup for SKU spec)
 *
 * Cache is process-scoped; never refreshed within a process. The probe re-runs
 * on every deploy, so contract drift (a Stripe price changing under us) is
 * caught at the next deploy boundary — that's the MYT-41 design.
 *
 * Per spec §10.
 */

import type { LookupKey } from './lookup-keys.js'

/**
 * Internal cache entry — INCLUDES stripe_price_id for the webhook reverse-map.
 * Used by handlers, NEVER serialized to a public response. The public endpoint
 * uses SkuPublicListing instead, which omits stripe_price_id.
 */
export interface SkuInternalEntry {
  readonly lookup_key: LookupKey
  readonly stripe_price_id: string  // e.g. price_1ABCxyz — internal-only
  readonly displayName: string
  readonly type: 'recurring' | 'one_time'
  readonly sessionsGranted: number
  readonly worldsGranted: number
  readonly price: { readonly unit_amount_cents: number; readonly currency: string }
}

/**
 * Public projection — EXCLUDES stripe_price_id. Per Stilton I7 round 3:
 * principle of least disclosure on a public unauthenticated endpoint; the
 * Stripe price ID has no business in a marketing/pricing-page payload.
 *
 * Build via TS rest-omit:  const { stripe_price_id: _, ...pub } = internal
 */
export interface SkuPublicListing {
  readonly lookup_key: LookupKey
  readonly displayName: string
  readonly type: 'recurring' | 'one_time'
  readonly sessionsGranted: number
  readonly worldsGranted: number
  readonly price: { readonly unit_amount_cents: number; readonly currency: string }
}

export interface SkuCache {
  readonly byLookupKey: ReadonlyMap<LookupKey, SkuInternalEntry>
  readonly byPriceId: ReadonlyMap<string, SkuInternalEntry>
  readonly publicListing: readonly SkuPublicListing[]
}

let cache: SkuCache | null = null

/**
 * Set the cache snapshot. Idempotent during boot (the probe is the only
 * caller); calling twice with different snapshots is a programming error.
 */
export function setSkuCache(snapshot: SkuCache): void {
  cache = snapshot
}

/**
 * Get the current cache snapshot, or null if the probe hasn't run.
 *
 * Callers handle the null case: GET /api/billing/skus returns 503 (defensive
 * only — the probe gates boot, so any request reaching the route should see
 * a non-null cache).
 */
export function getSkuCache(): SkuCache | null {
  return cache
}

/**
 * Test-only reset. Vitest's module-cache makes the module-level `cache`
 * sticky across tests within a file; this lets tests start clean.
 *
 * NOT exported from the public barrel; tests import directly via the file
 * path. Production code never calls this.
 */
export function _resetSkuCacheForTests(): void {
  cache = null
}
