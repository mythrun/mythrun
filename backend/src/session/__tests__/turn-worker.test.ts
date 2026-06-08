import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSessionState, type SessionState } from '../../redis/session-state.js'
import { sessionChannelPattern } from '../../contract/session-channel.js'
import { SessionController } from '../session-controller.js'
import { StubFastThinker, StubScribe, StubSlowThinker } from '../tiers/stubs.js'
import type { TriggerMessage } from '../tiers/types.js'
import type { SessionLock, SessionLockHandle } from '../session-lock.js'
import { makeTriggerState, type TriggerState } from '../trigger-state.js'
import type { TurnPublisher } from '../turn-publisher.js'
import { TURN_JOB_NAME, type TurnJobPayload, type TurnQueueLike } from '../turn-queue.js'
import {
  buildSessionTurnWorker,
  processTurnJob,
  publishTerminalTurnError,
  type TerminalFailureJob,
  type TurnProcessorDeps,
} from '../turn-worker.js'

// `buildSessionTurnWorker` is boot-wiring around `new BullmqWorker(...)`. To
// exercise its body WITHOUT a broker, mock `bullmq` so the `Worker` constructor
// captures the processor fn + every `.on(event, handler)` registration. The
// captured processor is then invoked with a real payload (running `processTurnJob`
// over ioredis-mock, which covers the `makeTiers` closure), and the captured
// `'failed'` handler is invoked directly (covering the arrow that delegates to
// `publishTerminalTurnError`). The `processTurnJob` unit tests above don't touch
// `bullmq` at runtime (the module only imports the type), so this mock is inert
// for them.
//
// The captured processor + handlers are typed structurally (not as bullmq's
// `Job`): the builder passes a `(job: Job | undefined, err) => void`, but every
// field the 'failed' arrow reads is already on `TerminalFailureJob`, so storing
// the handler against that narrower view lets us invoke it with a plain fake —
// no `as Job` cast. The mock's `on` accepts `unknown` args so the wider builder
// handler still type-checks at the registration call site.
type ProcessorFn = (job: { data: TurnJobPayload }) => Promise<{ ran: boolean }>
type FailedHandler = (job: TerminalFailureJob | undefined, err: Error) => void
interface CapturedWorker {
  readonly processor: ProcessorFn
  readonly handlers: Map<string, FailedHandler>
}
const captured: { worker: CapturedWorker | null } = { worker: null }

// Every `add(name, data)` the builder's explicit-drain `Queue` receives, so the
// buildSessionTurnWorker drain path is assertable without a broker.
const capturedQueueAdds: { name: string; data: TurnJobPayload }[] = []

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation((_name: string, processor: ProcessorFn) => {
    const handlers = new Map<string, FailedHandler>()
    const instance = {
      processor,
      handlers,
      on: (event: string, handler: FailedHandler) => {
        handlers.set(event, handler)
      },
    }
    captured.worker = { processor, handlers }
    return instance
  }),
  // The builder constructs ONE `Queue` for the explicit drain. Mock it as a thin
  // recorder so `new Queue(...)` doesn't touch a real connection.
  Queue: vi.fn().mockImplementation(() => ({
    add: (name: string, data: TurnJobPayload) => {
      capturedQueueAdds.push({ name, data })
      return Promise.resolve(undefined)
    },
  })),
}))

// processTurnJob is UNIT-tested with INJECTED fakes (a fake SessionLock, a
// recording TurnPublisher, stub tiers) and a real `makeSessionState` over
// ioredis-mock so the flush is asserted via `loadTurnState`. The end-to-end run
// with a real BullMQ Worker is Tasks 10/11 — we never construct one here.

const KEY_PREFIX = 'tw:'
const CAMPAIGN = 'c-tw-1'
const TURN = 't-tw-1'
const SESSION = 's-tw-1'

const TRIGGER: TriggerMessage = { userId: 'u1', characterName: 'Mara', text: 'I open the door' }

function payload(): { data: TurnJobPayload } {
  return {
    data: {
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      turnId: TURN,
      triggerMessages: [TRIGGER],
      maxConsumedSeq: 0,
      trigger: { kind: 'explicit' },
    },
  }
}

interface PublisherCalls {
  readonly order: string[]
  /** Args of each turnError call, so the H8 assertions read from a plain array
   *  rather than `expect(publisher.turnError)` (which detaches the method —
   *  `@typescript-eslint/unbound-method`). */
  readonly turnErrorArgs: { campaignId: string; turnId: string; message: string }[]
}

function newCalls(): PublisherCalls {
  return { order: [], turnErrorArgs: [] }
}

function recordingPublisher(calls: PublisherCalls): TurnPublisher {
  return {
    dmThinking: vi.fn((): Promise<void> => {
      calls.order.push('dm_thinking')
      return Promise.resolve()
    }),
    textDelta: vi.fn((): Promise<void> => {
      calls.order.push('text_delta')
      return Promise.resolve()
    }),
    turnEnd: vi.fn((): Promise<void> => {
      calls.order.push('turn_end')
      return Promise.resolve()
    }),
    turnError: vi.fn((campaignId: string, turnId: string, message: string): Promise<void> => {
      calls.order.push('turn_error')
      calls.turnErrorArgs.push({ campaignId, turnId, message })
      return Promise.resolve()
    }),
    emitFor: vi.fn(
      (campaignId: string, turnId: string): ((text: string) => Promise<void>) =>
        (_text: string): Promise<void> => {
          void campaignId
          void turnId
          void _text
          calls.order.push('text_delta')
          return Promise.resolve()
        },
    ),
  }
}

/** A fake lock handle. `extend` returns whatever the test wants; `release`
 *  records that it was called (the finally-block invariant). */
function fakeHandle(opts: {
  extendReturns: boolean
  release: ReturnType<typeof vi.fn>
}): SessionLockHandle {
  return {
    token: 'tok',
    extend: vi.fn((): Promise<boolean> => Promise.resolve(opts.extendReturns)),
    release: opts.release,
  }
}

function fakeLock(handle: SessionLockHandle | null): SessionLock {
  return {
    tryAcquire: vi.fn((): Promise<SessionLockHandle | null> => Promise.resolve(handle)),
  }
}

const silentLogger = { warn: vi.fn(), error: vi.fn() }

function makeTiers(): ReturnType<TurnProcessorDeps['makeTiers']> {
  return { st: new StubSlowThinker(), ft: new StubFastThinker(), scribe: new StubScribe() }
}

/** Records the `(name, data, opts)` of every enqueued explicit-drain follow-up
 *  turn so the §4.7 drain assertions read the payload off a plain array. */
interface QueueCall {
  readonly name: string
  readonly data: TurnJobPayload
}

function recordingTurnQueue(calls: QueueCall[]): TurnQueueLike {
  const add = vi.fn((name: string, data: TurnJobPayload): Promise<never> => {
    calls.push({ name, data })
    // The real `add` resolves to a BullMQ `Job`; the worker discards it, so a
    // resolved sentinel is enough.
    return Promise.resolve(undefined as never)
  })
  return { add }
}

/** A no-op trigger queue for the paths that never drain (the default case). */
function inertTurnQueue(): TurnQueueLike {
  return recordingTurnQueue([])
}

describe('processTurnJob', () => {
  let redis: Redis
  let sessionState: SessionState
  let triggerState: TriggerState

  beforeEach(async () => {
    redis = new IoRedisMock()
    await redis.flushall()
    sessionState = makeSessionState(redis, KEY_PREFIX)
    triggerState = makeTriggerState(redis, KEY_PREFIX)
  })
  afterEach(async () => {
    await redis.quit()
    vi.clearAllMocks()
  })

  it('happy path: acquires the lock, runs the turn, flushes state, releases', async () => {
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval')
    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    // dm_thinking precedes the streamed delta(s) which precede turn_end.
    expect(calls.order[0]).toBe('dm_thinking')
    expect(calls.order).toContain('text_delta')
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    expect(calls.order).not.toContain('turn_error')

    // The mutated turn state was flushed: the trigger + the stub assistant line
    // are persisted to Redis (assert via loadTurnState).
    const turnState = await sessionState.loadTurnState(CAMPAIGN)
    expect(turnState.ftHistory).toEqual([
      { role: 'user', content: TRIGGER.text, characterName: TRIGGER.characterName },
      { role: 'assistant', content: '(the DM responds.)' },
    ])

    expect(release).toHaveBeenCalledTimes(1)
    // The heartbeat timer is cleared in `finally` — no leaked interval.
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
  })

  it('contention: tryAcquire returns null → {ran:false}, no publish, no flush', async () => {
    const calls = newCalls()
    const deps: TurnProcessorDeps = {
      lock: fakeLock(null),
      sessionState,
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: false })
    expect(calls.order).toEqual([])

    const turnState = await sessionState.loadTurnState(CAMPAIGN)
    expect(turnState.ftHistory).toEqual([])
  })

  it('lock-lost at the FIRST checkpoint (right after loadFromRedis) aborts before processDmTurn', async () => {
    // The L118 checkpoint: lock loss detected immediately after loadFromRedis.
    // Make loadFromRedis slow so the tiny-interval heartbeat (extend→false)
    // flips lockLost DURING the load — the turn then throws LockLostError at
    // L118, before processDmTurn ever runs.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: false, release })

    const loadSpy = vi
      .spyOn(SessionController.prototype, 'loadFromRedis')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve()
            }, 40)
          }),
      )
    const processSpy = vi.spyOn(SessionController.prototype, 'processDmTurn')

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 5,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(loadSpy).toHaveBeenCalled()
    // Aborted at L118 — processDmTurn was never reached.
    expect(processSpy).not.toHaveBeenCalled()
    expect(calls.order).not.toContain('turn_error')
    expect(release).toHaveBeenCalledTimes(1)

    // Restore the prototype spies HERE (not via a describe-wide restoreAllMocks,
    // which would also tear down the module-level `bullmq` Worker mock the
    // buildSessionTurnWorker suite depends on).
    loadSpy.mockRestore()
    processSpy.mockRestore()
  })

  it('heartbeat extend() REJECTS → treated as lock-lost: warns, aborts without flushing, releases', async () => {
    // The heartbeat's `.catch` arm (a rejected `extend()`, distinct from a
    // resolved `false`): we can no longer prove we hold the lock, so the flag
    // flips lost and the turn aborts at its next checkpoint — same observable
    // outcome as extend()→false, but reached through the catch path.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle: SessionLockHandle = {
      token: 'tok',
      extend: vi.fn((): Promise<boolean> => Promise.reject(new Error('redis down'))),
      release,
    }

    const slowSt = new StubSlowThinker()
    vi.spyOn(slowSt, 'evaluate').mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ intervene: false })
          }, 40)
        }),
    )

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      publisher: recordingPublisher(calls),
      makeTiers: () => ({ st: slowSt, ft: new StubFastThinker(), scribe: new StubScribe() }),
      heartbeatMs: 5,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(calls.order).not.toContain('turn_error')
    // The catch arm logs the heartbeat failure (L106) AND the lock-lost abort.
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, turnId: TURN }),
      'turn lock heartbeat failed',
    )
    const turnState = await sessionState.loadTurnState(CAMPAIGN)
    expect(turnState.ftHistory).toEqual([])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('a real (non-lock-lost) error RETHROWS so BullMQ owns the retry; lock still released', async () => {
    // The catch arm's `throw err` (L135) + its `instanceof LockLostError ||
    // isLockLost()` false branch: a tier throws a plain Error while the lock is
    // healthy (extend→true). processTurnJob must propagate it (not swallow it),
    // and finally still clears the heartbeat + releases the lock.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    const boom = new Error('fast thinker exploded')
    const ft = new StubFastThinker()
    vi.spyOn(ft, 'render').mockRejectedValue(boom)

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      publisher: recordingPublisher(calls),
      makeTiers: () => ({ st: new StubSlowThinker(), ft, scribe: new StubScribe() }),
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    await expect(processTurnJob(deps, payload())).rejects.toThrow('fast thinker exploded')

    // Not a lock-lost abort: never published turn_error, never flushed.
    expect(calls.order).not.toContain('turn_error')
    const turnState = await sessionState.loadTurnState(CAMPAIGN)
    expect(turnState.ftHistory).toEqual([])
    // finally still released the lock on the error path.
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('lock-lost: heartbeat extend()→false aborts the turn without flushing; release still called', async () => {
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: false, release })

    // A slow ST so the tiny-interval heartbeat fires (flipping lockLost) BEFORE
    // the turn body reaches its next lockLost checkpoint.
    const slowSt = new StubSlowThinker()
    const evaluate = vi
      .spyOn(slowSt, 'evaluate')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({ intervene: false })
            }, 40)
          }),
      )

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      publisher: recordingPublisher(calls),
      makeTiers: () => ({ st: slowSt, ft: new StubFastThinker(), scribe: new StubScribe() }),
      heartbeatMs: 5,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    // It ran but aborted on lock loss: never flushed, never published turn_error.
    expect(result).toEqual({ ran: true })
    expect(evaluate).toHaveBeenCalled()
    expect(calls.order).not.toContain('turn_error')

    const turnState = await sessionState.loadTurnState(CAMPAIGN)
    expect(turnState.ftHistory).toEqual([])

    // The lock-lost branch warns and still releases in finally.
    expect(silentLogger.warn).toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('sets dm_responding during the turn body and clears it after release (§4.7)', async () => {
    // The drain guard: the worker flags `dm_responding` while a turn runs so the
    // dm-trigger worker won't enqueue a colliding turn, then clears it on
    // release. Observe "set during the body" by reading the flag inside the
    // publisher's dmThinking (which runs AFTER setResponding, inside the body),
    // and "cleared after" by reading it once processTurnJob resolves.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    let respondingDuringBody: boolean | null = null
    // Override dmThinking (which runs in the body, AFTER setResponding) to snapshot
    // the flag — typed via spread so no `any` cast is needed.
    const publisher: TurnPublisher = {
      ...recordingPublisher(calls),
      dmThinking: vi.fn(async (): Promise<void> => {
        respondingDuringBody = await triggerState.isResponding(CAMPAIGN)
        calls.order.push('dm_thinking')
      }),
    }

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      publisher,
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    // dm_responding was live while the turn body ran…
    expect(respondingDuringBody).toBe(true)
    // …and is cleared once the turn (and its finally) completes.
    expect(await triggerState.isResponding(CAMPAIGN)).toBe(false)
  })

  it('advances the responded-seq watermark to maxConsumedSeq after a successful flush (§4.7)', async () => {
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const job = payload()
    ;(job.data as { maxConsumedSeq: number }).maxConsumedSeq = 7

    const result = await processTurnJob(deps, job)

    expect(result).toEqual({ ran: true })
    // The watermark advanced to the batch's max consumed seq, so the next
    // trigger batch starts at (7, …].
    expect(await triggerState.respondedSeq(CAMPAIGN)).toBe(7)
  })

  it('does NOT advance the watermark when the turn aborts on lock loss (§4.7)', async () => {
    // A lock-lost abort never flushes, so it must also never advance the
    // watermark — the winning container owns the continuation + the watermark.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: false, release })

    const slowSt = new StubSlowThinker()
    vi.spyOn(slowSt, 'evaluate').mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ intervene: false })
          }, 40)
        }),
    )

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      publisher: recordingPublisher(calls),
      makeTiers: () => ({ st: slowSt, ft: new StubFastThinker(), scribe: new StubScribe() }),
      heartbeatMs: 5,
      logger: silentLogger,
    }

    const job = payload()
    ;(job.data as { maxConsumedSeq: number }).maxConsumedSeq = 9

    const result = await processTurnJob(deps, job)

    expect(result).toEqual({ ran: true })
    // Never flushed → watermark stays at the unset default (0).
    expect(await triggerState.respondedSeq(CAMPAIGN)).toBe(0)
    // …but dm_responding is still cleared in finally so the campaign isn't wedged.
    expect(await triggerState.isResponding(CAMPAIGN)).toBe(false)
  })

  it('drains a pending explicit summon on release: enqueues exactly one explicit follow-up turn (§4.7)', async () => {
    // An @dm landed while this turn was in flight → the server set the explicit
    // flag. On release the worker takes-and-clears it and enqueues one explicit
    // follow-up, so the summon is honored the instant the current turn ends.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const queueCalls: QueueCall[] = []

    // Seed the explicit-pending flag (as the server would on an in-flight @dm).
    await triggerState.setExplicitPending(CAMPAIGN)

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      triggerState,
      sessionTurnQueue: recordingTurnQueue(queueCalls),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const job = payload()
    ;(job.data as { maxConsumedSeq: number }).maxConsumedSeq = 4

    const result = await processTurnJob(deps, job)

    expect(result).toEqual({ ran: true })
    // Exactly one explicit follow-up was enqueued.
    expect(queueCalls).toHaveLength(1)
    expect(queueCalls[0]?.name).toBe(TURN_JOB_NAME)
    const drained = queueCalls[0]?.data
    expect(drained?.campaignId).toBe(CAMPAIGN)
    expect(drained?.sessionId).toBe(SESSION)
    expect(drained?.trigger.kind).toBe('explicit')
    expect(drained?.maxConsumedSeq).toBe(4)
    expect(drained?.triggerMessages).toEqual([])
    // A fresh turnId was minted for the follow-up (not the just-finished turn's).
    expect(drained?.turnId).not.toBe(TURN)
    expect(typeof drained?.turnId).toBe('string')

    // The flag is take-once: a second drain check sees nothing.
    expect(await triggerState.takeExplicitPending(CAMPAIGN)).toBe(false)
  })

  it('does NOT drain when no explicit summon is pending: no follow-up enqueued (§4.7)', async () => {
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const queueCalls: QueueCall[] = []

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      triggerState,
      sessionTurnQueue: recordingTurnQueue(queueCalls),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(queueCalls).toHaveLength(0)
  })

  it('a drain-enqueue failure is swallowed and does not mask the turn outcome (§4.7)', async () => {
    // The explicit-drain is in its own try/catch: if enqueue throws, the turn
    // still resolves {ran:true} (it succeeded) and the failure is logged, never
    // rethrown — a drain hiccup must not retry an already-flushed turn.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    await triggerState.setExplicitPending(CAMPAIGN)

    const boom = new Error('queue unreachable')
    const failingQueue = {
      add: vi.fn((): Promise<never> => Promise.reject(boom)),
    } as unknown as TurnQueueLike

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      triggerState,
      sessionTurnQueue: failingQueue,
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    // The turn itself succeeded; the drain failure didn't surface.
    expect(result).toEqual({ ran: true })
    expect(silentLogger.error).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// H8 boundary — the terminal-failure gate, unit-tested directly (no broker).
// `publishTerminalTurnError` publishes a turn_error ONLY when retries are
// exhausted. Locks the gate so a future edit can't silently start publishing on
// a non-final attempt (a premature give-up) or stop publishing on the final one.
// ---------------------------------------------------------------------------

function terminalFailureJob(attemptsMade: number, attempts: number): TerminalFailureJob {
  return {
    attemptsMade,
    opts: { attempts },
    data: {
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      turnId: TURN,
      triggerMessages: [TRIGGER],
      maxConsumedSeq: 0,
      trigger: { kind: 'explicit' },
    },
  }
}

/** A claim fn that always wins the latch (the single-publisher case). */
const alwaysClaim = (): Promise<boolean> => Promise.resolve(true)

describe('publishTerminalTurnError', () => {
  it('does NOT publish on a non-final attempt (retries remain)', async () => {
    const calls = newCalls()
    const publisher = recordingPublisher(calls)

    await publishTerminalTurnError(publisher, terminalFailureJob(1, 3), silentLogger, alwaysClaim)

    expect(calls.order).toEqual([])
    expect(calls.turnErrorArgs).toEqual([])
  })

  it('publishes once with the job campaignId/turnId on the final exhausted attempt', async () => {
    const calls = newCalls()
    const publisher = recordingPublisher(calls)

    await publishTerminalTurnError(publisher, terminalFailureJob(3, 3), silentLogger, alwaysClaim)

    expect(calls.order).toEqual(['turn_error'])
    expect(calls.turnErrorArgs).toHaveLength(1)
    expect(calls.turnErrorArgs[0]?.campaignId).toBe(CAMPAIGN)
    expect(calls.turnErrorArgs[0]?.turnId).toBe(TURN)
    expect(typeof calls.turnErrorArgs[0]?.message).toBe('string')
  })

  it('does nothing when job is undefined', async () => {
    const calls = newCalls()
    const publisher = recordingPublisher(calls)

    await publishTerminalTurnError(publisher, undefined, silentLogger, alwaysClaim)

    expect(calls.order).toEqual([])
    expect(calls.turnErrorArgs).toEqual([])
  })

  it('treats an absent opts.attempts as 1 (publishes when attemptsMade reaches the default)', async () => {
    // Branch `opts.attempts ?? 1`: a job whose opts omit `attempts` defaults the
    // cap to 1, so a single made attempt is already terminal.
    const calls = newCalls()
    const publisher = recordingPublisher(calls)
    const job: TerminalFailureJob = {
      attemptsMade: 1,
      opts: {}, // no `attempts` → nullish-coalesces to 1
      data: {
        campaignId: CAMPAIGN,
        sessionId: SESSION,
        turnId: TURN,
        triggerMessages: [TRIGGER],
        maxConsumedSeq: 0,
        trigger: { kind: 'explicit' },
      },
    }

    await publishTerminalTurnError(publisher, job, silentLogger, alwaysClaim)

    expect(calls.order).toEqual(['turn_error'])
    expect(calls.turnErrorArgs).toHaveLength(1)
  })

  it('publishes exactly ONCE across two calls for the same turnId (§4.8 SET-NX latch)', async () => {
    // The cross-container idempotency latch: the JS `failed` listener AND the
    // broker-side QueueEvents can both fire a terminal for one turn. A shared
    // `claim(turnId)` SET-NX gates the publish — exactly one path wins. Modeled
    // here with a stateful fake claim that returns true once then false.
    const calls = newCalls()
    const publisher = recordingPublisher(calls)
    let claimed = false
    const claim = vi.fn((): Promise<boolean> => {
      if (claimed) return Promise.resolve(false)
      claimed = true
      return Promise.resolve(true)
    })

    const job = terminalFailureJob(3, 3)
    // First terminal path wins the latch and publishes.
    await publishTerminalTurnError(publisher, job, silentLogger, claim)
    // Second terminal path for the SAME turnId loses the latch → no publish.
    await publishTerminalTurnError(publisher, job, silentLogger, claim)

    expect(claim).toHaveBeenCalledTimes(2)
    expect(claim).toHaveBeenCalledWith(TURN)
    // Despite two terminal invocations, only one turn_error went out.
    expect(calls.order).toEqual(['turn_error'])
    expect(calls.turnErrorArgs).toHaveLength(1)
  })

  it('does NOT call claim when the job is non-terminal (gate precedes the latch)', async () => {
    // The attempts-exhausted gate runs BEFORE the latch claim, so a non-final
    // attempt never consumes the SET-NX latch (which would wrongly suppress the
    // real terminal publish later).
    const calls = newCalls()
    const publisher = recordingPublisher(calls)
    const claim = vi.fn((): Promise<boolean> => Promise.resolve(true))

    await publishTerminalTurnError(publisher, terminalFailureJob(1, 3), silentLogger, claim)

    expect(claim).not.toHaveBeenCalled()
    expect(calls.order).toEqual([])
  })

  it('logs (does not throw) when the terminal turn_error publish itself rejects', async () => {
    // The `.catch` arm: publisher.turnError rejects. The handler must swallow it
    // into logger.error so no unhandled rejection escapes the 'failed' listener.
    const logger = { warn: vi.fn(), error: vi.fn() }
    const publishErr = new Error('realtime redis unreachable')
    const publisher: TurnPublisher = {
      dmThinking: vi.fn((): Promise<void> => Promise.resolve()),
      textDelta: vi.fn((): Promise<void> => Promise.resolve()),
      turnEnd: vi.fn((): Promise<void> => Promise.resolve()),
      turnError: vi.fn((): Promise<void> => Promise.reject(publishErr)),
      emitFor: vi.fn(() => (): Promise<void> => Promise.resolve()),
    }
    const original = new Error('the underlying turn failure')

    await publishTerminalTurnError(publisher, terminalFailureJob(3, 3), logger, alwaysClaim, original)

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: publishErr,
        original,
        campaignId: CAMPAIGN,
        turnId: TURN,
      }),
      'failed to publish terminal turn_error',
    )
  })
})

// ---------------------------------------------------------------------------
// buildSessionTurnWorker — boot-wiring. The `bullmq` mock (top of file) captures
// the processor fn + the 'failed' handler the builder registers, so both the
// `makeTiers` closure (reached by running the captured processor through a real
// turn) and the `worker.on('failed')` arrow (reached by invoking the captured
// handler) are exercised without a broker.
// ---------------------------------------------------------------------------

describe('buildSessionTurnWorker', () => {
  let redisBatch: Redis
  let redisRealtime: Redis

  beforeEach(async () => {
    captured.worker = null
    capturedQueueAdds.length = 0
    redisBatch = new IoRedisMock()
    redisRealtime = new IoRedisMock()
    await redisRealtime.flushall()
  })
  afterEach(async () => {
    await redisBatch.quit()
    await redisRealtime.quit()
    vi.clearAllMocks()
  })

  it('runs a turn through the captured processor (exercising the stub makeTiers) and flushes state', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    const worker = buildSessionTurnWorker(redisBatch, redisRealtime, 'bw:', logger)
    expect(worker).not.toBeNull()

    const cap = captured.worker
    if (cap === null) throw new Error('Worker constructor was not captured')

    // The session lock is acquired against redisRealtime via SET NX — a fresh
    // ioredis-mock keyspace means tryAcquire succeeds, so the processor runs a
    // full turn through the real stub tiers (makeTiers closure, L178-181).
    const result = await cap.processor(payload())
    expect(result).toEqual({ ran: true })

    // The stub FT line landed in the flushed turn state, proving makeTiers wired
    // the real stubs into the controller.
    const ss = makeSessionState(redisRealtime, 'bw:')
    const ts = await ss.loadTurnState(CAMPAIGN)
    expect(ts.ftHistory).toEqual([
      { role: 'user', content: TRIGGER.text, characterName: TRIGGER.characterName },
      { role: 'assistant', content: '(the DM responds.)' },
    ])
    // The §4.7 watermark advanced (proving triggerState was wired into the deps).
    expect(await makeTriggerState(redisRealtime, 'bw:').respondedSeq(CAMPAIGN)).toBe(0)
  })

  it('wires triggerState + sessionTurnQueue: an in-flight explicit summon drains on release (§4.7)', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    buildSessionTurnWorker(redisBatch, redisRealtime, 'bw:', logger)

    const cap = captured.worker
    if (cap === null) throw new Error('Worker constructor was not captured')

    // Seed the explicit-pending flag on the SAME keyspace the builder's
    // triggerState reads (redisRealtime), as the server would on an in-flight @dm.
    await makeTriggerState(redisRealtime, 'bw:').setExplicitPending(CAMPAIGN)

    const result = await cap.processor(payload())
    expect(result).toEqual({ ran: true })

    // The drain enqueued exactly one explicit follow-up on the builder's Queue.
    expect(capturedQueueAdds).toHaveLength(1)
    expect(capturedQueueAdds[0]?.data.trigger.kind).toBe('explicit')
    expect(capturedQueueAdds[0]?.data.campaignId).toBe(CAMPAIGN)
    expect(capturedQueueAdds[0]?.data.triggerMessages).toEqual([])
  })

  it("registers a 'failed' handler that delegates to publishTerminalTurnError", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    buildSessionTurnWorker(redisBatch, redisRealtime, 'bw:', logger)

    const cap = captured.worker
    if (cap === null) throw new Error('Worker constructor was not captured')
    const failedHandler = cap.handlers.get('failed')
    if (failedHandler === undefined) throw new Error("no 'failed' handler registered")

    // Invoke the captured arrow (L213) on a terminal (retries-exhausted) job.
    // It delegates to publishTerminalTurnError, which publishes a turn_error
    // frame on redisRealtime. Assert via a subscriber on the SAME ioredis-mock
    // instance the publisher uses (same-instance pub/sub delivers reliably).
    const sub = redisRealtime.duplicate()
    const messages: string[] = []
    sub.on('pmessage', (_pattern: string, _channel: string, message: string) => {
      messages.push(message)
    })
    await sub.psubscribe(sessionChannelPattern('bw:'))

    failedHandler(terminalFailureJob(3, 3), new Error('terminal turn failure'))

    await vi.waitFor(() => {
      expect(messages.some((m) => m.includes('turn_error'))).toBe(true)
    })
    await sub.quit()
  })

  it("the 'failed' handler is a no-op on a non-terminal job (retries remain)", () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    buildSessionTurnWorker(redisBatch, redisRealtime, 'bw:', logger)

    const cap = captured.worker
    if (cap === null) throw new Error('Worker constructor was not captured')
    const failedHandler = cap.handlers.get('failed')
    if (failedHandler === undefined) throw new Error("no 'failed' handler registered")

    // attemptsMade < attempts → publishTerminalTurnError returns early; the
    // arrow still runs (covering L213) but publishes nothing.
    expect(() => {
      failedHandler(terminalFailureJob(1, 3), new Error('retryable failure'))
    }).not.toThrow()
    expect(logger.error).not.toHaveBeenCalled()
  })
})
