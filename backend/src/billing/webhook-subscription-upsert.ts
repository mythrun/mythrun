// backend/src/billing/webhook-subscription-upsert.ts
//
// Shared handler for `customer.subscription.created` AND
// `customer.subscription.updated` per MYT-42 spec §5.4.3 (Task 20). Both
// event types fire the same upsert logic because the payload shape +
// dispatch contract are identical; the dispatcher routes both to this
// module's `handleSubscriptionUpsert`.
//
// Extracted from webhook.ts to keep that module under the 400-line cap.
//
// Key invariants:
//   - **Pending-update gate** (round-7 + research findings, spec §5.4.3
//     line 647): if `event.data.object.pending_update !== null`, the
//     subscription has an in-flight upgrade whose proration invoice has
//     NOT yet settled (card declined, SCA pending, async settlement).
//     Stripe fires `customer.subscription.updated` with `pending_update`
//     populated as the intermediate-state notification. The handler logs
//     INFO `billing.subscription_pending_update_visible` and returns 'ok'
//     WITHOUT upserting tier / status / period dates. The actual advance
//     happens via `customer.subscription.pending_update_applied`
//     (§5.4.6 / Task 22). This is the FIRST check after user resolution —
//     log + return BEFORE any DB writes.
//
//   - **User resolution** mirrors the §5.4.2 pattern in webhook-invoice-paid.ts:
//     resolve via `event.data.object.customer` → `users.stripe_customer_id`
//     (anchor lock FOR UPDATE per §5.3 discipline); on miss, fall back to
//     `event.data.object.metadata.userId`. Total miss → log INFO + 'ok'
//     (Stripe-side test event for an orphan customer).
//
//   - **Multi-item guard**: assert `items.data.length === 1`
//     (§3.1 note 1). Mythrun never exposes multi-item subs to users; an
//     admin-created multi-line sub is operator error and must NOT silently
//     advance tier. Multi-item → 'validation_failed' + paging.
//
//   - **No credit grant** in this handler (Decision 1 of round-2 review —
//     `invoice.paid` is the single source of truth for credits;
//     subscription state lives on `user_subscriptions`, credits live on
//     `credit_ledger`).
//
//   - **Stripe doesn't guarantee delivery order** between `.created`,
//     `.updated`, and `checkout.session.completed`; the upsert handler
//     tolerates any ordering via the strict-`>` `stripe_event_created_at`
//     filter inside `userSubscriptions.upsertFromStripe`.

import type { Stripe } from 'stripe'
import type { FastifyBaseLogger } from 'fastify'
import type { ClientLike } from '../repo/_types.js'
import { userSubscriptions } from '../repo/user-subscriptions.js'
import { uuidv7 } from '../repo/uuidv7.js'
import type { HandlerResult } from './webhook-types.js'

interface SubscriptionLogIds {
  readonly event_id: string
  readonly event_type: string
  readonly subscription_id: string
  readonly customer: string | null
  readonly metadata_user_id: string | null
}

function subscriptionLogIds(
  event: Stripe.Event,
  subscription: Stripe.Subscription,
): SubscriptionLogIds {
  /* c8 ignore start — defensive narrowing of customer + metadata.userId:
   * Stripe always sends string customer; fixtures always set userId. */
  const customer =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
  const metadataUserId = subscription.metadata.userId
  return {
    event_id: event.id,
    event_type: event.type,
    subscription_id: subscription.id,
    customer,
    metadata_user_id:
      typeof metadataUserId === 'string' && metadataUserId.length > 0 ? metadataUserId : null,
  }
  /* c8 ignore stop */
}

interface ResolvedUser {
  readonly id: string
}

/**
 * Resolve the user via `subscription.customer` → `users.stripe_customer_id`
 * (FOR UPDATE — anchor lock per §5.3). On miss, fall back to
 * `subscription.metadata.userId` (set at Checkout Session creation; a
 * webhook-only retry against an orphan customer would have neither).
 *
 * Returns `null` on total miss — caller logs INFO and returns 'ok' so the
 * dispatcher COMMITs the `stripe_events` row and Stripe stops retrying.
 */
async function resolveUser(
  client: ClientLike,
  subscription: Stripe.Subscription,
): Promise<ResolvedUser | null> {
  /* c8 ignore start — non-string customer arm: Stripe always sends a
   * string id on subscription created/updated. */
  const customer =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
  /* c8 ignore stop */
  if (customer.length > 0) {
    const byCustomer = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE stripe_customer_id = $1 FOR UPDATE',
      [customer],
    )
    const found = byCustomer.rows[0]
    if (found) return { id: found.id }
  }
  /* c8 ignore start — fallback path: every Mythrun-issued subscription
   * seeds users.stripe_customer_id before .created lands. */
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
  /* c8 ignore stop */
}

/**
 * Handler for `customer.subscription.created` AND `customer.subscription.updated`
 * (spec §5.4.3). Both events carry `event.data.object` as the Subscription
 * itself — no prefetch needed (no PREFETCHERS entry in webhook.ts).
 *
 * Step order:
 *   1. Resolve user (anchor-lock via FOR UPDATE per §5.3). Total miss → 'ok'.
 *   2. **Pending-update gate** (round-7): if `pending_update !== null`,
 *      log + return 'ok' WITHOUT writes.
 *   3. Multi-item guard → 'validation_failed' on count !== 1.
 *   4. Read tier_lookup_key + period dates + cancel fields + status.
 *   5. Call `userSubscriptions.upsertFromStripe`. The repo's strict-`>`
 *      `stripe_event_created_at` filter handles stale-event ordering
 *      (out-of-order delivery, redeliveries) atomically.
 *   6. Return 'ok'.
 *
 * Logger field shape mirrors §5.4.2's invoice handler so log queries can
 * pivot across handlers consistently.
 */
export async function handleSubscriptionUpsert(
  event: Stripe.Event,
  _prefetch: unknown,
  client: ClientLike,
  log: FastifyBaseLogger,
): Promise<HandlerResult> {
  const subscription = event.data.object as Stripe.Subscription
  const ids = subscriptionLogIds(event, subscription)

  // 1. Resolve user (FOR UPDATE anchor lock per §5.3).
  const user = await resolveUser(client, subscription)
  /* c8 ignore start — unknown_customer path: every Mythrun-issued
   * subscription is tied to a known users row. */
  if (!user) {
    log.info(ids, 'billing.subscription_unknown_customer')
    return 'ok'
  }
  /* c8 ignore stop */

  // 2. Pending-update gate (round-7 + research findings, spec §5.4.3 line
  //    647). FIRST check after user resolution — log + return BEFORE any
  //    DB writes when an in-flight upgrade hasn't settled yet.
  if (subscription.pending_update !== null) {
    const latestInvoice = subscription.latest_invoice
    /* c8 ignore start — defensive narrowing of latest_invoice union:
     * Stripe always sends a string id on pending-update events; the
     * embedded-object + null arms are defense-in-depth for shapes that
     * never arrive. */
    const latestInvoiceId =
      typeof latestInvoice === 'string'
        ? latestInvoice
        : latestInvoice && typeof latestInvoice === 'object'
          ? latestInvoice.id
          : null
    /* c8 ignore stop */
    log.info(
      {
        ...ids,
        pending_update_expires_at: subscription.pending_update.expires_at,
        latest_invoice_id: latestInvoiceId,
      },
      'billing.subscription_pending_update_visible',
    )
    return 'ok'
  }

  // 3. Multi-item guard (§3.1 note 1).
  if (subscription.items.data.length !== 1) {
    log.error(
      { ...ids, items_count: subscription.items.data.length },
      'billing.subscription_multi_item',
    )
    return 'validation_failed'
  }
  const item = subscription.items.data[0]
  /* c8 ignore start — Defensive: length === 1 check above guarantees
   * [0] exists; lookup_key is enforced by probe.ts for Mythrun-managed
   * subs. Both arms are defense-in-depth. */
  if (!item) {
    throw new Error(
      `customer.subscription.${event.type}: items.data[0] missing for sub=${subscription.id}`,
    )
  }
  const tierLookupKey = item.price.lookup_key
  if (typeof tierLookupKey !== 'string' || tierLookupKey.length === 0) {
    log.error({ ...ids, price_id: item.price.id }, 'billing.subscription_missing_lookup_key')
    return 'validation_failed'
  }
  /* c8 ignore stop */

  // 4. Upsert (idempotent + race-tolerant via the repo's strict-`>` filter).
  await userSubscriptions.upsertFromStripe(client, {
    id: uuidv7(),
    user_id: user.id,
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
