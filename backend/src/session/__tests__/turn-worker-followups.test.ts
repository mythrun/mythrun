// Split from the original monolithic turn-worker.test.ts along its thematic
// describe/it seams. Shared pure-mock builders live in ./_helpers/turn-worker-
// harness.ts + ./_helpers/turn-worker-deps.ts. No DB / scoped fixtures here (this
// suite is pure in-memory mocks), so the CONVENTIONS.md isolation pattern is N/A.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { type SessionState, makeSessionState } from '../../redis/session-state.js'
import { type TriggerState, makeTriggerState } from '../trigger-state.js'
import { TURN_JOB_NAME, type TurnQueueLike } from '../turn-queue.js'
import { QUIET_WINDOW_MS } from '../dm-trigger-config.js'
import { type TurnProcessorDeps, processTurnJob } from '../turn-worker.js'
import { CAMPAIGN, KEY_PREFIX, SESSION, TURN, fakeHandle, fakeLock, fakeRepo, installSlowProcessDmTurn, makeTiers, newCalls, payload, recordingPublisher, silentLogger } from './_helpers/turn-worker-harness.js'
import { type DmTriggerCall, type QueueCall, inertCombatLedger, inertDmTriggerQueue, inertEndSession, inertFinalize, inertLedgerTx, inertScribeQueue, inertStEvalQueue, inertTurnQueue, recordingDmTriggerQueue, recordingTurnQueue } from './_helpers/turn-worker-deps.js'

vi.mock('bullmq', () => ({
  Worker: vi.fn(),
  Queue: vi.fn(),
  // The §5 latch-terminal arm throws `UnrecoverableError`; the processor + tests
  // both reference it, so the mock exports a real throwable subclass (not a bare
  // vi.fn) so `instanceof` checks hold. This suite never constructs a Worker/Queue.
  UnrecoverableError: class UnrecoverableError extends Error {},
}))

describe('processTurnJob — watermark, drain & re-arm', () => {
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

  it('advances the responded-seq watermark to maxConsumedSeq after a successful flush (§4.7)', async () => {
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

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

    const processSpy = installSlowProcessDmTurn()

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

    processSpy.mockRestore()
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
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: recordingTurnQueue(queueCalls),
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
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: recordingTurnQueue(queueCalls),
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
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: failingQueue,
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

    // The turn itself succeeded; the drain failure didn't surface.
    expect(result).toEqual({ ran: true })
    expect(silentLogger.error).toHaveBeenCalled()
  })

  // ── §4.7 post-turn re-mature (auto path) ─────────────────────────────────
  it('re-arms the quiet window when player rows sit above the watermark after a turn (§4.7)', async () => {
    // A message that lands mid-turn has no pending evaluation (the in-flight
    // guard exited it). At turn end, the worker probes for unanswered rows above
    // the responded watermark — finding a player_message row, it re-arms the
    // debounce so the DM comes back for it.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const triggerCalls: DmTriggerCall[] = []

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({ trailingRows: [{ messageType: 'player_message' }] }),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: recordingDmTriggerQueue(triggerCalls),
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
    // The re-arm fired exactly once with the debounce name + dedup opt + delay.
    expect(triggerCalls).toHaveLength(1)
    expect(triggerCalls[0]?.name).toBe('evaluate')
    expect(triggerCalls[0]?.data).toEqual({ campaignId: CAMPAIGN })
    expect(triggerCalls[0]?.opts).toEqual({
      deduplication: { id: `dm-trigger:${CAMPAIGN}`, replace: true },
      delay: QUIET_WINDOW_MS,
    })
  })

  it('does NOT re-arm when no player rows sit above the watermark after a turn (§4.7)', async () => {
    // The default repo has no trailing rows → nothing unanswered → no re-arm.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const triggerCalls: DmTriggerCall[] = []

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: recordingDmTriggerQueue(triggerCalls),
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
    expect(triggerCalls).toHaveLength(0)
  })

  it('does NOT re-arm when the only trailing rows are DM rows (§4.7)', async () => {
    // Rows above the watermark exist, but they are the DM's own just-written
    // turn (no player_message) — there is nothing unanswered, so no re-arm.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const triggerCalls: DmTriggerCall[] = []

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({ trailingRows: [{ messageType: 'dm_text' }] }),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: recordingDmTriggerQueue(triggerCalls),
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
    expect(triggerCalls).toHaveLength(0)
  })

  it('re-arms on the §5 converge path too (the re-mature lives in the shared finally)', async () => {
    // The post-turn re-mature is in the shared `finally`, so it runs on the
    // converge path as well — a turn that converged a durable row still re-arms
    // if player rows sit unanswered above the watermark.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const triggerCalls: DmTriggerCall[] = []

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({ turnRowsExist: true, trailingRows: [{ messageType: 'player_message' }] }),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: recordingDmTriggerQueue(triggerCalls),
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
    // Converged (no render) AND re-armed.
    expect(calls.order).toEqual(['turn_end'])
    expect(triggerCalls).toHaveLength(1)
    expect(triggerCalls[0]?.name).toBe('evaluate')
  })

  it('a re-arm failure is swallowed and does not mask the turn outcome (§4.7)', async () => {
    // The post-turn re-mature is in its own try/catch: if the probe rejects, the
    // turn still resolves {ran:true} and the failure is logged, never rethrown —
    // a re-arm hiccup must not retry an already-flushed turn.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const logger = { warn: vi.fn(), error: vi.fn() }

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({ listAfterSeqRejects: new Error('pg unreachable') }),
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
      logger,
    }

    const result = await processTurnJob(deps, payload())

    // The turn itself succeeded; the re-arm failure didn't surface.
    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, turnId: TURN }),
      'failed to re-arm the quiet window after the turn',
    )
  })

  // ── §5 converge: turnRowsExist → true ────────────────────────────────────
})
