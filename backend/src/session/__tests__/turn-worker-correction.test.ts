// Split from the original monolithic turn-worker.test.ts along its thematic
// describe/it seams. Shared pure-mock builders live in ./_helpers/turn-worker-
// harness.ts + ./_helpers/turn-worker-deps.ts. No DB / scoped fixtures here (this
// suite is pure in-memory mocks), so the CONVENTIONS.md isolation pattern is N/A.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { type SessionState, makeSessionState } from '../../redis/session-state.js'
import { SessionController } from '../session-controller.js'
import { type TriggerState, makeTriggerState } from '../trigger-state.js'
import type { TurnJobPayload } from '../turn-queue.js'
import { type TurnProcessorDeps, processTurnJob } from '../turn-worker.js'
import { CAMPAIGN, KEY_PREFIX, SESSION, TURN, correctionPayload, fakeHandle, fakeLock, fakeRepo, makeTiers, newCalls, recordingPublisher, silentLogger } from './_helpers/turn-worker-harness.js'
import { inertCombatLedger, inertDmTriggerQueue, inertEndSession, inertFinalize, inertLedgerTx, inertScribeQueue, inertStEvalQueue, inertTurnQueue } from './_helpers/turn-worker-deps.js'

vi.mock('bullmq', () => ({
  Worker: vi.fn(),
  Queue: vi.fn(),
  // The §5 latch-terminal arm throws `UnrecoverableError`; the processor + tests
  // both reference it, so the mock exports a real throwable subclass (not a bare
  // vi.fn) so `instanceof` checks hold. This suite never constructs a Worker/Queue.
  UnrecoverableError: class UnrecoverableError extends Error {},
}))

describe('processTurnJob — correction turns', () => {
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

  it('a correction turn renders WITHOUT hitting the empty-batch guard (player-less is intentional, §7.2/D6)', async () => {
    // A correction is enqueued directly by the Scribe job, bypassing the
    // dm-trigger no-monologue guard. With triggerMessages:[] it is intentionally
    // player-less; the worker must still render it through the full FT path
    // (dm_thinking → render → persist → flush → turn_end), never short-circuit.
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

    const result = await processTurnJob(deps, correctionPayload('It is actually a forgery.', 3))

    expect(result).toEqual({ ran: true })
    // The full render lifecycle ran — the correction was delivered, not suppressed.
    expect(calls.order[0]).toBe('dm_thinking')
    expect(calls.order).toContain('text_delta')
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    expect(calls.order).not.toContain('turn_error')
  })

  it('a correction turn does NOT advance the responded-seq watermark (it consumed no player message, §7.2/§9)', async () => {
    // The correction carries maxConsumedSeq = the CURRENT watermark, but unlike a
    // real turn it must NEVER call setRespondedSeq — otherwise it would strand
    // genuine pending player messages above the watermark. Spy on setRespondedSeq
    // to assert it is never invoked, and confirm the watermark stays put.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    // Seed a non-zero watermark so "unchanged" is a meaningful assertion.
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
      repo: fakeRepo(),
      triggerState: recordingTrigger,
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

    // maxConsumedSeq=2 (the current watermark) — even so, the correction must not
    // re-assert it via setRespondedSeq.
    const result = await processTurnJob(deps, correctionPayload('It is actually a forgery.', 2))

    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    // The watermark advance was SKIPPED for the correction kind.
    expect(setRespondedSpy).not.toHaveBeenCalled()
    // …and an unresponded player seq above the watermark is NOT stranded.
    expect(await triggerState.respondedSeq(CAMPAIGN)).toBe(2)
  })

  it('a correction turn injects the correctionText as a [[DM CORRECTION: …]] one-shot direction (§7.2/D6)', async () => {
    // The worker sets the one-shot direction to the distinct `[[DM CORRECTION:
    // <Z>]]` marker (NOT a normal silent `[DM direction:]`), reusing the
    // existing direction-injection seam so the FT context carries it. Capture the
    // controller deps to prove the marker reached `pendingDirection`.
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
      correctionPayload('the seal is genuine, not the forgery I implied', 4),
    )

    expect(result).toEqual({ ran: true })
    const ctorDeps = (captureSpy.mock.instances[0] as unknown as {
      deps: { pendingDirection?: string }
    }).deps
    expect(ctorDeps.pendingDirection).toBe(
      '[[DM CORRECTION: the seal is genuine, not the forgery I implied]]',
    )

    captureSpy.mockRestore()
  })

  it('a correction turn with an absent correctionText injects an empty [[DM CORRECTION: ]] marker (§7.2/D6)', async () => {
    // Defensive: `correctionText` is optional on the payload, so the marker
    // composition coalesces a missing value to '' (`correctionText ?? ''`). The
    // Scribe job always sets it, but a malformed/legacy correction must still
    // render a well-formed (if empty) marker rather than `undefined`.
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

    // A correction payload with NO correctionText (the `?? ''` fallback arm).
    const noTextCorrection: { data: TurnJobPayload } = {
      data: {
        campaignId: CAMPAIGN,
        sessionId: SESSION,
        turnId: TURN,
        triggerMessages: [],
        maxConsumedSeq: 5,
        trigger: { kind: 'correction' },
      },
    }

    const result = await processTurnJob(deps, noTextCorrection)

    expect(result).toEqual({ ran: true })
    const ctorDeps = (captureSpy.mock.instances[0] as unknown as {
      deps: { pendingDirection?: string }
    }).deps
    expect(ctorDeps.pendingDirection).toBe('[[DM CORRECTION: ]]')

    captureSpy.mockRestore()
  })

  it('a correction turn does NOT consume the standing/one-shot direction slots (its direction is the injected Z, §7.2/D6)', async () => {
    // The correction's direction is the worker-injected `[[DM CORRECTION:]]`
    // marker, not a slot read. A live one-shot/standing direction is unrelated to
    // the correction and must NOT be burned by the correction render.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    await triggerState.setOneShotDirection(CAMPAIGN, 'D')
    await triggerState.setStandingDirection(CAMPAIGN, 'S')

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

    const result = await processTurnJob(deps, correctionPayload('It is actually a forgery.', 1))

    expect(result).toEqual({ ran: true })
    // The unrelated one-shot survives — the correction did not burn it.
    expect(await triggerState.takeOneShotDirection(CAMPAIGN)).toBe('D')
    expect(await triggerState.readStandingDirection(CAMPAIGN)).toBe('S')
  })

  // ── MYT-74b §1 — the player-less FAREWELL turn ───────────────────────────
  /** A `farewell`-kind payload: triggerMessages:[] (player-less), the silent-
   *  consume `farewellText`, a `worldId` carried on the payload (so the finalize
   *  needs no PG re-resolve), and a `maxConsumedSeq` equal to the CURRENT
   *  responded watermark (it must NOT advance past unresponded seqs). */



















})
