// myth-aiiao — the corrected-turn WHOLE-TURN-REPLACE push. When the audit
// gate's silent retry becomes the durable turn, the live client's canon is
// still the discarded attempt 1; the worker must rebuild the turn's replay
// frames from the persisted rows and publish ONE live `session_reconnect`
// frame (the client's transcript reducer whole-turn-replaces on its turnIds).
// Pure in-memory mocks (no DB) like the sibling split suites; the tiers fake
// fires TierTurnArgs.onAuditCorrected mid-render to simulate the gate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { type SessionState, makeSessionState } from '../../redis/session-state.js'
import { DEPARTED_AUTHOR_NAME } from '../attribution.js'
import { type TriggerState, makeTriggerState } from '../trigger-state.js'
import { type TurnProcessorDeps, processTurnJob } from '../turn-worker.js'
import type { SessionMessage } from '../../repo/types.js'
import type { AssistantMessage, FastThinker } from '../tiers/types.js'
import {
  CAMPAIGN,
  KEY_PREFIX,
  SESSION,
  TURN,
  correctionPayload,
  fakeHandle,
  fakeLock,
  fakeRepo,
  newCalls,
  payload,
  recordingPublisher,
  silentLogger,
} from './_helpers/turn-worker-harness.js'
import {
  inertCombatLedger,
  inertDmTriggerQueue,
  inertEndSession,
  inertFinalize,
  inertLedgerTx,
  inertScribeQueue,
  inertStEvalQueue,
  inertTurnQueue,
} from './_helpers/turn-worker-deps.js'

vi.mock('bullmq', () => ({
  Worker: vi.fn(),
  Queue: vi.fn(),
  UnrecoverableError: class UnrecoverableError extends Error {},
}))

/** An FT stub that emits one line and (optionally) fires the audit-corrected
 *  signal mid-render — the seam the real AuditedFastThinker calls on a clean
 *  retry. */
function correctedTiers(onRender?: () => void): TurnProcessorDeps['makeTiers'] {
  return (turn) => {
    const ft: FastThinker = {
      render: async (_ctx, emit): Promise<AssistantMessage> => {
        await emit.emitText('The vault light holds steady.')
        onRender?.()
        turn.onAuditCorrected()
        return {
          role: 'assistant',
          parts: [{ kind: 'text', text: 'The vault light holds steady.' }],
          usage: { input: 3, output: 4 },
        }
      },
    }
    return { ft, combatEvents: [] }
  }
}

function dmTextRow(seq: number, ordinal: number, content: string): SessionMessage {
  return {
    id: `m-${String(seq)}`,
    sessionId: SESSION,
    seq,
    userId: null,
    messageType: 'dm_text',
    content,
    createdAt: new Date('2026-07-24T00:00:00Z'),
    turnId: TURN,
    turnOrdinal: ordinal,
    triggerKind: null,
  }
}

describe('processTurnJob — myth-aiiao corrected-turn whole-turn-replace', () => {
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

  function makeDeps(over: Partial<TurnProcessorDeps> = {}): {
    deps: TurnProcessorDeps
    calls: ReturnType<typeof newCalls>
  } {
    const calls = newCalls()
    const handle = fakeHandle({ extendReturns: true, release: vi.fn() })
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
      makeTiers: correctedTiers(),
      heartbeatMs: 10_000,
      logger: silentLogger,
      ...over,
    }
    return { deps, calls }
  }

  it('a corrected player-triggered turn publishes ONE session_reconnect replace (persisted rows → replay frames), BEFORE turn_end', async () => {
    const rows = [
      dmTextRow(7, 0, 'The fingers do not yield.'),
      dmTextRow(8, 1, 'The vault light holds steady.'),
    ]
    const { deps, calls } = makeDeps({
      repo: fakeRepo({
        turnRows: rows,
        participants: [{ userId: 'u1', name: 'Sable' }],
        members: [{ userId: 'u1', displayName: 'Miklos' }],
      }),
    })

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(calls.turnReplaceArgs).toHaveLength(1)
    const replace = calls.turnReplaceArgs[0]
    expect(replace?.campaignId).toBe(CAMPAIGN)
    // The messages are the persisted rows mapped through rowToReplayFrame —
    // seq-bearing dm_message frames under the SAME turnId (the reducer's
    // whole-turn-replace key).
    expect(replace?.messages).toEqual([
      { type: 'dm_message', seq: 7, turnId: TURN, text: 'The fingers do not yield.' },
      { type: 'dm_message', seq: 8, turnId: TURN, text: 'The vault light holds steady.' },
    ])
    // Participants resolve through the roster + member display names.
    expect(replace?.participants).toEqual([
      { userId: 'u1', displayName: 'Miklos', characterName: 'Sable' },
    ])
    expect(replace?.mode).toBe('exploration')
    // Ordering: the replace lands before the turn settles.
    expect(calls.order.indexOf('turn_replace')).toBeLessThan(calls.order.indexOf('turn_end'))
  })

  it('a NON-corrected turn publishes NO replace', async () => {
    const { deps, calls } = makeDeps({
      // The default harness makeTiers never fires onAuditCorrected.
      makeTiers: (turn) => {
        void turn
        const ft: FastThinker = {
          render: async (_ctx, emit): Promise<AssistantMessage> => {
            await emit.emitText('clean')
            return { role: 'assistant', parts: [{ kind: 'text', text: 'clean' }], usage: { input: 1, output: 1 } }
          },
        }
        return { ft, combatEvents: [] }
      },
    })

    await processTurnJob(deps, payload())

    expect(calls.turnReplaceArgs).toHaveLength(0)
    expect(calls.order).not.toContain('turn_replace')
  })

  it('a corrected PLAYERLESS (correction) turn publishes NO replace — the buffered gate already made live == durable', async () => {
    const { deps, calls } = makeDeps({
      repo: fakeRepo({ turnRows: [dmTextRow(9, 0, 'corrected')] }),
    })

    const result = await processTurnJob(deps, correctionPayload('the fist never opened', 3))

    expect(result).toEqual({ ran: true })
    expect(calls.turnReplaceArgs).toHaveLength(0)
    expect(calls.order).not.toContain('turn_replace')
  })

  it('the replace roster resolves a DEPARTED member to the departed author name, and carries the LIVE mode', async () => {
    // u-gone still has a session PC but is no longer a campaign member; the
    // session is mid-combat, so the replace frame must say so (a reconnect
    // during exploration-by-default would flip the client's combat chrome off).
    await sessionState.setState(CAMPAIGN, { participants: ['u1'], mode: 'combat', status: 'active' })
    const { deps, calls } = makeDeps({
      repo: fakeRepo({
        turnRows: [dmTextRow(7, 0, 'Steel rings out.')],
        participants: [
          { userId: 'u1', name: 'Sable' },
          { userId: 'u-gone', name: 'Brenna Kell' },
        ],
        members: [{ userId: 'u1', displayName: 'Miklos' }],
      }),
    })

    await processTurnJob(deps, payload())

    const replace = calls.turnReplaceArgs[0]
    expect(replace?.mode).toBe('combat')
    expect(replace?.participants).toEqual([
      { userId: 'u1', displayName: 'Miklos', characterName: 'Sable' },
      { userId: 'u-gone', displayName: DEPARTED_AUTHOR_NAME, characterName: 'Brenna Kell' },
    ])
  })

  it('a successful replace push logs the frame count (the forensic record that live was repaired)', async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
    const { deps, calls } = makeDeps({
      repo: fakeRepo({ turnRows: [dmTextRow(7, 0, 'The fingers do not yield.')] }),
      logger,
    })

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(calls.turnReplaceArgs).toHaveLength(1)
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, turnId: TURN, frames: 1 }),
      expect.stringContaining('whole-turn-replace'),
    )
  })

  it('a replace-push failure is contained (turn still ends cleanly; error logged)', async () => {
    const failingRepo = fakeRepo({ turnRows: [dmTextRow(7, 0, 'x')] })
    const { deps, calls } = makeDeps({
      repo: {
        ...failingRepo,
        sessionMessages: {
          ...failingRepo.sessionMessages,
          listByTurn: () => Promise.reject(new Error('pg boom')),
        },
      },
    })

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    expect(calls.order).not.toContain('turn_replace')
    expect(silentLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, turnId: TURN }),
      expect.stringContaining('whole-turn-replace'),
    )
  })
})
