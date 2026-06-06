import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSessionState, type SessionState } from '../../redis/session-state.js'
import { sessionChannelPattern } from '../../contract/session-channel.js'
import { SessionController } from '../session-controller.js'
import { StubFastThinker, StubScribe, StubSlowThinker } from '../tiers/stubs.js'
import type { TriggerMessage } from '../tiers/types.js'
import type { SessionLock, SessionLockHandle } from '../session-lock.js'
import type { TurnPublisher } from '../turn-publisher.js'
import type { TurnJobPayload } from '../turn-queue.js'
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

describe('processTurnJob', () => {
  let redis: Redis
  let sessionState: SessionState

  beforeEach(async () => {
    redis = new IoRedisMock()
    await redis.flushall()
    sessionState = makeSessionState(redis, KEY_PREFIX)
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
    data: { campaignId: CAMPAIGN, sessionId: SESSION, turnId: TURN, triggerMessages: [TRIGGER] },
  }
}

describe('publishTerminalTurnError', () => {
  it('does NOT publish on a non-final attempt (retries remain)', () => {
    const calls = newCalls()
    const publisher = recordingPublisher(calls)

    publishTerminalTurnError(publisher, terminalFailureJob(1, 3), silentLogger)

    expect(calls.order).toEqual([])
    expect(calls.turnErrorArgs).toEqual([])
  })

  it('publishes once with the job campaignId/turnId on the final exhausted attempt', () => {
    const calls = newCalls()
    const publisher = recordingPublisher(calls)

    publishTerminalTurnError(publisher, terminalFailureJob(3, 3), silentLogger)

    expect(calls.order).toEqual(['turn_error'])
    expect(calls.turnErrorArgs).toHaveLength(1)
    expect(calls.turnErrorArgs[0]?.campaignId).toBe(CAMPAIGN)
    expect(calls.turnErrorArgs[0]?.turnId).toBe(TURN)
    expect(typeof calls.turnErrorArgs[0]?.message).toBe('string')
  })

  it('does nothing when job is undefined', () => {
    const calls = newCalls()
    const publisher = recordingPublisher(calls)

    publishTerminalTurnError(publisher, undefined, silentLogger)

    expect(calls.order).toEqual([])
    expect(calls.turnErrorArgs).toEqual([])
  })

  it('treats an absent opts.attempts as 1 (publishes when attemptsMade reaches the default)', () => {
    // Branch L242 `opts.attempts ?? 1`: a job whose opts omit `attempts`
    // defaults the cap to 1, so a single made attempt is already terminal.
    const calls = newCalls()
    const publisher = recordingPublisher(calls)
    const job: TerminalFailureJob = {
      attemptsMade: 1,
      opts: {}, // no `attempts` → nullish-coalesces to 1
      data: { campaignId: CAMPAIGN, sessionId: SESSION, turnId: TURN, triggerMessages: [TRIGGER] },
    }

    publishTerminalTurnError(publisher, job, silentLogger)

    expect(calls.order).toEqual(['turn_error'])
    expect(calls.turnErrorArgs).toHaveLength(1)
  })

  it('logs (does not throw) when the terminal turn_error publish itself rejects', async () => {
    // The `.catch` arm (L247-255): publisher.turnError rejects. The handler must
    // swallow it into logger.error so no unhandled rejection escapes the
    // 'failed' listener. We await a microtask flush so the rejected promise's
    // catch has run before asserting.
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

    publishTerminalTurnError(publisher, terminalFailureJob(3, 3), logger, original)

    // Flush the microtask queue so the rejected turnError's `.catch` runs.
    await Promise.resolve()
    await Promise.resolve()

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
