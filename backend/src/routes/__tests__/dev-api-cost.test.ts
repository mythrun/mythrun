// backend/src/routes/__tests__/dev-api-cost.test.ts
//
// The AUTH_MODE=bypass gate is the load-bearing property: the route answers 200
// with the running total ONLY under the dev bypass stack, and is ABSENT (404)
// under AUTH_MODE=real — which is what staging AND production boot. The route
// was previously gated on mythrunEnv!=='production', which left it registered
// on staging (mythrunEnv='staging', authMode='real'); the DevCostTicker widget
// saw 200s there and polled indefinitely (MYT-102 scout: 1723 polls). These
// tests pin that leak closed: `real` → 404, full stop.
//
// A standalone Fastify app (no auth plugins) is enough — the route is `public`,
// so the JWT/onboarding chain is irrelevant here. AUTH_MODE is stubbed per-test
// (the plugin reads process.env at register time, mirroring dev-credits.ts /
// dev-fire-turn.ts / dev-prep-prose.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { devApiCostRoutes } from '../dev-api-cost.js'
import { addCostUsd, _resetDevCostForTests } from '../../billing/dev-cost-tracker.js'

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(devApiCostRoutes)
  await app.ready()
  return app
}

describe('GET /api/dev/api-cost — AUTH_MODE=bypass gate', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => {
    _resetDevCostForTests()
  })

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    vi.unstubAllEnvs()
    _resetDevCostForTests()
  })

  it('bypass: 200 with the current running total', async () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    addCostUsd(0.5)
    addCostUsd(0.25)
    app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/api/dev/api-cost' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ totalUsd: 0.75 })
  })

  it('real: route is not registered → 404 (staging + production both boot real)', async () => {
    vi.stubEnv('AUTH_MODE', 'real')
    addCostUsd(9.99)
    app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/api/dev/api-cost' })
    expect(res.statusCode).toBe(404)
  })

  it('AUTH_MODE unset: route is not registered → 404 (gate fails closed)', async () => {
    vi.stubEnv('AUTH_MODE', '')
    addCostUsd(1.0)
    app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/api/dev/api-cost' })
    expect(res.statusCode).toBe(404)
  })
})
