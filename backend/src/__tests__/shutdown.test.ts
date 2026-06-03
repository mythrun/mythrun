import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createShutdown, buildApp } from '../app.js'
import type { AppDeps } from '../app-deps.js'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import IoredisMock from 'ioredis-mock'
import { createRepo } from '../repo/index.js'
import { makeStubEnv } from './helpers/stub-env.js'
import type { PipelineSubscriber } from '../sse/pipeline-subscriber.js'

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
    // MYT-51 T12: no-op queue — buildApp doesn't drive enqueue paths.
    worldGenQueue: {
      add: (): Promise<unknown> => Promise.resolve(undefined),
      getJobCounts: (): Promise<Record<string, number>> => Promise.resolve({}),
      getJob: (): Promise<null> => Promise.resolve(null),
    },
    sessionPrepQueue: { add: (): Promise<unknown> => Promise.resolve(undefined) },
  }
}

type ExitFn = (code?: string | number | null) => never

interface MockClients {
  pg: { end: ReturnType<typeof vi.fn> } & Partial<Pool>
  redisRealtime: { quit: ReturnType<typeof vi.fn> } & Partial<Redis>
  redisBatch: { quit: ReturnType<typeof vi.fn> } & Partial<Redis>
  subscriber: { close: ReturnType<typeof vi.fn> } & Partial<PipelineSubscriber>
  stopPeriodicLog: ReturnType<typeof vi.fn>
  // MYT-51 T12: world-gen BullMQ worker + queue, drained as part of shutdown.
  worldGenWorker: { close: ReturnType<typeof vi.fn> }
  worldGenQueue: { close: ReturnType<typeof vi.fn> }
  // myth-epo4 T22 / MYT-53: character-creation BullMQ worker + queue,
  // drained AFTER the world-gen pair (see createShutdown drain order).
  characterCreationWorker: { close: ReturnType<typeof vi.fn> }
  characterCreationQueue: { close: ReturnType<typeof vi.fn> }
}

function makeMockClients(): MockClients {
  return {
    pg: { end: vi.fn().mockResolvedValue(undefined) },
    redisRealtime: { quit: vi.fn().mockResolvedValue('OK') },
    redisBatch: { quit: vi.fn().mockResolvedValue('OK') },
    subscriber: { close: vi.fn().mockResolvedValue(undefined) },
    stopPeriodicLog: vi.fn(),
    worldGenWorker: { close: vi.fn().mockResolvedValue(undefined) },
    worldGenQueue: { close: vi.fn().mockResolvedValue(undefined) },
    characterCreationWorker: { close: vi.fn().mockResolvedValue(undefined) },
    characterCreationQueue: { close: vi.fn().mockResolvedValue(undefined) },
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

  it('drains in order: stopPeriodicLog → subscriber.close → worldGenWorker.close → worldGenQueue.close → characterCreationWorker.close → characterCreationQueue.close → app.close → pg.end → redis.quit (both), then exit(0)', async () => {
    const app = await buildApp(
      makeBuildAppDeps(),
      { mode: 'bypass' },
      { frontendBaseUrl: 'http://localhost:5173', env: makeStubEnv() },
    )
    const clients = makeMockClients()
    const callOrder: string[] = []

    clients.stopPeriodicLog.mockImplementation(() => {
      callOrder.push('stopPeriodicLog')
    })
    clients.subscriber.close.mockImplementation(() => {
      callOrder.push('subscriber.close')
      return Promise.resolve()
    })
    clients.worldGenWorker.close.mockImplementation(() => {
      callOrder.push('worldGenWorker.close')
      return Promise.resolve()
    })
    clients.worldGenQueue.close.mockImplementation(() => {
      callOrder.push('worldGenQueue.close')
      return Promise.resolve()
    })
    clients.characterCreationWorker.close.mockImplementation(() => {
      callOrder.push('characterCreationWorker.close')
      return Promise.resolve()
    })
    clients.characterCreationQueue.close.mockImplementation(() => {
      callOrder.push('characterCreationQueue.close')
      return Promise.resolve()
    })
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
      subscriber: clients.subscriber as unknown as PipelineSubscriber,
      stopPeriodicLog: clients.stopPeriodicLog,
      worldGenWorker: clients.worldGenWorker,
      worldGenQueue: clients.worldGenQueue,
      characterCreationWorker: clients.characterCreationWorker,
      characterCreationQueue: clients.characterCreationQueue,
    })
    await handler('SIGTERM')

    expect(callOrder).toEqual([
      'stopPeriodicLog',
      'subscriber.close',
      'worldGenWorker.close',
      'worldGenQueue.close',
      'characterCreationWorker.close',
      'characterCreationQueue.close',
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
      subscriber: clients.subscriber as unknown as PipelineSubscriber,
      stopPeriodicLog: clients.stopPeriodicLog,
      worldGenWorker: clients.worldGenWorker,
      worldGenQueue: clients.worldGenQueue,
      characterCreationWorker: clients.characterCreationWorker,
      characterCreationQueue: clients.characterCreationQueue,
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
      subscriber: clients.subscriber as unknown as PipelineSubscriber,
      stopPeriodicLog: clients.stopPeriodicLog,
      worldGenWorker: clients.worldGenWorker,
      worldGenQueue: clients.worldGenQueue,
      characterCreationWorker: clients.characterCreationWorker,
      characterCreationQueue: clients.characterCreationQueue,
    })
    await handler('SIGTERM')

    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
