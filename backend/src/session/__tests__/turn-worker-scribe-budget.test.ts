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
import { SESSION_TOKEN_BUDGET } from '../st-config.js'
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
  it('ends the session when cumulative usage reaches the budget after a flushed turn (T12)', async () => {
    // The post-flush success phase reads the durable cumulative usage. When
    // (input + output) >= SESSION_TOKEN_BUDGET, the worker fires the injected
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

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      // At-budget: input + output exactly equals SESSION_TOKEN_BUDGET.
      repo: fakeRepo({
        budgetSummary: { inputTokens: SESSION_TOKEN_BUDGET - 1_000, outputTokens: 1_000 },
      }),
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

  it('does NOT end the session when cumulative usage is under the budget (T12)', async () => {
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const endSession = vi.fn((): Promise<void> => Promise.resolve())

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      // Under budget: one token short of the threshold.
      repo: fakeRepo({
        budgetSummary: { inputTokens: SESSION_TOKEN_BUDGET - 1, outputTokens: 0 },
      }),
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
    // !isCorrection, so the budget check is skipped — even with usage at-budget,
    // a correction turn never auto-ends.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const endSession = vi.fn((): Promise<void> => Promise.resolve())

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({
        budgetSummary: { inputTokens: SESSION_TOKEN_BUDGET, outputTokens: 5_000 },
      }),
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

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({
        budgetSummary: { inputTokens: SESSION_TOKEN_BUDGET, outputTokens: 0 },
      }),
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
