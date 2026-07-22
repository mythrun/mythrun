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
import { StubFastThinker } from '../tiers/stubs.js'
import { type TriggerState, makeTriggerState } from '../trigger-state.js'
import type { TurnPublisher } from '../turn-publisher.js'
import { type TurnProcessorDeps, processTurnJob } from '../turn-worker.js'
import { CAMPAIGN, KEY_PREFIX, TURN, fakeHandle, fakeLock, fakeRepo, installSlowProcessDmTurn, makeTiers, newCalls, payload, recordingPublisher, silentLogger } from './_helpers/turn-worker-harness.js'
import { inertCombatLedger, inertDmTriggerQueue, inertEndSession, inertFinalize, inertLedgerTx, inertScribeQueue, inertStEvalQueue, inertTurnQueue } from './_helpers/turn-worker-deps.js'

vi.mock('bullmq', () => ({
  Worker: vi.fn(),
  Queue: vi.fn(),
  // The §5 latch-terminal arm throws `UnrecoverableError`; the processor + tests
  // both reference it, so the mock exports a real throwable subclass (not a bare
  // vi.fn) so `instanceof` checks hold. This suite never constructs a Worker/Queue.
  UnrecoverableError: class UnrecoverableError extends Error {},
}))

describe('processTurnJob — converge, latch & lifecycle order', () => {
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

  it('converges a durable turn: no render, advances the watermark, publishes turn_end (§5)', async () => {
    // PG rows already exist for this turnId (a re-run after a crash AFTER the
    // commit). The turn IS durable — converge to completion rather than
    // re-render: advance the watermark + publish turn_end + return. NEVER
    // re-render (no dm_thinking / text_delta) and NEVER turn_error.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    // A tier factory that THROWS if reached — a converge must never touch tiers.
    const exploding: TurnProcessorDeps['makeTiers'] = () => {
      throw new Error('makeTiers must not be called on the converge path')
    }

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
      makeTiers: exploding,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const job = payload()
    ;(job.data as { maxConsumedSeq: number }).maxConsumedSeq = 5

    const result = await processTurnJob(deps, job)

    expect(result).toEqual({ ran: true })
    // No render: dm_thinking / text_delta never fired; turn_end is the only frame.
    expect(calls.order).toEqual(['turn_end'])
    expect(calls.order).not.toContain('dm_thinking')
    expect(calls.order).not.toContain('text_delta')
    expect(calls.order).not.toContain('turn_error')
    // The watermark advanced so the batch isn't double-answered on the next run.
    expect(await triggerState.respondedSeq(CAMPAIGN)).toBe(5)
    // The lock was released in finally.
    expect(release).toHaveBeenCalledTimes(1)
  })

  // ── §5 latch-terminal: emitted but not committed ─────────────────────────
  it('terminal when frames streamed but nothing committed: turn_error once, throws UnrecoverableError (§5)', async () => {
    // Frames were broadcast (the emitted-anything latch is set) but no PG rows
    // committed. A retry would re-stream DIVERGENT prose + re-roll under the
    // same turnId — so this is terminal: publish turn_error (claim-gated) and
    // throw UnrecoverableError to skip the remaining BullMQ attempts. No render.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    // Seed the §5 emitted-anything latch for THIS turnId (as a prior streamed
    // attempt would have via the latched emitter), with no durable rows.
    await triggerState.markTurnEmitted(TURN)

    const exploding: TurnProcessorDeps['makeTiers'] = () => {
      throw new Error('makeTiers must not be called on the terminal path')
    }

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
      makeTiers: exploding,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    await expect(processTurnJob(deps, payload())).rejects.toBeInstanceOf(UnrecoverableError)

    // turn_error published exactly once (claim-gated), no render.
    expect(calls.order).toEqual(['turn_error'])
    expect(calls.turnErrorArgs).toHaveLength(1)
    expect(calls.turnErrorArgs[0]?.turnId).toBe(TURN)
    expect(calls.order).not.toContain('dm_thinking')
    expect(calls.order).not.toContain('text_delta')
    // The lock was released in finally despite the throw.
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('latch-terminal claim is gated: a second container loses the claim and publishes no turn_error (§4.8/§5)', async () => {
    // The terminal turn_error publish is claim-gated. Pre-claim the latch (as a
    // sibling container would), then run: the SET-NX claim loses, so NO
    // turn_error ships, but the run is still terminal (UnrecoverableError).
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    await triggerState.markTurnEmitted(TURN)
    // A sibling already won the latch.
    await triggerState.claimTurnErrorPublish(TURN)

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

    // The claim was lost → no turn_error from this container.
    expect(calls.order).not.toContain('turn_error')
    expect(release).toHaveBeenCalledTimes(1)
  })

  // ── fresh-run lifecycle ORDER ────────────────────────────────────────────
  it('fresh run drives the lifecycle in order: dm_thinking → load → process → persist → flush → watermark → turn_end', async () => {
    // A recorder threaded through the fakes pins the v2 turn lifecycle order:
    // dm_thinking (publisher) → loadFromRedis → processDmTurn → persistTurn
    // (appendDmTurn) → flushToRedis (flushTurnState) → setRespondedSeq → turnEnd.
    const order: string[] = []
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    // Spy the controller methods to record their order (they still run their
    // real bodies over the fakes).
    const loadSpy = vi
      .spyOn(SessionController.prototype, 'loadFromRedis')
      .mockImplementation((): Promise<void> => {
        order.push('load')
        return Promise.resolve()
      })
    const processSpy = vi
      .spyOn(SessionController.prototype, 'processDmTurn')
      .mockImplementation((): Promise<void> => {
        order.push('process')
        return Promise.resolve()
      })
    const persistSpy = vi
      .spyOn(SessionController.prototype, 'persistTurn')
      .mockImplementation((): Promise<void> => {
        order.push('persist')
        return Promise.resolve()
      })
    const flushSpy = vi
      .spyOn(SessionController.prototype, 'flushToRedis')
      .mockImplementation((): Promise<void> => {
        order.push('flush')
        return Promise.resolve()
      })

    // A publisher whose frames + a triggerState whose setRespondedSeq record
    // into the same order array.
    const publisher: TurnPublisher = {
      ...recordingPublisher(newCalls()),
      dmThinking: vi.fn((): Promise<void> => {
        order.push('dm_thinking')
        return Promise.resolve()
      }),
      turnEnd: vi.fn((): Promise<void> => {
        order.push('turn_end')
        return Promise.resolve()
      }),
    }
    const recordingTrigger: TriggerState = {
      ...triggerState,
      setRespondedSeq: vi.fn((campaignId: string, seq: number): Promise<void> => {
        order.push('watermark')
        return triggerState.setRespondedSeq(campaignId, seq)
      }),
    }

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({ turnRowsExist: false }),
      triggerState: recordingTrigger,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: inertScribeQueue(),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher,
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(order).toEqual([
      'dm_thinking',
      'load',
      'process',
      'persist',
      'flush',
      'watermark',
      'turn_end',
    ])

    loadSpy.mockRestore()
    processSpy.mockRestore()
    persistSpy.mockRestore()
    flushSpy.mockRestore()
  })

  // ── lock lost AFTER render, BEFORE persist ───────────────────────────────
  it('lock lost during processDmTurn aborts before persist: appendDmTurn never called, no turn_end (§3.7 lock-gate)', async () => {
    // The §3.7 lock-gate: the heartbeat flips lockLost during a slow
    // processDmTurn, so the post-process checkpoint throws LockLostError BEFORE
    // persistTurn — appendDmTurn is never reached and no turn_end fires.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: false, release })

    const appendDmTurn = vi.fn((): Promise<void> => Promise.resolve())

    // A slow render step so the tiny heartbeat fires (flipping lockLost) DURING
    // processDmTurn, before its post-process lock-gate checkpoint.
    const processSpy = installSlowProcessDmTurn()

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({ turnRowsExist: false, appendDmTurn }),
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

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    // Aborted before the durable write — appendDmTurn never ran, no turn_end.
    expect(appendDmTurn).not.toHaveBeenCalled()
    expect(calls.order).not.toContain('turn_end')
    expect(calls.order).not.toContain('turn_error')
    expect(release).toHaveBeenCalledTimes(1)

    processSpy.mockRestore()
  })

  // ── per-turn context resolution from the :state blob ─────────────────────
  it('resolves ftContext + worldTone from the :state blob when present (no PG re-load)', async () => {
    // When the :state blob carries ftContext + worldTone, the worker uses them
    // and does NOT re-read the prep from PG. Capture what makeTiers receives.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    await sessionState.setState(CAMPAIGN, {
      participants: ['u1'],
      mode: 'exploration',
      status: 'active',
      ftContext: 'PREP DOC FROM BLOB',
      worldTone: 'grim',
    })

    let seenTone: string | null = null
    const getBySpy = vi.fn()
    const repo = fakeRepo({ turnRowsExist: false })
    repo.sessionPreps.getBy = getBySpy.mockResolvedValue(null) as never

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo,
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
      makeTiers: (turn) => {
        seenTone = turn.worldTone
        return { ft: new StubFastThinker(), combatEvents: [] }
      },
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(seenTone).toBe('grim')
    // The prep was NOT re-read from PG (ftContext came from the blob).
    expect(getBySpy).not.toHaveBeenCalled()
  })

})
