// Split from the original monolithic turn-worker.test.ts along its thematic
// describe/it seams. Shared pure-mock builders live in ./_helpers/turn-worker-
// harness.ts + ./_helpers/turn-worker-deps.ts. No DB / scoped fixtures here (this
// suite is pure in-memory mocks), so the CONVENTIONS.md isolation pattern is N/A.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { UnrecoverableError } from 'bullmq'
import { type SessionState, makeSessionState } from '../../redis/session-state.js'
import { SessionController } from '../session-controller.js'
import { type TriggerState, makeTriggerState } from '../trigger-state.js'
import { ST_EVAL_JOB_NAME, type StEvalPayload, type StEvalQueueLike } from '../st-eval-queue.js'
import { type TurnProcessorDeps, processTurnJob } from '../turn-worker.js'
import { CAMPAIGN, KEY_PREFIX, SESSION, TURN, fakeHandle, fakeLock, fakeRepo, installSlowProcessDmTurn, makeTiers, newCalls, payload, recordingPublisher, silentLogger } from './_helpers/turn-worker-harness.js'
import { type StEvalCall, inertCombatLedger, inertDmTriggerQueue, inertEndSession, inertFinalize, inertLedgerTx, inertScribeQueue, inertStEvalQueue, inertTurnQueue, recordingStEvalQueue } from './_helpers/turn-worker-deps.js'

vi.mock('bullmq', () => ({
  Worker: vi.fn(),
  Queue: vi.fn(),
  // The §5 latch-terminal arm throws `UnrecoverableError`; the processor + tests
  // both reference it, so the mock exports a real throwable subclass (not a bare
  // vi.fn) so `instanceof` checks hold. This suite never constructs a Worker/Queue.
  UnrecoverableError: class UnrecoverableError extends Error {},
}))

describe('processTurnJob — direction slots & st-eval', () => {
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

  it('fresh run takes the one-shot direction (GETDEL) and READS the standing directive (§6)', async () => {
    // The fresh-run arm resolves both direction slots AFTER the converge/latch
    // exits and passes them into the controller deps. Seed both on the trigger
    // state; capture what the controller received.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    await triggerState.setOneShotDirection(CAMPAIGN, 'D')
    await triggerState.setStandingDirection(CAMPAIGN, 'S')

    const captureSpy = vi.spyOn(SessionController.prototype, 'loadFromRedis')

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: inertScribeQueue(),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    // The controller was constructed with both slots threaded in. `this.deps` is
    // captured off the controller instance the spy's `this` is bound to.
    const ctorDeps = (captureSpy.mock.instances[0] as unknown as {
      deps: { pendingDirection?: string; standingDirective?: string }
    }).deps
    expect(ctorDeps.pendingDirection).toBe('D')
    expect(ctorDeps.standingDirective).toBe('S')

    // The one-shot was CONSUMED (GETDEL): a second read sees nothing.
    expect(await triggerState.takeOneShotDirection(CAMPAIGN)).toBeNull()
    // The standing directive was READ, not cleared — it survives the turn.
    expect(await triggerState.readStandingDirection(CAMPAIGN)).toBe('S')

    captureSpy.mockRestore()
  })

  it('the converge path does NOT take the one-shot direction (a take on a non-rendering path burns a reveal, §6)', async () => {
    // A take before the converge exit would consume a sanctioned one-shot reveal
    // on a turn that never renders. The converge arm must leave the slot intact.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    await triggerState.setOneShotDirection(CAMPAIGN, 'D')

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({ turnRowsExist: true }),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: inertScribeQueue(),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(calls.order).toEqual(['turn_end'])
    // The one-shot was NOT consumed by the converge path — it survives.
    expect(await triggerState.takeOneShotDirection(CAMPAIGN)).toBe('D')
  })

  it('the latch-terminal path does NOT take the one-shot direction (§6)', async () => {
    // The §5 latch-terminal exits before the fresh-run take, so a streamed-but-
    // uncommitted turn leaves the one-shot intact for the next real render.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    await triggerState.setOneShotDirection(CAMPAIGN, 'D')
    await triggerState.markTurnEmitted(TURN)

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({ turnRowsExist: false }),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: inertScribeQueue(),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    await expect(processTurnJob(deps, payload())).rejects.toBeInstanceOf(UnrecoverableError)
    // The one-shot survives the terminal.
    expect(await triggerState.takeOneShotDirection(CAMPAIGN)).toBe('D')
  })

  it('a contention loser (no lock) does NOT take the one-shot direction (§6)', async () => {
    const calls = newCalls()

    await triggerState.setOneShotDirection(CAMPAIGN, 'D')

    const deps: TurnProcessorDeps = {
      lock: fakeLock(null),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: inertScribeQueue(),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: false })
    // A contention loser never renders, so it never burns the one-shot — it
    // survives for the lock holder.
    expect(await triggerState.takeOneShotDirection(CAMPAIGN)).toBe('D')
  })

  it('a flushed success bumps the ST floor counter, then enqueues the st-evaluation, after the watermark (§2/§8)', async () => {
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const stEvalCalls: StEvalCall[] = []

    // Record the relative order of the watermark advance, the floor-counter bump,
    // and the enqueue.
    const order: string[] = []
    const recordingTrigger: TriggerState = {
      ...triggerState,
      setRespondedSeq: vi.fn((c: string, seq: number): Promise<void> => {
        order.push('watermark')
        return triggerState.setRespondedSeq(c, seq)
      }),
      incrTurnsSinceSt: vi.fn((c: string): Promise<number> => {
        order.push('incr')
        return triggerState.incrTurnsSinceSt(c)
      }),
    }
    const stEvalQueue: StEvalQueueLike = {
      add: vi.fn((name: string, data: StEvalPayload): Promise<never> => {
        order.push('enqueue')
        stEvalCalls.push({ name, data })
        return Promise.resolve(undefined as never)
      }),
    }

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState: recordingTrigger,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue,
      scribeQueue: inertScribeQueue(),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    // The §2 enqueue carries the campaign + session ids.
    expect(stEvalCalls).toHaveLength(1)
    expect(stEvalCalls[0]?.name).toBe(ST_EVAL_JOB_NAME)
    expect(stEvalCalls[0]?.data).toEqual({ campaignId: CAMPAIGN, sessionId: SESSION })
    // Order: watermark (setRespondedSeq) → floor bump → enqueue.
    expect(order).toEqual(['watermark', 'incr', 'enqueue'])
  })

  it('the converge path does NOT enqueue an st-evaluation (only a fresh flushed turn has an FT response, §2)', async () => {
    // Converge advances the watermark but does NOT enqueue — there is no fresh FT
    // response to evaluate.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const stEvalCalls: StEvalCall[] = []

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({ turnRowsExist: true }),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: recordingStEvalQueue(stEvalCalls),
      scribeQueue: inertScribeQueue(),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(calls.order).toEqual(['turn_end'])
    expect(stEvalCalls).toHaveLength(0)
  })

  it('a lock-lost abort does NOT enqueue an st-evaluation (no fresh FT response, §2)', async () => {
    // A lock-lost run never flushes, so the gated enqueue never fires.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: false, release })
    const stEvalCalls: StEvalCall[] = []

    const processSpy = installSlowProcessDmTurn()

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: recordingStEvalQueue(stEvalCalls),
      scribeQueue: inertScribeQueue(),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 5,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(calls.order).not.toContain('turn_end')
    expect(stEvalCalls).toHaveLength(0)

    processSpy.mockRestore()
  })

  it('an st-evaluation enqueue failure is isolated: logged, turn still returns {ran:true} (§2)', async () => {
    // The enqueue is in its own try/catch — an enqueue hiccup never masks the
    // turn outcome (the turn already flushed; a rethrow would re-run it).
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const logger = { warn: vi.fn(), error: vi.fn() }

    const boom = new Error('st-eval queue unreachable')
    const stEvalQueue: StEvalQueueLike = {
      add: vi.fn((): Promise<never> => Promise.reject(boom)),
    }

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue,
      scribeQueue: inertScribeQueue(),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger,
    }

    const result = await processTurnJob(deps, payload())

    // The turn itself succeeded; the enqueue failure didn't surface.
    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, turnId: TURN }),
      'failed to enqueue st-evaluation',
    )
  })

  // ── MYT-73 §2.4 — the post-turn Scribe enqueue (flushed-success gating) ────
})
