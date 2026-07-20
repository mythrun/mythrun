import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as queueEventsModule from '../session/session-turn-queue-events.js'

vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    databaseUrl: 'postgresql://test@localhost:5432/test',
    redisBatchUrl: 'redis://localhost:6379',
    redisRealtimeUrl: 'redis://localhost:6380',
    voyageApiKey: 'test-voyage-key',
    // Other fields not consumed by main()
  }),
}))

// The Voyage boot probe makes a real embed call; mock it to a no-op so the boot
// test neither hits the network nor depends on a valid VOYAGE_API_KEY. The
// probe's own crash-on-config / degrade-on-transient behavior is covered by
// src/boot/__tests__/voyage-probe.test.ts.
vi.mock('../boot/voyage-probe.js', () => ({
  probeVoyageAtBoot: vi.fn((): Promise<void> => Promise.resolve()),
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

// MYT-74b T14: spy on buildSessionTurnQueueEvents to assert the 5th `finalize`
// arg (the QueueEvents backstop closure) is threaded through from worker.main().
// The spy calls THROUGH to the real builder (captured before spying) so the
// existing QueueEvents-instance + duplicate()/quit() teardown assertions hold.
const realBuildQueueEvents = queueEventsModule.buildSessionTurnQueueEvents
const buildQueueEventsSpy = vi
  .spyOn(queueEventsModule, 'buildSessionTurnQueueEvents')
  .mockImplementation((...args) => realBuildQueueEvents(...args))

describe('worker.main()', () => {
  beforeEach(() => {
    vi.useRealTimers()
    buildQueueEventsSpy.mockClear()
    buildQueueEventsSpy.mockImplementation((...args) => realBuildQueueEvents(...args))
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

    // myth-y2qfi: main() installs the process-level escape guard at boot. Capture
    // the listener baseline before boot so we can assert install + teardown.
    const baseUnhandled = process.listenerCount('unhandledRejection')
    const baseUncaught = process.listenerCount('uncaughtException')

    void main() // never awaited — main blocks forever on Promise<never>

    // Wait for startup: workers registered, health server up. Nine workers:
    // world-gen, campaign-setup, session-prep (MYT-61 T4), session-turn (MYT-66),
    // dm-trigger (MYT-67 T9), st-evaluation (MYT-69 T15), scribe (MYT-73 T11),
    // session-reconcile (MYT-74a T13), session-analysis (MYT-74b T14).
    await vi.waitFor(() => {
      expect(workerInstances).toHaveLength(9)
    })
    // myth-y2qfi: the escape guard's unhandledRejection + uncaughtException
    // listeners are registered at boot (the net that kept the 2026-07-19
    // floating rejection from killing all nine queues).
    expect(process.listenerCount('unhandledRejection')).toBe(baseUnhandled + 1)
    expect(process.listenerCount('uncaughtException')).toBe(baseUncaught + 1)
    // The dm-trigger worker is on QUEUE_DM_TRIGGER ('dm-trigger').
    expect(workerInstances.map((w) => w.name)).toContain('dm-trigger')
    // The st-evaluation worker (MYT-69) is on QUEUE_ST_EVAL ('st-evaluation').
    expect(workerInstances.map((w) => w.name)).toContain('st-evaluation')
    // The scribe worker (MYT-73) is on QUEUE_SCRIBE ('scribe').
    expect(workerInstances.map((w) => w.name)).toContain('scribe')
    // The session-reconcile worker (MYT-74a) is on QUEUE_SESSION_RECONCILE
    // ('session-reconcile').
    expect(workerInstances.map((w) => w.name)).toContain('session-reconcile')
    // The session-analysis worker (MYT-74b T14) is on QUEUE_SESSION_ANALYSIS
    // ('session-analysis').
    expect(workerInstances.map((w) => w.name)).toContain('session-analysis')
    // MYT-102 A2: the campaign-setup worker attaches the 'failed' listener
    // that surfaces attempts-exhausted character-creation jobs (flips the
    // concept to 'failed' + publishes a terminal stage-failed). Without it,
    // an exhausted transient leaves the concept at 'processing' forever.
    const campaignSetup = workerInstances.find((w) => w.name === 'campaign-setup')
    expect(campaignSetup).toBeDefined()
    expect(campaignSetup?.on).toHaveBeenCalledWith('failed', expect.any(Function))
    // T16 also wires the session-turn QueueEvents subscriber (MYT-67 T12) — one
    // QueueEvents on a duplicate()d blocking connection.
    expect(queueEventsInstances).toHaveLength(1)
    expect(batchDuplicateMock).toHaveBeenCalledTimes(1)
    // MYT-74b T14: the QueueEvents subscriber is built with a 5th `finalize` arg
    // (the backstop closure that runs finalizeEndedSession from the broker side).
    expect(buildQueueEventsSpy).toHaveBeenCalledTimes(1)
    expect(buildQueueEventsSpy.mock.calls[0]).toHaveLength(5)
    expect(typeof buildQueueEventsSpy.mock.calls[0]?.[4]).toBe('function')
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
    // myth-y2qfi: graceful shutdown detaches the escape-guard listeners, so the
    // process returns to its pre-boot listener baseline (no per-reload leak).
    expect(process.listenerCount('unhandledRejection')).toBe(baseUnhandled)
    expect(process.listenerCount('uncaughtException')).toBe(baseUncaught)
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
