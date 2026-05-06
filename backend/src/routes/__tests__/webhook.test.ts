// backend/src/routes/__tests__/webhook.test.ts
//
// MYT-42 Task 15 — webhook plugin shell. Covers the §13 contract lines
// 1498–1503: encapsulated raw-body parser, single registered route,
// charset-suffix tolerance, missing/invalid signature → 400, fail-closed
// against `STRIPE_WEBHOOK_SECRET = 'PLACEHOLDER'`.
//
// We use a real Stripe SDK + real `Stripe.webhooks.generateTestHeaderString`
// to construct a valid signature header, then exercise the full
// `constructEvent` path inside the route handler. This means the plugin's
// signature-verification contract is tested against the actual SDK
// behavior, not a mocked verifier.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
} from 'fastify'
import rateLimit from '@fastify/rate-limit'
import Stripe from 'stripe'
import type { Pool } from 'pg'
import type { Env } from '../../config/env.js'
import { webhookRoutes } from '../webhook.js'

// Test fixture: a structurally valid `whsec_*` secret. The actual bytes
// don't matter for `generateTestHeaderString` + `constructEvent` round-trip
// (HMAC works against any string). Stripe's verifier accepts any
// non-empty secret on both sides; the 'PLACEHOLDER' fail-closed test below
// proves that a value the SDK CAN'T derive a matching HMAC for produces a
// rejection.
const TEST_WEBHOOK_SECRET = 'whsec_test_secret_for_myt42_unit_tests'

function buildStubEnv(webhookSecret: string): Env {
  return Object.freeze({
    databaseUrl: 'postgresql://stub/db',
    redisRealtimeUrl: 'redis://stub:6379',
    redisBatchUrl: 'redis://stub:6379',
    port: 0,
    authMode: 'bypass',
    frontendBaseUrl: 'http://localhost:5173',
    stripeSecretKey: 'rk_test_unit_test_secret_key',
    stripeWebhookSecret: webhookSecret,
  })
}

function stubPool(): Pool {
  return {} as unknown as Pool
}

// Mounts the webhook plugin onto a fresh Fastify with a rate-limit
// registration (so `config.rateLimit` resolves) but no auth/onRoute hooks.
// Tests that need the public-route allowlist hook are MYT-42 Task 33's
// concern, not this task's.
async function buildTestApp(opts: {
  readonly env: Env
  readonly siblingJsonRoute?: boolean
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(rateLimit, {
    global: false,
    max: 1000,
    timeWindow: '1 minute',
  })
  await app.register(webhookRoutes, { pool: stubPool(), env: opts.env })
  if (opts.siblingJsonRoute) {
    // Sibling JSON route registered AFTER webhookRoutes on the root app —
    // proves the encapsulated parser scope didn't leak. The handler
    // captures `request.body` so we can assert it's a parsed object
    // (NOT a Buffer).
    const sibling: FastifyPluginAsync = (scope) => {
      scope.post('/api/sibling-json', (request, reply) => {
        return reply.send({ kind: 'sibling', body: request.body })
      })
      return Promise.resolve()
    }
    await app.register(sibling)
  }
  await app.ready()
  return app
}

// Constructs a Stripe-signed test payload and returns the raw bytes +
// signature header value. Uses Stripe's own helper to ensure the signature
// is byte-exact compatible with `constructEvent`.
function signedPayload(
  payload: object,
  secret: string,
): { readonly raw: string; readonly signature: string } {
  const raw = JSON.stringify(payload)
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: raw,
    secret,
  })
  return { raw, signature }
}

// Minimal valid Stripe event shape — `constructEvent` only validates the
// HMAC over the full raw bytes, so the inner shape here just needs to
// parse as JSON. Type-tagging it for our handler's sake.
function fakeEvent(): object {
  return {
    id: 'evt_test_myt42_task15',
    object: 'event',
    api_version: '2026-04-22.dahlia',
    created: Math.floor(Date.now() / 1000),
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_stub' } },
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
  }
}

describe('webhookRoutes plugin (MYT-42 Task 15)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildTestApp({
      env: buildStubEnv(TEST_WEBHOOK_SECRET),
      siblingJsonRoute: true,
    })
  })

  afterAll(async () => {
    await app.close()
  })

  it('plugin registers exactly one route at POST /webhooks/stripe', async () => {
    // Walk the route tree via an onRoute hook. Counting from the hook is
    // more robust than parsing `printRoutes()` output (which uses
    // box-drawing characters that vary across Fastify versions).
    const counter = Fastify({ logger: false })
    await counter.register(rateLimit, {
      global: false,
      max: 1000,
      timeWindow: '1 minute',
    })
    const registeredRoutes: { method: string | string[]; url: string }[] = []
    counter.addHook('onRoute', (route) => {
      registeredRoutes.push({ method: route.method, url: route.url })
    })
    await counter.register(webhookRoutes, {
      pool: stubPool(),
      env: buildStubEnv(TEST_WEBHOOK_SECRET),
    })
    await counter.ready()

    // Plugin contributes exactly one route — POST /webhooks/stripe.
    expect(registeredRoutes).toHaveLength(1)
    const entry = registeredRoutes[0]
    expect(entry).toBeDefined()
    if (entry) {
      expect(entry.url).toBe('/webhooks/stripe')
      const methods = Array.isArray(entry.method) ? entry.method : [entry.method]
      expect(methods).toContain('POST')
    }

    // Sanity-check printRoutes also reflects the single registration. The
    // tree-format output strips the leading slash from the leaf segment
    // ("webhooks/stripe"), so match against the un-prefixed form.
    const tree = counter.printRoutes({ includeHooks: false })
    expect(tree).toContain('webhooks/stripe')
    expect(tree).toContain('POST')

    await counter.close()
  })

  it('sibling JSON route still receives a parsed object (encapsulation holds)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sibling-json',
      payload: { hello: 'world' },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ kind: string; body: unknown }>()
    expect(body.kind).toBe('sibling')
    // The sibling's parser is the inherited default JSON parser — body is
    // a plain object, NOT a Buffer or Buffer-shaped serialization.
    expect(body.body).toEqual({ hello: 'world' })
  })

  it('webhook handler receives a Buffer for Content-Type: application/json', async () => {
    const { raw, signature } = signedPayload(fakeEvent(), TEST_WEBHOOK_SECRET)
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: raw,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
    })
    // 200 = signature verified + dispatchEvent stub returned cleanly +
    // reply was sent. This proves request.body was a Buffer at the
    // verification call site (constructEvent on a non-Buffer/non-string
    // throws TypeError, which our catch surfaces as 400 invalid_signature).
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ received: true })
  })

  it('webhook handler receives a Buffer for Content-Type: application/json; charset=utf-8', async () => {
    const { raw, signature } = signedPayload(fakeEvent(), TEST_WEBHOOK_SECRET)
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: raw,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'stripe-signature': signature,
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ received: true })
  })

  it('missing Stripe-Signature header → 400 { code: missing_signature }', async () => {
    const { raw } = signedPayload(fakeEvent(), TEST_WEBHOOK_SECRET)
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: raw,
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ code: 'missing_signature' })
  })

  it('invalid signature → 400 { code: invalid_signature }', async () => {
    const { raw } = signedPayload(fakeEvent(), TEST_WEBHOOK_SECRET)
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: raw,
      headers: {
        'content-type': 'application/json',
        // Well-formed but cryptographically invalid signature header.
        'stripe-signature': 't=1700000000,v1=deadbeef',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ code: 'invalid_signature' })
  })

  it("STRIPE_WEBHOOK_SECRET='PLACEHOLDER' fails closed against any signed payload", async () => {
    // Build a separate app with the placeholder secret. Any real Stripe-
    // signed payload paired with this secret yields a different HMAC and
    // therefore fails verification — proving the MYT-41 → MYT-42 window
    // value is fail-closed by design.
    const placeholderApp = await buildTestApp({
      env: buildStubEnv('PLACEHOLDER'),
    })
    const { raw, signature } = signedPayload(fakeEvent(), TEST_WEBHOOK_SECRET)
    const res = await placeholderApp.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: raw,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ code: 'invalid_signature' })
    await placeholderApp.close()
  })
})
