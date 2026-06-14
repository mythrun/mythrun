// backend/src/routes/__tests__/webhook-edge.test.ts
//
// Edge-case tests for routes/webhook.ts that the primary webhook.test.ts
// doesn't reach:
//   - Line 71-74 webhook_parser_misconfigured (request.body not a Buffer)
//   - Line 91-94 errType=undefined fallback when constructEvent throws a
//     plain Error (no `type` property on the thrown value).
//
// These are defense-in-depth paths so we drive them by mocking
// getStripeClient at the module boundary and (for the Buffer branch) by
// re-registering an inner content-type parser that delivers an object.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import type { Env } from '../../config/env.js'
import { webhookRoutes } from '../webhook.js'

// Mock the dispatcher at the import boundary — same as webhook.test.ts.
vi.mock('../../billing/webhook.js', () => ({
  dispatchEvent: vi.fn(() => Promise.resolve()),
}))

// Mock the Stripe client so we can control constructEvent's throw shape.
vi.mock('../../billing/stripe-client.js', () => ({
  getStripeClient: vi.fn(),
}))

import { getStripeClient } from '../../billing/stripe-client.js'

const mockedGetStripeClient = vi.mocked(getStripeClient)

function buildEnv(): Env {
  return Object.freeze({
    databaseUrl: 'postgresql://stub/db',
    redisRealtimeUrl: 'redis://stub:6379',
    redisBatchUrl: 'redis://stub:6379',
    redisKeyPrefix: 'test:use1:',
    mythrunEnv: 'development',
    port: 0,
    authMode: 'bypass',
    frontendBaseUrl: 'http://localhost:5173',
    stripeSecretKey: 'rk_test_stub',
    stripeWebhookSecret: 'whsec_test_stub',
    anthropicApiKey: 'sk-ant-stub',
    voyageApiKey: 'pa-stub',
  })
}

function stubPool(): Pool {
  return {} as unknown as Pool
}

describe('webhookRoutes — defensive edge cases', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    app = undefined
  })

  afterEach(async () => {
    if (app) await app.close()
  })

  it('returns 400 invalid_signature when constructEvent throws an Error without a `type` property (errType=undefined branch)', async () => {
    // Force constructEvent to throw a plain Error — no `type` field on the
    // thrown value. Hits the `errType = undefined` fallback at line 94.
    const stripeStub = {
      webhooks: {
        constructEvent: (): never => {
          // A literal Error instance — `'type' in err` is false because
          // Error has no 'type' enumerable property by default.
          throw new Error('boom-no-type-field')
        },
      },
    }
    mockedGetStripeClient.mockReturnValue(stripeStub as unknown as ReturnType<typeof getStripeClient>)

    app = Fastify({ logger: false })
    await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
    await app.register(webhookRoutes, { pool: stubPool(), env: buildEnv() })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: '{}',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=1700000000,v1=deadbeef',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ code: 'invalid_signature' })
  })

  it('returns 500 internal when the upstream parser delivers a non-Buffer body (defensive line 71-74)', async () => {
    // To exercise the Buffer.isBuffer guard, register the webhook plugin in
    // a way that bypasses its encapsulated parser. We do this by registering
    // a NEW content-type parser AFTER webhookRoutes has been mounted, at the
    // same encapsulation scope — Fastify will use the outer JSON parser for
    // the child context if we manually re-register at the root before child
    // ready completes. Simpler: register webhookRoutes through a child that
    // re-overrides the parser to return a parsed object.
    //
    // We achieve this by registering a sibling content-type parser at the
    // parent app scope (NOT inside webhookRoutes' encapsulation) that runs
    // FIRST. But Fastify v5 inherits parent's parser into children; since
    // webhookRoutes removes its own then registers buffer-passthrough, our
    // approach: register the webhookRoutes plugin, then directly overwrite
    // the buffer parser at the same encapsulation by re-registering JSON
    // (passing object) inside the plugin context.
    //
    // Cleanest path: build a tiny Fastify app whose ONLY parser is JSON →
    // object, mount the route HANDLER manually (replicating the route's
    // body), pass the body as object. But that doesn't exercise the real
    // webhookRoutes code. Instead, we add a preHandler that overwrites
    // request.body with an object before the handler runs.
    app = Fastify({ logger: false })
    await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
    await app.register(webhookRoutes, { pool: stubPool(), env: buildEnv() })

    // Hook fires before the route handler — overwrite request.body so
    // Buffer.isBuffer returns false. The webhookRoutes context is
    // encapsulated, so this hook can only attach AFTER ready; use
    // `addHook` on the root app which propagates to children via the
    // plugin tree.
    app.addHook('preHandler', (request, _reply, done) => {
      if (request.url === '/webhooks/stripe') {
        // Replace the parsed Buffer with a plain object to hit the
        // defensive Buffer.isBuffer false branch.
        ;(request as unknown as { body: unknown }).body = { not: 'a-buffer' }
      }
      done()
    })

    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: '{}',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=1700000000,v1=deadbeef',
      },
    })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ code: 'internal' })
  })
})
