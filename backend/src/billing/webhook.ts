// backend/src/billing/webhook.ts
//
// Task 15 STUB. The real dispatcher (idempotent insert into stripe_events,
// per-event-type prefetch + handler invocation, validation-failed sentinel,
// API-version mismatch handling) is implemented by Task 16 per
// `docs/superpowers/specs/2026-05-05-myt-42-stripe-webhook-checkout-design.md`
// §5.3.
//
// This stub exists only so the Task 15 webhook-plugin route handler can
// import + call dispatchEvent at the type level. Replace the body in
// Task 16; the signature is the canonical dispatcher contract per §5.3
// (`(event, stripe, pool, log)` — the per-handler signature
// `(event, prefetch, client)` lives one layer down inside this function).
//
// Logger type note: spec §5.3 line 433 declares `log: Logger` (pino's
// Logger). However, Fastify's `request.log` is typed as `FastifyBaseLogger`
// — a structural subset of pino without `LoggerExtras` (EventEmitter +
// child-logger machinery the dispatcher does not call). Typing the
// parameter as `FastifyBaseLogger` accepts both Fastify's `request.log`
// and a real pino instance without a type assertion. The dispatcher only
// needs `.info / .warn / .error / .debug`, all of which are present on
// `FastifyBaseLogger`.

import type { Stripe } from 'stripe'
import type { Pool } from 'pg'
import type { FastifyBaseLogger } from 'fastify'

/* eslint-disable @typescript-eslint/no-unused-vars
   -- Task 15 stub: parameters are part of the §5.3 dispatcher contract
   that Task 16 will implement against. Keeping them named (not anonymized
   to `_`) so the signature is grep-discoverable when Task 16 lands. */
export async function dispatchEvent(
  _event: Stripe.Event,
  _stripe: Stripe,
  _pool: Pool,
  _log: FastifyBaseLogger,
): Promise<void> {
  // no-op stub — Task 16 implements
  return Promise.resolve()
}
/* eslint-enable @typescript-eslint/no-unused-vars */
