// Split from the original monolithic turn-worker.test.ts along its thematic
// describe/it seams. Shared pure-mock builders live in ./_helpers/turn-worker-
// harness.ts + ./_helpers/turn-worker-deps.ts. No DB / scoped fixtures here (this
// suite is pure in-memory mocks), so the CONVENTIONS.md isolation pattern is N/A.
import { describe, expect, it, vi } from 'vitest'
import type { TurnEmitter } from '../tiers/types.js'
import type { TurnPublisher } from '../turn-publisher.js'
import { type TerminalFailureJob, publishTerminalTurnError } from '../turn-worker.js'
import { CAMPAIGN, SESSION, TRIGGER, TURN, alwaysClaim, newCalls, recordingPublisher, silentLogger, terminalFailureJob } from './_helpers/turn-worker-harness.js'

vi.mock('bullmq', () => ({
  Worker: vi.fn(),
  Queue: vi.fn(),
  // The §5 latch-terminal arm throws `UnrecoverableError`; the processor + tests
  // both reference it, so the mock exports a real throwable subclass (not a bare
  // vi.fn) so `instanceof` checks hold. This suite never constructs a Worker/Queue.
  UnrecoverableError: class UnrecoverableError extends Error {},
}))

describe('publishTerminalTurnError', () => {
  it('does NOT publish on a non-final attempt (retries remain)', async () => {
    const calls = newCalls()
    const publisher = recordingPublisher(calls)

    await publishTerminalTurnError(publisher, terminalFailureJob(1, 3), silentLogger, alwaysClaim)

    expect(calls.order).toEqual([])
    expect(calls.turnErrorArgs).toEqual([])
  })

  it('publishes once with the job campaignId/turnId on the final exhausted attempt', async () => {
    const calls = newCalls()
    const publisher = recordingPublisher(calls)

    await publishTerminalTurnError(publisher, terminalFailureJob(3, 3), silentLogger, alwaysClaim)

    expect(calls.order).toEqual(['turn_error'])
    expect(calls.turnErrorArgs).toHaveLength(1)
    expect(calls.turnErrorArgs[0]?.campaignId).toBe(CAMPAIGN)
    expect(calls.turnErrorArgs[0]?.turnId).toBe(TURN)
    expect(typeof calls.turnErrorArgs[0]?.message).toBe('string')
  })

  it('does nothing when job is undefined', async () => {
    const calls = newCalls()
    const publisher = recordingPublisher(calls)

    await publishTerminalTurnError(publisher, undefined, silentLogger, alwaysClaim)

    expect(calls.order).toEqual([])
    expect(calls.turnErrorArgs).toEqual([])
  })

  it('treats an absent opts.attempts as 1 (publishes when attemptsMade reaches the default)', async () => {
    // Branch `opts.attempts ?? 1`: a job whose opts omit `attempts` defaults the
    // cap to 1, so a single made attempt is already terminal.
    const calls = newCalls()
    const publisher = recordingPublisher(calls)
    const job: TerminalFailureJob = {
      attemptsMade: 1,
      opts: {}, // no `attempts` → nullish-coalesces to 1
      data: {
        campaignId: CAMPAIGN,
        sessionId: SESSION,
        turnId: TURN,
        triggerMessages: [TRIGGER],
        maxConsumedSeq: 0,
        trigger: { kind: 'explicit' },
      },
    }

    await publishTerminalTurnError(publisher, job, silentLogger, alwaysClaim)

    expect(calls.order).toEqual(['turn_error'])
    expect(calls.turnErrorArgs).toHaveLength(1)
  })

  it('publishes exactly ONCE across two calls for the same turnId (§4.8 SET-NX latch)', async () => {
    // The cross-container idempotency latch: the JS `failed` listener AND the
    // broker-side QueueEvents can both fire a terminal for one turn. A shared
    // `claim(turnId)` SET-NX gates the publish — exactly one path wins. Modeled
    // here with a stateful fake claim that returns true once then false.
    const calls = newCalls()
    const publisher = recordingPublisher(calls)
    let claimed = false
    const claim = vi.fn((): Promise<boolean> => {
      if (claimed) return Promise.resolve(false)
      claimed = true
      return Promise.resolve(true)
    })

    const job = terminalFailureJob(3, 3)
    // First terminal path wins the latch and publishes.
    await publishTerminalTurnError(publisher, job, silentLogger, claim)
    // Second terminal path for the SAME turnId loses the latch → no publish.
    await publishTerminalTurnError(publisher, job, silentLogger, claim)

    expect(claim).toHaveBeenCalledTimes(2)
    expect(claim).toHaveBeenCalledWith(TURN)
    // Despite two terminal invocations, only one turn_error went out.
    expect(calls.order).toEqual(['turn_error'])
    expect(calls.turnErrorArgs).toHaveLength(1)
  })

  it('does NOT call claim when the job is non-terminal (gate precedes the latch)', async () => {
    // The attempts-exhausted gate runs BEFORE the latch claim, so a non-final
    // attempt never consumes the SET-NX latch (which would wrongly suppress the
    // real terminal publish later).
    const calls = newCalls()
    const publisher = recordingPublisher(calls)
    const claim = vi.fn((): Promise<boolean> => Promise.resolve(true))

    await publishTerminalTurnError(publisher, terminalFailureJob(1, 3), silentLogger, claim)

    expect(claim).not.toHaveBeenCalled()
    expect(calls.order).toEqual([])
  })

  it('logs (does not throw) when the terminal turn_error publish itself rejects', async () => {
    // The `.catch` arm: publisher.turnError rejects. The handler must swallow it
    // into logger.error so no unhandled rejection escapes the 'failed' listener.
    const logger = { warn: vi.fn(), error: vi.fn() }
    const publishErr = new Error('realtime redis unreachable')
    const publisher: TurnPublisher = {
      dmThinking: vi.fn((): Promise<void> => Promise.resolve()),
      textDelta: vi.fn((): Promise<void> => Promise.resolve()),
      skillCheck: vi.fn((): Promise<void> => Promise.resolve()),
      diceRoll: vi.fn((): Promise<void> => Promise.resolve()),
      ledgerUpdate: vi.fn((): Promise<void> => Promise.resolve()),
      modeChange: vi.fn((): Promise<void> => Promise.resolve()),
      combatStarted: vi.fn((): Promise<void> => Promise.resolve()),
      combatResolved: vi.fn((): Promise<void> => Promise.resolve()),
      dmCorrection: vi.fn((): Promise<void> => Promise.resolve()),
      turnEnd: vi.fn((): Promise<void> => Promise.resolve()),
      turnReplace: vi.fn((): Promise<void> => Promise.resolve()),
      turnError: vi.fn((): Promise<void> => Promise.reject(publishErr)),
      emitFor: vi.fn(
        (): TurnEmitter => ({
          emitText: (): Promise<void> => Promise.resolve(),
          emitSkillCheck: (): Promise<void> => Promise.resolve(),
          emitDiceRoll: (): Promise<void> => Promise.resolve(),
          emitLedgerUpdate: (): Promise<void> => Promise.resolve(),
          emitModeChange: (): Promise<void> => Promise.resolve(),
          emitCombatStarted: (): Promise<void> => Promise.resolve(),
          emitCombatResolved: (): Promise<void> => Promise.resolve(),
          emitCorrection: (): Promise<void> => Promise.resolve(),
        }),
      ),
    }
    const original = new Error('the underlying turn failure')

    await publishTerminalTurnError(publisher, terminalFailureJob(3, 3), logger, alwaysClaim, original)

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
