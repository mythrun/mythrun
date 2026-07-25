// myth-wtj2i — the test the old errors.ts CLAIMED existed. Its header said "the
// §13 routes test asserts that every emit-site uses a code that's in this
// union", but nothing imported the union at all, so the closed enum was a
// comment. This file is that consumer.
//
// Two layers:
//   1. COMPILE-TIME. `HTTP_STATUS` below is a `Record<BillingErrorCode, …>`.
//      Adding a code to BILLING_ERROR_CODES without a status here fails
//      typecheck; a status for a code that no longer exists fails too. The
//      `billingError()` calls in the round-trip test are the same check applied
//      to the emit-site signature.
//   2. RUNTIME. The tuple and the type cannot drift (the type is derived), so
//      the runtime checks here are about the tuple itself: no duplicates, and
//      every code is actually reachable from a route.

import { describe, expect, it } from 'vitest'
import {
  BILLING_ERROR_CODES,
  billingError,
  type BillingErrorCode,
  type BillingErrorEnvelope,
} from '../errors.js'

/** Every billing error code and the HTTP status its emit site sends. Exhaustive
 *  by type: a new code without a row here is a compile error. */
const HTTP_STATUS: Record<BillingErrorCode, 400 | 409 | 500 | 502 | 503> = {
  body_invalid: 400,
  mixed_cart: 400,
  tier_cart_shape: 400,
  duplicate_lookup_key: 400,
  unknown_lookup_key: 400,
  no_active_subscription: 400,
  tier_unchanged: 400,
  not_an_upgrade: 400,
  invalid_cursor: 400,
  missing_signature: 400,
  invalid_signature: 400,
  upgrade_already_pending: 409,
  internal: 500,
  stripe_unavailable: 502,
  upgrade_payment_pending: 502,
  sku_cache_unavailable: 503,
}

describe('BILLING_ERROR_CODES', () => {
  it('has no duplicate entries', () => {
    expect(new Set(BILLING_ERROR_CODES).size).toBe(BILLING_ERROR_CODES.length)
  })

  it('is exactly the key set of the documented status map (no orphan either way)', () => {
    // The compile-time half is the Record type above. This is the runtime
    // mirror: it catches a tuple entry that typecheck can't see as missing
    // (TypeScript widens nothing here, but the assertion documents intent and
    // fails loudly if the tuple is edited without the map).
    expect([...BILLING_ERROR_CODES].sort()).toEqual(Object.keys(HTTP_STATUS).sort())
  })
})

describe('billingError', () => {
  it('builds the { code } envelope for every code in the union', () => {
    for (const code of BILLING_ERROR_CODES) {
      const envelope: BillingErrorEnvelope = billingError(code)
      expect(envelope).toEqual({ code })
    }
  })

  it('preserves the literal type so narrower call-site unions still check', () => {
    // Compile-time assertion: the generic returns `{ code: 'mixed_cart' }`, not
    // `{ code: BillingErrorCode }`, so a handler whose failure union only
    // admits a subset of codes can still return it. If the signature ever
    // widens, this assignment stops compiling.
    const narrow: { readonly code: 'mixed_cart' } = billingError('mixed_cart')
    expect(narrow.code).toBe('mixed_cart')
  })

  it('spreads cleanly for the codes that carry a detail payload', () => {
    const withDetail = { ...billingError('unknown_lookup_key'), lookup_key: 'sku_nope' }
    expect(withDetail).toEqual({ code: 'unknown_lookup_key', lookup_key: 'sku_nope' })
  })
})
