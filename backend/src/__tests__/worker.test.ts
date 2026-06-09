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

// buildSessionTurnQueueEvents (MYT-67 T12) calls `redisBatch.duplicate()` for
// the QueueEvents BRPOP stream's dedicated blocking connection. The duplicate
// gets its own `.quit()` in SessionTurnQueueEvents.close(); the mock returns a
// fake bearing the same shape so the boot path doesn't throw.
const batchDuplicateQuitMock = vi.fn((): Promise<string> => Promise.resolve('OK'))
const batchDuplicateMock = vi.fn(() => ({ quit: batchDuplicateQuitMock }))

vi.mock('../redis/bullmq-client.js', () => ({
  createBullmqRedisClient: () => ({
    ping: batchPingMock,
    quit: batchQuitMock,
    duplicate: batchDuplicateMock,
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
const startHealthServerMock = vi.fn(() => Promise.resolve({ close: healthCloseMock }))

vi.mock('../worker/health-server.js', () => ({
  startHealthServer: startHealthServerMock,
}))

interface FakeWorker {
  name: string
  close: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}
const workerInstances: FakeWorker[] = []

interface FakeQueueEvents {
  close: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}
const queueEventsInstances: FakeQueueEvents[] = []

// The bullmq mock now also covers Queue + QueueEvents, which the two new MYT-67
// builders construct:
//   - buildDmTriggerWorker (T9) makes two `new Queue(...)` producers (dm-trigger,
//     session-turn) on the shared redisBatch — a fake `.add`/`.close` suffices.
//   - buildSessionTurnQueueEvents (T12) makes one `new QueueEvents(...)` on a
//     `duplicate()`d connection plus a job-fetch `new Queue(...)`. The QueueEvents
//     needs `.on('failed', ...)` at build time and `.close()` on shutdown; we
//     capture instances so the test can assert close() runs on SIGTERM.
// (buildSessionTurnWorker already constructed a `new Queue(...)`, so the prior
// mock — Worker-only — actually threw at boot; this closes that gap too.)
vi.mock('bullmq', () => ({
  Worker: vi.fn((name: string) => {
    const instance: FakeWorker = {
      name,
      close: vi.fn(() => Promise.resolve()),
      on: vi.fn(),
    }
    workerInstances.push(instance)
    return instance
  }),
  Queue: vi.fn((name: string) => ({
    name,
    add: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  })),
  QueueEvents: vi.fn(() => {
    const instance: FakeQueueEvents = {
      close: vi.fn(() => Promise.resolve()),
      on: vi.fn(),
    }
    queueEventsInstances.push(instance)
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
    batchDuplicateMock.mockClear()
    batchDuplicateQuitMock.mockClear()
    workerInstances.length = 0
    queueEventsInstances.length = 0
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

    // Wait for startup: workers registered, health server up. Five workers:
    // world-gen, campaign-setup, session-prep (MYT-61 T4), session-turn (MYT-66),
    // dm-trigger (MYT-67 T9, added in T16).
    await vi.waitFor(() => {
      expect(workerInstances).toHaveLength(5)
    })
    // The dm-trigger worker is the fifth, on QUEUE_DM_TRIGGER ('dm-trigger').
    expect(workerInstances.map((w) => w.name)).toContain('dm-trigger')
    // T16 also wires the session-turn QueueEvents subscriber (MYT-67 T12) — one
    // QueueEvents on a duplicate()d blocking connection.
    expect(queueEventsInstances).toHaveLength(1)
    expect(batchDuplicateMock).toHaveBeenCalledTimes(1)
    expect(batchPingMock).toHaveBeenCalledTimes(1)
    expect(realtimePingMock).toHaveBeenCalledTimes(1)
    expect(pgQueryMock).toHaveBeenCalledWith('SELECT 1')
    // Default health port when WORKER_HEALTH_PORT is unset.
    expect(startHealthServerMock).toHaveBeenCalledWith(3001, expect.anything())

    process.emit('SIGTERM', 'SIGTERM' as NodeJS.Signals)

    // Wait for clean shutdown.
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0)
    })
    expect(healthCloseMock).toHaveBeenCalledTimes(1)
    for (const w of workerInstances) {
      expect(w.close).toHaveBeenCalled()
    }
    // The QueueEvents subscriber's dedicated blocking connection MUST be torn
    // down on SIGTERM (sessionTurnEvents.close() → queueEvents.close() + its
    // duplicate().quit()), else a connection leaks per deploy (§4.8).
    expect(queueEventsInstances[0]?.close).toHaveBeenCalledTimes(1)
    expect(batchDuplicateQuitMock).toHaveBeenCalledTimes(1)
    expect(pgEndMock).toHaveBeenCalledTimes(1)
    expect(batchQuitMock).toHaveBeenCalledTimes(1)
    expect(realtimeQuitMock).toHaveBeenCalledTimes(1)
  })

  it('honors WORKER_HEALTH_PORT (local-dev escape hatch for a :3001 collision)', async () => {
    vi.stubEnv('WORKER_HEALTH_PORT', '3901')
    const { main } = await import('../worker.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    void main() // never awaited — main blocks forever on Promise<never>

    await vi.waitFor(() => {
      expect(startHealthServerMock).toHaveBeenCalled()
    })
    expect(startHealthServerMock).toHaveBeenCalledWith(3901, expect.anything())

    process.emit('SIGTERM', 'SIGTERM' as NodeJS.Signals)
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0)
    })
    vi.unstubAllEnvs()
  })
})
