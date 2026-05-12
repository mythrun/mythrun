import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { Worker as BullmqWorker } from 'bullmq'
import type { FastifyInstance } from 'fastify'
import { startHealthServer } from '../health-server.js'

function mockPool(queryImpl?: () => Promise<unknown>): Pool {
  return {
    query: vi.fn(queryImpl ?? (() => Promise.resolve({ rows: [] }))),
  } as unknown as Pool
}

function mockRedis(pingImpl?: () => Promise<string>): Redis {
  return {
    ping: vi.fn(pingImpl ?? (() => Promise.resolve('PONG'))),
  } as unknown as Redis
}

function mockWorker(name: string, isRunning = true): BullmqWorker {
  return { name, isRunning: vi.fn(() => isRunning) } as unknown as BullmqWorker
}

describe('startHealthServer', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
  })

  it('returns 200 with { healthy: true } when all probes pass', async () => {
    app = await startHealthServer(0, {
      pg: mockPool(),
      redisBatch: mockRedis(),
      redisRealtime: mockRedis(),
      workers: [mockWorker('world-gen'), mockWorker('campaign-setup')],
    })

    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ healthy: true })
  })

  it('returns 503 with the failed probe name when pg fails', async () => {
    app = await startHealthServer(0, {
      pg: mockPool(() => Promise.reject(new Error('pg down'))),
      redisBatch: mockRedis(),
      redisRealtime: mockRedis(),
      workers: [mockWorker('world-gen'), mockWorker('campaign-setup')],
    })

    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ healthy: false, failed: ['pg'] })
  })

  it('returns 503 with worker-<name> when a BullMQ worker is not running', async () => {
    app = await startHealthServer(0, {
      pg: mockPool(),
      redisBatch: mockRedis(),
      redisRealtime: mockRedis(),
      workers: [mockWorker('world-gen', true), mockWorker('campaign-setup', false)],
    })

    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ healthy: false, failed: ['worker-campaign-setup'] })
  })
})
