import { describe, it, expect, afterEach } from 'vitest'
import { buildApp } from '../app.js'
import type { AppDeps } from '../app-deps.js'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { createRepo } from '../repo/index.js'

const mockPool = {} as Pool
const mockDeps: AppDeps = {
  pg: mockPool,
  redisRealtime: {} as Redis,
  redisBatch: {} as Redis,
  repo: createRepo(mockPool),
}

describe('buildApp', () => {
  let app: ReturnType<typeof buildApp> | undefined
  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
  })

  it('builds a Fastify instance with no side effects on import', () => {
    app = buildApp(mockDeps)
    expect(app).toBeDefined()
  })

  it('/health returns {status:"ok"}', async () => {
    app = buildApp(mockDeps)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})
