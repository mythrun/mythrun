// backend/src/billing/webhook-pending-update-applied.ts
//
// Handler for `customer.subscription.pending_update_applied` per MYT-42
// spec §5.4.6 (Task 22). This is the canonical credit-grant path for
// tier-upgrade events introduced by `payment_behavior: 'pending_if_incomplete'`
// (§4.6); the round-7+8 redesign moved the credit grant off `invoice.paid`
// `subscription_update` and onto this event so the items-advance + payment-
// landed signal is delivered atomically by Stripe.
//
// Key invariants:
//   - **Prefetch the proration invoice** (Petra I3 round 5): credit DELTAs
//     are derived from the invoice line items, NOT from the user_subscriptions
//     row. The `customer.subscription.updated` handler may have already
//     overwritten `tier_lookup_key`, so reading "OLD" from there would be
//     wrong. Both OLD and NEW prices ride on the proration invoice's lines.
//
//   - **Type-narrow on `pricing.type === 'price_details'`** before reading
//     `price_details.price` (Carthage C3 round 8 — no `as` casts). Stripe
//     types this field as a discriminated union; gating the discriminant
//     gives us safe access without assertion.
//
//   - **Symmetric `do_update_coalesce`** on the billing_history append
//     (Persepolis C4 round 8): `invoice.paid` `subscription_update` (Task 19)
//     writes the SAME billing_history row via the same upsert shape. Stripe
//     does not contractually order `pending_update_applied` vs `invoice.paid`
//     deliveries; whichever arrives first writes the canonical row, the
//     second arrival fills NULLs without overwriting. The RETURNING id from
//     the upsert is the canonical billing_history.id used as the FK on the
//     credit_ledger grant rows.
//
//   - **Idempotent `upsertFromStripe`**: pending_update_applied is the
//     canonical place to record the NEW tier on `user_subscriptions`. If a
//     prior `customer.subscription.updated` already wrote it, the strict-`>`
//     filter on `stripe_event_created_at` rejects the redundant write.
//
//   - **Amount validation** asserts `subtotal_excluding_tax === (newPrice -
//     oldPrice)` (the flat dollar delta). Mismatch → 'validation_failed'.
//
//   - **expires_at = period_end + 1 month** for the billing_history row +
//     credit_ledger grants. Computed in JS as `period_end_ms + 30 * 86400000`
//     — close enough for monthly billing UX. The next `subscription_cycle`
//     invoice replaces these credits a month later anyway.

import type { Stripe } from 'stripe'
import type { FastifyBaseLogger } from 'fastify'
import type { ClientLike } from '../repo/_types.js'
import { billingHistory } from '../repo/billing-history.js'
import { userSubscriptions } from '../repo/user-subscriptions.js'
import { grantInTx } from '../repo/credits.js'
import { uuidv7 } from '../repo/uuidv7.js'
import { getSkuCache } from './sku-cache.js'
import { LOOKUP_KEYS, type LookupKey } from './lookup-keys.js'
import type { HandlerResult } from './webhook-types.js'

/**
 * Shape of the prefetched proration invoice. The dispatcher runs the
 * prefetcher OUTSIDE the dispatch tx (per §5.3 prefetch-then-write
 * discipline). `invoice` is `null` when the Subscription's `latest_invoice`
 * was somehow unset — defensive against an event shape that shouldn't occur
 * for a `pending_update_applied` delivery.
 */
export interface PendingUpdateAppliedPrefetch {
  readonly invoice: Stripe.Invoice | null
}

/**
 * Prefetcher for `customer.subscription.pending_update_applied` (spec
 * §5.4.6). Reads `subscription.latest_invoice` (string id or embedded form)
 * and retrieves the invoice so the handler can derive OLD/NEW tier from
 * the proration line items.
 */
export async function prefetchPendingUpdateApplied(
  event: Stripe.Event,
  stripe: Stripe,
): Promise<PendingUpdateAppliedPrefetch> {
  const sub = event.data.object as Stripe.Subscription
  const latestInvoiceId =
    typeof sub.latest_invoice === 'string' ? sub.latest_invoice : (sub.latest_invoice?.id ?? null)
  if (latestInvoiceId === null) return { invoice: null }
  const invoice = await stripe.invoices.retrieve(latestInvoiceId)
  return { invoice }
}

/**
 * Runtime-shape gate for the prefetch. Throws on unexpected shape — a
 * programming error that should fail loudly (the dispatcher will ROLLBACK
 * and Stripe redelivers).
 */
function asPendingUpdateAppliedPrefetch(prefetch: unknown): PendingUpdateAppliedPrefetch {
  if (typeof prefetch !== 'object' || prefetch === null || !('invoice' in prefetch)) {
    throw new Error('customer.subscription.pending_update_applied: prefetch shape unexpected')
  }
  return prefetch as PendingUpdateAppliedPrefetch
}

interface PendingUpdateLogIds {
  readonly event_id: string
  readonly subscription_id: string
  readonly customer: string | null
  readonly metadata_user_id: string | null
  readonly invoice_id: string | null
}

function pendingUpdateLogIds(
  event: Stripe.Event,
  subscription: Stripe.Subscription,
  invoice: Stripe.Invoice | null,
): PendingUpdateLogIds {
  const customer =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
  const metadataUserId = subscription.metadata.userId
  return {
    event_id: event.id,
    subscription_id: subscription.id,
    customer: customer.length > 0 ? customer : null,
    metadata_user_id:
      typeof metadataUserId === 'string' && metadataUserId.length > 0 ? metadataUserId : null,
    invoice_id: invoice?.id ?? null,
  }
}

/**
 * Resolve the user via `subscription.customer` → `users.stripe_customer_id`
 * (FOR UPDATE — anchor lock per §5.3). On miss, fall back to
 * `subscription.metadata.userId`. Returns `null` on total miss — caller
 * pages `billing.upgrade_orphan` (real money landed for an unresolvable
 * customer) and returns 'ok'.
 */
async function resolveUser(
  client: ClientLike,
  subscription: Stripe.Subscription,
): Promise<{ readonly id: string } | null> {
  const customer =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
  if (customer.length > 0) {
    const byCustomer = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE stripe_customer_id = $1 FOR UPDATE',
      [customer],
    )
    const found = byCustomer.rows[0]
    if (found) return { id: found.id }
  }
  const fallbackUserId = subscription.metadata.userId
  if (typeof fallbackUserId !== 'string' || fallbackUserId.length === 0) {
    return null
  }
  const byUserId = await client.query<{ id: string }>(
    'SELECT id FROM users WHERE id = $1 FOR UPDATE',
    [fallbackUserId],
  )
  const found = byUserId.rows[0]
  return found ? { id: found.id } : null
}

/**
 * Reverse-resolve a Stripe Price id → lookup_key via the SKU cache.
 * Returns `null` on cache miss (caller logs + returns 'validation_failed').
 *
 * Throws if the cache itself is uninitialized — boot-time invariant
 * violation.
 */
function lookupKeyForPriceId(priceId: string): LookupKey | null {
  const cache = getSkuCache()
  if (!cache) {
    throw new Error('pending_update_applied: SKU cache not initialized')
  }
  const entry = cache.byPriceId.get(priceId)
  return entry?.lookup_key ?? null
}

/**
 * Read the canonical PaymentIntent id from a basil-shape Invoice's
 * `payments[]` array. Stripe removed `Invoice.payment_intent` at basil;
 * the canonical PI lives on the first payment record's
 * `payment.payment_intent` (per §3.1 note 7 + Carthage C1 round 8).
 */
function readPrimaryPaymentIntent(invoice: Stripe.Invoice): string | null {
  const payments = invoice.payments?.data
  if (!payments) return null
  const first = payments[0]
  if (!first) return null
  const pi = first.payment.payment_intent
  if (pi === undefined) return null
  if (typeof pi === 'string') return pi
  return pi.id
}

/**
 * Walk `invoice.lines.data` and split into negative- and positive-amount
 * lines that pass the `pricing.type === 'price_details'` discriminator
 * (Carthage C3 round 8 type-narrowing).
 *
 * Per spec §5.4.6 line 736: a proration invoice for an upgrade carries
 * EXACTLY ONE negative line (refund of the OLD tier's unused proration)
 * and EXACTLY ONE positive line (charge for the NEW tier's prorated
 * remainder). Anything else is operator error or an invoice shape we don't
 * understand; the handler returns 'validation_failed'.
 *
 * The tighter type on the returned lines guarantees `pricing.price_details`
 * is non-null at the call site without further narrowing.
 */
interface NarrowedLine {
  readonly amount: number
  readonly priceId: string
}

interface SplitLines {
  readonly negatives: readonly NarrowedLine[]
  readonly positives: readonly NarrowedLine[]
  readonly allAmounts: readonly number[]
}

function splitInvoiceLines(invoice: Stripe.Invoice): SplitLines {
  const negatives: NarrowedLine[] = []
  const positives: NarrowedLine[] = []
  const allAmounts: number[] = []
  for (const line of invoice.lines.data) {
    allAmounts.push(line.amount)
    // Per Carthage C3 round 8: gate on `pricing.type === 'price_details'`
    // before reading price_details.price. Stripe types `pricing.type` as
    // the literal 'price_details' today (`pricing` itself is nullable);
    // we still defensively guard `price_details` since the shape is
    // optional in the type and the runtime payload could lag the SDK.
    const pricing = line.pricing
    if (pricing?.type !== 'price_details') continue
    const details = pricing.price_details
    if (!details) continue
    // `details.price` is typed `string | Price` (a Price object when expanded;
    // the prefetcher does NOT expand prices on the proration invoice, so the
    // runtime value is always a string id — narrow on `typeof` without `as`).
    const priceRef = details.price
    const priceId = typeof priceRef === 'string' ? priceRef : priceRef.id
    const narrowed: NarrowedLine = { amount: line.amount, priceId }
    if (line.amount < 0) negatives.push(narrowed)
    else if (line.amount > 0) positives.push(narrowed)
  }
  return { negatives, positives, allAmounts }
}

/**
 * Look up a `LookupKeySpec` by string. The spec keys are a closed set; an
 * unknown lookup_key here is a programming error (the SKU cache only emits
 * keys from `LOOKUP_KEYS`).
 */
function lookupKeySpec(key: LookupKey): {
  readonly priceCents: number
  readonly sessionsGranted: number
  readonly worldsGranted: number
} {
  const spec = LOOKUP_KEYS[key]
  // priceCents is NOT carried on LOOKUP_KEYS itself (the price lives in
  // Stripe per the lookup-keys.ts comment); we pull it from the SKU cache,
  // which is populated by the boot probe with the live Stripe unit_amount.
  const cache = getSkuCache()
  if (!cache) {
    throw new Error('pending_update_applied: SKU cache not initialized')
  }
  const entry = cache.byLookupKey.get(key)
  if (!entry) {
    throw new Error(`pending_update_applied: SKU cache missing entry for lookup_key=${key}`)
  }
  return {
    priceCents: entry.price.unit_amount_cents,
    sessionsGranted: spec.sessionsGranted,
    worldsGranted: spec.worldsGranted,
  }
}

/**
 * Compute the +1-month projection for `expires_at` on the billing_history
 * row + credit_ledger grants. Uses 30 days as a flat approximation —
 * monthly billing UX doesn't materially differ between 30 and 31 days, and
 * the next `subscription_cycle` invoice replaces these credits a month
 * later anyway.
 */
function expiresAtPlusOneMonth(periodEndSec: number): Date {
  const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000
  return new Date(periodEndSec * 1000 + ONE_MONTH_MS)
}

interface ParsedProration {
  readonly error: HandlerResult | null
  readonly oldLookupKey: LookupKey
  readonly newLookupKey: LookupKey
  readonly oldSpec: ReturnType<typeof lookupKeySpec>
  readonly newSpec: ReturnType<typeof lookupKeySpec>
  readonly subtotal: number
}

// Three sub-steps of the pending_update_applied handler fused into one
// helper because they share the 'validation_failed' return path and their
// outputs thread strictly forward into each other:
//   (a) splitInvoiceLines → exactly one negative + one positive line
//   (b) reverse-resolve OLD/NEW lookup_keys from the price IDs
//   (c) amount validation against newSpec.priceCents - oldSpec.priceCents
// Errors emit the corresponding billing.upgrade_* / billing.amount_*
// log line and surface a HandlerResult discriminator the caller returns.
function parseAndValidateProration(
  invoice: Stripe.Invoice,
  ids: PendingUpdateLogIds,
  log: FastifyBaseLogger,
): ParsedProration {
  const split = splitInvoiceLines(invoice)
  if (split.negatives.length !== 1 || split.positives.length !== 1) {
    log.error({ ...ids, line_amounts: split.allAmounts }, 'billing.upgrade_unexpected_line_shape')
    return parsedProrationError('validation_failed')
  }
  const negative = split.negatives[0]
  const positive = split.positives[0]
  if (!negative || !positive) {
    // length === 1 but [0] missing is unreachable; satisfies strict-TS
    // exhaustive narrowing without `as`.
    throw new Error(`pending_update_applied: line split inconsistent for invoice=${invoice.id}`)
  }

  const oldLookupKey = lookupKeyForPriceId(negative.priceId)
  const newLookupKey = lookupKeyForPriceId(positive.priceId)
  if (oldLookupKey === null || newLookupKey === null) {
    log.error(
      {
        ...ids,
        old_price_id: negative.priceId,
        new_price_id: positive.priceId,
        old_resolved: oldLookupKey,
        new_resolved: newLookupKey,
      },
      'billing.upgrade_unknown_price_id',
    )
    return parsedProrationError('validation_failed')
  }

  const subtotal = invoice.subtotal_excluding_tax
  const oldSpec = lookupKeySpec(oldLookupKey)
  const newSpec = lookupKeySpec(newLookupKey)
  const expectedDelta = newSpec.priceCents - oldSpec.priceCents
  if (subtotal === null || subtotal !== expectedDelta) {
    log.error(
      {
        ...ids,
        old_lookup_key: oldLookupKey,
        new_lookup_key: newLookupKey,
        expected: expectedDelta,
        actual: subtotal,
      },
      'billing.amount_validation_failed',
    )
    return parsedProrationError('validation_failed')
  }

  return { error: null, oldLookupKey, newLookupKey, oldSpec, newSpec, subtotal }
}

// Helper for the validation_failed early-return branches. The shape
// satisfies ParsedProration's `readonly` fields with placeholders that
// callers never read (caller short-circuits on `error !== null`).
function parsedProrationError(error: HandlerResult): ParsedProration {
  return {
    error,
    oldLookupKey: 'tier_wayfarer',
    newLookupKey: 'tier_wayfarer',
    oldSpec: { priceCents: 0, sessionsGranted: 0, worldsGranted: 0 },
    newSpec: { priceCents: 0, sessionsGranted: 0, worldsGranted: 0 },
    subtotal: 0,
  }
}

interface SubscriptionFields {
  readonly tierLookupKey: string
  readonly periodStart: number
  readonly periodEnd: number
}

/**
 * Read the single Subscription Item's NEW tier lookup_key + period dates.
 * Returns `null` on multi-item or missing fields — caller returns
 * 'validation_failed' (Mythrun never exposes multi-item subs).
 */
function readSubscriptionFields(subscription: Stripe.Subscription): SubscriptionFields | null {
  if (subscription.items.data.length !== 1) return null
  const item = subscription.items.data[0]
  if (!item) return null
  const lookupKey = item.price.lookup_key
  if (typeof lookupKey !== 'string' || lookupKey.length === 0) return null
  return {
    tierLookupKey: lookupKey,
    periodStart: item.current_period_start,
    periodEnd: item.current_period_end,
  }
}

/**
 * Handler for `customer.subscription.pending_update_applied` (spec §5.4.6).
 *
 * Step order:
 *   1. Read prefetched invoice; null → log paging + 'ok'.
 *   2. Resolve user (anchor-lock); total miss → page upgrade_orphan + 'ok'.
 *   3. Read NEW tier from subscription.items + period dates.
 *   4. Split invoice lines: exactly one negative (OLD price) + one positive
 *      (NEW price). Otherwise → page upgrade_unexpected_line_shape +
 *      'validation_failed'.
 *   5. Reverse-resolve OLD/NEW lookup_keys via SKU cache; cache miss →
 *      page upgrade_unknown_price_id + 'validation_failed'.
 *   6. Amount validation: subtotal_excluding_tax === newPrice - oldPrice.
 *      Mismatch → page amount_validation_failed + 'validation_failed'.
 *   7. upsertFromStripe (idempotent strict-`>` filter handles a prior
 *      `customer.subscription.updated` having already written the row).
 *   8. billing_history.append with do_update_coalesce; capture RETURNING id.
 *   9. grantInTx for each non-zero credit DELTA, linking back to the
 *      billing_history row.
 *  10. Return 'ok'.
 */
export async function handlePendingUpdateApplied(
  event: Stripe.Event,
  prefetch: unknown,
  client: ClientLike,
  log: FastifyBaseLogger,
): Promise<HandlerResult> {
  const { invoice } = asPendingUpdateAppliedPrefetch(prefetch)
  const subscription = event.data.object as Stripe.Subscription
  const ids = pendingUpdateLogIds(event, subscription, invoice)

  // 1. Resolve user (anchor lock per §5.3 — must happen before further
  //    DB writes). On total miss, page billing.upgrade_orphan + 'ok'.
  const user = await resolveUser(client, subscription)
  if (!user) {
    log.error(ids, 'billing.upgrade_orphan')
    return 'ok'
  }

  // 2. Defensive: latest_invoice was unset (shouldn't happen for a
  //    pending_update_applied delivery — Stripe always stamps the proration
  //    invoice on the subscription before firing the event). Page +
  //    return 'ok' so Stripe stops retrying; manual reconciliation handles
  //    the corruption.
  if (invoice === null) {
    log.error(ids, 'billing.upgrade_invoice_missing')
    return 'ok'
  }

  // 3. Read NEW tier from the subscription itself (the items have already
  //    advanced).
  const fields = readSubscriptionFields(subscription)
  if (!fields) {
    log.error(
      { ...ids, items_count: subscription.items.data.length },
      'billing.upgrade_subscription_invalid_items',
    )
    return 'validation_failed'
  }

  // 4-6. Parse + reverse-resolve + amount-validate the proration invoice.
  //      Three steps fused into one helper because they share the
  //      'validation_failed' return path and the variables thread through
  //      (lines → priceIds → lookup_keys → specs → subtotal compared
  //      against newSpec.priceCents - oldSpec.priceCents).
  const parsed = parseAndValidateProration(invoice, ids, log)
  if (parsed.error !== null) return parsed.error
  const { newLookupKey, oldSpec, newSpec, subtotal } = parsed

  // 7. upsertFromStripe — idempotent against a prior
  //    `customer.subscription.updated` having already written the NEW tier
  //    (strict-`>` filter on stripe_event_created_at).
  await userSubscriptions.upsertFromStripe(client, {
    id: uuidv7(),
    user_id: user.id,
    stripe_subscription_id: subscription.id,
    tier_lookup_key: fields.tierLookupKey,
    status: subscription.status,
    current_period_start: new Date(fields.periodStart * 1000),
    current_period_end: new Date(fields.periodEnd * 1000),
    cancel_at_period_end: subscription.cancel_at_period_end,
    cancel_at: subscription.cancel_at,
    cancellation_details: subscription.cancellation_details,
    stripe_event_created_at: new Date(event.created * 1000),
  })

  // 8. Append billing_history row with race-symmetric do_update_coalesce.
  //    The `invoice.paid` `subscription_update` handler (§5.4.2) writes the
  //    SAME row via the same upsert shape; whichever arrives first writes
  //    the canonical values, the second fills NULLs.
  const expiresAt = expiresAtPlusOneMonth(fields.periodEnd)
  const paymentIntentId = readPrimaryPaymentIntent(invoice)
  const historyRow = await billingHistory.append(
    client,
    {
      id: uuidv7(),
      user_id: user.id,
      kind: 'invoice',
      source_id_stripe: invoice.id,
      stripe_payment_intent_id: paymentIntentId,
      lookup_key: newLookupKey,
      amount_cents: subtotal,
      currency: invoice.currency,
      expires_at: expiresAt,
      occurred_at: new Date(invoice.created * 1000),
    },
    { onConflict: 'do_update_coalesce' },
  )

  // 9. Grant the credit DELTAs. `sessionsDelta` and `worldsDelta` may be
  //    zero (down-tier between equivalent counts) or negative (true
  //    downgrade — out of scope for upgrades but handled defensively).
  //    Only positive deltas land grants; recordClawback is owned by the
  //    refund handler, not here.
  const sessionsDelta = newSpec.sessionsGranted - oldSpec.sessionsGranted
  const worldsDelta = newSpec.worldsGranted - oldSpec.worldsGranted
  if (sessionsDelta > 0) {
    await grantInTx(client, {
      userId: user.id,
      creditType: 'session',
      amount: sessionsDelta,
      sourceType: 'subscription',
      sourcePurchaseId: null,
      sourceBillingHistoryId: historyRow.id,
      sourceId: null,
      expiresAt,
    })
  }
  if (worldsDelta > 0) {
    await grantInTx(client, {
      userId: user.id,
      creditType: 'world_gen',
      amount: worldsDelta,
      sourceType: 'subscription',
      sourcePurchaseId: null,
      sourceBillingHistoryId: historyRow.id,
      sourceId: null,
      expiresAt,
    })
  }

  return 'ok'
}
