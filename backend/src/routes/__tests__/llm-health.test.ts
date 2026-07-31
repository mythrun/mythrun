// backend/src/routes/__tests__/llm-health.test.ts
//
// GET /api/llm-health (llm-outage-resilience §4.1): public, one tracker read,
// EXACTLY `{state: 'ok'|'degraded', since: number|null}` — the frontend zod
// schema in client-core/src/api/llm-health.ts pins this shape, and any drift
// there turns into a ContractValidationError the strip reads as "ok" (a silent
// outage-notice outage). The route test is the backend half of that pin.

import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerLlmHealthRoute } from '../llm-health.js'
import type { LlmHealthState, LlmHealthTracker } from '../../llm/llm-health.js'
import { makeStubDeps } from '../../__tests__/helpers/stub-deps.js'

/** Shape-only tracker whose read() resolves the given state. The probe-side
 *  methods are never reached by the route — plain resolved stubs satisfy the
 *  interface. The read spy is returned ALONGSIDE the tracker (never plucked
 *  off it — @typescript-eslint/unbound-method) so tests can assert call
 *  counts. */
function stubTracker(state: LlmHealthState): {
  tracker: LlmHealthTracker
  read: ReturnType<typeof vi.fn<() => Promise<LlmHealthState>>>
} {
  const read = vi.fn(() => Promise.resolve(state))
  return {
    tracker: {
      report: () => Promise.resolve(),
      read,
      readModels: () => Promise.resolve([]),
      probeSuccess: () => Promise.resolve('counting' as const),
      probeFailure: () => Promise.resolve(),
      markPromotePending: () => Promise.resolve(),
      clearPromotePending: () => Promise.resolve(),
      hasPromotePending: () => Promise.resolve(false),
    },
    read,
  }
}

async function buildApp(tracker?: LlmHealthTracker): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const deps = makeStubDeps()
  if (tracker !== undefined) deps.llmHealthTracker = tracker
  registerLlmHealthRoute(app, deps)
  await app.ready()
  return app
}

let app: FastifyInstance | undefined

afterEach(async () => {
  if (app) await app.close()
  app = undefined
})

describe('GET /api/llm-health', () => {
  it('returns 200 {state: "ok", since: null} while healthy — exactly the two-field shape', async () => {
    const { tracker, read } = stubTracker({ state: 'ok', since: null })
    app = await buildApp(tracker)

    const res = await app.inject({ method: 'GET', url: '/api/llm-health' })
    expect(res.statusCode).toBe(200)
    // toEqual pins the WHOLE payload (no extra fields): the frontend schema
    // parse is strict about the two keys it validates.
    expect(res.json()).toEqual({ state: 'ok', since: null })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('returns 200 {state: "degraded", since: <ms>} while degraded', async () => {
    app = await buildApp(stubTracker({ state: 'degraded', since: 1_722_300_000_000 }).tracker)

    const res = await app.inject({ method: 'GET', url: '/api/llm-health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ state: 'degraded', since: 1_722_300_000_000 })
  })

  it('opts out of auth via config.auth public (mirrors /health/ready)', async () => {
    // The bare-Fastify harness registers no auth hook, so pin the declarative
    // marker itself: capture the route's config through onRoute — the same
    // object the auth plugin's bypass reads in the full app.
    const fastify = Fastify({ logger: false })
    let capturedAuth: unknown
    fastify.addHook('onRoute', (route) => {
      if (route.url === '/api/llm-health') {
        capturedAuth = (route.config as { auth?: unknown } | undefined)?.auth
      }
    })
    const deps = makeStubDeps()
    deps.llmHealthTracker = stubTracker({ state: 'ok', since: null }).tracker
    registerLlmHealthRoute(fastify, deps)
    await fastify.ready()
    app = fastify
    expect(capturedAuth).toBe('public')
  })

  it('returns 503 llm_health_unavailable when no tracker is injected (boot-gate-off fallback)', async () => {
    // The boot-gate-disabled binary (and bare test harnesses) carry no
    // tracker; the route fails loud with a typed 503 — which the frontend's
    // positive-assertion-only hook degrades to "ok" (no strip off local
    // noise). Mirrors the characterCreationQueue 503 'queue_not_ready'
    // posture.
    app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/api/llm-health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: 'llm_health_unavailable' })
  })
})
