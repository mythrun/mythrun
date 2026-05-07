/**
 * Thin re-export shell for the Stripe-customer find-or-create helper.
 *
 * Per spec §3 line 66, this module exists as the public entry point for
 * checkout + portal route handlers. The actual three-phase prefetch-then-
 * write implementation lives in `repo.users.findOrCreateStripeCustomer`
 * (see Task 7 / spec §9).
 *
 * Route handlers should import from THIS module, not directly from
 * `../repo/users.js` — the indirection lets us swap the implementation
 * (e.g., wrap with telemetry, add a mock for tests) without touching
 * every consumer.
 */
export {
  findOrCreateStripeCustomer,
  type StripeCustomersClient,
} from '../repo/users.js'
