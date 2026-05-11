import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createShutdown, buildApp } from '../app.js'
import type { AppDeps } from '../app-deps.js'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import IoredisMock from 'ioredis-mock'
import { createRepo } from '../repo/index.js'
import { makeStubEnv } from './helpers/stub-env.js'

// Minimal AppDeps for buildApp registration. Real ioredis-mock instances
// are required because @fastify/rate-limit calls redis.defineCommand at
// register time. createShutdown's own input is mocked separately
// (MockClients below) so we can assert shutdown ordering.
function makeBuildAppDeps(): AppDeps {
  const mockPool = {} as Pool
  return {
    pg: mockPool,
    redisRealtime: new IoredisMock(),
    redisBatch: new IoredisMock(),
    redisKeyPrefix: 'test:use1:',
    repo: createRepo(mockPool),
  }
}

type ExitFn = (code?: string | number | null) => never

interface MockClients {
  pg: { end: ReturnType<typeof vi.fn> } & Partial<Pool>
  redisRealtime: { quit: ReturnType<typeof vi.fn> } & Partial<Redis>
  redisBatch: { quit: ReturnType<typeof vi.fn> } & Partial<Redis>
}

function makeMockClients(): MockClients {
  return {
    pg: { end: vi.fn().mockResolvedValue(undefined) },
    redisRealtime: { quit: vi.fn().mockResolvedValue('OK') },
    redisBatch: { quit: vi.fn().mockResolvedValue('OK') },
  }
}

describe('createShutdown', () => {
  let exitSpy: ReturnType<typeof vi.fn<ExitFn>>
  const originalExit: ExitFn = process.exit.bind(process)

  beforeEach(() => {
    exitSpy = vi.fn<ExitFn>(() => undefined as never)
    process.exit = exitSpy
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('COGNITO_USER_POOL_ID', '')
    vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
    vi.stubEnv('COGNITO_ISSUER_URL', '')
    vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
    // Force the bypass plugin's Layer 2b ECS task-metadata probe to fail
    // (i.e. "we are not on ECS"), so registration proceeds.
    globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
  })
  afterEach(() => {
    process.exit = originalExit
  })

  it('drains in order: app.close → pg.end → redis.quit (both), then exit(0)', async () => {
    const app = await buildApp(
      makeBuildAppDeps(),
      { mode: 'bypass' },
      { frontendBaseUrl: 'http://localhost:5173', env: makeStubEnv() },
    )
    const clients = makeMockClients()
    const callOrder: string[] = []

    vi.spyOn(app, 'close').mockImplementation((() => {
      callOrder.push('app.close')
      return Promise.resolve()
    }) as unknown as typeof app.close)
    clients.pg.end.mockImplementation(() => {
      callOrder.push('pg.end')
      return Promise.resolve()
    })
    clients.redisRealtime.quit.mockImplementation(() => {
      callOrder.push('redis-realtime.quit')
      return Promise.resolve('OK')
    })
    clients.redisBatch.quit.mockImplementation(() => {
      callOrder.push('redis-batch.quit')
      return Promise.resolve('OK')
    })
    exitSpy.mockImplementation((code) => {
      callOrder.push(`exit:${String(code)}`)
      return undefined as never
    })

    const handler = createShutdown(app, {
      pg: clients.pg as unknown as Pool,
      redisRealtime: clients.redisRealtime as unknown as Redis,
      redisBatch: clients.redisBatch as unknown as Redis,
    })
    await handler('SIGTERM')

    expect(callOrder).toEqual([
      'app.close',
      'pg.end',
      'redis-realtime.quit',
      'redis-batch.quit',
      'exit:0',
    ])
  })

  it('exits with code 1 if app.close throws', async () => {
    const app = await buildApp(
      makeBuildAppDeps(),
      { mode: 'bypass' },
      { frontendBaseUrl: 'http://localhost:5173', env: makeStubEnv() },
    )
    const clients = makeMockClients()
    vi.spyOn(app, 'close').mockImplementation((() =>
      Promise.reject(new Error('boom'))) as unknown as typeof app.close)

    const handler = createShutdown(app, {
      pg: clients.pg as unknown as Pool,
      redisRealtime: clients.redisRealtime as unknown as Redis,
      redisBatch: clients.redisBatch as unknown as Redis,
    })
    await handler('SIGTERM')

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('exits with code 1 if pg.end throws (after app.close succeeded)', async () => {
    const app = await buildApp(
      makeBuildAppDeps(),
      { mode: 'bypass' },
      { frontendBaseUrl: 'http://localhost:5173', env: makeStubEnv() },
    )
    const clients = makeMockClients()
    vi.spyOn(app, 'close').mockImplementation((() =>
      Promise.resolve()) as unknown as typeof app.close)
    clients.pg.end.mockRejectedValue(new Error('pg boom'))

    const handler = createShutdown(app, {
      pg: clients.pg as unknown as Pool,
      redisRealtime: clients.redisRealtime as unknown as Redis,
      redisBatch: clients.redisBatch as unknown as Redis,
    })
    await handler('SIGTERM')

    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
