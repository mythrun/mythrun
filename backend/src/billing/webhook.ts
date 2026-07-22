// backend/src/billing/webhook.ts
//
// MYT-42 Task 16. Stripe webhook dispatcher per spec §5.3.
//
// Contract:
//   - Defense-in-depth: assert event.api_version === STRIPE_API_VERSION.
//     Mismatch is FAIL-CLOSED — we record the stripe_events row in its
//     own short tx (so Stripe stops retrying) and skip handler invocation
//     entirely. Typed field access against the wrong API version is silent
//     corruption (per Ephesus I3 / Carthage M4 round 5).
//
//   - Phase 1 (outside any DB tx): per-event-type prefetch. Stripe API
//     calls live HERE, not inside the tx, so a Stripe outage delays
//     processing without pinning the PoolClient (per Chimera I2 / Hydra
//     I2 / Sphinx M3 round 2).
//
//   - Phase 2 (inside the dispatch tx): a single multi-statement
//     `BEGIN; SET LOCAL transaction_isolation = 'read committed';
//      SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '5s'`
//     command — all three SET LOCALs are load-bearing per Petra C1 round 5
//     (matches MYT-40's atomicDebit recipe). Then idempotent insert into
//     stripe_events, optional handler invocation, COMMIT.
//
//   - Validation-failed sentinel (Petra C2 round 5): handlers MAY return
//     'validation_failed' to signal "COMMIT only the stripe_events row;
//     skip downstream writes." Distinct from throwing, which ROLLBACKs
//     (so Stripe redelivers) and rethrows so the route returns 5xx.
//
//   - HANDLERS + PREFETCHERS are exported so tests can override entries
//     without recompiling. Subsequent tasks (17-24) replace each
//     `async () => 'ok'` stub with the real per-event handler.
//
// Logger type: spec §5.3 declares `log: Logger` (pino's Logger), but
// Fastify's `request.log` is typed as `FastifyBaseLogger` — a structural
// subset that covers .info/.warn/.error/.debug. Typing as
// `FastifyBaseLogger` accepts both Fastify's request.log and a real pino
// instance without a type assertion at the call site.

import type { Stripe } from 'stripe'
import type { Pool } from 'pg'
import type { FastifyBaseLogger } from 'fastify'
import { createRepo, ROLLBACK, type TxRepo } from '../repo/index.js'
import { uuidv7 } from '../repo/uuidv7.js'
import { STRIPE_API_VERSION } from './stripe-client.js'
import { handleCheckoutCompletedPayment } from './webhook-checkout-payment.js'
import { handleInvoicePaid, prefetchInvoicePaid } from './webhook-invoice-paid.js'
import { handleSubscriptionUpsert } from './webhook-subscription-upsert.js'
import { handleSubscriptionDeleted } from './webhook-subscription-deleted.js'
import {
  handlePendingUpdateApplied,
  prefetchPendingUpdateApplied,
} from './webhook-pending-update-applied.js'
import { handlePendingUpdateExpired } from './webhook-pending-update-expired.js'
import { handleRefundEvent, prefetchRefund } from './webhook-refund.js'
import type { HandlerResult } from './webhook-types.js'

export type KnownStripeEventType =
  | 'checkout.session.completed'
  | 'invoice.paid'
  | 'customer.subscription.created'
  | 'customer.subscription.updated'
  | 'customer.subscription.deleted'
  | 'customer.subscription.pending_update_applied'
  | 'customer.subscription.pending_update_expired'
  | 'refund.created'
  | 'refund.updated'

export type EventHandler = (
  event: Stripe.Event,
  prefetch: unknown,
  tx: TxRepo,
  log: FastifyBaseLogger,
) => Promise<HandlerResult>

export type PrefetchFn = (event: Stripe.Event, stripe: Stripe) => Promise<unknown>

// Per-event handler map. All entries are wired to their real per-event
// handlers as of Task 24 (refund.created / refund.updated were the last
// two stubs). Exported so tests can override individual entries.
export const HANDLERS: Record<KnownStripeEventType, EventHandler> = {
  'checkout.session.completed': handleCheckoutCompleted,
  'invoice.paid': handleInvoicePaid,
  'customer.subscription.created': handleSubscriptionUpsert,
  'customer.subscription.updated': handleSubscriptionUpsert,
  'customer.subscription.deleted': handleSubscriptionDeleted,
  'customer.subscription.pending_update_applied': handlePendingUpdateApplied,
  'customer.subscription.pending_update_expired': handlePendingUpdateExpired,
  'refund.created': handleRefundEvent,
  'refund.updated': handleRefundEvent,
}

// Per-event prefetch shapes (spec §5.3 lines 510-547). Tasks 17-24 fill
// in the entries that need Stripe-side fetches; the default for
// unlisted entries is "no prefetch" (handler reads event.data.object
// directly).
export const PREFETCHERS: Partial<Record<KnownStripeEventType, PrefetchFn>> = {
  'checkout.session.completed': prefetchCheckoutCompleted,
  'invoice.paid': prefetchInvoicePaid,
  'customer.subscription.pending_update_applied': prefetchPendingUpdateApplied,
  'refund.created': prefetchRefund,
  'refund.updated': prefetchRefund,
}

/**
 * Look up a HANDLERS entry by runtime event-type string. Returns
 * `undefined` for unknown types — distinct from the `as` assertion used
 * earlier in this module's history (which lied about the index lookup
 * being total). Stripe's `event.type` is `string` on the wire; only a
 * runtime check guarantees the lookup is safe.
 */
function lookupHandler(eventType: string): EventHandler | undefined {
  return Object.prototype.hasOwnProperty.call(HANDLERS, eventType)
    ? HANDLERS[eventType as KnownStripeEventType]
    : undefined
}

function lookupPrefetcher(eventType: string): PrefetchFn | undefined {
  return Object.prototype.hasOwnProperty.call(PREFETCHERS, eventType)
    ? PREFETCHERS[eventType as KnownStripeEventType]
    : undefined
}

/**
 * Per-call SET LOCAL knobs for the dispatch tx + the record-only tx. The
 * three SET LOCALs are load-bearing per Petra C1 round 5 (matches MYT-40's
 * atomicDebit recipe): isolation 'read committed', lock_timeout 1s,
 * statement_timeout 5s. Passed to `repo.transaction` as TxOpts (it emits the
 * `SET LOCAL` statements inside the BEGIN scope — see db/transaction.ts:
 * beginPrelude), preserving the exact prior hand-managed recipe.
 */
export const DISPATCH_TX_OPTS = {
  isolation: 'read committed',
  lockTimeoutMs: 1000,
  statementTimeoutMs: 5000,
} as const

type DispatchRepo = ReturnType<typeof createRepo>

/**
 * Record the stripe_events row in its own short tx, COMMIT. Used by the
 * api-version-mismatch path to ack the event so Stripe stops retrying.
 * Identical timeout discipline to the main dispatch tx — a slow holder
 * on the row index can't pin the PoolClient. `repo.transaction` owns the
 * connect/BEGIN/SET LOCAL/COMMIT/release recipe; this just supplies the
 * single write + the opts.
 */
async function recordEventOnlyTx(repo: DispatchRepo, event: Stripe.Event): Promise<void> {
  await repo.transaction(
    (tx) => tx.stripeEvents.recordOrSkip(event.id, event.type),
    DISPATCH_TX_OPTS,
  )
}

export async function dispatchEvent(
  event: Stripe.Event,
  stripe: Stripe,
  pool: Pool,
  log: FastifyBaseLogger,
): Promise<void> {
  const repo = createRepo(pool)
  // 1. API-version gate (fail-closed). Typed field access against the
  //    wrong version is silent corruption per spec §3.1 notes 6/7/8 and
  //    §5.3 round-5 fixes.
  if (event.api_version !== STRIPE_API_VERSION) {
    log.error(
      {
        event_api_version: event.api_version,
        sdk_pin: STRIPE_API_VERSION,
        event_id: event.id,
      },
      'stripe_webhook_api_version_mismatch',
    )
    // Best-effort ack so Stripe stops retrying. If even this fails (DB
    // outage), the throw bubbles up to the route handler, which returns
    // 5xx and Stripe redelivers — the safe behavior in that case.
    await recordEventOnlyTx(repo, event)
    return
  }

  // 2. Phase 1: prefetch outside the DB tx. Stripe SDK calls (and any
  //    tail latency under Stripe outage) do NOT pin a PoolClient.
  //
  // `event.type` is a runtime string from Stripe's wire payload; we look
  // it up in PREFETCHERS / HANDLERS without an `as` assertion so the
  // optional-undefined return reflects reality (unknown event type =
  // missing entry).
  const prefetcher = lookupPrefetcher(event.type)
  const prefetch = prefetcher ? await prefetcher(event, stripe) : undefined

  // 3. Phase 2: dispatch tx with full timeout discipline. `repo.transaction`
  //    owns connect → BEGIN (+ SET LOCAL prelude) → COMMIT/ROLLBACK → release.
  //    The callback encodes the three terminal outcomes the contract requires:
  //      - duplicate redelivery → return `ROLLBACK` (the no-op-discard
  //        sentinel: rolls back, surfaces NO error, so Stripe stops retrying);
  //      - unknown event type   → COMMIT the stripe_events row (clean return);
  //      - handler ran          → COMMIT, return the handler's HandlerResult so
  //        the post-commit `validation_failed` log fires off the return value;
  //      - handler throws       → propagates out of the callback →
  //        repo.transaction ROLLBACKs + rethrows (drives Stripe redelivery).
  const result = await repo.transaction((tx) => dispatchInTx(event, prefetch, tx, log), DISPATCH_TX_OPTS)

  if (result !== ROLLBACK && result === 'validation_failed') {
    // Handler is contractually required to have written nothing else when
    // returning the sentinel (spec §5.3 line 487, §13 regression test).
    // Logging at error level — AFTER the COMMIT — so paging-grade alarms can
    // fire on the pattern. The stripe_events row IS committed; only the
    // downstream writes were skipped.
    log.error({ event_id: event.id }, 'billing.handler_validation_failed_committed')
  }
}

/**
 * The body of the Phase-2 dispatch transaction. Runs entirely on the in-flight
 * tx client (`tx`). Returns:
 *   - `ROLLBACK` for a duplicate redelivery (no-op discard, no error);
 *   - `'ok'` for an unknown event type (COMMIT the stripe_events row);
 *   - the handler's `HandlerResult` ('ok' / 'validation_failed') otherwise
 *     (COMMIT; the caller logs on 'validation_failed' after commit).
 * A handler throw propagates out, rolling back the whole tx.
 */
async function dispatchInTx(
  event: Stripe.Event,
  prefetch: unknown,
  tx: TxRepo,
  log: FastifyBaseLogger,
): Promise<HandlerResult | typeof ROLLBACK> {
  const inserted = await tx.stripeEvents.recordOrSkip(event.id, event.type)
  if (inserted === 'duplicate') {
    // Idempotent discard: ROLLBACK with no error surfaced (Stripe stops
    // retrying without a needless 5xx).
    return ROLLBACK
  }

  const handler = lookupHandler(event.type)
  if (!handler) {
    // Unknown event type: COMMIT the stripe_events row (acknowledges the
    // delivery so Stripe stops retrying) and exit cleanly.
    log.info({ event_type: event.type, event_id: event.id }, 'stripe_webhook_unknown_type')
    return 'ok'
  }

  return await handler(event, prefetch, tx, log)
}

// ─── checkout.session.completed (Task 17, MYT-42 §5.4.1) ────────────────────
//
// Subscription mode: upsert user_subscriptions ONLY. No billing_history,
// no credit_ledger writes — those are owned by the `invoice.paid` handler
// (Decision 1 of round-2 review + Manchego M2 round 3). The downstream
// `invoice.paid` arrives ~100ms later (or whenever SCA / ACH settles)
// and produces the credit grant.
//
// Payment mode (à-la-carte): deferred to Task 18. The handler returns
// 'ok' as a temporary placeholder so unrelated payment-mode webhook
// deliveries don't retry-loop in the meantime.

/**
 * Shape of the prefetched session + subscription. The dispatcher runs
 * this OUTSIDE the dispatch tx (per §5.3 prefetch-then-write discipline),
 * so a Stripe outage can delay processing without pinning the PoolClient.
 *
 * `subscription` is null for payment-mode sessions (no Stripe
 * subscription was created); the subscription-branch handler asserts
 * non-null before reading from it.
 */
interface CheckoutCompletedPrefetch {
  readonly session: Stripe.Checkout.Session
  readonly subscription: Stripe.Subscription | null
}

/**
 * Prefetcher for `checkout.session.completed` (spec §5.3 line 512).
 *
 * Always retrieves the session (the event payload at dahlia does NOT
 * include `line_items`). When the session is in subscription mode,
 * additionally retrieves the subscription so the handler has access to
 * `items.data[0].current_period_*` plus `status`, `cancel_at_period_end`,
 * `cancel_at`, and `cancellation_details` — Stripe's webhook payloads
 * don't deep-expand by default per §3.1 note 4.
 *
 * Idempotent on retry: completed sessions and their subscriptions are
 * immutable post-completion.
 */
async function prefetchCheckoutCompleted(
  event: Stripe.Event,
  stripe: Stripe,
): Promise<CheckoutCompletedPrefetch> {
  const obj = event.data.object as Stripe.Checkout.Session
  const session = await stripe.checkout.sessions.retrieve(obj.id, {
    expand: ['line_items.data.price'],
  })
  let subscription: Stripe.Subscription | null = null
  if (typeof session.subscription === 'string' && session.subscription.length > 0) {
    subscription = await stripe.subscriptions.retrieve(session.subscription, {
      expand: ['items.data.price'],
    })
  }
  return { session, subscription }
}

/**
 * Read the prefetch with a runtime-shape gate so the handler doesn't
 * have to litter `as` casts. Throws if the prefetch is shaped wrong —
 * a programming error that should be caught loudly (the dispatcher will
 * ROLLBACK and Stripe redelivers).
 */
function asCheckoutPrefetch(prefetch: unknown): CheckoutCompletedPrefetch {
  if (
    typeof prefetch !== 'object' ||
    prefetch === null ||
    !('session' in prefetch) ||
    !('subscription' in prefetch)
  ) {
    throw new Error('checkout.session.completed: prefetch shape unexpected')
  }
  // The interface fields are typed; the cast through unknown lets us
  // narrow without fighting TS's structural-type inference on `in`.
  return prefetch as CheckoutCompletedPrefetch
}

/**
 * Handler for `checkout.session.completed` (spec §5.4.1).
 *
 * Resolves user via `event.data.object.metadata.userId` (NOT via
 * `customer.id` — checkout sessions carry the userId in metadata at
 * session-create time per §4.3). Cross-checks `customer` against
 * `users.stripe_customer_id` for defense-in-depth. On miss or mismatch,
 * pages a paging-grade error metric and returns 'ok' so the dispatcher
 * COMMITs the `stripe_events` row (Stripe stops retrying); manual
 * reconciliation handles the corruption.
 *
 * Branches on `mode`:
 *   - 'subscription': upsert `user_subscriptions` via the repo (single
 *     ON CONFLICT statement; idempotent across redeliveries and across
 *     racing `customer.subscription.created/.updated` events). NO writes
 *     to billing_history / credit_ledger.
 *   - 'payment': Task 18 placeholder — returns 'ok'.
 */
interface CheckoutLogIds {
  readonly event_id: string
  readonly session_id: string
  readonly payment_intent: string | null
  readonly subscription: string | null
  readonly metadata_user_id: string | null
  readonly customer: string | null
}

function checkoutLogIds(event: Stripe.Event, session: Stripe.Checkout.Session): CheckoutLogIds {
  return {
    event_id: event.id,
    session_id: session.id,
    payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : null,
    subscription: typeof session.subscription === 'string' ? session.subscription : null,
    metadata_user_id: session.metadata?.userId ?? null,
    customer: typeof session.customer === 'string' ? session.customer : null,
  }
}

async function handleCheckoutCompleted(
  event: Stripe.Event,
  prefetch: unknown,
  tx: TxRepo,
  log: FastifyBaseLogger,
): Promise<HandlerResult> {
  const { session, subscription } = asCheckoutPrefetch(prefetch)
  const ids = checkoutLogIds(event, session)

  // 1. Orphan check — `metadata.userId` doesn't resolve to a users row.
  //    Page (paid-but-unknown-user is paging-grade per §5.4.1) + COMMIT
  //    the stripe_events row + return 'ok' (NOT validation_failed; that
  //    sentinel is reserved for amount-validation per §5.4 cross-cutting
  //    rule 2). NO throw — throwing would ROLLBACK and Stripe would
  //    redeliver, accumulating noise without changing the outcome.
  if (ids.metadata_user_id === null) {
    log.error(ids, 'billing.checkout_orphan')
    return 'ok'
  }
  const user = await tx.users.getForUpdateById(ids.metadata_user_id)
  if (!user) {
    log.error(ids, 'billing.checkout_orphan')
    return 'ok'
  }

  // 2. Cross-check: session.customer must match users.stripe_customer_id.
  //    A mismatch means the user-checkout-customer triple is corrupted
  //    (operator review). Page + COMMIT + return 'ok' — same shape as
  //    the orphan path; the row writes are NOT applied.
  if (ids.customer !== user.stripe_customer_id) {
    log.error(
      { ...ids, users_stripe_customer_id: user.stripe_customer_id },
      'billing.checkout_customer_mismatch',
    )
    return 'ok'
  }

  // 3. Branch on session.mode.
  if (session.mode === 'subscription') {
    return await handleCheckoutCompletedSubscription(
      event,
      session,
      subscription,
      user.id,
      tx,
      log,
    )
  }
  if (session.mode === 'payment') {
    return await handleCheckoutCompletedPayment(event, session, user.id, tx, log)
  }
  // 'setup' mode (or anything else dahlia might add): nothing to do.
  log.info(
    { event_id: event.id, session_id: session.id, mode: session.mode },
    'billing.checkout_unhandled_mode',
  )
  return 'ok'
}

/**
 * Subscription-mode branch of `checkout.session.completed` (spec §5.4.1
 * subscription-mode bullets, lines 586-589).
 *
 * Writes ONLY the `user_subscriptions` row via `upsertFromStripe`
 * (idempotent ON CONFLICT). NO `billing_history`, NO `credit_ledger` —
 * those are owned by `invoice.paid`.
 */
async function handleCheckoutCompletedSubscription(
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
  subscription: Stripe.Subscription | null,
  userId: string,
  tx: TxRepo,
  log: FastifyBaseLogger,
): Promise<HandlerResult> {
  // Multi-line subscription guard (per Persepolis C4 round 7 multi-line
  // pattern, applied here for the subscription branch — Mythrun never
  // exposes multi-item subs to users; an admin-created multi-line
  // subscription session is operator error and must NOT silently grant
  // a tier). Returning 'validation_failed' commits stripe_events without
  // any other writes; Stripe stops retrying.
  const lineCount = session.line_items?.data.length ?? 0
  if (lineCount !== 1) {
    log.error(
      { event_id: event.id, session_id: session.id, line_items_count: lineCount },
      'billing.checkout_subscription_multi_line',
    )
    return 'validation_failed'
  }

  // Subscription must have been prefetched. Stripe always sets
  // session.subscription when mode='subscription'; a null prefetch here
  // is a programming error and should fail loudly.
  if (!subscription) {
    throw new Error(
      `checkout.session.completed: subscription mode but prefetch.subscription is null (session=${session.id})`,
    )
  }
  if (subscription.items.data.length !== 1) {
    log.error(
      {
        event_id: event.id,
        subscription_id: subscription.id,
        items_count: subscription.items.data.length,
      },
      'billing.checkout_subscription_multi_item',
    )
    return 'validation_failed'
  }
  const item = subscription.items.data[0]
  /* c8 ignore start — invariant assertion: the length-check immediately
     above already returned when items.data.length !== 1, so items.data[0]
     must exist. The TS narrowing rejects a non-null assertion without it,
     which would also hide a real bug if the length check ever changed. */
  if (!item) {
    throw new Error(
      `checkout.session.completed: subscription items.data[0] missing (sub=${subscription.id})`,
    )
  }
  /* c8 ignore stop */
  const tierLookupKey = item.price.lookup_key
  if (typeof tierLookupKey !== 'string' || tierLookupKey.length === 0) {
    log.error(
      {
        event_id: event.id,
        subscription_id: subscription.id,
        price_id: item.price.id,
      },
      'billing.checkout_subscription_missing_lookup_key',
    )
    return 'validation_failed'
  }

  await tx.userSubscriptions.upsertFromStripe({
    id: uuidv7(),
    user_id: userId,
    stripe_subscription_id: subscription.id,
    tier_lookup_key: tierLookupKey,
    status: subscription.status,
    current_period_start: new Date(item.current_period_start * 1000),
    current_period_end: new Date(item.current_period_end * 1000),
    cancel_at_period_end: subscription.cancel_at_period_end,
    cancel_at: subscription.cancel_at,
    cancellation_details: subscription.cancellation_details,
    stripe_event_created_at: new Date(event.created * 1000),
  })
  return 'ok'
}
