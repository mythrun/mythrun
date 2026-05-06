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
import type { ClientLike } from '../repo/_types.js'
import { stripeEvents } from '../repo/stripe-events.js'
import { STRIPE_API_VERSION } from './stripe-client.js'

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

export type HandlerResult = 'ok' | 'validation_failed'

export type EventHandler = (
  event: Stripe.Event,
  prefetch: unknown,
  client: ClientLike,
) => Promise<HandlerResult>

export type PrefetchFn = (event: Stripe.Event, stripe: Stripe) => Promise<unknown>

// Per-event handler stubs. Tasks 17-24 replace each
// `() => Promise.resolve('ok')` with the real handler (see spec §5.4.1
// through §5.4.7). Exported so tests can override individual entries.
//
// ESLint @typescript-eslint/require-await flags `async () => 'ok'`
// shaped stubs because the body has no `await`. Using
// `() => Promise.resolve('ok')` produces an identical runtime value and
// the same `EventHandler` type signature without the lint error.
const okHandler: EventHandler = () => Promise.resolve('ok')

export const HANDLERS: Record<KnownStripeEventType, EventHandler> = {
  'checkout.session.completed': okHandler,
  'invoice.paid': okHandler,
  'customer.subscription.created': okHandler,
  'customer.subscription.updated': okHandler,
  'customer.subscription.deleted': okHandler,
  'customer.subscription.pending_update_applied': okHandler,
  'customer.subscription.pending_update_expired': okHandler,
  'refund.created': okHandler,
  'refund.updated': okHandler,
}

// Per-event prefetch shapes (spec §5.3 lines 510-547). Currently empty;
// Tasks 17-24 fill in the entries that need Stripe-side fetches (e.g.
// checkout.session.completed expands line_items, invoice.paid resolves
// the parent subscription). Default: no prefetch (handler reads
// event.data.object directly).
export const PREFETCHERS: Partial<Record<KnownStripeEventType, PrefetchFn>> = {}

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
 * Open a short tx, record the stripe_events row, COMMIT. Used by the
 * api-version-mismatch path to ack the event so Stripe stops retrying.
 * Identical timeout discipline to the main dispatch tx — a slow holder
 * on the row index can't pin the PoolClient.
 */
async function recordEventOnlyTx(
  pool: Pool,
  event: Stripe.Event,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(
      "BEGIN; SET LOCAL transaction_isolation = 'read committed'; SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '5s'",
    )
    await stripeEvents.recordOrSkip(client, event.id, event.type)
    await client.query('COMMIT')
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Connection dead; pool will recycle. Swallow so the original
      // error propagates to the caller.
    }
    throw err
  } finally {
    client.release()
  }
}

export async function dispatchEvent(
  event: Stripe.Event,
  stripe: Stripe,
  pool: Pool,
  log: FastifyBaseLogger,
): Promise<void> {
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
    await recordEventOnlyTx(pool, event)
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

  // 3. Phase 2: dispatch tx with full timeout discipline.
  const client = await pool.connect()
  try {
    await client.query(
      "BEGIN; SET LOCAL transaction_isolation = 'read committed'; SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '5s'",
    )

    const inserted = await stripeEvents.recordOrSkip(client, event.id, event.type)
    if (inserted === 'duplicate') {
      await client.query('ROLLBACK')
      return
    }

    const handler = lookupHandler(event.type)
    if (!handler) {
      // Unknown event type: COMMIT the stripe_events row (acknowledges
      // the delivery so Stripe stops retrying) and exit cleanly.
      log.info(
        { event_type: event.type, event_id: event.id },
        'stripe_webhook_unknown_type',
      )
      await client.query('COMMIT')
      return
    }

    const result = await handler(event, prefetch, client)
    await client.query('COMMIT')

    if (result === 'validation_failed') {
      // Handler is contractually required to have written nothing else
      // when returning the sentinel (spec §5.3 line 487, §13 regression
      // test). Logging at error level so paging-grade alarms can fire
      // on the pattern.
      log.error(
        { event_id: event.id },
        'billing.handler_validation_failed_committed',
      )
    }
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Connection dead; pool will recycle. Swallow so the original
      // error propagates.
    }
    throw err
  } finally {
    client.release()
  }
}
