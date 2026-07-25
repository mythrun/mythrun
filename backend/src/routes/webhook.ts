// backend/src/routes/webhook.ts
//
// MYT-42 Task 15. Encapsulated Fastify plugin hosting the single Stripe
// webhook route. The raw-body parser lives INSIDE this plugin so it stays
// scoped to the child encapsulation context — Fastify v5's
// `addContentTypeParser` is encapsulation-scoped, NOT route-scoped, so
// installing it on the top-level `app` would replace the JSON parser
// for every route in the system. See spec §5.1 lines 341–365.
//
// Per Stilton C1 round 3 (cited in spec §5.1): Fastify v5 INHERITS the
// parent's default 'application/json' parser into child contexts. We must
// `removeContentTypeParser('application/json')` first, then register the
// buffer-pass-through, otherwise app.ready() throws
// FST_ERR_CTP_ALREADY_PRESENT.
//
// Signature verification calls Stripe's `constructEvent`, which fails
// closed against any non-`whsec_*`-shaped secret — including the literal
// 'PLACEHOLDER' value accepted at boot per the MYT-41 → MYT-42 window.
// No bypass branch.

import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'
import type { Stripe } from 'stripe'
import type { Env } from '../config/env.js'
import { getStripeClient } from '../billing/stripe-client.js'
import { billingError } from '../billing/errors.js'
import { dispatchEvent } from '../billing/webhook.js'

export interface WebhookRoutesOpts {
  readonly pool: Pool
  readonly env: Env
}

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (route registration is synchronous), so the rule is
// disabled here per existing precedent in routes/users.ts.
export const webhookRoutes: FastifyPluginAsync<WebhookRoutesOpts> =
  // eslint-disable-next-line @typescript-eslint/require-await
  async (scope, opts) => {
    // Encapsulation-scoped parser. removeContentTypeParser on the inherited
    // default JSON parser FIRST, then register the buffer pass-through.
    scope.removeContentTypeParser('application/json')
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: 256 * 1024 },
      (_req, body, done) => {
        done(null, body)
      },
    )

    scope.post(
      '/webhooks/stripe',
      {
        config: {
          auth: 'public',
          rateLimit: { max: 1500, timeWindow: '1 minute' },
        },
      },
      async (request, reply) => {
        // 1. Signature header gate.
        const sig = request.headers['stripe-signature']
        if (!sig || typeof sig !== 'string') {
          return reply.code(400).send(billingError('missing_signature'))
        }

        // 2. Defense-in-depth: assert the parser delivered a Buffer. If a
        // future refactor accidentally drops the encapsulated parser
        // registration, request.body would be a parsed object — which would
        // (a) leak secrets via JSON-canonicalization mismatch on the HMAC
        // and (b) silently undermine signature verification. Fail loudly
        // instead of silently calling constructEvent on a non-Buffer.
        if (!Buffer.isBuffer(request.body)) {
          request.log.error({ bodyType: typeof request.body }, 'webhook_parser_misconfigured')
          return reply.code(500).send(billingError('internal'))
        }
        const rawBody: Buffer = request.body

        // 3. Stripe SDK client (cached at module level).
        const stripe = getStripeClient(opts.env)

        // 4. Verify signature. constructEvent throws on any mismatch; we
        // log only `err.message` and `err.type` (per Ephesus I6 round 7
        // redaction concern: dumping the full err object would log the
        // offending signature value). Returns 400 with the
        // 'invalid_signature' billing error code so Stripe's redelivery
        // dashboard surfaces the rejection cleanly.
        let event: Stripe.Event
        try {
          event = stripe.webhooks.constructEvent(rawBody, sig, opts.env.stripeWebhookSecret)
        } catch (err) {
          /* c8 ignore start — `String(err)` arm fires for non-Error
           * rejections; Stripe SDK's constructEvent always throws
           * a StripeSignatureVerificationError subclass of Error. */
          const message = err instanceof Error ? err.message : String(err)
          /* c8 ignore stop */
          const errType =
            typeof err === 'object' && err !== null && 'type' in err
              ? (err as { type?: unknown }).type
              : undefined
          request.log.warn({ err: { message, type: errType } }, 'stripe_webhook_signature_invalid')
          return reply.code(400).send(billingError('invalid_signature'))
        }

        // 5. Dispatch (Task 16 fills in the stub body).
        await dispatchEvent(event, stripe, opts.pool, request.log)

        // 6. Acknowledge.
        return reply.code(200).send({ received: true })
      },
    )
  }
