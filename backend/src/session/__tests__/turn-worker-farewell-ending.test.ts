// Split from the original monolithic turn-worker.test.ts along its thematic
// describe/it seams. Shared pure-mock builders live in ./_helpers/turn-worker-
// harness.ts + ./_helpers/turn-worker-deps.ts. No DB / scoped fixtures here (this
// suite is pure in-memory mocks), so the CONVENTIONS.md isolation pattern is N/A.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { type SessionState, makeSessionState } from '../../redis/session-state.js'
import { type TriggerState, makeTriggerState } from '../trigger-state.js'
import { FAREWELL_DIRECTION, type TurnJobPayload } from '../turn-queue.js'
import { type TurnProcessorDeps, processTurnJob } from '../turn-worker.js'
import { CAMPAIGN, KEY_PREFIX, SESSION, TURN, fakeHandle, fakeLock, fakeRepo, farewellPayload, makeTiers, newCalls, payload, recordingPublisher, silentLogger } from './_helpers/turn-worker-harness.js'
import { type DmTriggerCall, type QueueCall, inertCombatLedger, inertDmTriggerQueue, inertEndSession, inertFinalize, inertLedgerTx, inertScribeQueue, inertStEvalQueue, inertTurnQueue, recordingDmTriggerQueue, recordingTurnQueue } from './_helpers/turn-worker-deps.js'

vi.mock('bullmq', () => ({
  Worker: vi.fn(),
  Queue: vi.fn(),
  // The §5 latch-terminal arm throws `UnrecoverableError`; the processor + tests
  // both reference it, so the mock exports a real throwable subclass (not a bare
  // vi.fn) so `instanceof` checks hold. This suite never constructs a Worker/Queue.
  UnrecoverableError: class UnrecoverableError extends Error {},
}))

describe('processTurnJob — farewell finalize & ending gates', () => {
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

  it('a farewell turn on the converge path STILL finalizes (the finalize lives in the shared finally, §1.3)', async () => {
    // A farewell whose rows already committed (a re-run after a crash post-commit)
    // converges before the fresh-run arm — but the finalize is in the shared
    // `finally`, so it STILL runs. Also: the converge path must NOT advance the
    // watermark for a player-less farewell.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const finalize = vi.fn((): Promise<void> => Promise.resolve())

    await triggerState.setRespondedSeq(CAMPAIGN, 2)

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
      finalizeEndedSession: finalize,
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, farewellPayload({ worldId: 'w-fin', maxConsumedSeq: 9 }))

    expect(result).toEqual({ ran: true })
    // Converged (no render) — turn_end is the only frame.
    expect(calls.order).toEqual(['turn_end'])
    // The finalize STILL ran from the shared finally.
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledWith({
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      worldId: 'w-fin',
    })
    // The player-less converge did NOT advance the watermark past unresponded seqs.
    expect(await triggerState.respondedSeq(CAMPAIGN)).toBe(2)
  })

  it('a farewell turn resolves the worldId via resolveWorldId when absent from the payload (§1.3)', async () => {
    // The finalize prefers `job.data.worldId` but falls back to resolveWorldId
    // (blob-cached campaign→world) when the payload omits it. Seed the :state blob
    // so resolveWorldId returns a cached worldId without a PG read.
    await sessionState.setState(CAMPAIGN, {
      participants: ['u1'],
      mode: 'exploration',
      status: 'active',
      worldId: 'w-cached',
    })

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

    // A farewell payload with NO worldId (the resolveWorldId fallback arm).
    const noWorldIdFarewell: { data: TurnJobPayload } = {
      data: {
        campaignId: CAMPAIGN,
        sessionId: SESSION,
        turnId: TURN,
        triggerMessages: [],
        maxConsumedSeq: 0,
        trigger: { kind: 'farewell' },
        farewellText: FAREWELL_DIRECTION,
      },
    }

    const result = await processTurnJob(deps, noWorldIdFarewell)

    expect(result).toEqual({ ran: true })
    expect(finalize).toHaveBeenCalledWith({
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      worldId: 'w-cached',
    })
  })

  // ── MYT-74b §1.3 — the ending gate suppresses post-turn re-engagement ─────
  it('an ending session suppresses the explicit drain AND the post-turn re-mature in the finally (§1.3)', async () => {
    // Once `endSession` claims the `ending` flag, the post-turn re-engagement work
    // (explicit drain + quiet-window re-mature) would only re-summon the DM into a
    // closing session. With isEnding=true, BOTH are suppressed — even though an
    // explicit summon is pending AND a trailing player row sits above the watermark.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const queueCalls: QueueCall[] = []
    const triggerCalls: DmTriggerCall[] = []

    // Mark the session ending (as endSession would have) BEFORE the turn runs.
    await sessionState.tryMarkEnding(CAMPAIGN)
    // Seed an explicit summon + a trailing player row that WOULD normally re-engage.
    await triggerState.setExplicitPending(CAMPAIGN)

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({ trailingRows: [{ messageType: 'player_message' }] }),
      triggerState,
      sessionTurnQueue: recordingTurnQueue(queueCalls),
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
    // The ending gate suppressed BOTH the explicit drain and the re-mature.
    expect(queueCalls).toHaveLength(0)
    expect(triggerCalls).toHaveLength(0)
    // The explicit-pending flag was NOT consumed (the drain block never ran).
    expect(await triggerState.takeExplicitPending(CAMPAIGN)).toBe(true)
  })

  it('a non-ending session still runs the explicit drain + re-mature (the gate is isEnding-conditional, §1.3)', async () => {
    // The control: with isEnding=false (the default), the post-turn re-engagement
    // work runs as before — proving the suppression is gated on the ending flag,
    // not unconditional.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const queueCalls: QueueCall[] = []
    const triggerCalls: DmTriggerCall[] = []

    await triggerState.setExplicitPending(CAMPAIGN)

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({ trailingRows: [{ messageType: 'player_message' }] }),
      triggerState,
      sessionTurnQueue: recordingTurnQueue(queueCalls),
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
    // Not ending → the explicit drain enqueued one follow-up AND the re-mature fired.
    expect(queueCalls).toHaveLength(1)
    expect(queueCalls[0]?.data.trigger.kind).toBe('explicit')
    expect(triggerCalls).toHaveLength(1)
    expect(triggerCalls[0]?.name).toBe('evaluate')
  })

  // ── MYT-75 T7 — post-turn combat application ──────────────────────────────
})
