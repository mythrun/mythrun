import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Resolves to the `Worker` from the `vi.mock('bullmq', ...)` factory below —
// the myth-jykft ordering assertions read its invocationCallOrder.
import { Worker as BullmqWorkerCtor } from 'bullmq'
import * as queueEventsModule from '../session/session-turn-queue-events.js'
// Real modules, spied per-test: the §1.4 boot-wiring test intercepts
// createLlmHealthTracker (fake tracker) + setLlmHealthSink (capture the bound
// sink) to pin that boot binds the ai.ts sink to tracker.report.
import * as aiModule from '../llm/ai.js'
import * as llmHealthModule from '../llm/llm-health.js'
import type { LlmHealthTracker } from '../llm/llm-health.js'
// Resolves to the mocked `probeVoyageAtBoot` from the factory below — the
// myth-ha6qr boot-failure test drives it to reject.
import { probeVoyageAtBoot } from '../boot/voyage-probe.js'

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

// myth-jykft: the health server is two-phase — startHealthServer(port) BINDS
// (the same-host duplicate-worker guard), arm(deps) supplies the probes once
// boot finishes. The mock keeps both so the ordering assertions below can see
// bind-before-registration and arm-after-registration.
const healthCloseMock = vi.fn(() => Promise.resolve())
const healthArmMock = vi.fn()
const startHealthServerMock = vi.fn(() =>
  Promise.resolve({ arm: healthArmMock, close: healthCloseMock }),
)

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
  name: string
  close: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}
const queueEventsInstances: FakeQueueEvents[] = []

// llm-outage-resilience Task 7: the probe wiring constructs producer Queues
// (the probe queue + three promote-scan handles) and registers the repeatable
// cycle via upsertJobScheduler — capture instances so the test can assert the
// scheduler registration and the shutdown closes by queue name.
interface FakeQueue {
  name: string
  add: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  upsertJobScheduler: ReturnType<typeof vi.fn>
  getDelayed: ReturnType<typeof vi.fn>
}
const queueInstances: FakeQueue[] = []

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
  Queue: vi.fn((name: string) => {
    const instance: FakeQueue = {
      name,
      add: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
      upsertJobScheduler: vi.fn(() => Promise.resolve()),
      getDelayed: vi.fn(() => Promise.resolve([])),
    }
    queueInstances.push(instance)
    return instance
  }),
  QueueEvents: vi.fn((name: string) => {
    const instance: FakeQueueEvents = {
      name,
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
    healthArmMock.mockClear()
    startHealthServerMock.mockClear()
    batchDuplicateMock.mockClear()
    batchDuplicateQuitMock.mockClear()
    vi.mocked(BullmqWorkerCtor).mockClear()
    workerInstances.length = 0
    queueEventsInstances.length = 0
    queueInstances.length = 0
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

    // Wait for startup: workers registered, health server up. Ten workers:
    // world-gen, campaign-setup, session-prep (MYT-61 T4), session-turn (MYT-66),
    // dm-trigger (MYT-67 T9), st-evaluation (MYT-69 T15), scribe (MYT-73 T11),
    // session-reconcile (MYT-74a T13), session-analysis (MYT-74b T14),
    // llm-health-probe (llm-outage-resilience T7).
    await vi.waitFor(() => {
      expect(workerInstances).toHaveLength(10)
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
    // llm-outage-resilience T7: the recovery-probe worker consumes
    // QUEUE_LLM_HEALTH_PROBE, and boot registers the repeatable 60s cycle via
    // the IDEMPOTENT upsertJobScheduler (same scheduler id every boot — a
    // rolling deploy must re-assert, not stack, the repeatable job).
    expect(workerInstances.map((w) => w.name)).toContain('llm-health-probe')
    const probeQueue = queueInstances.find((q) => q.name === 'llm-health-probe')
    expect(probeQueue).toBeDefined()
    expect(probeQueue?.upsertJobScheduler).toHaveBeenCalledWith(
      'llm-health-probe-cycle',
      { every: 60_000 },
      { name: 'llm-health-probe' },
    )
    // The §3.2 promote scan's producer handles on the three prep queues exist
    // (Worker objects can't list delayed jobs).
    for (const scanQueue of ['world-gen', 'session-prep', 'campaign-setup']) {
      expect(queueInstances.map((q) => q.name)).toContain(scanQueue)
    }
    // MYT-102 A2: the campaign-setup worker attaches the 'failed' listener
    // that surfaces attempts-exhausted character-creation jobs (flips the
    // concept to 'failed' + publishes a terminal stage-failed). Without it,
    // an exhausted transient leaves the concept at 'processing' forever.
    const campaignSetup = workerInstances.find((w) => w.name === 'campaign-setup')
    expect(campaignSetup).toBeDefined()
    expect(campaignSetup?.on).toHaveBeenCalledWith('failed', expect.any(Function))
    // T16 also wires the session-turn QueueEvents subscriber (MYT-67 T12), and
    // llm-outage-resilience Task 9 adds the three prep-queue subscribers
    // (world-gen, session-prep, campaign-setup) — four QueueEvents total, each
    // on its own duplicate()d blocking connection.
    expect(queueEventsInstances).toHaveLength(4)
    expect(queueEventsInstances.map((qe) => qe.name).sort()).toEqual([
      'campaign-setup',
      'session-prep',
      'session-turn',
      'world-gen',
    ])
    expect(batchDuplicateMock).toHaveBeenCalledTimes(4)
    // MYT-74b T14: the QueueEvents subscriber is built with a 5th `finalize` arg
    // (the backstop closure that runs finalizeEndedSession from the broker side).
    expect(buildQueueEventsSpy).toHaveBeenCalledTimes(1)
    expect(buildQueueEventsSpy.mock.calls[0]).toHaveLength(5)
    expect(typeof buildQueueEventsSpy.mock.calls[0]?.[4]).toBe('function')
    expect(batchPingMock).toHaveBeenCalledTimes(1)
    expect(realtimePingMock).toHaveBeenCalledTimes(1)
    expect(pgQueryMock).toHaveBeenCalledWith('SELECT 1')
    // Default health port when WORKER_HEALTH_PORT is unset.
    expect(startHealthServerMock).toHaveBeenCalledWith(3001)
    // myth-jykft: the bind is the duplicate-consumer guard, so it MUST precede
    // every BullMQ worker registration — otherwise a second worker on this host
    // has already started stealing jobs by the time the port check fires. The
    // arm() phase runs on the other side, once all nine workers exist, so an
    // un-armed worker never reports green.
    const registrations = vi.mocked(BullmqWorkerCtor).mock.invocationCallOrder
    const bindOrder = startHealthServerMock.mock.invocationCallOrder[0] ?? Infinity
    const armOrder = healthArmMock.mock.invocationCallOrder[0] ?? -Infinity
    expect(bindOrder).toBeLessThan(Math.min(...registrations))
    expect(armOrder).toBeGreaterThan(Math.max(...registrations))
    expect(healthArmMock).toHaveBeenCalledTimes(1)

    process.emit('SIGTERM', 'SIGTERM' as NodeJS.Signals)

    // Wait for clean shutdown.
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0)
    })
    expect(healthCloseMock).toHaveBeenCalledTimes(1)
    for (const w of workerInstances) {
      expect(w.close).toHaveBeenCalled()
    }
    // Every QueueEvents subscriber's dedicated blocking connection MUST be
    // torn down on SIGTERM (sessionTurnEvents.close() + prepQueueEvents.close()
    // → each queueEvents.close() + its duplicate().quit()), else a connection
    // leaks per deploy (§4.8).
    for (const qe of queueEventsInstances) {
      expect(qe.close, `queue-events ${qe.name} close`).toHaveBeenCalledTimes(1)
    }
    expect(batchDuplicateQuitMock).toHaveBeenCalledTimes(4)
    // llm-outage-resilience T7: the probe queue + the three promote-scan
    // producer handles are distinct Queue clients on redisBatch — each MUST be
    // closed on SIGTERM or a connection leaks per deploy (the finalize-producer
    // rule, extended).
    for (const name of ['llm-health-probe', 'world-gen', 'session-prep', 'campaign-setup']) {
      const q = queueInstances.find((instance) => instance.name === name)
      expect(q?.close, `queue ${name} close`).toHaveBeenCalled()
    }
    expect(pgEndMock).toHaveBeenCalledTimes(1)
    expect(batchQuitMock).toHaveBeenCalledTimes(1)
    expect(realtimeQuitMock).toHaveBeenCalledTimes(1)
    // myth-y2qfi: graceful shutdown detaches the escape-guard listeners, so the
    // process returns to its pre-boot listener baseline (no per-reload leak).
    expect(process.listenerCount('unhandledRejection')).toBe(baseUnhandled)
    expect(process.listenerCount('uncaughtException')).toBe(baseUncaught)
  })

  // llm-outage-resilience §1.4: the boot wiring that makes the outage tracker
  // exist in production — main() must bind the ai.ts connectivity sink to the
  // tracker's report(). Regression pin: the feature once shipped with
  // setLlmHealthSink having ZERO production callers, leaving the sink a
  // silent no-op; this test fails if the binding ever drops out of boot.
  it('binds the ai.ts llm-health sink to tracker.report at boot (§1.4)', async () => {
    const { main } = await import('../worker.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const report = vi.fn((): Promise<void> => Promise.resolve())
    const fakeTracker: LlmHealthTracker = {
      report,
      read: () => Promise.resolve({ state: 'ok', since: null }),
      readModels: () => Promise.resolve([]),
      probeSuccess: () => Promise.resolve('counting' as const),
      probeFailure: () => Promise.resolve(),
      markPromotePending: () => Promise.resolve(),
      clearPromotePending: () => Promise.resolve(),
      hasPromotePending: () => Promise.resolve(false),
    }
    vi.spyOn(llmHealthModule, 'createLlmHealthTracker').mockReturnValue(fakeTracker)
    const setSinkSpy = vi.spyOn(aiModule, 'setLlmHealthSink')

    void main() // never awaited — main blocks forever on Promise<never>
    await vi.waitFor(() => {
      expect(healthArmMock).toHaveBeenCalled()
    })

    expect(setSinkSpy).toHaveBeenCalledTimes(1)
    const sink = setSinkSpy.mock.calls[0]?.[0]
    expect(sink).toBeTypeOf('function')
    // Drive the captured sink with a connectivity report and assert it lands
    // on tracker.report — the binding, not just "a function was registered".
    const connectivityReport = {
      callsite: 'world_and_factions',
      jobId: 'job-1',
      modelId: 'test-model',
      mode: 'streaming',
      failureClass: 'connectivity',
    } as const
    await sink?.(connectivityReport)
    expect(report).toHaveBeenCalledWith(connectivityReport)

    process.emit('SIGTERM', 'SIGTERM' as NodeJS.Signals)
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0)
    })
  })

  it('honors WORKER_HEALTH_PORT (local-dev escape hatch for a :3001 collision)', async () => {
    vi.stubEnv('WORKER_HEALTH_PORT', '3901')
    const { main } = await import('../worker.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    void main() // never awaited — main blocks forever on Promise<never>

    // Wait on arm(), not on the bind: myth-jykft moved the bind to the TOP of
    // main(), so a bind-only wait would fire the SIGTERM below before the
    // signal handlers exist. arm() is the last step of boot.
    await vi.waitFor(() => {
      expect(healthArmMock).toHaveBeenCalled()
    })
    expect(startHealthServerMock).toHaveBeenCalledWith(3901)

    process.emit('SIGTERM', 'SIGTERM' as NodeJS.Signals)
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0)
    })
    vi.unstubAllEnvs()
  })

  // myth-jykft: the duplicate-consumer guard. A second worker on the same host
  // loses the health-port bind and must refuse to boot LOUDLY — silently
  // registering as a competing consumer is the bug.
  it('refuses to boot when the health port is taken, registering NO queue consumer', async () => {
    const { main } = await import('../worker.js')
    const { logger } = await import('../llm/logger.js')
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const baseUnhandled = process.listenerCount('unhandledRejection')
    startHealthServerMock.mockRejectedValueOnce(
      Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:3001'), {
        code: 'EADDRINUSE',
      }),
    )

    void main() // never awaited — myth-ha6qr routes the throw to a non-zero exit

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    // The whole point: nothing consumed a queue before the port check.
    expect(workerInstances).toHaveLength(0)
    // Loud, and classified as a config error rather than a transient.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'worker.health_port_in_use', healthPort: 3001 }),
      expect.stringContaining('already in use'),
    )
    // The bind precedes the escape-guard install, so the EADDRINUSE throw fails
    // the process instead of being contained into a consumer-less zombie.
    expect(process.listenerCount('unhandledRejection')).toBe(baseUnhandled)
  })

  // myth-ha6qr: a boot-phase failure — a bad Voyage key, an unreachable Redis,
  // an unreadable cost-cap row — must EXIT NON-ZERO. Before the fix the escape
  // guard was installed at the TOP of main(), and it is keep-alive by default,
  // so the probe's rejection was contained: the process sat half-live and
  // silent (health bound but never armed, zero queue consumers, no crash). In
  // ECS the health check eventually noticed; locally it just hung.
  it('exits non-zero on a boot-probe failure, closing every partial client', async () => {
    const { main } = await import('../worker.js')
    const { logger } = await import('../llm/logger.js')
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const baseUnhandled = process.listenerCount('unhandledRejection')
    const baseUncaught = process.listenerCount('uncaughtException')

    // Captured INSIDE the probe: the escape guard must not be installed while a
    // boot probe is in flight, or the rejection below is swallowed keep-alive.
    let unhandledListenersDuringProbe = -1
    vi.mocked(probeVoyageAtBoot).mockImplementationOnce(() => {
      unhandledListenersDuringProbe = process.listenerCount('unhandledRejection')
      return Promise.reject(
        Object.assign(new Error('voyage returned dimension 512, expected 1024'), {
          code: 'voyage_config',
        }),
      )
    })

    void main() // never awaited — the boot catch exits the process

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    expect(unhandledListenersDuringProbe).toBe(baseUnhandled)
    // The probe runs before any worker registration, so nothing consumed a queue.
    expect(workerInstances).toHaveLength(0)
    // Loud, and the logged error is the SECRET-FREE descriptor — the stable
    // scalars only, no `stack`, no `cause`, no `diagnostic.rawTextSnippet`.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'worker.boot_failed',
        err: {
          name: 'Error',
          code: 'voyage_config',
          terminal: false,
          message: 'voyage returned dimension 512, expected 1024',
        },
      }),
      expect.stringContaining('boot failed'),
    )
    // Partial cleanup: the bound health socket is released (so a restart can
    // rebind it) and pg + both Redis clients are closed.
    expect(healthCloseMock).toHaveBeenCalledTimes(1)
    expect(pgEndMock).toHaveBeenCalledTimes(1)
    expect(batchQuitMock).toHaveBeenCalledTimes(1)
    expect(realtimeQuitMock).toHaveBeenCalledTimes(1)
    // No leaked process listeners from the failed boot.
    expect(process.listenerCount('unhandledRejection')).toBe(baseUnhandled)
    expect(process.listenerCount('uncaughtException')).toBe(baseUncaught)
  })
})
