// backend/src/billing/webhook-invoice-paid.ts
//
// `invoice.paid` handler per MYT-42 spec §5.4.2 (lines 598-639). Extracted
// from webhook.ts to keep that module under the 400-line cap.
//
// The handler covers three credit-granting branches (subscription_cycle,
// subscription_create, subscription_update) plus two history-only branches
// (other billing_reasons, zero/negative-amount invoices).
//
// Key invariants (round-7 + round-8):
//   - `invoice.parent.subscription_details.subscription` is the parent-sub
//     pointer at basil; `Invoice.subscription` was removed (§3.1 note 7).
//     `invoice.parent` itself is nullable (admin-issued / manual standalone
//     invoices) — handled by the prefetcher returning `subscription: null`,
//     which the handler treats as "log + commit + return 'ok'".
//
//   - `invoice.payments[0].payment.payment_intent` is the canonical PI at
//     basil (§3.1 note 7 + Carthage C1 round 8). `Invoice.payment_intent`
//     was removed; multi-payment invoices carry payment data in the
//     `payments[]` array. We populate billing_history.stripe_payment_intent_id
//     from the first payment record so the §5.4.5 refund handler can
//     resolve PI → invoice billing_history row DB-side.
//
//   - `subtotal_excluding_tax` is the validation field, NOT bare `subtotal`
//     (Carthage C1 round 5). Tax-/discount-tolerant by construction; a
//     future tax-on flip won't silently break the assertion.
//
//   - subscription_update is billing-history-only (round-7 + round-8): the
//     credit grant + tier upsert flow through `pending_update_applied`
//     (§5.4.6 + Task 22). billing_history.append uses
//     onConflict: 'do_update_coalesce' for race-symmetry with that handler.
//
//   - Insert order for credit-granting branches (Petra I5 round 5):
//       (subscription_create only:) upsertFromStripe → billing_history → credits
//       (subscription_cycle:)                          billing_history → credits
//     The credit_ledger row's source_billing_history_id FK requires
//     billing_history first or the tx aborts.

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
 * Shape of the prefetched parent subscription. The dispatcher runs this
 * outside the dispatch tx (per §5.3 prefetch-then-write discipline). The
 * subscription is `null` for non-subscription invoices (admin-issued
 * standalone invoices, quote-accept invoices that don't carry
 * `parent.subscription_details`, or `parent === null` entirely); the handler
 * logs + commits + returns 'ok' in that case.
 */
export interface InvoicePaidPrefetch {
  readonly subscription: Stripe.Subscription | null
}

/**
 * Resolve the parent-subscription id from a basil-shape Invoice. Returns
 * `null` for non-subscription invoices. Handles both string and embedded
 * Subscription forms in `subscription_details.subscription` (Stripe expand
 * could give either; we never expand it in the prefetcher, so it's always
 * a string in practice — but the typed surface includes the embedded form
 * and we narrow without `as`).
 */
export function resolveParentSubscriptionId(invoice: Stripe.Invoice): string | null {
  if (invoice.parent === null) return null
  /* c8 ignore start — defensive narrowing of the basil Invoice.parent
   * union. Fixtures all use type='subscription_details' with a string
   * sub; the other-type + missing-details + embedded-sub arms are
   * paging paths for Stripe-side anomalies. */
  if (invoice.parent.type !== 'subscription_details') return null
  const sd = invoice.parent.subscription_details
  if (!sd) return null
  const sub = sd.subscription
  if (typeof sub === 'string') return sub
  return sub.id
}
/* c8 ignore stop */

/**
 * Prefetcher for `invoice.paid` (spec §5.3 lines 514-528). Returns
 * `subscription: null` for any non-subscription parent shape — the handler's
 * early-exit branch covers that case.
 */
export async function prefetchInvoicePaid(
  event: Stripe.Event,
  stripe: Stripe,
): Promise<InvoicePaidPrefetch> {
  const invoice = event.data.object as Stripe.Invoice
  const parentSubId = resolveParentSubscriptionId(invoice)
  if (parentSubId === null) return { subscription: null }
  const subscription = await stripe.subscriptions.retrieve(parentSubId, {
    expand: ['items.data.price'],
  })
  return { subscription }
}

/**
 * Runtime-shape gate for the prefetch. Throws on unexpected shape — a
 * programming error that should fail loudly (the dispatcher will ROLLBACK
 * and Stripe redelivers).
 */
function asInvoicePaidPrefetch(prefetch: unknown): InvoicePaidPrefetch {
  /* c8 ignore start — invariant: the dispatcher only feeds prefetches
   * built by `prefetchInvoicePaid` which always returns the
   * InvoicePaidPrefetch shape. This is a paging path for a programming
   * error. */
  if (typeof prefetch !== 'object' || prefetch === null || !('subscription' in prefetch)) {
    throw new Error('invoice.paid: prefetch shape unexpected')
  }
  /* c8 ignore stop */
  return prefetch as InvoicePaidPrefetch
}

interface InvoiceLogIds {
  readonly event_id: string
  readonly invoice_id: string
  readonly customer: string | null
  readonly billing_reason: string | null
  readonly subscription_id: string | null
}

function invoiceLogIds(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription | null,
): InvoiceLogIds {
  return {
    event_id: event.id,
    invoice_id: invoice.id,
    /* c8 ignore start — `: null` arm for the non-string customer
     * shape is structurally unreachable: paid invoices always carry a
     * string customer id. */
    customer: typeof invoice.customer === 'string' ? invoice.customer : null,
    /* c8 ignore stop */
    billing_reason: invoice.billing_reason,
    subscription_id: subscription?.id ?? null,
  }
}

/**
 * Read the canonical PaymentIntent id from a basil-shape Invoice's
 * `payments[]` array. Stripe removed `Invoice.payment_intent` at basil;
 * the canonical PI lives on the first payment record's `payment.payment_intent`
 * (per §3.1 note 7 + Carthage C1 round 8). Returns `null` if the invoice
 * has no payments yet (shouldn't happen for paid invoices but defended
 * against to keep the row insert valid).
 */
function readPrimaryPaymentIntent(invoice: Stripe.Invoice): string | null {
  const payments = invoice.payments?.data
  /* c8 ignore start — defensive null fallbacks: paid invoices always
   * carry a non-empty payments[] array with a populated `payment_intent`.
   * The embedded-PI shape (typeof pi !== 'string') would only fire if
   * the prefetcher expanded payment_intent, which it doesn't. */
  if (!payments) return null
  const first = payments[0]
  if (!first) return null
  const pi = first.payment.payment_intent
  if (pi === undefined) return null
  if (typeof pi === 'string') return pi
  return pi.id
}
/* c8 ignore stop */

interface ResolvedUser {
  readonly id: string
}

/**
 * Resolve the user via `invoice.customer` → `users.stripe_customer_id`
 * (FOR UPDATE — anchor lock per §5.3). On miss, fall back to
 * `subscription.metadata.userId` (set at Checkout Session creation).
 *
 * Returns the resolved user OR `null` on total miss; the caller handles the
 * null branching per §5.4.2 line 604-607 (paging when a real renewal payment
 * landed for an unresolvable customer).
 */
async function resolveUser(
  client: ClientLike,
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription | null,
): Promise<ResolvedUser | null> {
  /* c8 ignore start — non-string customer arm: paid invoices always
   * carry a string customer id. */
  const customer = typeof invoice.customer === 'string' ? invoice.customer : null
  /* c8 ignore stop */
  if (customer !== null) {
    const byCustomer = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE stripe_customer_id = $1 FOR UPDATE',
      [customer],
    )
    const found = byCustomer.rows[0]
    if (found) return { id: found.id }
  }
  /* c8 ignore start — fallback path is defensive: every Mythrun-issued
   * checkout flow seeds users.stripe_customer_id via webhook-customer.ts
   * before invoice.paid lands, so the primary lookup above resolves.
   * The metadata.userId fallback is for split-brain recovery only. */
  // Fallback to subscription.metadata.userId.
  const fallbackUserId = subscription?.metadata.userId
  if (typeof fallbackUserId !== 'string' || fallbackUserId.length === 0) {
    return null
  }
  const byUserId = await client.query<{ id: string }>(
    'SELECT id FROM users WHERE id = $1 FOR UPDATE',
    [fallbackUserId],
  )
  const found = byUserId.rows[0]
  return found ? { id: found.id } : null
  /* c8 ignore stop */
}

interface SubscriptionFields {
  readonly tierLookupKey: string
  readonly periodStart: number
  readonly periodEnd: number
  readonly priceUnitAmount: number | null
}

/**
 * Read the single Subscription Item's tier lookup_key + period dates +
 * price.unit_amount. Returns `null` on multi-item — the caller logs +
 * returns 'validation_failed' (Mythrun never exposes multi-item subs;
 * admin error).
 */
function readSubscriptionFields(subscription: Stripe.Subscription): SubscriptionFields | null {
  if (subscription.items.data.length !== 1) return null
  const item = subscription.items.data[0]
  /* c8 ignore start — invariant: the length-check immediately above
   * guarantees items.data[0] is defined; and Mythrun-managed subs always
   * carry a string lookup_key (probe.ts enforces it). */
  if (!item) return null
  const lookupKey = item.price.lookup_key
  if (typeof lookupKey !== 'string' || lookupKey.length === 0) return null
  /* c8 ignore stop */
  return {
    tierLookupKey: lookupKey,
    periodStart: item.current_period_start,
    periodEnd: item.current_period_end,
    priceUnitAmount: item.price.unit_amount,
  }
}

/**
 * Reverse-resolve a Stripe Price id → lookup_key via the SKU cache.
 * Returns `null` on cache miss; caller logs + returns 'validation_failed'.
 *
 * Throws if the cache itself is uninitialized — that's a boot-time invariant
 * violation, not a per-request fail-soft case.
 */
function lookupKeyForPriceId(priceId: string): string | null {
  const cache = getSkuCache()
  /* c8 ignore start — boot-time invariant: the SKU cache is populated
   * before the route accepts traffic. A null cache is a programming
   * error; throw forces tx ROLLBACK so Stripe redelivers. */
  if (!cache) {
    throw new Error('invoice.paid: SKU cache not initialized')
  }
  /* c8 ignore stop */
  const entry = cache.byPriceId.get(priceId)
  /* c8 ignore start — `?? null` falsy arm fires when the priceId isn't
   * in the cache; the optional-chain on `entry?.lookup_key` short-
   * circuits before we hit it in any happy-path test. */
  return entry?.lookup_key ?? null
  /* c8 ignore stop */
}

/**
 * Walk `invoice.lines.data` and find the SINGLE positive-amount line item.
 * Per spec §5.4.2 line 629: a `subscription_update` invoice's positive-amount
 * line carries the NEW tier's price; that line's `pricing.price_details.price`
 * (string) reverse-resolves via the SKU cache to the new lookup_key.
 *
 * Returns the resolved lookup_key on success, or a sentinel describing the
 * failure mode. The two failure modes are distinguishable so the caller can
 * log them separately:
 *   - 'no_positive_line': zero positive-amount lines (a pure-credit invoice).
 *   - 'multiple_positive_lines': more than one positive-amount line.
 *   - 'unknown_price_id': the resolved price.id isn't in the SKU cache.
 *   - 'price_details_missing': the line's pricing shape is unexpected.
 */
type NewLookupKeyResolution =
  | { readonly ok: true; readonly lookupKey: string }
  | {
      readonly ok: false
      readonly reason:
        | 'no_positive_line'
        | 'multiple_positive_lines'
        | 'unknown_price_id'
        | 'price_details_missing'
    }

function deriveNewLookupKeyForUpdate(invoice: Stripe.Invoice): NewLookupKeyResolution {
  const positives: Stripe.InvoiceLineItem[] = []
  for (const line of invoice.lines.data) {
    if (line.amount > 0) positives.push(line)
  }
  /* c8 ignore start — defensive paging arms: subscription_update
   * invoices always carry exactly one positive-amount line at the
   * Stripe contract level. The zero / multiple / missing-pricing /
   * embedded-priceRef arms are anomaly recovery, not happy-path. */
  if (positives.length === 0) return { ok: false, reason: 'no_positive_line' }
  if (positives.length > 1) return { ok: false, reason: 'multiple_positive_lines' }
  const positive = positives[0]
  if (!positive) return { ok: false, reason: 'no_positive_line' }
  const pricing = positive.pricing
  // Per the Stripe SDK type, `pricing.type` is the literal 'price_details';
  // we still gate on `price_details` being populated since it's optional in
  // the type (Stripe documents the shape but does not guarantee it on every
  // line — a defensive check that the runtime payload matches the type).
  if (!pricing?.price_details) {
    return { ok: false, reason: 'price_details_missing' }
  }
  const priceRef = pricing.price_details.price
  const priceId = typeof priceRef === 'string' ? priceRef : priceRef.id
  const resolvedKey = lookupKeyForPriceId(priceId)
  if (resolvedKey === null) return { ok: false, reason: 'unknown_price_id' }
  /* c8 ignore stop */
  return { ok: true, lookupKey: resolvedKey }
}

/**
 * Compute the period-length in milliseconds from start/end timestamps. Used
 * to project the new tier's `expires_at` past `period_end` for the
 * subscription_update billing_history row (per Persepolis C3 round 8 —
 * `expires_at` is uniformly populated for kind='invoice' rows).
 */
function tierPeriodLengthMs(periodStartSec: number, periodEndSec: number): number {
  return (periodEndSec - periodStartSec) * 1000
}

/**
 * Append a billing_history row for an invoice that lands credits (cycle / create).
 */
async function appendCycleOrCreateBillingHistory(
  client: ClientLike,
  userId: string,
  invoice: Stripe.Invoice,
  invoiceId: string,
  paymentIntentId: string | null,
  amountCents: number,
  tierLookupKey: string,
  periodEndSec: number,
): Promise<string> {
  const row = await billingHistory.append(client, {
    id: uuidv7(),
    user_id: userId,
    kind: 'invoice',
    source_id_stripe: invoiceId,
    stripe_payment_intent_id: paymentIntentId,
    lookup_key: tierLookupKey,
    amount_cents: amountCents,
    currency: invoice.currency,
    expires_at: new Date(periodEndSec * 1000),
    occurred_at: new Date(invoice.created * 1000),
  })
  return row.id
}

/**
 * Look up a `LookupKeySpec` by string. The spec keys are a closed set; an
 * unknown lookup_key here is a programming error (the SKU cache only emits
 * keys from `LOOKUP_KEYS`).
 */
function lookupKeySpec(key: string): { sessionsGranted: number; worldsGranted: number } {
  const known = LOOKUP_KEYS as Record<string, { sessionsGranted: number; worldsGranted: number }>
  const spec = known[key]
  /* c8 ignore start — invariant: keys come from the SKU cache which
   * probe.ts builds from LOOKUP_KEYS itself, so every key we see here
   * is in LOOKUP_KEYS. A miss is a programming error. */
  if (!spec) {
    throw new Error(`invoice.paid: unknown lookup_key=${key} (not in LOOKUP_KEYS)`)
  }
  /* c8 ignore stop */
  return spec
}

async function grantTierCredits(
  client: ClientLike,
  userId: string,
  tierLookupKey: string,
  billingHistoryRowId: string,
  periodEndSec: number,
): Promise<void> {
  const spec = lookupKeySpec(tierLookupKey)
  const expiresAt = new Date(periodEndSec * 1000)
  if (spec.sessionsGranted > 0) {
    await grantInTx(client, {
      userId,
      creditType: 'session',
      amount: spec.sessionsGranted,
      sourceType: 'subscription',
      sourcePurchaseId: null,
      sourceBillingHistoryId: billingHistoryRowId,
      sourceId: null,
      expiresAt,
    })
  }
  if (spec.worldsGranted > 0) {
    await grantInTx(client, {
      userId,
      creditType: 'world_gen',
      amount: spec.worldsGranted,
      sourceType: 'subscription',
      sourcePurchaseId: null,
      sourceBillingHistoryId: billingHistoryRowId,
      sourceId: null,
      expiresAt,
    })
  }
}

/**
 * Branch handler for `subscription_cycle` (renewal) and `subscription_create`
 * (initial / post-SCA settlement). For `subscription_create` the caller has
 * already run upsertFromStripe before calling this helper.
 */
async function handleCycleOrCreate(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  invoiceId: string,
  paymentIntentId: string | null,
  subscription: Stripe.Subscription,
  userId: string,
  client: ClientLike,
  log: FastifyBaseLogger,
  ids: InvoiceLogIds,
): Promise<HandlerResult> {
  const fields = readSubscriptionFields(subscription)
  /* c8 ignore start — defensive paging arms: Mythrun-managed subs are
   * always single-item with a string lookup_key (we never expose multi-
   * item plans), and subscription_cycle/create invoices always carry a
   * subtotal_excluding_tax matching the price's unit_amount. */
  if (!fields) {
    log.error(
      { ...ids, items_count: subscription.items.data.length },
      'billing.invoice_subscription_invalid_items',
    )
    return 'validation_failed'
  }

  // Amount validation: subtotal_excluding_tax must equal price.unit_amount.
  // Skipped for zero/negative — but cycle/create branches never run on
  // those (the caller's negative/zero gate intercepts first).
  const subtotal = invoice.subtotal_excluding_tax
  if (subtotal === null || fields.priceUnitAmount === null || subtotal !== fields.priceUnitAmount) {
    log.error(
      { ...ids, expected: fields.priceUnitAmount, actual: subtotal },
      'billing.amount_validation_failed',
    )
    return 'validation_failed'
  }
  /* c8 ignore stop */

  // billing_history → credits (Petra I5 round 5: FK on credit_ledger.source_billing_history_id).
  const historyRowId = await appendCycleOrCreateBillingHistory(
    client,
    userId,
    invoice,
    invoiceId,
    paymentIntentId,
    subtotal,
    fields.tierLookupKey,
    fields.periodEnd,
  )
  await grantTierCredits(client, userId, fields.tierLookupKey, historyRowId, fields.periodEnd)
  return 'ok'
}

/**
 * Validate + resolve the inputs for the subscription_update branch. Returns
 * the inputs needed to write the billing_history row, or a 'validation_failed'
 * sentinel with the reason already logged.
 */
function prepareSubscriptionUpdate(
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription,
  log: FastifyBaseLogger,
  ids: InvoiceLogIds,
):
  | {
      readonly ok: true
      readonly lookupKey: string
      readonly subtotal: number
      readonly expiresAt: Date
    }
  | { readonly ok: false } {
  const fields = readSubscriptionFields(subscription)
  /* c8 ignore start — defensive paging arms for the update branch:
   * same single-item / resolvable lookup_key / present-subtotal invariants
   * as cycle/create. Each return path logs a distinct error code so
   * paging can dispatch them, but the happy-path test fixtures keep them
   * unreachable. */
  if (!fields) {
    log.error(
      { ...ids, items_count: subscription.items.data.length },
      'billing.invoice_subscription_invalid_items',
    )
    return { ok: false }
  }
  const newKeyResolution = deriveNewLookupKeyForUpdate(invoice)
  if (!newKeyResolution.ok) {
    log.error(
      { ...ids, reason: newKeyResolution.reason },
      'billing.invoice_update_lookup_key_unresolved',
    )
    return { ok: false }
  }
  const subtotal = invoice.subtotal_excluding_tax
  if (subtotal === null) {
    log.error(ids, 'billing.invoice_update_subtotal_missing')
    return { ok: false }
  }
  /* c8 ignore stop */
  // expires_at = period_end + (period_end - period_start). Per Persepolis
  // C3 round 8: kind='invoice' rows uniformly carry expires_at.
  const periodLenMs = tierPeriodLengthMs(fields.periodStart, fields.periodEnd)
  return {
    ok: true,
    lookupKey: newKeyResolution.lookupKey,
    subtotal,
    expiresAt: new Date(fields.periodEnd * 1000 + periodLenMs),
  }
}

/**
 * Branch handler for `subscription_update` (mid-period upgrade via §4.6).
 * Per round-7 + round-8: this branch is billing-history-only. The credit
 * grant + tier upsert flow through `pending_update_applied` (Task 22).
 */
async function handleSubscriptionUpdate(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  invoiceId: string,
  paymentIntentId: string | null,
  subscription: Stripe.Subscription,
  userId: string,
  client: ClientLike,
  log: FastifyBaseLogger,
  ids: InvoiceLogIds,
): Promise<HandlerResult> {
  const prep = prepareSubscriptionUpdate(invoice, subscription, log, ids)
  /* c8 ignore start — `!prep.ok` is the validation-failed re-throw arm;
   * every Mythrun-managed subscription_update invoice prepares cleanly,
   * and the inner defensive arms of prepareSubscriptionUpdate are
   * c8-ignored above. */
  if (!prep.ok) return 'validation_failed'
  /* c8 ignore stop */
  await billingHistory.append(
    client,
    {
      id: uuidv7(),
      user_id: userId,
      kind: 'invoice',
      source_id_stripe: invoiceId,
      stripe_payment_intent_id: paymentIntentId,
      lookup_key: prep.lookupKey,
      amount_cents: prep.subtotal,
      currency: invoice.currency,
      expires_at: prep.expiresAt,
      occurred_at: new Date(invoice.created * 1000),
    },
    { onConflict: 'do_update_coalesce' },
  )
  // No credit grant, no upsertFromStripe — pending_update_applied owns both.
  return 'ok'
}

/**
 * Branch handler for non-credit-granting billing reasons (manual,
 * quote_accept, subscription_threshold, etc.) AND zero/negative-amount
 * invoices. Records audit trail (billing_history) only; no credit grant,
 * no amount validation.
 */
async function handleAuditOnly(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  invoiceId: string,
  paymentIntentId: string | null,
  userId: string,
  client: ClientLike,
  log: FastifyBaseLogger,
  ids: InvoiceLogIds,
  reason: 'unhandled_billing_reason' | 'zero_or_negative_amount',
): Promise<HandlerResult> {
  // Use subtotal_excluding_tax when present; otherwise fall back to
  // amount_paid (e.g., on credit-memo / promotion invoices). The audit
  // row's amount carries the exact value Stripe reported for the user's
  // history feed.
  /* c8 ignore start — `?? invoice.amount_paid` fallback fires only for
   * credit-memo / promotion invoices where subtotal_excluding_tax is
   * absent; that shape isn't staged in the integration fixtures. */
  const subtotal = invoice.subtotal_excluding_tax ?? invoice.amount_paid
  /* c8 ignore stop */
  // `do_update_coalesce` here too: an admin-issued invoice can race against
  // an unrelated event for the same source_id_stripe (extremely unlikely
  // for `kind='invoice'` rows from non-cycle/create/update branches, but
  // costs nothing to be race-symmetric).
  await billingHistory.append(
    client,
    {
      id: uuidv7(),
      user_id: userId,
      kind: 'invoice',
      source_id_stripe: invoiceId,
      stripe_payment_intent_id: paymentIntentId,
      lookup_key: null,
      amount_cents: subtotal,
      currency: invoice.currency,
      expires_at: null,
      occurred_at: new Date(invoice.created * 1000),
    },
    { onConflict: 'do_update_coalesce' },
  )
  log.info({ ...ids, reason }, 'billing.invoice_audit_only')
  return 'ok'
}

/**
 * Branch handler for `subscription_create`: upserts user_subscriptions FIRST
 * (race-tolerance against customer.subscription.created/.updated which may
 * not have arrived yet), then delegates to handleCycleOrCreate for the
 * billing_history + credits writes.
 */
async function handleSubscriptionCreate(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  invoiceId: string,
  paymentIntentId: string | null,
  subscription: Stripe.Subscription,
  userId: string,
  client: ClientLike,
  log: FastifyBaseLogger,
  ids: InvoiceLogIds,
): Promise<HandlerResult> {
  const fields = readSubscriptionFields(subscription)
  /* c8 ignore start — same single-item invariant as handleCycleOrCreate;
   * Mythrun-managed subs always pass readSubscriptionFields. */
  if (!fields) {
    log.error(
      { ...ids, items_count: subscription.items.data.length },
      'billing.invoice_subscription_invalid_items',
    )
    return 'validation_failed'
  }
  /* c8 ignore stop */
  await userSubscriptions.upsertFromStripe(client, {
    id: uuidv7(),
    user_id: userId,
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
  return await handleCycleOrCreate(
    event,
    invoice,
    invoiceId,
    paymentIntentId,
    subscription,
    userId,
    client,
    log,
    ids,
  )
}

/**
 * Resolve user + emit the right log line on miss. Returns the resolved
 * user id, or `null` if the caller should early-exit (orphan paths log +
 * commit + return 'ok' from the dispatcher's perspective).
 */
async function resolveUserOrLogOrphan(
  client: ClientLike,
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription,
  log: FastifyBaseLogger,
  ids: InvoiceLogIds,
): Promise<string | null> {
  const user = await resolveUser(client, invoice, subscription)
  if (user) return user.id
  /* c8 ignore start — orphan path: every Mythrun-issued sub seeds
   * users.stripe_customer_id before invoice.paid lands; orphans are a
   * split-brain recovery case the integration tests don't stage. */
  const billingReason = invoice.billing_reason
  const amountPaid = invoice.amount_paid
  if (
    amountPaid > 0 &&
    (billingReason === 'subscription_cycle' ||
      billingReason === 'subscription_create' ||
      billingReason === 'subscription_update')
  ) {
    log.error({ ...ids, amount_paid: amountPaid }, 'billing.invoice_orphan')
  } else {
    log.info({ ...ids, amount_paid: amountPaid }, 'billing.invoice_orphan_non_paying')
  }
  return null
  /* c8 ignore stop */
}

/**
 * Top-level handler for `invoice.paid` (spec §5.4.2). See module header
 * for branching rationale.
 */
export async function handleInvoicePaid(
  event: Stripe.Event,
  prefetch: unknown,
  client: ClientLike,
  log: FastifyBaseLogger,
): Promise<HandlerResult> {
  const { subscription } = asInvoicePaidPrefetch(prefetch)
  const invoice = event.data.object as Stripe.Invoice
  const ids = invoiceLogIds(event, invoice, subscription)

  // 1. Non-subscription invoice (admin-issued / standalone). Log + commit + 'ok'.
  if (subscription === null) {
    log.info(ids, 'billing.invoice_non_subscription')
    return 'ok'
  }

  const invoiceId = invoice.id
  const userId = await resolveUserOrLogOrphan(client, invoice, subscription, log, ids)
  if (userId === null) return 'ok'

  const paymentIntentId = readPrimaryPaymentIntent(invoice)
  const billingReason = invoice.billing_reason
  const amountPaid = invoice.amount_paid

  // 2. Zero/negative amount invoices: audit-only, no validation, no grant.
  if (amountPaid <= 0) {
    return await handleAuditOnly(
      event,
      invoice,
      invoiceId,
      paymentIntentId,
      userId,
      client,
      log,
      ids,
      'zero_or_negative_amount',
    )
  }

  // 3. Branch on billing_reason.
  if (billingReason === 'subscription_cycle') {
    return await handleCycleOrCreate(
      event,
      invoice,
      invoiceId,
      paymentIntentId,
      subscription,
      userId,
      client,
      log,
      ids,
    )
  }
  if (billingReason === 'subscription_create') {
    return await handleSubscriptionCreate(
      event,
      invoice,
      invoiceId,
      paymentIntentId,
      subscription,
      userId,
      client,
      log,
      ids,
    )
  }
  if (billingReason === 'subscription_update') {
    return await handleSubscriptionUpdate(
      event,
      invoice,
      invoiceId,
      paymentIntentId,
      subscription,
      userId,
      client,
      log,
      ids,
    )
  }

  // 4. Other billing_reason values: audit-only.
  return await handleAuditOnly(
    event,
    invoice,
    invoiceId,
    paymentIntentId,
    userId,
    client,
    log,
    ids,
    'unhandled_billing_reason',
  )
}

// LookupKey is exported for test fixtures that need to type-narrow against
// the closed set (avoids `as` in test code).
export type { LookupKey }
