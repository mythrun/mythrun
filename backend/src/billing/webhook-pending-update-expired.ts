import type { Stripe } from 'stripe'
import type { EventHandler } from './webhook.js'

/**
 * Handler for `customer.subscription.pending_update_expired`.
 *
 * Per spec §5.4.6 — the upgrade-failure path. Stripe gave up after
 * ~23 hours of retry attempts. The associated invoice is voided by
 * Stripe; the subscription's pending_update hash is cleared and items
 * remain on the OLD tier (because pending_if_incomplete blocks
 * item-advance until payment lands).
 *
 * Handler responsibilities:
 * - Resolve user (informational only — used for the log line).
 * - Log INFO `billing.upgrade_expired` with the relevant IDs. NOT
 *   paging-grade — this is an expected outcome of a card decline +
 *   user not updating their payment method within 23h.
 * - **No DB writes.** Stripe didn't change items; we didn't either.
 *   No tier change, no billing_history row. Stripe voided the
 *   invoice; nothing to record.
 *
 * Optional follow-up bead: surface a notification to the user
 * ("your upgrade attempt expired; please retry"). Out of scope for
 * MYT-42 — the user can simply re-click "Upgrade" and the §4.6
 * route re-runs cleanly.
 */
export const handlePendingUpdateExpired: EventHandler = async (event, _prefetch, _client, log) => {
  const sub = event.data.object as Stripe.Subscription

  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
  const latestInvoiceId =
    typeof sub.latest_invoice === 'string'
      ? sub.latest_invoice
      : (sub.latest_invoice?.id ?? null)
  const targetTierLookupKey = sub.items.data[0]?.price.lookup_key ?? null

  log.info(
    {
      event_id: event.id,
      subscription_id: sub.id,
      customer_id: customerId,
      latest_invoice_id: latestInvoiceId,
      target_tier_lookup_key: targetTierLookupKey,
    },
    'billing.upgrade_expired',
  )

  return 'ok'
}
