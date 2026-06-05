import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSessionState, type SessionState } from '../../redis/session-state.js'
import { StubFastThinker, StubScribe, StubSlowThinker } from '../tiers/stubs.js'
import type { TriggerMessage } from '../tiers/types.js'
import type { SessionLock, SessionLockHandle } from '../session-lock.js'
import type { TurnPublisher } from '../turn-publisher.js'
import type { TurnJobPayload } from '../turn-queue.js'
import {
  processTurnJob,
  publishTerminalTurnError,
  type TerminalFailureJob,
  type TurnProcessorDeps,
} from '../turn-worker.js'

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
})
