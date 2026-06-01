import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    databaseUrl: 'postgresql://test@localhost:5432/test',
    redisBatchUrl: 'redis://localhost:6379',
    redisRealtimeUrl: 'redis://localhost:6380',
    // Other fields not consumed by main()
  }),
}))

const batchPingMock = vi.fn((): Promise<string> => Promise.resolve('PONG'))
const batchQuitMock = vi.fn((): Promise<string> => Promise.resolve('OK'))
const realtimePingMock = vi.fn((): Promise<string> => Promise.resolve('PONG'))
const realtimeQuitMock = vi.fn((): Promise<string> => Promise.resolve('OK'))

vi.mock('../redis/bullmq-client.js', () => ({
  createBullmqRedisClient: () => ({
    ping: batchPingMock,
    quit: batchQuitMock,
  }),
}))

vi.mock('../redis/client.js', () => ({
  createRedisClient: () => ({
    ping: realtimePingMock,
    quit: realtimeQuitMock,
  }),
}))

// readCostCap + readCharacterCreationCostCap (called at boot) issue
// `SELECT value FROM settings WHERE key = '...'`. Both expect a `value`
// column parseable as a positive number. The startup probe issues
// `SELECT 1` which returns the same {value:'10'} row — harmless;
// pg returns whatever columns the SELECT names without complaining.
const pgQueryMock = vi.fn(() => Promise.resolve({ rows: [{ value: '10' }] }))
const pgEndMock = vi.fn(() => Promise.resolve())

vi.mock('../db/postgres.js', () => ({
  createPgPool: () => ({
    query: pgQueryMock,
    end: pgEndMock,
  }),
}))

const healthCloseMock = vi.fn(() => Promise.resolve())

vi.mock('../worker/health-server.js', () => ({
  startHealthServer: vi.fn(() => Promise.resolve({ close: healthCloseMock })),
}))

interface FakeWorker {
  name: string
  close: ReturnType<typeof vi.fn>
}
const workerInstances: FakeWorker[] = []

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation((name: string) => {
    const instance: FakeWorker = {
      name,
      close: vi.fn(() => Promise.resolve()),
    }
    workerInstances.push(instance)
    return instance
  }),
}))

describe('worker.main()', () => {
  beforeEach(() => {
    vi.useRealTimers()
    batchPingMock.mockClear()
    batchQuitMock.mockClear()
    realtimePingMock.mockClear()
    realtimeQuitMock.mockClear()
    pgQueryMock.mockClear()
    pgEndMock.mockClear()
    healthCloseMock.mockClear()
    workerInstances.length = 0
  })

  afterEach(() => {
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
    vi.restoreAllMocks()
  })

  it('starts up, registers workers + health server, then shuts down cleanly on SIGTERM', async () => {
    const { main } = await import('../worker.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    void main() // never awaited — main blocks forever on Promise<never>

    // Wait for startup: workers registered, health server up. Three workers:
    // world-gen, campaign-setup, session-prep (MYT-61 T4).
    await vi.waitFor(() => {
      expect(workerInstances).toHaveLength(3)
    })
    expect(batchPingMock).toHaveBeenCalledTimes(1)
    expect(realtimePingMock).toHaveBeenCalledTimes(1)
    expect(pgQueryMock).toHaveBeenCalledWith('SELECT 1')

    process.emit('SIGTERM', 'SIGTERM' as NodeJS.Signals)

    // Wait for clean shutdown.
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0)
    })
    expect(healthCloseMock).toHaveBeenCalledTimes(1)
    for (const w of workerInstances) {
      expect(w.close).toHaveBeenCalled()
    }
    expect(pgEndMock).toHaveBeenCalledTimes(1)
    expect(batchQuitMock).toHaveBeenCalledTimes(1)
    expect(realtimeQuitMock).toHaveBeenCalledTimes(1)
  })
})
