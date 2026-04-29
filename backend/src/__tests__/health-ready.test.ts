import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { makeStubDeps } from './helpers/stub-deps.js'

interface ReadyBody {
  ready: boolean
  failed?: string[]
}

describe('GET /health/ready', () => {
  let app: ReturnType<typeof buildApp> | undefined

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
    vi.useRealTimers()
  })

  it('returns 200 {ready:true} when all probes succeed', async () => {
    app = buildApp(makeStubDeps())
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(200)
    expect(res.json<ReadyBody>()).toEqual({ ready: true })
  })

  it("returns 503 with failed:['pg'] when pg.query rejects", async () => {
    app = buildApp(
      makeStubDeps({
        pgQuery: () => Promise.reject(new Error('connection refused')),
      }),
    )
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(503)
    expect(res.json<ReadyBody>()).toEqual({ ready: false, failed: ['pg'] })
  })

  it('returns 503 with both failed names when pg + redis-batch reject', async () => {
    app = buildApp(
      makeStubDeps({
        pgQuery: () => Promise.reject(new Error('pg down')),
        pingBatch: () => Promise.reject(new Error('redis-batch down')),
      }),
    )
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(503)
    const body = res.json<ReadyBody>()
    expect(body.ready).toBe(false)
    expect(body.failed?.sort()).toEqual(['pg', 'redis-batch'])
  })

  it('returns 503 when one probe hangs > 1s (others resolve)', async () => {
    vi.useFakeTimers()
    app = buildApp(
      makeStubDeps({
        // Hang forever — Promise.race timeout should kick in.
        pgQuery: () => new Promise(() => undefined),
      }),
    )
    const responsePromise = app.inject({ method: 'GET', url: '/health/ready' })
    await vi.advanceTimersByTimeAsync(1001)
    const res = await responsePromise
    expect(res.statusCode).toBe(503)
    const body = res.json<ReadyBody>()
    expect(body.failed).toEqual(['pg'])
  })
})
