/**
 * The closed set of 4xx/5xx `code` values any billing route may return.
 *
 * myth-wtj2i — the previous version of this file was a bare `type` union that
 * NOTHING imported: the emit sites wrote `reply.code(400).send({ code: '…' })`
 * with an inferred string literal, so the "closed enum" was documentation, not
 * a constraint, and a typo shipped a code no client knew. It was deleted as
 * dead code. This version is load-bearing:
 *
 *   - The union is DERIVED from the `BILLING_ERROR_CODES` tuple, so the type
 *     and the runtime list cannot drift apart.
 *   - Every emit site constructs its envelope through `billingError(code)`,
 *     whose parameter is typed to the union — an unknown code is a TYPE ERROR
 *     at the emit site, not a silent 400 with a made-up body.
 *   - `eslint.config.js` bans a bare `{ code: '…' }` object literal in the
 *     billing route files, so a new site cannot quietly reintroduce the
 *     unchecked form.
 *   - `__tests__/errors.test.ts` holds a `Record<BillingErrorCode, …>` status
 *     map: adding a code here without documenting its HTTP status fails
 *     typecheck, and a stale entry does too.
 *
 * Adding a new code requires:
 *   1. Adding it to `BILLING_ERROR_CODES` below.
 *   2. Adding a row to §12.2 (Scenarios) of the billing spec.
 *   3. Adding its status to the map in `__tests__/errors.test.ts`.
 *   4. Emitting it via `billingError()` from the route handler.
 *
 * Per spec §12.1.
 *
 * NOT included: `unauthenticated` / `username_required`. Those are the shared
 * cross-route auth envelope emitted by every authenticated plugin's
 * `resolveUserId` (cf. routes/invites.ts), not a billing-domain error, and the
 * lint rule exempts them by value.
 */
export const BILLING_ERROR_CODES = [
  'body_invalid', // Zod schema rejected body
  'mixed_cart', // tier + à-la-carte in same cart
  'tier_cart_shape', // tier with items.length > 1 OR quantity > 1
  'duplicate_lookup_key', // same lookup_key listed twice in items[]
  'unknown_lookup_key', // lookup_key not in LOOKUP_KEYS
  'no_active_subscription', // /upgrade-tier called by user with no active sub
  'tier_unchanged', // /upgrade-tier target_tier === current tier
  'not_an_upgrade', // /upgrade-tier target_tier price <= current
  'invalid_cursor', // /history cursor failed base64url/JSON decode
  'stripe_unavailable', // Stripe API call returned 5xx or timed out
  'missing_signature', // /webhooks/stripe missing Stripe-Signature header
  'invalid_signature', // /webhooks/stripe constructEvent failed
  'upgrade_payment_pending', // /upgrade-tier proration invoice failed to settle synchronously; pending_update populated (per §4.6 + §5.4.6)
  'upgrade_already_pending', // /upgrade-tier called while sub already has a pending_update from a prior attempt (per Petra I5 round 7)
  'sku_cache_unavailable', // GET /api/billing/skus — boot probe hasn't populated the cache yet (defensive; probe gates app.ready())
  // NOT in spec §12.1's list — but routes/webhook.ts DOES emit it (the 500 when
  // the raw-body parser registration is missing and request.body isn't a
  // Buffer). Recorded here so the union stays honest about what the routes can
  // actually return; §12.1 should gain the row.
  'internal',
] as const

export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number]

/**
 * The wire envelope shape for billing errors.
 *
 * 4xx responses use `{ code, ...detail }` per §4.1. The `detail` shape varies
 * per code (see §12.2 Scenarios for the per-code detail contract); use type
 * guards at the consumer side.
 */
export interface BillingErrorEnvelope {
  readonly code: BillingErrorCode
}

/**
 * Build a billing error envelope. THE enforcement point: `code` is typed to
 * the closed union, so `billingError('typoed_code')` fails typecheck.
 *
 * The literal type is preserved through the generic, so a caller whose return
 * type narrows the code (e.g. `CartValidationFailure`) still type-checks
 * against its own narrower union. Codes that carry a `detail` payload spread
 * this: `{ ...billingError('unknown_lookup_key'), lookup_key }`.
 */
export function billingError<C extends BillingErrorCode>(code: C): { readonly code: C } {
  return { code }
}
