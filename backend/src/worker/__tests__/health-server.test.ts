import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { Worker as BullmqWorker } from 'bullmq'
import type { FastifyInstance } from 'fastify'
import { startHealthServer, type HealthDeps, type WorkerHealthServer } from '../health-server.js'

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
  let health: WorkerHealthServer | undefined

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(async () => {
    if (health) {
      await health.close()
      health = undefined
    }
  })

  /** Bind on an ephemeral port, then arm — the two-phase boot worker.ts uses. */
  async function armed(deps: HealthDeps): Promise<FastifyInstance> {
    health = await startHealthServer(0)
    health.arm(deps)
    return health.app
  }

  it('returns 200 with { healthy: true } when all probes pass', async () => {
    const app = await armed({
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
    const app = await armed({
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
    const app = await armed({
      pg: mockPool(),
      redisBatch: mockRedis(),
      redisRealtime: mockRedis(),
      workers: [mockWorker('world-gen', true), mockWorker('campaign-setup', false)],
    })

    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ healthy: false, failed: ['worker-campaign-setup'] })
  })

  it('returns 503 with the failed probe when a probe never resolves (timeout)', async () => {
    // Exercises the setTimeout-reject arm at health-server.ts:31-33 — a
    // probe that never settles within PROBE_TIMEOUT_MS (1s) gets the
    // timeout rejection from Promise.race and is marked ok=false.
    //
    // Use a hanging redis ping (Promise that never resolves) so the
    // timeout wins the race.
    const hangingRedis = {
      ping: vi.fn(() => new Promise<string>(() => undefined)),
    } as unknown as Redis
    const app = await armed({
      pg: mockPool(),
      redisBatch: hangingRedis,
      redisRealtime: mockRedis(),
      workers: [mockWorker('world-gen')],
    })

    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ healthy: false, failed: ['redis-batch'] })
  }, 5000)

  // myth-jykft — phase 1 of the two-phase boot.
  it('is bound but 503 BEFORE arm() — a worker mid-boot never reports green', async () => {
    health = await startHealthServer(0)

    const res = await health.app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ healthy: false, failed: ['boot'] })
  })

  it('the bind is the duplicate-worker guard: a second bind on the same port throws EADDRINUSE', async () => {
    // The whole point of binding BEFORE registering any BullMQ worker: a second
    // worker process on this host dies here instead of silently becoming a
    // competing consumer of the shared queues.
    health = await startHealthServer(0)
    const addr = health.app.server.address()
    if (addr === null || typeof addr === 'string') throw new Error('expected a TCP address')

    await expect(startHealthServer(addr.port)).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })
})
