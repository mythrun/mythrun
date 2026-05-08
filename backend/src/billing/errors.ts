/**
 * Closed enum of every 4xx/5xx response code any billing route can return.
 *
 * The §13 routes test asserts that every emit-site uses a code that's in
 * this union (via a compile-time const check). Adding a new code requires:
 *   1. Adding it here.
 *   2. Adding a row to §12.2 (Scenarios) of the spec.
 *   3. Updating any route handler that emits it.
 *
 * Per spec §12.1.
 */
export type BillingErrorCode =
  | 'body_invalid' // Zod schema rejected body
  | 'mixed_cart' // tier + à-la-carte in same cart
  | 'tier_cart_shape' // tier with items.length > 1 OR quantity > 1
  | 'duplicate_lookup_key' // same lookup_key listed twice in items[]
  | 'unknown_lookup_key' // lookup_key not in LOOKUP_KEYS
  | 'no_active_subscription' // /upgrade-tier called by user with no active sub
  | 'tier_unchanged' // /upgrade-tier target_tier === current tier
  | 'not_an_upgrade' // /upgrade-tier target_tier price <= current
  | 'invalid_cursor' // /history cursor failed base64url/JSON decode
  | 'stripe_unavailable' // Stripe API call returned 5xx or timed out
  | 'missing_signature' // /webhooks/stripe missing Stripe-Signature header
  | 'invalid_signature' // /webhooks/stripe constructEvent failed
  | 'upgrade_payment_pending' // /upgrade-tier proration invoice failed to settle synchronously; pending_update populated (per §4.6 + §5.4.6)
  | 'upgrade_already_pending' // /upgrade-tier called while sub already has a pending_update from a prior attempt (per Petra I5 round 7)
  | 'sku_cache_unavailable' // GET /api/billing/skus — boot probe hasn't populated the cache yet (defensive; probe gates app.ready())

/**
 * The wire envelope shape for billing errors.
 *
 * 4xx responses use `{ code, ...detail }` per §4.1. The `detail` shape varies
 * per code (see §12.2 Scenarios for the per-code detail contract); use
 * type guards at the consumer side.
 */
export interface BillingErrorEnvelope {
  readonly code: BillingErrorCode
}
