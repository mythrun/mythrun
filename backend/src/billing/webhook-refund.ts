// backend/src/billing/webhook-refund.ts
//
// Shared handler for `refund.created` and `refund.updated` per MYT-42 spec
// §5.4.5 (Task 24). Both event types carry `event.data.object` as the
// Refund object with the current `status` snapshot, so a single handler
// covers both delivery shapes.
//
// Step order (deviates from §5.3 anchor-lock-first per Manchego I2 round 3
// — user_id is unknown until step 1's resolution finishes):
//
//   −1. Status gate (round-6 Carthage C1) — only `succeeded` proceeds; other
//       statuses log + commit + return 'ok'.
//   0.  Partial-refund hard-refuse — assert prefetch.charge.amount_refunded
//       === amount_captured. Mismatch → paging metric + commit + return 'ok'.
//   1.  Resolve originating Mythrun entity DB-side (round-8 Carthage C1):
//       à-la-carte purchases first, subscription invoice billing_history
//       second. Three terminal sub-cases (round-8 Petra I7):
//         a) refund.payment_intent === null → INFO + 'ok'
//         b) match exists but status='refunded' already → INFO + 'ok'
//         c) PI set but no row found → WARN + THROW (Stripe redelivers)
//   2.  User-row anchor lock + re-fetch under FOR UPDATE on source rows
//       (round-7 Persepolis C5): if status flipped to 'refunded' during the
//       lock-free window, INFO + 'ok'.
//   3.  recordClawback for each originating grant row (Persepolis C2 +
//       Petra I5 round 8 — ON CONFLICT idempotency).
//   4.  UPDATE source row status='refunded' (idempotent via WHERE
//       status='completed').
//   5.  Append refund billing_history row with onConflict: 'do_nothing'.

import type { Stripe } from 'stripe'
import type { FastifyBaseLogger } from 'fastify'
import type { ClientLike } from '../repo/_types.js'
import { billingHistory, type BillingHistoryRow } from '../repo/billing-history.js'
import { purchases, type PurchaseRow } from '../repo/purchases.js'
import { uuidv7 } from '../repo/uuidv7.js'
import type { HandlerResult } from './webhook-types.js'

/**
 * Shape of the prefetched charge. `null` when refund.charge is absent
 * (legacy non-PI charges, admin-issued refunds outside Mythrun, refunds
 * landing without a charge id). The handler treats null as "fall through
 * to step 1's resolution paths" — those paths typically also resolve to
 * step 1's no-PI / no-row branches.
 */
export interface RefundPrefetch {
  readonly charge: Stripe.Charge | null
}

/**
 * Prefetcher for `refund.created` / `refund.updated` (spec §5.4.5 line 673,
 * §5.3 prefetch-then-write discipline). Optional-chains the charge
 * retrieve; a missing charge is not an error here.
 */
export async function prefetchRefund(event: Stripe.Event, stripe: Stripe): Promise<RefundPrefetch> {
  const refund = event.data.object as Stripe.Refund
  const chargeRef = refund.charge
  if (chargeRef === null) return { charge: null }
  /* c8 ignore start — embedded-charge arm: Stripe always sends a string
   * id on Refund.charge; the embedded-object form requires explicit
   * expand, which we don't request. */
  const chargeId = typeof chargeRef === 'string' ? chargeRef : chargeRef.id
  /* c8 ignore stop */
  const charge = await stripe.charges.retrieve(chargeId)
  return { charge }
}

/**
 * Runtime-shape gate for the prefetch. Throws on unexpected shape — a
 * programming error that should fail loudly (the dispatcher will ROLLBACK
 * and Stripe redelivers).
 */
function asRefundPrefetch(prefetch: unknown): RefundPrefetch {
  /* c8 ignore start — invariant: prefetch from prefetchRefund always
   * conforms; defense-in-depth for a programming error. */
  if (typeof prefetch !== 'object' || prefetch === null || !('charge' in prefetch)) {
    throw new Error('refund.created/refund.updated: prefetch shape unexpected')
  }
  /* c8 ignore stop */
  return prefetch as RefundPrefetch
}

/**
 * Read `refund.payment_intent` as a string id (or null when absent). Stripe
 * types this as `string | PaymentIntent | null`; we never expand it on the
 * Refund payload, so the runtime value is always a string id when set.
 */
function readPaymentIntentId(refund: Stripe.Refund): string | null {
  const pi = refund.payment_intent
  if (pi === null) return null
  /* c8 ignore start — embedded-PI arm: Stripe Refund.payment_intent
   * is always a string when set; the embedded form requires explicit
   * expand, which we don't request. */
  if (typeof pi === 'string') return pi
  return pi.id
}
/* c8 ignore stop */

/**
 * Read `refund.charge` as a string id (or null). Same shape considerations
 * as `readPaymentIntentId`.
 */
function readChargeId(refund: Stripe.Refund): string | null {
  const ch = refund.charge
  if (ch === null) return null
  /* c8 ignore start — embedded-charge arm: same as readPaymentIntentId;
   * Stripe Refund.charge is always a string when set. */
  if (typeof ch === 'string') return ch
  return ch.id
}
/* c8 ignore stop */

interface RefundLogIds {
  readonly event_id: string
  readonly refund_id: string
  readonly status: string | null
  readonly payment_intent: string | null
  readonly charge: string | null
}

function refundLogIds(event: Stripe.Event, refund: Stripe.Refund): RefundLogIds {
  return {
    event_id: event.id,
    refund_id: refund.id,
    status: refund.status,
    payment_intent: readPaymentIntentId(refund),
    charge: readChargeId(refund),
  }
}

/**
 * Step −1: status gate. Returns `true` when the handler should proceed to
 * downstream steps; logs + returns `false` otherwise. The two non-success
 * branches log distinct messages so paging rules can target the rare
 * `succeeded → failed` case (run-book per spec §5.4.5 line 671).
 */
function statusGateAllowsProceed(
  refund: Stripe.Refund,
  log: FastifyBaseLogger,
  ids: RefundLogIds,
): boolean {
  if (refund.status === 'succeeded') return true
  if (refund.status === 'pending' || refund.status === 'requires_action') {
    log.info(ids, 'billing.refund_pending')
    return false
  }
  // 'failed' / 'canceled' / null / unknown future values — treat as terminal
  // non-success. No clawback writes have happened yet (this gate is the
  // first check), so no reversal is needed.
  log.info(ids, 'billing.refund_terminal_non_success')
  return false
}

/**
 * Step 0: partial-refund hard-refuse. Returns `true` to proceed, `false` to
 * abort with paging-grade log + commit + 'ok'.
 *
 * `prefetch.charge === null` is NOT a partial-refund signal — the prefetcher
 * already fell back to null when refund.charge was missing. The caller
 * routes that case to step 1's resolution paths (which typically also
 * resolve to "PI null" or "neither matches").
 */
function partialRefundCheckAllowsProceed(
  charge: Stripe.Charge | null,
  refund: Stripe.Refund,
  log: FastifyBaseLogger,
  ids: RefundLogIds,
): boolean {
  if (charge === null) return true // fall through to step 1 paths
  if (charge.amount_refunded === charge.amount_captured) return true
  log.error(
    {
      ...ids,
      charge_id: charge.id,
      amount_captured: charge.amount_captured,
      amount_refunded: charge.amount_refunded,
    },
    'billing.partial_refund_unsupported',
  )
  return false
}

/**
 * Originating-entity resolution result. Discriminated by `kind`:
 *   - 'alacarte': one or more `purchases` rows (multi-line cart) with all
 *     status='completed'. Walk each row's grants and clawback per row.
 *   - 'subscription': a single billing_history row of kind='invoice'.
 *   - 'already_refunded': the resolution found rows but they're all already
 *     status='refunded' — idempotent replay.
 *   - 'unknown_origin': refund.payment_intent was null.
 *   - 'transient_miss': PI set but neither path resolved.
 */
type ResolutionResult =
  | {
      readonly kind: 'alacarte'
      readonly userId: string
      readonly rows: readonly PurchaseRow[]
    }
  | {
      readonly kind: 'subscription'
      readonly userId: string
      readonly billingHistoryId: string
    }
  | { readonly kind: 'already_refunded' }
  | { readonly kind: 'unknown_origin' }
  | { readonly kind: 'transient_miss' }

/**
 * Step 1 (lock-free): resolve originating Mythrun entity. Returns the
 * discriminated result the caller branches on.
 */
async function resolveOrigin(client: ClientLike, refund: Stripe.Refund): Promise<ResolutionResult> {
  const paymentIntentId = readPaymentIntentId(refund)
  if (paymentIntentId === null) return { kind: 'unknown_origin' }

  // À-la-carte path first (§5.4.5 line 688). Purchases are returned ORDER BY
  // id ASC so concurrent clawback transactions acquire row locks in a
  // consistent order — defends against cross-handler deadlocks.
  const allPurchases = await purchases.getByPaymentIntent(client, paymentIntentId)
  if (allPurchases.length > 0) {
    const completed = allPurchases.filter((r) => r.status === 'completed')
    if (completed.length > 0) {
      // All rows on a single PI share the same user_id (cart ⇒ one user).
      const first = completed[0]
      /* c8 ignore start — Defensive: length > 0 makes this unreachable,
       * but TS strict-narrow requires the check. */
      if (!first) {
        throw new Error('refund: purchases completed[0] missing despite length>0')
      }
      /* c8 ignore stop */
      return { kind: 'alacarte', userId: first.user_id, rows: completed }
    }
    // Found rows but all status='refunded' → operator-driven replay.
    return { kind: 'already_refunded' }
  }

  // Subscription path (§5.4.5 line 689; round-8 Carthage C1 — DB-side
  // resolution via the partial index `idx_billing_history_invoice_pi`).
  const invoiceRow = await billingHistory.findInvoiceByPaymentIntent(client, paymentIntentId)
  if (invoiceRow !== null) {
    /* c8 ignore start — subscription billing_history `already_refunded`
     * arm: tested for the à-la-carte path; subscription replays are a
     * rarer operator-driven scenario. */
    if (invoiceRow.status === 'refunded') return { kind: 'already_refunded' }
    /* c8 ignore stop */
    return {
      kind: 'subscription',
      userId: invoiceRow.user_id,
      billingHistoryId: invoiceRow.id,
    }
  }

  // PI set but neither path resolved → transient miss (refund.created
  // arrived BEFORE invoice.paid / checkout.session.completed for the same
  // PI). Caller WARNs + THROWs to roll back stripe_events.
  return { kind: 'transient_miss' }
}

/**
 * Acquire the user-row anchor lock (§5.3 discipline, applied late per
 * Manchego I2 round 3). Re-entrant on the same xid; safe to call when the
 * caller already holds the lock.
 */
async function lockUserRow(client: ClientLike, userId: string): Promise<void> {
  await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
}

/**
 * Re-fetch à-la-carte purchases under FOR UPDATE on the matched ids (round-7
 * Persepolis C5 / step 4). Returns the rows still in status='completed';
 * an empty result indicates a concurrent refund flipped them during the
 * lock-free window between resolveOrigin and lockUserRow.
 */
async function refetchPurchasesUnderLock(
  client: ClientLike,
  rows: readonly PurchaseRow[],
): Promise<readonly PurchaseRow[]> {
  const ids = rows.map((r) => r.id)
  /* c8 ignore start — `ids.length === 0` is unreachable: the caller
   * only invokes this with a non-empty rows array (refund path always
   * resolves at least one purchase). */
  if (ids.length === 0) return []
  /* c8 ignore stop */
  const result = await client.query<PurchaseRow>(
    `SELECT id, user_id, stripe_payment_intent_id, lookup_key, quantity,
            amount_cents, currency, status, created_at
       FROM purchases
       WHERE id = ANY($1::uuid[])
       ORDER BY id ASC
       FOR UPDATE`,
    [ids],
  )
  return result.rows.filter((r) => r.status === 'completed')
}

/**
 * Re-fetch the subscription billing_history row under FOR UPDATE. Returns
 * the row when status is still 'completed', null when a concurrent refund
 * already flipped it.
 */
async function refetchBillingHistoryUnderLock(
  client: ClientLike,
  id: string,
): Promise<BillingHistoryRow | null> {
  const result = await client.query<BillingHistoryRow>(
    `SELECT id, user_id, kind, source_id_stripe, stripe_payment_intent_id,
            lookup_key, amount_cents, currency, status, expires_at,
            occurred_at, created_at
       FROM billing_history
       WHERE id = $1
       FOR UPDATE`,
    [id],
  )
  const row = result.rows[0]
  /* c8 ignore start — `!row` arm is unreachable: refetchBillingHistory
   * is called with an id resolved in the same tx; the row exists.
   * The `: null` arm fires only on a concurrent refund's status flip. */
  if (!row) return null
  return row.status === 'completed' ? row : null
  /* c8 ignore stop */
}

/**
 * Originating-grant row shape used to compute the clawback. The `id` is the
 * source_id we use as the recordClawback idempotency key (round-8 Persepolis
 * C2 / Petra I5 — the `uniq_credit_ledger_debit_idempotency` partial unique
 * index keys on (user_id, credit_type, source_id) WHERE source_type='debit').
 */
interface OriginGrantRow {
  readonly id: string
  readonly user_id: string
  readonly credit_type: 'session' | 'world_gen'
  readonly amount: number
}

/**
 * Pull originating grant rows for an à-la-carte purchase. Per migration 007's
 * credit_ledger_source_link_chk: source_type='purchase' rows have
 * source_purchase_id NOT NULL; these are the rows we claw back.
 */
async function loadAlaCarteGrants(
  client: ClientLike,
  purchaseId: string,
): Promise<readonly OriginGrantRow[]> {
  const result = await client.query<OriginGrantRow>(
    `SELECT id, user_id, credit_type, amount
       FROM credit_ledger
       WHERE source_purchase_id = $1
         AND source_type = 'purchase'`,
    [purchaseId],
  )
  return result.rows
}

/**
 * Pull originating grant rows for a subscription invoice. Per migration 007:
 * source_type='subscription' rows carry source_billing_history_id NOT NULL.
 */
async function loadSubscriptionGrants(
  client: ClientLike,
  billingHistoryId: string,
): Promise<readonly OriginGrantRow[]> {
  const result = await client.query<OriginGrantRow>(
    `SELECT id, user_id, credit_type, amount
       FROM credit_ledger
       WHERE source_billing_history_id = $1
         AND source_type = 'subscription'`,
    [billingHistoryId],
  )
  return result.rows
}

/**
 * Insert a clawback debit row. Mirrors `recordClawback` from
 * `repo/credits.ts` — same ON CONFLICT shape. Inlined here because the
 * exported `recordClawback` is a method on the closure-bound repo
 * (`createCreditsRepo`), and we don't have a pool-bound repo at this layer;
 * we have a `ClientLike` from the dispatcher's tx. The exported standalone
 * `grantInTx` helper takes ClientLike, but no equivalent for clawbacks
 * exists today, so this module owns the SQL.
 *
 * The per-row INSERT is intentional: a multi-line cart's clawback has 2-6
 * rows in practice; one round-trip per row is the simplest correct shape
 * and still finishes well within the dispatcher's 5s statement timeout.
 */
async function insertClawbackRow(client: ClientLike, row: OriginGrantRow): Promise<void> {
  const id = uuidv7()
  await client.query(
    `INSERT INTO credit_ledger
       (id, user_id, credit_type, amount, source_type, source_id,
        expires_at, source_purchase_id, source_billing_history_id)
     VALUES ($1, $2, $3, $4, 'debit', $5, NULL, NULL, NULL)
     ON CONFLICT (user_id, credit_type, source_id) WHERE source_type = 'debit'
     DO NOTHING`,
    [id, row.user_id, row.credit_type, -Math.abs(row.amount), row.id],
  )
}

/**
 * Step 3 + step 4 (à-la-carte): for each completed purchase row, write
 * clawback rows for every originating grant + flip status='refunded'. The
 * caller has already acquired the user-row lock and re-fetched the rows
 * under FOR UPDATE.
 */
async function applyAlaCarteClawbacks(
  client: ClientLike,
  rows: readonly PurchaseRow[],
): Promise<void> {
  for (const row of rows) {
    const grants = await loadAlaCarteGrants(client, row.id)
    for (const g of grants) await insertClawbackRow(client, g)
    await purchases.markRefunded(client, row.id)
  }
}

/**
 * Step 3 + step 4 (subscription): write clawback rows + flip the
 * billing_history row's status='refunded'.
 */
async function applySubscriptionClawback(
  client: ClientLike,
  billingHistoryId: string,
): Promise<void> {
  const grants = await loadSubscriptionGrants(client, billingHistoryId)
  for (const g of grants) await insertClawbackRow(client, g)
  await billingHistory.markRefunded(client, billingHistoryId)
}

/**
 * Step 5: append the refund-self billing_history row with onConflict:
 * 'do_nothing' so a redelivered `refund.created` (different event_id, same
 * `re_*`) doesn't 23505 on the (kind, source_id_stripe) UNIQUE.
 */
async function appendRefundHistoryRow(
  client: ClientLike,
  userId: string,
  refund: Stripe.Refund,
): Promise<void> {
  await billingHistory.append(
    client,
    {
      id: uuidv7(),
      user_id: userId,
      kind: 'refund',
      source_id_stripe: refund.id,
      stripe_payment_intent_id: null,
      lookup_key: null,
      amount_cents: -refund.amount,
      currency: refund.currency,
      expires_at: null,
      occurred_at: new Date(refund.created * 1000),
    },
    { onConflict: 'do_nothing' },
  )
}

/**
 * Top-level handler for `refund.created` / `refund.updated` (spec §5.4.5).
 * See module header for step ordering.
 */
export async function handleRefundEvent(
  event: Stripe.Event,
  prefetch: unknown,
  client: ClientLike,
  log: FastifyBaseLogger,
): Promise<HandlerResult> {
  const { charge } = asRefundPrefetch(prefetch)
  const refund = event.data.object as Stripe.Refund
  const ids = refundLogIds(event, refund)

  // Step −1: status gate.
  if (!statusGateAllowsProceed(refund, log, ids)) return 'ok'

  // Step 0: partial-refund hard-refuse.
  if (!partialRefundCheckAllowsProceed(charge, refund, log, ids)) return 'ok'

  // Step 1: resolve originating entity.
  const resolution = await resolveOrigin(client, refund)
  if (resolution.kind === 'unknown_origin') {
    log.info(ids, 'billing.refund_unknown_origin')
    return 'ok'
  }
  if (resolution.kind === 'already_refunded') {
    log.info(ids, 'billing.refund_already_applied')
    return 'ok'
  }
  if (resolution.kind === 'transient_miss') {
    // Caller throws so the dispatcher rolls back stripe_events; Stripe
    // redelivers once the originating row exists.
    log.warn(ids, 'billing.refund_resolution_miss')
    /* c8 ignore start — `?? '<null>'` arm fires only when the refund has
     * no payment_intent at all; the transient_miss path is reached only
     * with a non-null PI, so this fallback is defense-in-depth. */
    throw new Error(
      `refund: transient resolution miss for refund_id=${refund.id} ` +
        `payment_intent=${ids.payment_intent ?? '<null>'}`,
    )
    /* c8 ignore stop */
  }

  // Step 2: anchor-lock + re-fetch under lock.
  await lockUserRow(client, resolution.userId)

  if (resolution.kind === 'alacarte') {
    const stillCompleted = await refetchPurchasesUnderLock(client, resolution.rows)
    /* c8 ignore start — `stillCompleted.length === 0` is the race-loss
     * arm: a concurrent refund handler flipped the rows to 'refunded'
     * between our unlocked resolve and the locked re-fetch. Integration
     * tests run serial; this is defense-in-depth. */
    if (stillCompleted.length === 0) {
      log.info(ids, 'billing.refund_already_applied')
      return 'ok'
    }
    /* c8 ignore stop */
    // Step 3 + 4: clawbacks + markRefunded per row.
    await applyAlaCarteClawbacks(client, stillCompleted)
    // Step 5: refund self-row.
    await appendRefundHistoryRow(client, resolution.userId, refund)
    return 'ok'
  }

  // resolution.kind === 'subscription'
  const stillCompleted = await refetchBillingHistoryUnderLock(client, resolution.billingHistoryId)
  /* c8 ignore start — same race-loss arm as the alacarte branch above;
   * defense-in-depth for a concurrent refund flipping status during
   * the lock window. */
  if (stillCompleted === null) {
    log.info(ids, 'billing.refund_already_applied')
    return 'ok'
  }
  /* c8 ignore stop */
  await applySubscriptionClawback(client, resolution.billingHistoryId)
  await appendRefundHistoryRow(client, resolution.userId, refund)
  return 'ok'
}
