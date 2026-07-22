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
import type { AssistantMessage, FastThinker, FtTurnContext, PartyLedgerSnapshot, TurnEmitter } from '../tiers/types.js'
import { type TriggerState, makeTriggerState } from '../trigger-state.js'
import { type TurnProcessorDeps, processTurnJob } from '../turn-worker.js'
import { KEY_PREFIX, SESSION, TURN, fakeHandle, fakeLock, fakeRepo, makeTiers, newCalls, payload, recordingPublisher, silentLogger } from './_helpers/turn-worker-harness.js'
import { inertCombatLedger, inertDmTriggerQueue, inertEndSession, inertFinalize, inertLedgerTx, inertScribeQueue, inertStEvalQueue, inertTurnQueue } from './_helpers/turn-worker-deps.js'

vi.mock('bullmq', () => ({
  Worker: vi.fn(),
  Queue: vi.fn(),
  // The §5 latch-terminal arm throws `UnrecoverableError`; the processor + tests
  // both reference it, so the mock exports a real throwable subclass (not a bare
  // vi.fn) so `instanceof` checks hold. This suite never constructs a Worker/Queue.
  UnrecoverableError: class UnrecoverableError extends Error {},
}))

describe('processTurnJob — roster attribution & party ledger', () => {
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

  it('builds the attribution map from a non-empty participant roster and completes the turn', async () => {
    // Exercises the userId → character-name map construction (the
    // listSessionParticipantCharacters .map callback) on a non-empty roster. The
    // stub tiers don't read the map's contents, so the observable effect is the
    // turn completing through persist (appendDmTurn fired) with the roster present
    // — the controller received a populated map without erroring.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    const appendDmTurn = vi.fn((): Promise<void> => Promise.resolve())
    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({
        turnRowsExist: false,
        participants: [
          { userId: 'u1', name: 'Mara' },
          { userId: 'u2', name: 'Theo' },
        ],
        appendDmTurn,
      }),
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
    // The turn ran to the durability point: the stub FT's rendered line was
    // appended (persistTurn) and turn_end shipped — with the roster mapped.
    expect(appendDmTurn).toHaveBeenCalledTimes(1)
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
  })

  it('resolves the roster from session_participants and attributes player rows by CHARACTER name (MYT-68)', async () => {
    // The bug this fixes: the roster (and the player-attribution map) used to come
    // from the campaign DISPLAY names — so the FT ctx attributed a player row to
    // "Dev User 1", the model echoed that into roll_skill_check.character_name,
    // and the resolver (which speaks character names) returned not_found, fail-
    // softing the first check. The worker now resolves BOTH off
    // repo.characters.listSessionParticipantCharacters (CHARACTER names). Capture
    // the ctx the FT receives to prove the resolved names reach BOTH the roster
    // and the rendered ftHistory attribution.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    let seenParticipants: readonly string[] | null = null
    let seenHistory: FtTurnContext['ftHistory'] | null = null
    const capturingFt: FastThinker = {
      render: vi.fn(
        async (ctx: FtTurnContext, emit: TurnEmitter): Promise<AssistantMessage> => {
          seenParticipants = ctx.participants
          seenHistory = ctx.ftHistory
          await emit.emitText('chunk')
          return {
            role: 'assistant',
            parts: [{ kind: 'text', text: 'ok' }],
            usage: { input: 0, output: 0 },
          }
        },
      ),
    }

    const repo = fakeRepo({
      turnRowsExist: false,
      participants: [
        { userId: 'u1', name: 'Bryn' },
        { userId: 'u2', name: 'Arin' },
      ],
    })
    // One player row authored by u1 — the codec must attribute it as the CHARACTER
    // name "Bryn" (NOT the userId, NOT a display name), proving the attribution
    // map carries character names into the rendered FT history.
    repo.sessionMessages.listFtContextRows = () =>
      Promise.resolve([
        {
          id: 'm1',
          sessionId: SESSION,
          seq: 1,
          turnId: 't0',
          messageType: 'player_message',
          userId: 'u1',
          content: 'I keep to the shadows.',
          createdAt: new Date(),
        } as never,
      ])

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
      makeTiers: () => ({ ft: capturingFt, combatEvents: [] }),
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    // The resolved roster (deterministic joined order) reached the FT ctx.
    expect(seenParticipants).toEqual(['Bryn', 'Arin'])
    // The player row was attributed by CHARACTER name, not userId/display name.
    const history = seenHistory as unknown as FtTurnContext['ftHistory']
    const userMsg = history.find((m) => m.role === 'user')
    expect(userMsg?.role === 'user' ? userMsg.characterName : undefined).toBe('Bryn')
  })

  // ── MYT-70 §7 — per-turn party-ledger snapshot load ──────────────────────
  it('fresh run loads the party-ledger snapshot and threads it into the controller deps (§7)', async () => {
    // The fresh-run arm reads repo.characters.readPartyLedgerSnapshot(sessionId)
    // alongside the roster, and constructs the controller with `partyLedger` set.
    // Capture the ctor deps off the controller instance (the same capture seam
    // the §6 direction-slot test uses).
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const partyLedgerCalls: string[] = []

    const snapshot: PartyLedgerSnapshot = [
      {
        characterId: 'ch1',
        name: 'Mara',
        hitPoints: 11,
        maxHitPoints: 14,
        hitDie: 8,
        hitDiceRemaining: 2,
        level: 3,
        gold: 25,
        slots: [],
        conditions: [],
        trackedFeatures: [],
        spells: [],
        equipment: [],
      },
    ]

    const captureSpy = vi.spyOn(SessionController.prototype, 'loadFromRedis')

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({ partyLedgerCalls, partyLedger: snapshot }),
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
    // The snapshot read was driven exactly once, for this session.
    expect(partyLedgerCalls).toEqual([SESSION])
    // The controller received the snapshot on its deps.
    const ctorDeps = (captureSpy.mock.instances[0] as unknown as {
      deps: { partyLedger?: PartyLedgerSnapshot }
    }).deps
    expect(ctorDeps.partyLedger).toEqual(snapshot)

    captureSpy.mockRestore()
  })

  it('the converge path does NOT load the party-ledger snapshot (fresh-run-only read, §7)', async () => {
    // A durable turn converges before the fresh-run arm — it must not issue the
    // per-turn snapshot read (matching the roster-load placement).
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const partyLedgerCalls: string[] = []

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({ turnRowsExist: true, partyLedgerCalls }),
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
    expect(partyLedgerCalls).toEqual([])
  })

  it('the latch-terminal path does NOT load the party-ledger snapshot (§7)', async () => {
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const partyLedgerCalls: string[] = []

    await triggerState.markTurnEmitted(TURN)

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({ turnRowsExist: false, partyLedgerCalls }),
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
    expect(partyLedgerCalls).toEqual([])
  })

  it('a contention loser (no lock) does NOT load the party-ledger snapshot (§7)', async () => {
    const calls = newCalls()
    const partyLedgerCalls: string[] = []

    const deps: TurnProcessorDeps = {
      lock: fakeLock(null),
      sessionState,
      repo: fakeRepo({ partyLedgerCalls }),
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
    expect(partyLedgerCalls).toEqual([])
  })

  // ── MYT-69 §6/§2 — direction slots + st-evaluation enqueue ────────────────
})
