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
// MYT-51 T12: separate ping/quit for the dedicated BullMQ-compatible
// connection that server.ts spins up alongside the API's redisBatch.
const mockBullmqPing = vi.fn()
const mockBullmqQuit = vi.fn().mockResolvedValue('OK')
const mockListen = vi.fn().mockResolvedValue(undefined)
const mockCreateRedisClient = vi.fn()
const mockProbe = vi.fn().mockResolvedValue(undefined)

vi.mock('../db/postgres.js', () => ({
  createPgPool: () => ({ query: mockPgQuery, end: mockPgEnd }) as unknown as Pool,
}))
vi.mock('../redis/client.js', () => ({
  createRedisClient: (url: string) => mockCreateRedisClient(url) as Redis,
}))
// MYT-51 T12: stub createBullmqRedisClient — server.ts builds a
// dedicated worker-side connection alongside the regular redisBatch
// (BullMQ requires `maxRetriesPerRequest: null`, the regular fast-fail
// client violates that). The unit test doesn't drive a real worker;
// satisfy ping (boot probe) + quit (shutdown).
vi.mock('../redis/bullmq-client.js', () => ({
  createBullmqRedisClient: () =>
    ({
      ping: mockBullmqPing,
      quit: mockBullmqQuit,
      duplicate: () => ({ ping: mockBullmqPing, quit: mockBullmqQuit }),
    }) as unknown as Redis,
}))
// MYT-51 T12: stub the bullmq Queue + Worker. The real classes try to
// connect to Redis at construction time; we never drive jobs in this
// unit test, so a hand-rolled no-op is sufficient.
vi.mock('bullmq', () => ({
  Queue: class FakeQueue {
    add = (): Promise<unknown> => Promise.resolve(undefined)
    getJobCounts = (): Promise<Record<string, number>> => Promise.resolve({})
    getJob = (): Promise<null> => Promise.resolve(null)
    close = (): Promise<void> => Promise.resolve()
  },
  Worker: class FakeWorker {
    close = (): Promise<void> => Promise.resolve()
  },
}))
// MYT-41: stub the Stripe probe so server.test.ts stays unit-level. The
// probe-itself happy path is covered in src/billing/__tests__/probe.test.ts.
vi.mock('../billing/stripe-client.js', () => ({
  getStripeClient: () => ({}) as unknown as import('stripe').default,
}))
vi.mock('../billing/probe.js', () => ({
  probeStripeContract: async (): Promise<void> => {
    await mockProbe()
  },
}))
const mockProbeMigrationsCurrent = vi.fn()
vi.mock('../boot/migrations-current.js', () => ({
  probeMigrationsCurrent: async (pool: unknown): Promise<void> => {
    await mockProbeMigrationsCurrent(pool)
  },
}))
// myth-oehx P2: server.ts reads cost-caps from the settings table at
// boot. The boot gate happy-path doesn't run real SQL — stub the reads
// to return sensible defaults so main() doesn't blow on the generic
// mockPgQuery shape (which returns {} without a rows array).
vi.mock('../llm/prep/cost-cap.js', async () => {
  const actual = await vi.importActual<typeof import('../llm/prep/cost-cap.js')>(
    '../llm/prep/cost-cap.js',
  )
  return {
    ...actual,
    readCostCap: vi.fn().mockResolvedValue(10.0),
    readCharacterCreationCostCap: vi.fn().mockResolvedValue(5.0),
  }
})

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
  BOOT_GATE_ENABLED: '1',
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
    mockProbe.mockReset().mockResolvedValue(undefined)
    mockProbeMigrationsCurrent.mockReset().mockResolvedValue(undefined)
    mockBullmqPing.mockReset().mockResolvedValue('PONG')
    mockBullmqQuit.mockReset().mockResolvedValue('OK')
    // Each call to createRedisClient returns a fresh ioredis-shaped object.
    // Order matters: server.ts calls realtime first, then batch.
    const fakeRtr = { ping: mockRtrPing, quit: mockRtrQuit } as unknown as Redis
    const fakeRtb = { ping: mockRtbPing, quit: mockRtbQuit } as unknown as Redis
    mockCreateRedisClient
      .mockReset()
      .mockImplementationOnce(() => fakeRtr)
      .mockImplementationOnce(() => fakeRtb)
    process.exitCode = undefined
    // Strip any DB_*/REDIS_* component-form vars from origEnv so the
    // tests' URL-form REQUIRED_ENV controls behavior deterministically.
    // env.ts now accepts either form; without this clear, a developer
    // shell that exports DB_HOST etc. would mask the "missing DATABASE_URL"
    // test path.
    const cleaned = { ...origEnv }
    delete cleaned.DB_HOST
    delete cleaned.DB_PORT
    delete cleaned.DB_USER
    delete cleaned.DB_NAME
    delete cleaned.DB_PASSWORD
    delete cleaned.REDIS_HOST
    delete cleaned.REDIS_PORT
    delete cleaned.REDIS_AUTH_TOKEN
    process.env = { ...cleaned, ...REQUIRED_ENV }
    vi.spyOn(process, 'exit').mockImplementation(
      (() => undefined) as unknown as typeof process.exit,
    )
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

  it(
    'migrations-current probe fails → exitCode=1, named in error log, app.listen NOT called',
    async () => {
      mockPgQuery.mockResolvedValue({})
      mockRtrPing.mockResolvedValue('PONG')
      mockRtbPing.mockResolvedValue('PONG')
      mockProbeMigrationsCurrent.mockRejectedValueOnce(
        new Error(
          'migrations-current: image expects 8 migrations, DB is missing 2 (007_recreate_billing_tables.sql, 008_billing_metering.sql). Run `gh workflow run db-migrate` then re-trigger Deploy.',
        ),
      )

      let errorOutput = ''
      const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errorOutput += args.map(String).join(' ') + '\n'
      })

      await import('../server.js')

      // Boot-gate aborts before app.listen runs.
      expect(mockListen).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(1)
      expect(errorOutput).toContain('migrations-current')
      expect(errorOutput).toContain('Run `gh workflow run db-migrate`')

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
