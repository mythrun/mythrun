import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

// requireOnboarded looks up the users row via getByCognitoSubWithTimeout.
// In these tests the Pool is a stub, so we mock the users repo to return
// a synthetic onboarded row for the bypass user. Tests that need to
// exercise the 403/401/null paths live in require-onboarded.test.ts.
vi.mock('../repo/users.js', () => ({
  createUsersRepo: () => ({
    getByCognitoSubWithTimeout: vi.fn().mockResolvedValue({
      id: 'stub-user-id',
      cognitoSub: 'bypass:dev-1',
      username: 'bypass',
      displayName: 'Bypass',
    }),
  }),
}))

import { buildApp } from '../app.js'
import type { AppDeps } from '../app-deps.js'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { createRepo } from '../repo/index.js'

const makeStubDeps = (): AppDeps => {
  const mockPool = {} as Pool
  return {
    pg: mockPool,
    redisRealtime: {} as Redis,
    redisBatch: {} as Redis,
    repo: createRepo(mockPool),
  }
}

describe('buildApp', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('COGNITO_USER_POOL_ID', '')
    vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
    vi.stubEnv('COGNITO_ISSUER_URL', '')
    vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
    // Force the bypass plugin's Layer 2b ECS task-metadata probe to fail
    // (i.e. "we are not on ECS"), so registration proceeds.
    globalThis.fetch = (): Promise<Response> =>
      Promise.reject(new Error('ECONNREFUSED'))
  })

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
    vi.unstubAllEnvs()
  })

  it('builds a Fastify instance with no side effects on import', async () => {
    app = await buildApp(makeStubDeps(), { mode: 'bypass' })
    expect(app).toBeDefined()
  })

  it('/health returns {status:"ok"}', async () => {
    app = await buildApp(makeStubDeps(), { mode: 'bypass' })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('encapsulation: auth hook applies to parent-scope routes', async () => {
    app = await buildApp(makeStubDeps(), { mode: 'bypass' })
    let attached: unknown = 'sentinel'
    app.get('/post-register-route', (request) => {
      attached = request.user
      return { ok: true }
    })
    const res = await app.inject({ method: 'GET', url: '/post-register-route' })
    expect(res.statusCode).toBe(200)
    expect(attached).toMatchObject({ sub: 'bypass:dev-1' })
  })
})
