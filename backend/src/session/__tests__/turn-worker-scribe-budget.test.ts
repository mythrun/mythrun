// Split from the original monolithic turn-worker.test.ts along its thematic
// describe/it seams. Shared pure-mock builders live in ./_helpers/turn-worker-
// harness.ts + ./_helpers/turn-worker-deps.ts. No DB / scoped fixtures here (this
// suite is pure in-memory mocks), so the CONVENTIONS.md isolation pattern is N/A.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { type SessionState, makeSessionState } from '../../redis/session-state.js'
import { StubFastThinker } from '../tiers/stubs.js'
import { type TriggerState, makeTriggerState } from '../trigger-state.js'
import { SCRIBE_JOB_NAME, type ScribeQueueLike } from '../scribe-queue.js'
import type { WorkingSetProposal } from '../working-set/types.js'
import { SESSION_FT_CONTEXT_BUDGET } from '../ft-config.js'
import { type TurnProcessorDeps, processTurnJob } from '../turn-worker.js'
import { CAMPAIGN, KEY_PREFIX, SESSION, TURN, correctionPayload, fakeHandle, fakeLock, fakeRepo, makeTiers, newCalls, payload, recordingPublisher, silentLogger } from './_helpers/turn-worker-harness.js'
import { type ScribeCall, inertCombatLedger, inertDmTriggerQueue, inertEndSession, inertFinalize, inertLedgerTx, inertScribeQueue, inertStEvalQueue, inertTurnQueue, recordingScribeQueue } from './_helpers/turn-worker-deps.js'

vi.mock('bullmq', () => ({
  Worker: vi.fn(),
  Queue: vi.fn(),
  // The §5 latch-terminal arm throws `UnrecoverableError`; the processor + tests
  // both reference it, so the mock exports a real throwable subclass (not a bare
  // vi.fn) so `instanceof` checks hold. This suite never constructs a Worker/Queue.
  UnrecoverableError: class UnrecoverableError extends Error {},
}))

describe('processTurnJob — scribe enqueue & budget auto-end', () => {
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

  it('a flushed (non-correction) turn enqueues ONE Scribe job carrying the turn ids (§2.4)', async () => {
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const scribeCalls: ScribeCall[] = []

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: recordingScribeQueue(scribeCalls),
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
    // Exactly one Scribe job, named SCRIBE_JOB_NAME, carrying this turn's ids +
    // the resolved worldId (the stub FT renders one canned line as the prose).
    expect(scribeCalls).toHaveLength(1)
    expect(scribeCalls[0]?.name).toBe(SCRIBE_JOB_NAME)
    expect(scribeCalls[0]?.data.campaignId).toBe(CAMPAIGN)
    expect(scribeCalls[0]?.data.sessionId).toBe(SESSION)
    expect(scribeCalls[0]?.data.turnId).toBe(TURN)
    // worldId resolves off the fake repo's getWorldId ('w-fake').
    expect(scribeCalls[0]?.data.worldId).toBe('w-fake')
    // The stub FT appends no [[WORLD_DELTA]] → the payload carries null.
    expect(scribeCalls[0]?.data.worldDelta).toBeNull()
  })

  it('threads a mid-turn recorded injection through the shared sink onto the Scribe payload (§2.4)', async () => {
    // The worker builds ONE per-turn `injections` array and wires it into BOTH
    // the FT tools' `recordInjection` sink (the arrow `(p) => injections.push(p)`)
    // and the controller. A lookup that records an ST-vet relay mid-turn must
    // therefore surface on the post-turn Scribe payload. The fake tier factory
    // exercises the sink the way a real lookup tool would.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const scribeCalls: ScribeCall[] = []

    const injected: WorkingSetProposal = {
      kind: 'fact',
      content: 'The bell tower has been silent since the siege.',
      subjectName: 'Old Bell Tower',
      tier: 'known',
      provenance: { kind: 'objective' },
      source: 'st_injection',
    }
    const recordingTiers: TurnProcessorDeps['makeTiers'] = (args) => {
      args.recordInjection(injected)
      return { ft: new StubFastThinker(), combatEvents: [] }
    }

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: recordingScribeQueue(scribeCalls),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers: recordingTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(scribeCalls).toHaveLength(1)
    expect(scribeCalls[0]?.data.injections).toEqual([injected])
  })

  it('a correction turn does NOT enqueue a Scribe job (player-less, already-vetted Z, §2.4)', async () => {
    // A correction delivers an already secret-free `Z`; running the tripwire over
    // it is wasted spend and risks a retcon loop — the enqueue is skipped exactly
    // like the watermark advance (both gated on `!isCorrection`).
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const scribeCalls: ScribeCall[] = []

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: recordingScribeQueue(scribeCalls),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, correctionPayload('It is actually a forgery.', 2))

    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    // The correction turn rendered + flushed, but enqueued NO Scribe job.
    expect(scribeCalls).toHaveLength(0)
  })

  it('the converge path does NOT enqueue a Scribe job (no fresh FT response, §2.4)', async () => {
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const scribeCalls: ScribeCall[] = []

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({ turnRowsExist: true }),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: recordingScribeQueue(scribeCalls),
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
    expect(scribeCalls).toHaveLength(0)
  })

  it('a Scribe enqueue failure is isolated: logged, turn still returns {ran:true} (§2.4)', async () => {
    // The Scribe enqueue is in its own try/catch — an enqueue hiccup never masks
    // the turn outcome (the turn already flushed; a rethrow would re-run it).
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const logger = { warn: vi.fn(), error: vi.fn() }

    const boom = new Error('scribe queue unreachable')
    const scribeQueue: ScribeQueueLike = {
      add: vi.fn((): Promise<never> => Promise.reject(boom)),
    }

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue,
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

    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, turnId: TURN }),
      'failed to enqueue scribe',
    )
  })

  // ── MYT-74a T12 — budget-100% auto-end ───────────────────────────────────
  it('ends the session when the FT context reaches the ceiling after a flushed turn (T12)', async () => {
    // The post-flush success phase reads the durable FT context level. When
    // it is >= SESSION_FT_CONTEXT_BUDGET, the worker fires the injected
    // end orchestration with {campaignId, sessionId, worldId} (worldId resolved
    // on the fresh-run arm). The :state blob carries a worldId so resolveWorldId
    // returns it without a PG read.
    await sessionState.setState(CAMPAIGN, {
      participants: ['u1'],
      mode: 'exploration',
      status: 'active',
      worldId: 'w-budget',
    })

    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const endSession = vi.fn((): Promise<void> => Promise.resolve())

    // myth-zd6pn — seed the REAL Redis level the auto-end now reads. The stub
    // FT reports no context fill, so the worker does not overwrite it: this is
    // the read-back arm (the converge-path shape).
    await sessionState.setFtContextTokens(CAMPAIGN, SESSION_FT_CONTEXT_BUDGET)

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      // At the ceiling: FT context fill exactly equals the budget.
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: inertScribeQueue(),
      endSession,
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
    // The turn still completed normally (the end is fired off the turn outcome).
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    // The auto-end fired exactly once with the resolved ids.
    expect(endSession).toHaveBeenCalledTimes(1)
    expect(endSession).toHaveBeenCalledWith({
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      worldId: 'w-budget',
    })
  })

  it('does NOT end the session when the FT context is under the ceiling (T12)', async () => {
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const endSession = vi.fn((): Promise<void> => Promise.resolve())

    // myth-zd6pn — one token short of the ceiling.
    await sessionState.setFtContextTokens(CAMPAIGN, SESSION_FT_CONTEXT_BUDGET - 1)

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      // Under the ceiling: one token short.
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: inertScribeQueue(),
      endSession,
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
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    // Under budget → the auto-end never fired.
    expect(endSession).not.toHaveBeenCalled()
  })

  it('does NOT end the session on a correction turn even at-budget (player-less, T12)', async () => {
    // A correction is player-less and gated like the watermark/scribe on
    // !isCorrection, so the check is skipped — even at the context ceiling,
    // a correction turn never auto-ends.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const endSession = vi.fn((): Promise<void> => Promise.resolve())

    // myth-zd6pn — over the ceiling, but the turn is player-less.
    await sessionState.setFtContextTokens(CAMPAIGN, SESSION_FT_CONTEXT_BUDGET + 5_000)

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: inertScribeQueue(),
      endSession,
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, correctionPayload('It was a forgery.', 0))

    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    // A correction never reaches the budget check.
    expect(endSession).not.toHaveBeenCalled()
  })

  it('a budget auto-end failure is swallowed and does not mask the turn outcome (T12)', async () => {
    // The budget auto-end is in its own try/catch — an endSession throw never
    // rethrows out of the flushed turn (a rethrow would re-run an already-flushed
    // turn via BullMQ attempts). The turn still resolves {ran:true} and the
    // failure is logged.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const logger = { warn: vi.fn(), error: vi.fn() }
    const boom = new Error('reconcile queue unreachable')
    const endSession = vi.fn((): Promise<void> => Promise.reject(boom))

    // myth-zd6pn — at the ceiling, so the (throwing) auto-end is reached.
    await sessionState.setFtContextTokens(CAMPAIGN, SESSION_FT_CONTEXT_BUDGET)

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: inertScribeQueue(),
      endSession,
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    expect(endSession).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, turnId: TURN }),
      'failed to end session on budget',
    )
  })

  // ── MYT-73 §7.2 (D6) — the player-less correction turn ────────────────────
  /** A `correction`-kind payload: triggerMessages:[] (player-less), the
   *  secret-free `Z` on `correctionText`, and a maxConsumedSeq equal to the
   *  CURRENT responded watermark (it must NOT advance past unresponded seqs). */

















})

// ── myth-nu0hm — the mechanical session-progress fraction on turn_end ───────
describe('processTurnJob — session-progress signal (myth-nu0hm)', () => {
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

  /** The suite's standard deps, with the session-state seam overridable so a
   *  test can drive the failure arm. */
  function progressDeps(
    calls: ReturnType<typeof newCalls>,
    overrides?: {
      sessionState?: SessionState
      makeTiers?: TurnProcessorDeps['makeTiers']
      logger?: TurnProcessorDeps['logger']
    },
  ): TurnProcessorDeps {
    return {
      lock: fakeLock(fakeHandle({ extendReturns: true, release: vi.fn((): Promise<void> => Promise.resolve()) })),
      sessionState: overrides?.sessionState ?? sessionState,
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
      makeTiers: overrides?.makeTiers ?? makeTiers,
      heartbeatMs: 10_000,
      logger: overrides?.logger ?? silentLogger,
    }
  }

  /** A Fast Thinker that reports a specific context fill (the final tool-loop
   *  step's input tokens). The StubFastThinker reports none. */
  function tiersWithContext(contextTokens: number): TurnProcessorDeps['makeTiers'] {
    return () => ({
      ft: {
        render: async (_ctx, emit) => {
          await emit.emitText('(the DM considers the scene…)')
          return {
            role: 'assistant' as const,
            parts: [{ kind: 'text' as const, text: '(the DM responds.)' }],
            contextTokens,
          }
        },
      },
      combatEvents: [],
    })
  }

  it('turn_end carries the FT CONTEXT-FILL fraction', async () => {
    // myth-zd6pn — one axis. Cumulative gross spend no longer moves the bar at
    // all: the session ends when the FT's window fills, so that IS the number.
    await sessionState.flushTurnState(CAMPAIGN, {
      usage: { input: SESSION_FT_CONTEXT_BUDGET * 4, output: 0 },
    })
    const calls = newCalls()

    const result = await processTurnJob(
      progressDeps(calls, { makeTiers: tiersWithContext(SESSION_FT_CONTEXT_BUDGET * 0.5) }),
      payload(),
    )

    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    // Half the window, despite four times the old budget in gross tokens.
    expect(calls.turnEndProgress).toEqual([{ fraction: 0.5 }])
  })

  it('a huge GROSS spend with a small window reads as an EARLY session', async () => {
    // The regression this fix exists for. Before myth-zd6pn a session at this
    // shape (mostly cache reads) published ~1.0 and auto-ended; the FT was
    // holding ~4% of its window at the time.
    await sessionState.flushTurnState(CAMPAIGN, {
      usage: { input: 545_000, output: 20_000 },
    })
    const calls = newCalls()

    await processTurnJob(
      progressDeps(calls, { makeTiers: tiersWithContext(35_600) }),
      payload(),
    )

    expect(calls.turnEndProgress).toEqual([{ fraction: 0.05 }])
  })

  it('writes the FT context level so the ST worker reads the same number', async () => {
    // The end arm, the progress bar, wind-down and the converge steer must all
    // agree about how much session is left; they agree by reading one key.
    const calls = newCalls()

    await processTurnJob(
      progressDeps(calls, { makeTiers: tiersWithContext(400_000) }),
      payload(),
    )

    expect(await sessionState.ftContextTokens(CAMPAIGN)).toBe(400_000)
  })

  it('the published fraction NEVER walks back when the context term falls', async () => {
    // A previous combat-heavy turn pushed the floor to 0.85. This turn is
    // terse: low context fill. The bar must hold, not drop.
    await sessionState.raiseProgressFraction(CAMPAIGN, 0.85)
    const calls = newCalls()

    await processTurnJob(
      progressDeps(calls, { makeTiers: tiersWithContext(1_000) }),
      payload(),
    )

    expect(calls.turnEndProgress).toEqual([{ fraction: 0.85 }])
    // ...and the floor is still 0.85 for the next turn / a joining client.
    expect(await sessionState.progressFraction(CAMPAIGN)).toBe(0.85)
  })

  it('the fraction is COARSE — an awkward fill lands on a 0.05 bucket', async () => {
    const calls = newCalls()

    await processTurnJob(
      progressDeps(calls, {
        makeTiers: tiersWithContext(Math.round(SESSION_FT_CONTEXT_BUDGET * 0.5199)),
      }),
      payload(),
    )

    expect(calls.turnEndProgress).toEqual([{ fraction: 0.5 }])
  })

  it('a context-level write failure is swallowed and does not mask the turn', async () => {
    // The level is a signal, not the turn. A Redis hiccup here degrades the end
    // arm and the progress bar to the previous reading (nearly right, and it
    // self-heals next turn); it must never cost the table a rendered turn.
    const logger = { warn: vi.fn(), error: vi.fn() }
    const broken: SessionState = {
      ...sessionState,
      setFtContextTokens: () => Promise.reject(new Error('redis down')),
    }
    const calls = newCalls()

    const result = await processTurnJob(
      progressDeps(calls, {
        sessionState: broken,
        makeTiers: tiersWithContext(400_000),
        logger,
      }),
      payload(),
    )

    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, turnId: TURN }),
      'failed to store FT context level',
    )
  })

  it('a progress failure OMITS the fraction but still publishes turn_end', async () => {
    // The fraction is a readout; turn_end is what tells the client the turn is
    // over. A Redis hiccup must cost the number, never the turn.
    const broken: SessionState = {
      ...sessionState,
      raiseProgressFraction: () => Promise.reject(new Error('redis down')),
    }
    const calls = newCalls()

    const result = await processTurnJob(progressDeps(calls, { sessionState: broken }), payload())

    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    expect(calls.turnEndProgress).toEqual([undefined])
  })

  it('the CONVERGE path (rows already durable) still publishes a fraction', async () => {
    // No fresh render there, so there is no context reading this turn — the
    // STORED level from the previous turn still gives an honest number.
    await sessionState.setFtContextTokens(CAMPAIGN, SESSION_FT_CONTEXT_BUDGET * 0.4)
    const calls = newCalls()
    const deps: TurnProcessorDeps = {
      ...progressDeps(calls),
      repo: fakeRepo({ turnRowsExist: true }),
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(calls.turnEndProgress).toEqual([{ fraction: 0.4 }])
  })
})
