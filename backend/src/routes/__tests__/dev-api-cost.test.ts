// backend/src/routes/__tests__/dev-api-cost.test.ts
//
// The never-prod gate is the load-bearing property: the route answers 200 with
// the running total under mythrunEnv 'development'/'staging', and is ABSENT
// (404) under 'production'. A standalone Fastify app (no auth plugins) is enough
// — the route is `public`, so the JWT/onboarding chain is irrelevant here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { devApiCostRoutes } from '../dev-api-cost.js'
import { addCostUsd, _resetDevCostForTests } from '../../billing/dev-cost-tracker.js'

async function buildTestApp(
  mythrunEnv: 'production' | 'staging' | 'development',
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(devApiCostRoutes, { mythrunEnv })
  await app.ready()
  return app
}

describe('GET /api/dev/api-cost — never-prod gate', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => {
    _resetDevCostForTests()
  })

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    _resetDevCostForTests()
  })

  it('development: 200 with the current running total', async () => {
    addCostUsd(0.5)
    addCostUsd(0.25)
    app = await buildTestApp('development')
    const res = await app.inject({ method: 'GET', url: '/api/dev/api-cost' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ totalUsd: 0.75 })
  })

  it('staging: 200 (staging still wants the ticker despite authMode=real)', async () => {
    addCostUsd(1.2345)
    app = await buildTestApp('staging')
    const res = await app.inject({ method: 'GET', url: '/api/dev/api-cost' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ totalUsd: 1.2345 })
  })

  it('production: route is not registered → 404', async () => {
    addCostUsd(9.99)
    app = await buildTestApp('production')
    const res = await app.inject({ method: 'GET', url: '/api/dev/api-cost' })
    expect(res.statusCode).toBe(404)
  })
})
