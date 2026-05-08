import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { makeStubDeps } from './helpers/stub-deps.js'
import { makeStubEnv } from './helpers/stub-env.js'

interface ReadyBody {
  ready: boolean
  failed?: string[]
}

describe('GET /health/ready', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('COGNITO_USER_POOL_ID', '')
    vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
    vi.stubEnv('COGNITO_ISSUER_URL', '')
    vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
    // Force the bypass plugin's Layer 2b ECS task-metadata probe to fail
    // (i.e. "we are not on ECS"), so registration proceeds.
    globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
  })

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
    vi.useRealTimers()
  })

  it('returns 200 {ready:true} when all probes succeed', async () => {
    app = await buildApp(
      makeStubDeps(),
      { mode: 'bypass' },
      { frontendBaseUrl: 'http://localhost:5173', env: makeStubEnv() },
    )
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(200)
    expect(res.json<ReadyBody>()).toEqual({ ready: true })
  })

  it("returns 503 with failed:['pg'] when pg.query rejects", async () => {
    app = await buildApp(
      makeStubDeps({
        pgQuery: () => Promise.reject(new Error('connection refused')),
      }),
      { mode: 'bypass' },
      { frontendBaseUrl: 'http://localhost:5173', env: makeStubEnv() },
    )
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(503)
    expect(res.json<ReadyBody>()).toEqual({ ready: false, failed: ['pg'] })
  })

  it('returns 503 with both failed names when pg + redis-batch reject', async () => {
    app = await buildApp(
      makeStubDeps({
        pgQuery: () => Promise.reject(new Error('pg down')),
        pingBatch: () => Promise.reject(new Error('redis-batch down')),
      }),
      { mode: 'bypass' },
      { frontendBaseUrl: 'http://localhost:5173', env: makeStubEnv() },
    )
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(503)
    const body = res.json<ReadyBody>()
    expect(body.ready).toBe(false)
    expect(body.failed?.sort()).toEqual(['pg', 'redis-batch'])
  })

  it('returns 503 when one probe hangs > 1s (others resolve)', async () => {
    vi.useFakeTimers()
    app = await buildApp(
      makeStubDeps({
        // Hang forever — Promise.race timeout should kick in.
        pgQuery: () => new Promise(() => undefined),
      }),
      { mode: 'bypass' },
      { frontendBaseUrl: 'http://localhost:5173', env: makeStubEnv() },
    )
    const responsePromise = app.inject({ method: 'GET', url: '/health/ready' })
    await vi.advanceTimersByTimeAsync(1001)
    const res = await responsePromise
    expect(res.statusCode).toBe(503)
    const body = res.json<ReadyBody>()
    expect(body.failed).toEqual(['pg'])
  })
})
