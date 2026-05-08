import { describe, it, expect, beforeAll } from 'vitest'
import Stripe from 'stripe'

/**
 * Pre-ship empirical verification — `payment_behavior: 'pending_if_incomplete'`
 *
 * Per MYT-42 spec §3.1 note 9 (and Task 35 of the plan): trust-but-verify the
 * documented behavior of `pending_if_incomplete` against the live Stripe test
 * API. Historical Cashier issue #969 (closed) shipped a regression where
 * incomplete payments STILL advanced subscription items; the bug was fixed
 * upstream but our upgrade flow's correctness depends entirely on the fix
 * being in place at the SDK + API version we pin.
 *
 * What it verifies:
 * 1. `subscriptions.update({ payment_behavior: 'pending_if_incomplete', items: [{ id, price: <new_price> }], proration_behavior: 'always_invoice' })`
 *    against a customer whose default payment method is the Stripe test
 *    soft-decline card `4000000000000341` (insufficient_funds) returns a
 *    Subscription whose `pending_update` hash is POPULATED.
 * 2. The Subscription's `items.data[0].price.id` is STILL the OLD price —
 *    items did NOT advance.
 *
 * If either assertion fails, the upgrade flow's atomicity guarantee
 * evaporates — that's the entire point of `pending_if_incomplete`.
 *
 * Run conditions: requires `STRIPE_TEST_FULL_KEY` (an unrestricted
 * `sk_test_*` key). NOT `STRIPE_SECRET_KEY` — that's the production-shape
 * restricted key (`rk_*`) and per MYT-41 §1 it deliberately lacks
 * `rak_payment_method_write` (the prod app doesn't create PaymentMethods
 * server-side; tokenization happens client-side via Stripe.js + Checkout).
 * The verification has to create a test PaymentMethod on a fresh customer,
 * which needs the broader scope. Test-mode keys carry no production-data
 * risk; using the unrestricted shape here doesn't undermine the prod
 * contract.
 *
 * Skip-gates: without `STRIPE_TEST_FULL_KEY` the test is skipped so the
 * unit-test suite runs clean locally and in CI.
 *
 * Price IDs are looked up by lookup_key (`tier_wayfarer`, `tier_mythwright`)
 * so there's nothing to copy/paste.
 *
 * Cleanup: the test deletes the customer at the end (cascades to the
 * subscription + payment method). On failure, leftover customers may be
 * orphaned in the test-mode account — operator can prune via Dashboard.
 */

const RAW_KEY = process.env.STRIPE_TEST_FULL_KEY
const apiKey = typeof RAW_KEY === 'string' && RAW_KEY.startsWith('sk_test_') ? RAW_KEY : null

const describeMaybe = apiKey !== null ? describe : describe.skip

describeMaybe('pre-ship: payment_behavior pending_if_incomplete', () => {
  let stripe: Stripe
  let wayfarerId: string
  let mythwrightId: string

  beforeAll(async () => {
    if (apiKey === null) return
    stripe = new Stripe(apiKey, { apiVersion: '2026-04-22.dahlia' })

    const wayfarer = await stripe.prices.list({
      lookup_keys: ['tier_wayfarer'],
      active: true,
      limit: 1,
    })
    const mythwright = await stripe.prices.list({
      lookup_keys: ['tier_mythwright'],
      active: true,
      limit: 1,
    })

    const wId = wayfarer.data[0]?.id
    const mId = mythwright.data[0]?.id
    if (wId === undefined || mId === undefined) {
      throw new Error(
        'tier_wayfarer or tier_mythwright price not found on test-mode account; ' +
          'run the MYT-41 product/price Terraform against test-mode first',
      )
    }
    wayfarerId = wId
    mythwrightId = mId
  }, 30_000)

  it('returns Subscription with pending_update populated AND items NOT advanced on soft-decline card', async () => {
    let customerId: string | undefined

    try {
      const customer = await stripe.customers.create({
        description: 'MYT-42 Task 35 verification — pending_if_incomplete',
        metadata: { mythrun_test: 'pending_if_incomplete' },
      })
      customerId = customer.id

      // Stripe blocks raw PAN submission on Standard accounts. We use
      // Stripe-managed test PaymentMethod fixtures (https://docs.stripe.com/testing).
      //   - pm_card_visa            : succeeds at attach AND at charge
      //   - pm_card_chargeCustomerFail : succeeds at attach, declines at charge
      // The upgrade flow we're verifying needs the latter behavior on the
      // proration invoice to force pending_update population. We bootstrap
      // the subscription with the successful card so we have an `active`
      // sub on Wayfarer, then swap the default PM to the failing card just
      // before the upgrade call — mirroring the real-world scenario where
      // a customer's saved card later starts declining.
      const okPm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id })
      await stripe.customers.update(customer.id, {
        invoice_settings: { default_payment_method: okPm.id },
      })

      const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: wayfarerId }],
        payment_behavior: 'error_if_incomplete',
        expand: ['latest_invoice.payment_intent'],
      })

      expect(subscription.status).toBe('active')
      expect(subscription.items.data[0]?.price.id).toBe(wayfarerId)

      const itemId = subscription.items.data[0]?.id
      if (itemId === undefined) throw new Error('subscription created without items[0].id')

      // Swap to the will-decline-at-charge card.
      const failPm = await stripe.paymentMethods.attach('pm_card_chargeCustomerFail', {
        customer: customer.id,
      })
      await stripe.customers.update(customer.id, {
        invoice_settings: { default_payment_method: failPm.id },
      })

      // eslint-disable-next-line mythrun/no-stripe-subscription-price-mutation
      const updated = await stripe.subscriptions.update(subscription.id, {
        items: [{ id: itemId, price: mythwrightId }],
        payment_behavior: 'pending_if_incomplete',
        proration_behavior: 'always_invoice',
      })

      // Assertion 1: pending_update hash is populated
      // (Stripe SDK may type pending_update as nullable — runtime null is the failure.)
      expect(updated.pending_update).not.toBeNull()
      expect(updated.pending_update).toBeDefined()

      // Assertion 2: items DID NOT advance — still on the OLD price
      expect(updated.items.data[0]?.price.id).toBe(wayfarerId)
      expect(updated.items.data[0]?.price.id).not.toBe(mythwrightId)

      // Bonus: status should still be active (subscription is "split-brain
      // safe" — old tier still serving until payment lands).
      expect(['active', 'past_due']).toContain(updated.status)
    } finally {
      if (customerId !== undefined) {
        try {
          await stripe.customers.del(customerId)
        } catch {
          // Best-effort cleanup; orphan customers are operator-prunable.
        }
      }
    }
  }, 60_000)
})
