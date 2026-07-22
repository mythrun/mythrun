// Split from the original monolithic turn-worker.test.ts along its thematic
// describe/it seams. Shared pure-mock builders live in ./_helpers/turn-worker-
// harness.ts + ./_helpers/turn-worker-deps.ts. No DB / scoped fixtures here (this
// suite is pure in-memory mocks), so the CONVENTIONS.md isolation pattern is N/A.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { type SessionState, makeSessionState } from '../../redis/session-state.js'
import { SessionController } from '../session-controller.js'
import { StubFastThinker } from '../tiers/stubs.js'
import { type TriggerState, makeTriggerState } from '../trigger-state.js'
import { FAREWELL_DIRECTION, type TurnJobPayload } from '../turn-queue.js'
import { SESSION_TOKEN_BUDGET } from '../st-config.js'
import { type TurnProcessorDeps, processTurnJob } from '../turn-worker.js'
import { CAMPAIGN, KEY_PREFIX, SESSION, TURN, fakeHandle, fakeLock, fakeRepo, farewellPayload, makeTiers, newCalls, recordingPublisher, silentLogger } from './_helpers/turn-worker-harness.js'
import { type ScribeCall, inertCombatLedger, inertDmTriggerQueue, inertEndSession, inertFinalize, inertLedgerTx, inertScribeQueue, inertStEvalQueue, inertTurnQueue, recordingScribeQueue } from './_helpers/turn-worker-deps.js'

vi.mock('bullmq', () => ({
  Worker: vi.fn(),
  Queue: vi.fn(),
  // The §5 latch-terminal arm throws `UnrecoverableError`; the processor + tests
  // both reference it, so the mock exports a real throwable subclass (not a bare
  // vi.fn) so `instanceof` checks hold. This suite never constructs a Worker/Queue.
  UnrecoverableError: class UnrecoverableError extends Error {},
}))

describe('processTurnJob — farewell turns', () => {
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

  it('a farewell turn renders via the silent-consume seam: RAW farewell text as pendingDirection, triggerKind:farewell (§1.2)', async () => {
    // The farewell is the player-less end-of-session send-off. Its direction is the
    // RAW farewell text (NOT a `[[DM CORRECTION:]]` marker) — the controller/FT
    // fuses it via the single-bracket silent-consume seam. Capture the controller
    // deps to prove BOTH: pendingDirection is the raw text and triggerKind is
    // 'farewell'.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

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

    const result = await processTurnJob(
      deps,
      farewellPayload({ farewellText: 'Wind down the scene and give everyone a quiet goodbye.' }),
    )

    expect(result).toEqual({ ran: true })
    // The full render lifecycle ran (player-less is intentional, like a correction).
    expect(calls.order[0]).toBe('dm_thinking')
    expect(calls.order).toContain('text_delta')
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    const ctorDeps = (captureSpy.mock.instances[0] as unknown as {
      deps: { pendingDirection?: string; triggerKind?: string }
    }).deps
    // The RAW farewell text reached pendingDirection — NOT a [[DM CORRECTION:]] marker.
    expect(ctorDeps.pendingDirection).toBe('Wind down the scene and give everyone a quiet goodbye.')
    expect(ctorDeps.pendingDirection).not.toContain('[[DM CORRECTION:')
    // The controller config carried the farewell trigger kind.
    expect(ctorDeps.triggerKind).toBe('farewell')

    captureSpy.mockRestore()
  })

  it('a farewell turn with no farewellText falls back to FAREWELL_DIRECTION as pendingDirection (§1.2)', async () => {
    // Defensive: `farewellText` is optional on the payload; the worker coalesces a
    // missing value to the fixed FAREWELL_DIRECTION rather than `undefined`.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

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

    // A farewell payload with NO farewellText (the `?? FAREWELL_DIRECTION` arm).
    const noTextFarewell: { data: TurnJobPayload } = {
      data: {
        campaignId: CAMPAIGN,
        sessionId: SESSION,
        turnId: TURN,
        triggerMessages: [],
        maxConsumedSeq: 0,
        trigger: { kind: 'farewell' },
        worldId: 'w-farewell',
      },
    }

    const result = await processTurnJob(deps, noTextFarewell)

    expect(result).toEqual({ ran: true })
    const ctorDeps = (captureSpy.mock.instances[0] as unknown as {
      deps: { pendingDirection?: string }
    }).deps
    expect(ctorDeps.pendingDirection).toBe(FAREWELL_DIRECTION)

    captureSpy.mockRestore()
  })

  it('a farewell turn does NOT advance the watermark, enqueue Scribe, or run the budget auto-end (isPlayerless gates, §1)', async () => {
    // A farewell is player-less (like a correction): it consumed no player message,
    // so the !isPlayerless gates suppress setRespondedSeq, the Scribe enqueue, and
    // the budget auto-end. Seed a non-zero watermark + at-budget usage so each
    // "skipped" assertion is meaningful.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const scribeCalls: ScribeCall[] = []
    const endSession = vi.fn((): Promise<void> => Promise.resolve())

    await triggerState.setRespondedSeq(CAMPAIGN, 2)
    const setRespondedSpy = vi.fn((c: string, seq: number): Promise<void> =>
      triggerState.setRespondedSeq(c, seq),
    )
    const recordingTrigger: TriggerState = {
      ...triggerState,
      setRespondedSeq: setRespondedSpy,
    }

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      // At-budget usage — a real turn would auto-end here; a farewell must not.
      repo: fakeRepo({
        budgetSummary: { inputTokens: SESSION_TOKEN_BUDGET, outputTokens: 5_000 },
      }),
      triggerState: recordingTrigger,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: recordingScribeQueue(scribeCalls),
      endSession,
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, farewellPayload({ maxConsumedSeq: 2 }))

    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    // Watermark advance SKIPPED (player-less): never re-asserted, stays at 2.
    expect(setRespondedSpy).not.toHaveBeenCalled()
    expect(await triggerState.respondedSeq(CAMPAIGN)).toBe(2)
    // Scribe enqueue SKIPPED.
    expect(scribeCalls).toHaveLength(0)
    // Budget auto-end SKIPPED even at-budget.
    expect(endSession).not.toHaveBeenCalled()
  })

  it('a farewell turn that renders cleanly finalizes exactly once with the resolved ids (Eddystone-C1, §1.3)', async () => {
    // The unconditional finalize runs in the `finally` on the clean-render path:
    // exactly one finalize call with {campaignId, sessionId, worldId} (worldId off
    // the farewell payload, no PG re-resolve).
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const finalize = vi.fn((): Promise<void> => Promise.resolve())

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
      finalizeEndedSession: finalize,
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, farewellPayload({ worldId: 'w-fin' }))

    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledWith({
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      worldId: 'w-fin',
    })
  })

  it('a farewell turn whose FT render THROWS still finalizes exactly once (Eddystone-C1 guard, §1.3)', async () => {
    // The load-bearing invariant: a thrown/timed-out farewell render must NEVER
    // leave a session permanently un-ended. Because the finalize lives in the
    // shared `finally`, a render that throws still finalizes exactly once. The
    // turn itself rethrows (real failure → BullMQ owns the retry policy).
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const finalize = vi.fn((): Promise<void> => Promise.resolve())

    const boom = new Error('farewell render exploded')
    const ft = new StubFastThinker()
    vi.spyOn(ft, 'render').mockRejectedValue(boom)

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
      finalizeEndedSession: finalize,
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers: () => ({ ft, combatEvents: [] }),
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    // The render throw propagates (real failure), but the finally still finalized.
    await expect(processTurnJob(deps, farewellPayload({ worldId: 'w-fin' }))).rejects.toThrow(
      'farewell render exploded',
    )

    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledWith({
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      worldId: 'w-fin',
    })
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('a farewell finalize failure is swallowed and does not mask the turn outcome (§1.3)', async () => {
    // The finalize is in its own try/catch in the finally: a finalize throw never
    // masks the turn outcome (the turn already flushed; a rethrow would re-run an
    // already-flushed farewell via BullMQ attempts). Logged, not rethrown.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const logger = { warn: vi.fn(), error: vi.fn() }
    const finalize = vi.fn((): Promise<void> => Promise.reject(new Error('reconcile unreachable')))

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
      finalizeEndedSession: finalize,
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger,
    }

    const result = await processTurnJob(deps, farewellPayload())

    // The turn itself succeeded; the finalize failure didn't surface.
    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, turnId: TURN }),
      'failed to finalize ended session',
    )
  })

})
