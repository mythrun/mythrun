// backend/src/billing/webhook-checkout-payment.ts
//
// Payment-mode (à-la-carte) branch of `checkout.session.completed` per
// MYT-42 spec §5.4.1 lines 590-596. Extracted from webhook.ts to keep that
// module under the 400-line cap (lint warning, CLAUDE.md convention).
//
// The handler walks `session.line_items.data`, resolves each `price.id`
// against the SKU cache, validates the reconstructed subtotal against
// `session.amount_subtotal`, asserts payment_status='paid', then writes:
//   - one purchases row per line_item,
//   - one billing_history row (kind='purchase', lookup_key=NULL),
//   - one credit_ledger row per (line, credit_type with grant > 0), linked
//     back to the purchases row via source_purchase_id (Decision 4 of
//     round-2 review + migration 007's credit_ledger_source_link_chk).
//
// All "soft fail" branches (unknown price ID, amount mismatch, non-paid
// status, missing PaymentIntent) return 'validation_failed': the dispatcher
// COMMITs the stripe_events row so Stripe stops retrying, but skips the
// downstream writes.

import type { Stripe } from 'stripe'
import type { FastifyBaseLogger } from 'fastify'
import type { TxRepo } from '../repo/index.js'
import { type NewPurchaseRow } from '../repo/purchases.js'
import { uuidv7 } from '../repo/uuidv7.js'
import { getSkuCache, type SkuInternalEntry } from './sku-cache.js'
import { LOOKUP_KEYS, type LookupKey, type LookupKeySpec } from './lookup-keys.js'
import type { HandlerResult } from './webhook-types.js'

interface PaymentLineResolution {
  readonly id: string // line_item id, for log context only
  readonly quantity: number
  readonly amountTotal: number // line.amount_total (per-line, post-tax/discount)
  readonly currency: string // line.price.currency
  readonly priceId: string // line.price.id
  readonly entry: SkuInternalEntry
  readonly spec: LookupKeySpec
}

/**
 * Resolve one line_item against the SKU cache + LOOKUP_KEYS spec map. Returns
 * `null` on unknown price.id or missing required fields; the caller logs a
 * paging error and returns 'validation_failed'.
 */
function resolvePaymentLine(
  line: Stripe.LineItem,
  log: FastifyBaseLogger,
  logCtx: { event_id: string; session_id: string },
): PaymentLineResolution | null {
  const price = line.price
  /* c8 ignore start — Stripe-side invariant: payment-mode line_items
   * always carry a price with a non-empty id. The handler's contract
   * (prefetcher expands line_items.data.price) guarantees this; the
   * defensive null/empty check is a paging path for a Stripe anomaly
   * we can't recover from. */
  if (!price || typeof price.id !== 'string' || price.id.length === 0) {
    log.error({ ...logCtx, line_id: line.id }, 'billing.checkout_unknown_price_id')
    return null
  }
  /* c8 ignore stop */
  const cache = getSkuCache()
  /* c8 ignore start — boot-time invariant: the SKU cache is populated
   * before the route accepts traffic per §10. A null cache here is a
   * programming error; throwing forces a tx ROLLBACK so Stripe redelivers. */
  if (!cache) {
    throw new Error('checkout.session.completed payment mode: SKU cache not initialized')
  }
  /* c8 ignore stop */
  const entry = cache.byPriceId.get(price.id)
  if (!entry) {
    log.error(
      { ...logCtx, line_id: line.id, price_id: price.id },
      'billing.checkout_unknown_price_id',
    )
    return null
  }
  // The cache's lookup_key is one of LookupKey by construction (probe.ts
  // builds the cache from LOOKUP_KEYS). LOOKUP_KEYS is a Record over
  // LookupKey, so the indexed access is total at the type level — no `as`
  // needed.
  const cachedKey: LookupKey = entry.lookup_key
  const spec = LOOKUP_KEYS[cachedKey]
  return {
    id: line.id,
    /* c8 ignore start — `?? 1` fallback is defensive: payment-mode
     * line_items always carry a non-null quantity. */
    quantity: line.quantity ?? 1,
    /* c8 ignore stop */
    amountTotal: line.amount_total,
    currency: price.currency,
    priceId: price.id,
    entry,
    spec,
  }
}

async function grantCreditsForLine(
  tx: TxRepo,
  userId: string,
  resolution: PaymentLineResolution,
  purchaseRowId: string,
): Promise<void> {
  if (resolution.spec.sessionsGranted > 0) {
    await tx.credits.grantInTx({
      userId,
      creditType: 'session',
      amount: resolution.spec.sessionsGranted * resolution.quantity,
      sourceType: 'purchase',
      sourcePurchaseId: purchaseRowId,
      sourceBillingHistoryId: null,
      sourceId: null,
      expiresAt: null,
    })
  }
  if (resolution.spec.worldsGranted > 0) {
    await tx.credits.grantInTx({
      userId,
      creditType: 'world_gen',
      amount: resolution.spec.worldsGranted * resolution.quantity,
      sourceType: 'purchase',
      sourcePurchaseId: purchaseRowId,
      sourceBillingHistoryId: null,
      sourceId: null,
      expiresAt: null,
    })
  }
}

/**
 * Payment-mode (à-la-carte) handler for `checkout.session.completed`.
 * See module header for spec references and contract.
 */
export async function handleCheckoutCompletedPayment(
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
  userId: string,
  tx: TxRepo,
  log: FastifyBaseLogger,
): Promise<HandlerResult> {
  const ids = { event_id: event.id, session_id: session.id }

  // The prefetcher always retrieves session with expand: ['line_items.data.price'].
  // A null line_items here is a Stripe-side anomaly we don't have a recovery
  // for; treat the same as "no resolvable lines" and return validation_failed.
  /* c8 ignore start — `?? []` fallback is structurally unreachable: the
   * prefetcher's expand-list guarantees session.line_items is set. */
  const lines = session.line_items?.data ?? []
  /* c8 ignore stop */
  /* c8 ignore start — Stripe-side invariant: payment-mode checkout
   * sessions never come back with an empty line_items.data array; this
   * is a defensive paging path for the anomaly. */
  if (lines.length === 0) {
    log.error(ids, 'billing.checkout_payment_no_line_items')
    return 'validation_failed'
  }
  /* c8 ignore stop */

  // 1. Resolve every line against the SKU cache. Any unknown price.id ⇒
  //    validation_failed. Stop on first miss so the log line carries the
  //    specific bad price id, not a list.
  const resolved: PaymentLineResolution[] = []
  for (const line of lines) {
    const r = resolvePaymentLine(line, log, ids)
    if (!r) return 'validation_failed'
    resolved.push(r)
  }

  // 2. Defensive payment_status='paid' assertion (spec §5.4.1 line 596). At
  //    launch under payment_method_types: ['card', 'link'] this is always
  //    true; a non-paid value is misconfiguration and must page.
  if (session.payment_status !== 'paid') {
    log.error(
      { ...ids, payment_status: session.payment_status },
      'billing.payment_status_unexpected',
    )
    return 'validation_failed'
  }

  // 3. Amount validation (spec §5.4 cross-cutting rule 2 + Chimera I5 round 2):
  //    expected_subtotal = sum(unit_amount_cents * quantity) per resolved SKU;
  //    assert == session.amount_subtotal. amount_subtotal is pre-tax-pre-discount,
  //    so a future tax-on flip won't silently break this assertion.
  const expectedSubtotal = resolved.reduce(
    (acc, r) => acc + r.entry.price.unit_amount_cents * r.quantity,
    0,
  )
  const actualSubtotal = session.amount_subtotal
  if (actualSubtotal === null || expectedSubtotal !== actualSubtotal) {
    log.error(
      { event_id: event.id, expected: expectedSubtotal, actual: actualSubtotal },
      'billing.amount_validation_failed',
    )
    return 'validation_failed'
  }

  // 4. PaymentIntent ID must be present (purchases.stripe_payment_intent_id is
  //    NOT NULL). For payment-mode sessions Stripe always sets payment_intent;
  //    a null here is a Stripe-side anomaly we can't recover from. Page +
  //    return validation_failed instead of crashing the tx.
  const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : null
  if (paymentIntent === null) {
    log.error(ids, 'billing.checkout_payment_no_payment_intent')
    return 'validation_failed'
  }

  // 5. Build purchase rows (one per line). Insert via insertMany — single
  //    batched INSERT, fewer round-trips than per-row inserts.
  const purchaseRows: NewPurchaseRow[] = resolved.map((r) => ({
    id: uuidv7(),
    user_id: userId,
    stripe_payment_intent_id: paymentIntent,
    lookup_key: r.entry.lookup_key,
    quantity: r.quantity,
    amount_cents: r.amountTotal,
    currency: r.currency,
  }))
  await tx.purchases.insertMany(purchaseRows)

  // 6. Append billing_history (one row, kind='purchase', lookup_key=NULL).
  //    Currency uses session.currency (cart-level), not per-line. à-la-carte
  //    never expires. Default opts (plain INSERT throws on conflict) is safe:
  //    the stripe_events PK already dedupes redeliveries before the handler
  //    runs, so a 23505 here would be a real bug.
  /* c8 ignore start — both `??` fallbacks are defensive: payment-mode
   * sessions always carry `currency`, and the earlier length-check
   * guarantees `resolved[0]` is defined. The 'usd' tail is the final
   * defense-in-depth default. */
  const sessionCurrency = session.currency ?? resolved[0]?.currency ?? 'usd'
  /* c8 ignore stop */
  await tx.billingHistory.append({
    id: uuidv7(),
    user_id: userId,
    kind: 'purchase',
    source_id_stripe: paymentIntent,
    stripe_payment_intent_id: paymentIntent,
    lookup_key: null,
    amount_cents: actualSubtotal,
    currency: sessionCurrency,
    expires_at: null,
    occurred_at: new Date(event.created * 1000),
  })

  // 7. Grant credits. One credit_ledger row per (resolved line, credit_type
  //    with grant > 0). source_type='purchase' requires source_purchase_id
  //    NOT NULL per migration 007's credit_ledger_source_link_chk;
  //    source_billing_history_id MUST be NULL. expires_at = null.
  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i]
    const purchaseRow = purchaseRows[i]
    /* c8 ignore start — defensive invariant: purchaseRows was built by
     * `resolved.map(...)` immediately above so the arrays have identical
     * length and matching indices. Either being undefined here is a
     * programming error, not a runtime path. */
    if (!r || !purchaseRow) {
      throw new Error('handleCheckoutCompletedPayment: resolved/purchaseRow length mismatch')
    }
    /* c8 ignore stop */
    await grantCreditsForLine(tx, userId, r, purchaseRow.id)
  }

  return 'ok'
}
