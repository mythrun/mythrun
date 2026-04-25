import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'

// Mocks must be declared before the dynamic import of server.ts inside tests.
// vi.mock() is hoisted to the top of the file by Vitest's transformer.
const mockPgQuery = vi.fn()
const mockPgEnd = vi.fn().mockResolvedValue(undefined)
const mockRtrPing = vi.fn()
const mockRtrQuit = vi.fn().mockResolvedValue('OK')
const mockRtbPing = vi.fn()
const mockRtbQuit = vi.fn().mockResolvedValue('OK')
const mockListen = vi.fn().mockResolvedValue(undefined)
const mockCreateRedisClient = vi.fn()

vi.mock('../db/postgres.js', () => ({
  createPgPool: () => ({ query: mockPgQuery, end: mockPgEnd }) as unknown as Pool,
}))
vi.mock('../redis/client.js', () => ({
  createRedisClient: (url: string) => mockCreateRedisClient(url) as Redis,
}))
vi.mock('../app.js', async () => {
  const actual = await vi.importActual<typeof import('../app.js')>('../app.js')
  return {
    ...actual,
    buildApp: () => ({
      listen: mockListen,
      log: { info: vi.fn(), error: vi.fn() },
      close: vi.fn().mockResolvedValue(undefined),
    }),
  }
})

const REQUIRED_ENV = {
  DATABASE_URL: 'postgresql://u:p@h:5432/d',
  REDIS_REALTIME_URL: 'redis://h:6379',
  REDIS_BATCH_URL: 'redis://h:6380',
  PORT: '3000',
}

const TEST_TIMEOUT_MS = 30_000

describe('server boot gate', () => {
  const origEnv = { ...process.env }

  beforeEach(() => {
    // Wipe call history but keep mocked module factories. Fresh module
    // import per test (via vi.resetModules) re-runs `await main()` at the
    // module top, which is the harness for each scenario.
    vi.resetModules()
    mockPgQuery.mockReset()
    mockPgEnd.mockReset().mockResolvedValue(undefined)
    mockRtrPing.mockReset()
    mockRtrQuit.mockReset().mockResolvedValue('OK')
    mockRtbPing.mockReset()
    mockRtbQuit.mockReset().mockResolvedValue('OK')
    mockListen.mockReset().mockResolvedValue(undefined)
    // Each call to createRedisClient returns a fresh ioredis-shaped object.
    // Order matters: server.ts calls realtime first, then batch.
    const fakeRtr = { ping: mockRtrPing, quit: mockRtrQuit } as unknown as Redis
    const fakeRtb = { ping: mockRtbPing, quit: mockRtbQuit } as unknown as Redis
    mockCreateRedisClient
      .mockReset()
      .mockImplementationOnce(() => fakeRtr)
      .mockImplementationOnce(() => fakeRtb)
    process.exitCode = undefined
    process.env = { ...origEnv, ...REQUIRED_ENV }
    vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit)
  })

  afterEach(() => {
    process.env = origEnv
    vi.restoreAllMocks()
  })

  it(
    'happy path: all probes succeed → app.listen called, no exitCode',
    async () => {
      mockPgQuery.mockResolvedValue({})
      mockRtrPing.mockResolvedValue('PONG')
      mockRtbPing.mockResolvedValue('PONG')

      // Importing server.js executes `await main()` at module top.
      await import('../server.js')

      expect(mockPgQuery).toHaveBeenCalled()
      expect(mockRtrPing).toHaveBeenCalled()
      expect(mockRtbPing).toHaveBeenCalled()
      expect(mockListen).toHaveBeenCalledWith({ port: 3000, host: '0.0.0.0' })
      expect(process.exitCode).not.toBe(1)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'Postgres probe fails → exitCode=1, app.listen NOT called, closePartials runs',
    async () => {
      mockPgQuery.mockRejectedValue(new Error('connection refused'))
      mockRtrPing.mockResolvedValue('PONG')
      mockRtbPing.mockResolvedValue('PONG')

      await import('../server.js')

      expect(process.exitCode).toBe(1)
      expect(mockListen).not.toHaveBeenCalled()
      expect(mockPgEnd).toHaveBeenCalled()
      expect(mockRtrQuit).toHaveBeenCalled()
      expect(mockRtbQuit).toHaveBeenCalled()
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'Redis (realtime) probe fails → exitCode=1, named in error log',
    async () => {
      mockPgQuery.mockResolvedValue({})
      mockRtrPing.mockRejectedValue(new Error('redis down'))
      mockRtbPing.mockResolvedValue('PONG')

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      await import('../server.js')

      expect(process.exitCode).toBe(1)
      expect(mockListen).not.toHaveBeenCalled()
      const allErrCalls = errSpy.mock.calls.flat().join(' ')
      expect(allErrCalls).toContain('Redis (realtime)')
      errSpy.mockRestore()
    },
    TEST_TIMEOUT_MS,
  )

  it('Missing DATABASE_URL → exitCode=1 from env validation, no clients created', async () => {
    delete process.env.DATABASE_URL
    await import('../server.js')
    expect(process.exitCode).toBe(1)
    expect(mockPgQuery).not.toHaveBeenCalled()
    expect(mockListen).not.toHaveBeenCalled()
  })
})
