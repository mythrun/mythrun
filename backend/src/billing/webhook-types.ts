// backend/src/billing/webhook-types.ts
//
// Shared types between the dispatcher (webhook.ts) and the per-event-type
// handlers (e.g. webhook-checkout-payment.ts). Lives in its own file to
// avoid a circular import: webhook.ts imports the handler functions, and
// the handlers need the result-sentinel type.

/**
 * Handler return contract per spec §5.3 (Petra C2 round 5).
 *   - `'ok'`: COMMIT all writes (stripe_events row + handler's writes).
 *   - `'validation_failed'`: COMMIT only the stripe_events row so Stripe
 *     stops retrying; the dispatcher logs the sentinel pattern. Distinct
 *     from throwing, which ROLLBACKs (Stripe redelivers) and re-throws so
 *     the route returns 5xx.
 */
export type HandlerResult = 'ok' | 'validation_failed'
