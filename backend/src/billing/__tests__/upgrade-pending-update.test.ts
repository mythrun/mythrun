import { describe, it, expect } from 'vitest'
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
 * What this verifies:
 * 1. `subscriptions.update({ payment_behavior: 'pending_if_incomplete', items: [{ id, price: <new_price> }], proration_behavior: 'always_invoice' })`
 *    against a customer whose default payment method is the Stripe test
 *    soft-decline card `4000000000000341` (insufficient_funds) returns a
 *    Subscription whose `pending_update` hash is POPULATED.
 * 2. The Subscription's `items.data[0].price.id` is STILL the OLD price —
 *    items did NOT advance.
 *
 * If either assertion fails, STOP and surface to Miklos before shipping.
 * The upgrade flow's atomicity guarantee evaporates if items advance on
 * decline — that's the entire point of `pending_if_incomplete`.
 *
 * Skip gating: requires `STRIPE_TEST_API_KEY`, `STRIPE_TEST_WAYFARER_PRICE_ID`,
 * `STRIPE_TEST_MYTHWRIGHT_PRICE_ID` env vars. Without them, the test is
 * skipped (so the unit-test suite runs clean in CI / local without secrets).
 *
 * Manual run:
 *   STRIPE_TEST_API_KEY=rk_test_... \
 *   STRIPE_TEST_WAYFARER_PRICE_ID=price_... \
 *   STRIPE_TEST_MYTHWRIGHT_PRICE_ID=price_... \
 *   pnpm vitest run src/billing/__tests__/upgrade-pending-update.test.ts
 *
 * Cleanup: the test deletes the customer at the end (which cascades to the
 * subscription + payment method). On failure, leftover customers may be
 * orphaned in the test-mode account — Miklos can prune them via Dashboard.
 */

const TEST_API_KEY = process.env['STRIPE_TEST_API_KEY']
const WAYFARER_PRICE_ID = process.env['STRIPE_TEST_WAYFARER_PRICE_ID']
const MYTHWRIGHT_PRICE_ID = process.env['STRIPE_TEST_MYTHWRIGHT_PRICE_ID']

const SHOULD_RUN =
  typeof TEST_API_KEY === 'string' &&
  TEST_API_KEY.startsWith('rk_test_') &&
  typeof WAYFARER_PRICE_ID === 'string' &&
  WAYFARER_PRICE_ID.length > 0 &&
  typeof MYTHWRIGHT_PRICE_ID === 'string' &&
  MYTHWRIGHT_PRICE_ID.length > 0

const describeMaybe = SHOULD_RUN ? describe : describe.skip

describeMaybe('pre-ship: payment_behavior pending_if_incomplete', () => {
  it('returns Subscription with pending_update populated AND items NOT advanced on soft-decline card', async () => {
    if (!SHOULD_RUN) return

    const stripe = new Stripe(TEST_API_KEY!, {
      apiVersion: '2026-04-22.dahlia',
    })

    let customerId: string | undefined

    try {
      const customer = await stripe.customers.create({
        description: 'MYT-42 Task 35 verification — pending_if_incomplete',
        metadata: { mythrun_test: 'pending_if_incomplete' },
      })
      customerId = customer.id

      const paymentMethod = await stripe.paymentMethods.create({
        type: 'card',
        card: {
          number: '4000000000000341',
          exp_month: 12,
          exp_year: new Date().getFullYear() + 2,
          cvc: '123',
        },
      })
      await stripe.paymentMethods.attach(paymentMethod.id, { customer: customer.id })
      await stripe.customers.update(customer.id, {
        invoice_settings: { default_payment_method: paymentMethod.id },
      })

      const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: WAYFARER_PRICE_ID! }],
        payment_behavior: 'error_if_incomplete',
        expand: ['latest_invoice.payment_intent'],
      })

      expect(subscription.status).toBe('active')
      expect(subscription.items.data[0]?.price.id).toBe(WAYFARER_PRICE_ID)

      const itemId = subscription.items.data[0]?.id
      expect(itemId).toBeTruthy()

      const updated = await stripe.subscriptions.update(subscription.id, {
        items: [{ id: itemId!, price: MYTHWRIGHT_PRICE_ID! }],
        payment_behavior: 'pending_if_incomplete',
        proration_behavior: 'always_invoice',
      })

      // Assertion 1: pending_update hash is populated
      // (Stripe SDK may type pending_update as nullable — runtime null is the failure.)
      expect(updated.pending_update).not.toBeNull()
      expect(updated.pending_update).toBeDefined()

      // Assertion 2: items DID NOT advance — still on the OLD price
      expect(updated.items.data[0]?.price.id).toBe(WAYFARER_PRICE_ID)
      expect(updated.items.data[0]?.price.id).not.toBe(MYTHWRIGHT_PRICE_ID)

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
