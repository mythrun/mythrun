// backend/src/billing/webhook-subscription-deleted.ts
//
// Handler for `customer.subscription.deleted` per MYT-42 spec §5.4.4
// (Task 21). Extracted from webhook.ts to keep that module under the
// 400-line cap.
//
// Key invariants:
//   - **No PREFETCHERS entry**: `event.data.object` IS the Subscription
//     object. No Stripe API call needed.
//
//   - **User resolution** mirrors the §5.4.3 pattern in
//     webhook-subscription-upsert.ts: resolve via `event.data.object.customer`
//     → `users.stripe_customer_id` (anchor-lock FOR UPDATE per §5.3 discipline);
//     on miss, fall back to `event.data.object.metadata.userId`. Total miss →
//     log INFO `billing.subscription_unknown_customer` + return 'ok'.
//
//   - **cancel_at_period_end PRESERVED** (Kraken C3 round 2): the `.deleted`
//     event fires for BOTH user-initiated (Cancel at period end, then the
//     period ends) and Stripe-initiated (dunning, `reason='payment_failed'`)
//     cancellations. Collapsing `cancel_at_period_end` to `false` on `.deleted`
//     destroys the user-vs-Stripe-cancel distinction needed for differential UX,
//     re-subscribe prompts, refund decisioning, and churn analytics. Write the
//     value exactly as it arrives.
//
//   - **No credit_ledger writes** (§3.3 + §10): existing credits remain
//     consumable through natural `expires_at` (`current_period_end`). The user
//     paid for the period; no retroactive expiry on cancellation.
//
//   - **No-row-matched path**: if `markCanceled` returns 0 (Stripe-side test
//     event, deleted user, deletion-before-creation race), log INFO
//     `billing.subscription_deleted_unknown_id` + return 'ok' so the
//     dispatcher COMMITs the `stripe_events` row and Stripe stops retrying.

import type { Stripe } from 'stripe'
import type { FastifyBaseLogger } from 'fastify'
import type { ClientLike } from '../repo/_types.js'
import { userSubscriptions } from '../repo/user-subscriptions.js'
import type { HandlerResult } from './webhook-types.js'

interface SubscriptionDeletedLogIds {
  readonly event_id: string
  readonly subscription_id: string
  readonly customer: string | null
  readonly metadata_user_id: string | null
}

function deletedLogIds(
  event: Stripe.Event,
  subscription: Stripe.Subscription,
): SubscriptionDeletedLogIds {
  const customer =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
  const metadataUserId = subscription.metadata.userId
  return {
    event_id: event.id,
    subscription_id: subscription.id,
    customer,
    metadata_user_id:
      typeof metadataUserId === 'string' && metadataUserId.length > 0 ? metadataUserId : null,
  }
}

/**
 * Resolve the user via `subscription.customer` → `users.stripe_customer_id`
 * (FOR UPDATE — anchor lock per §5.3). On miss, fall back to
 * `subscription.metadata.userId`. Returns `null` on total miss — caller logs
 * INFO and returns 'ok'.
 *
 * Mirrors `resolveUser` in webhook-subscription-upsert.ts; extracted here
 * for clarity since the deleted handler has no other shared state with the
 * upsert handler.
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
 * Handler for `customer.subscription.deleted` (spec §5.4.4).
 *
 * `event.data.object` is the Subscription object at deletion time — no
 * PREFETCHERS entry needed.
 *
 * Step order:
 *   1. Resolve user (anchor-lock via FOR UPDATE per §5.3). Total miss → 'ok'.
 *   2. Call `userSubscriptions.markCanceled` with `cancel_at_period_end`
 *      PRESERVED from the payload (Kraken C3 round 2).
 *   3. If rowcount = 0 (no row matched): log INFO
 *      `billing.subscription_deleted_unknown_id` + return 'ok'.
 *   4. Return 'ok'.
 *
 * credit_ledger is never touched (§3.3 + §10 — no retroactive expiry).
 */
export async function handleSubscriptionDeleted(
  event: Stripe.Event,
  _prefetch: unknown,
  client: ClientLike,
  log: FastifyBaseLogger,
): Promise<HandlerResult> {
  const subscription = event.data.object as Stripe.Subscription
  const ids = deletedLogIds(event, subscription)

  // 1. Resolve user (FOR UPDATE anchor lock per §5.3).
  const user = await resolveUser(client, subscription)
  if (!user) {
    log.info(ids, 'billing.subscription_unknown_customer')
    return 'ok'
  }

  // 2. Mark canceled — preserves cancel_at_period_end as-is per Kraken C3
  //    round 2. The user row anchor lock was already acquired in step 1, so
  //    the §5.3 anchor-lock-first discipline is satisfied.
  const rowsUpdated = await userSubscriptions.markCanceled(client, subscription.id, {
    cancel_at_period_end: subscription.cancel_at_period_end,
    cancel_at: subscription.cancel_at,
    cancellation_details: subscription.cancellation_details,
  })

  // 3. No row matched (Stripe-side test event, deleted user, or
  //    deletion-before-creation race). Log INFO + return 'ok' so the dispatcher
  //    COMMITs the stripe_events row and Stripe stops retrying.
  if (rowsUpdated === 0) {
    log.info({ ...ids, user_id: user.id }, 'billing.subscription_deleted_unknown_id')
    return 'ok'
  }

  return 'ok'
}
