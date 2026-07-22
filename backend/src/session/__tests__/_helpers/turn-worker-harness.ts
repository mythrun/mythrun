// Shared core fakes for the split `turn-worker` unit suites. Injected mocks +
// fixture builders — no DB, no scoped fixtures (this suite never touches
// Postgres), so the CONVENTIONS.md isolation pattern doesn't apply here. The
// queue recorders, inert deps, and combat fixtures live in the sibling
// `turn-worker-deps.ts`; the `bullmq` mock + captured worker state live only in
// the `buildSessionTurnWorker` suite (the one path that constructs a Worker).
import { vi, type MockInstance } from 'vitest'
import { SessionController } from '../../session-controller.js'
import { StubFastThinker } from '../../tiers/stubs.js'
import type {
  PartyLedgerSnapshot,
  TriggerMessage,
  TurnEmitter,
} from '../../tiers/types.js'
import type { SessionMessage } from '../../../repo/types.js'
import type { SessionLock, SessionLockHandle } from '../../session-lock.js'
import type { TurnPublisher } from '../../turn-publisher.js'
import { FAREWELL_DIRECTION, type TurnJobPayload } from '../../turn-queue.js'
import type { TerminalFailureJob, TurnProcessorDeps, TurnWorkerRepo } from '../../turn-worker.js'

export const KEY_PREFIX = 'tw:'
export const CAMPAIGN = 'c-tw-1'
export const TURN = 't-tw-1'
export const SESSION = 's-tw-1'

export const TRIGGER: TriggerMessage = { userId: 'u1', characterName: 'Mara', text: 'I open the door' }

export function payload(): { data: TurnJobPayload } {
  return {
    data: {
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      turnId: TURN,
      triggerMessages: [TRIGGER],
      maxConsumedSeq: 0,
      trigger: { kind: 'explicit' },
    },
  }
}

export interface PublisherCalls {
  readonly order: string[]
  /** Args of each turnError call, so the H8 assertions read from a plain array
   *  rather than `expect(publisher.turnError)` (which detaches the method —
   *  `@typescript-eslint/unbound-method`). */
  readonly turnErrorArgs: { campaignId: string; turnId: string; message: string }[]
}

export function newCalls(): PublisherCalls {
  return { order: [], turnErrorArgs: [] }
}

export function recordingPublisher(calls: PublisherCalls): TurnPublisher {
  return {
    dmThinking: vi.fn((): Promise<void> => {
      calls.order.push('dm_thinking')
      return Promise.resolve()
    }),
    textDelta: vi.fn((): Promise<void> => {
      calls.order.push('text_delta')
      return Promise.resolve()
    }),
    turnEnd: vi.fn((): Promise<void> => {
      calls.order.push('turn_end')
      return Promise.resolve()
    }),
    skillCheck: vi.fn((): Promise<void> => {
      calls.order.push('skill_check')
      return Promise.resolve()
    }),
    diceRoll: vi.fn((): Promise<void> => {
      calls.order.push('dice_roll')
      return Promise.resolve()
    }),
    ledgerUpdate: vi.fn((): Promise<void> => {
      calls.order.push('ledger_update')
      return Promise.resolve()
    }),
    modeChange: vi.fn((): Promise<void> => {
      calls.order.push('mode_change')
      return Promise.resolve()
    }),
    combatStarted: vi.fn((): Promise<void> => {
      calls.order.push('combat_started')
      return Promise.resolve()
    }),
    combatResolved: vi.fn((): Promise<void> => {
      calls.order.push('combat_resolved')
      return Promise.resolve()
    }),
    dmCorrection: vi.fn((): Promise<void> => {
      calls.order.push('dm_correction')
      return Promise.resolve()
    }),
    turnError: vi.fn((campaignId: string, turnId: string, message: string): Promise<void> => {
      calls.order.push('turn_error')
      calls.turnErrorArgs.push({ campaignId, turnId, message })
      return Promise.resolve()
    }),
    emitFor: vi.fn((campaignId: string, turnId: string): TurnEmitter => {
      void campaignId
      void turnId
      return {
        emitText: (_text: string): Promise<void> => {
          void _text
          calls.order.push('text_delta')
          return Promise.resolve()
        },
        emitSkillCheck: (): Promise<void> => {
          calls.order.push('skill_check')
          return Promise.resolve()
        },
        emitDiceRoll: (): Promise<void> => {
          calls.order.push('dice_roll')
          return Promise.resolve()
        },
        emitLedgerUpdate: (): Promise<void> => {
          calls.order.push('ledger_update')
          return Promise.resolve()
        },
        emitModeChange: (): Promise<void> => {
          calls.order.push('mode_change')
          return Promise.resolve()
        },
        emitCombatStarted: (): Promise<void> => {
          calls.order.push('combat_started')
          return Promise.resolve()
        },
        emitCombatResolved: (): Promise<void> => {
          calls.order.push('combat_resolved')
          return Promise.resolve()
        },
        emitCorrection: (): Promise<void> => {
          calls.order.push('dm_correction')
          return Promise.resolve()
        },
      }
    }),
  }
}

/** A fake lock handle. `extend` returns whatever the test wants; `release`
 *  records that it was called (the finally-block invariant). */
export function fakeHandle(opts: {
  extendReturns: boolean
  release: ReturnType<typeof vi.fn>
}): SessionLockHandle {
  return {
    token: 'tok',
    extend: vi.fn((): Promise<boolean> => Promise.resolve(opts.extendReturns)),
    release: opts.release,
  }
}

export function fakeLock(handle: SessionLockHandle | null): SessionLock {
  return {
    tryAcquire: vi.fn((): Promise<SessionLockHandle | null> => Promise.resolve(handle)),
  }
}

export const silentLogger = { warn: vi.fn(), error: vi.fn() }

/** Install a SLOW `processDmTurn` on the controller so a tiny-interval heartbeat
 *  fires (flipping lockLost) DURING the turn body, before its next lock-gate
 *  checkpoint. The in-turn SlowThinker seam is retired (MYT-69), so the slow
 *  phase that used to be a stubbed `st.evaluate` is now the controller's render
 *  step. Returns the spy so the caller can restore it (a describe-wide
 *  restoreAllMocks would tear down the module-level `bullmq` mock). */
export function installSlowProcessDmTurn(): MockInstance<(maxConsumedSeq: number) => Promise<void>> {
  const spy = vi.spyOn(SessionController.prototype, 'processDmTurn')
  spy.mockImplementation(
    () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve()
        }, 40)
      }),
  )
  return spy
}

export function makeTiers(): ReturnType<TurnProcessorDeps['makeTiers']> {
  // MYT-75: makeTiers now returns the per-turn combatEvents accumulator (the
  // combat tools push into it; the worker reads it post-turn at T7).
  return { ft: new StubFastThinker(), combatEvents: [] }
}

/** A minimal in-memory `TurnWorkerRepo`. Overrides let a test set
 *  `turnRowsExist`/`wasTurnEmitted`-adjacent behavior, the member roster, etc.
 *  Defaults: no durable rows, empty transcript, no roster, no prep, no
 *  participant character — the fresh-run path against the stub tiers. */
export function fakeRepo(overrides?: {
  turnRowsExist?: boolean
  session?: { sessionNumber: number } | null
  ftContext?: string | null
  appendDmTurn?: (input: unknown) => Promise<void>
  /** §4.7 post-turn re-mature probe: the rows above the responded watermark the
   *  `finally` re-arm reads. Default empty → no re-arm. */
  trailingRows?: readonly { messageType: string }[]
  /** Make `listAfterSeq` reject, to drive the re-arm catch arm. */
  listAfterSeqRejects?: Error
  /** MYT-68: the session-participant roster the worker resolves per turn from
   *  session_participants — `{userId, name}` in joined order. The names feed the
   *  FT prompt roster; the userId→name map is the codec's player attribution.
   *  Default [] → an empty roster. */
  participants?: readonly { userId: string; name: string }[]
  /** MYT-70 §7: a recorder of the sessionIds `readPartyLedgerSnapshot` was
   *  called with — proves the fresh-run arm loads the snapshot (and the
   *  non-rendering paths do NOT). */
  partyLedgerCalls?: string[]
  /** MYT-70 §7: the party-ledger snapshot the read returns (default []). */
  partyLedger?: PartyLedgerSnapshot
  /** MYT-74a T12: the durable cumulative usage the budget auto-end reads. Default
   *  `null` (a fresh session with no recorded usage) → 0 cumulative tokens → under
   *  budget → no auto-end. */
  budgetSummary?: { inputTokens: number; outputTokens: number } | null
  /** myth-dwyuw: the transcript rows `augmentFtContextWithEntityCards` scans as
   *  its name-detection haystack (also the controller's history rebuild). Default
   *  [] → augment early-returns the base ft_context. */
  ftContextRows?: readonly SessionMessage[]
  /** myth-dwyuw: the KNOWN-tier canon entities `augment` loads (default []). */
  canonEntities?: readonly { id: string; name: string; entityType: string }[]
  /** myth-dwyuw: the KNOWN-tier facts `augment` loads per matched entity (default []). */
  canonFacts?: readonly { entityId: string; content: string }[]
  /** myth-dwyuw: a recorder of the worldIds `entities.listByWorld` was called
   *  with — proves the wire-up threads the RESOLVED worldId into `augment`. */
  augmentWorldIds?: string[]
}): TurnWorkerRepo {
  const session = overrides?.session === undefined ? { sessionNumber: 1 } : overrides.session
  const prep = overrides?.ftContext == null ? null : { ftContext: overrides.ftContext }
  const trailing = overrides?.trailingRows ?? []
  const budget = overrides?.budgetSummary ?? null
  return {
    sessionMessages: {
      turnRowsExist: () => Promise.resolve(overrides?.turnRowsExist ?? false),
      listFtContextRows: () => Promise.resolve([...(overrides?.ftContextRows ?? [])]),
      appendDmTurn: overrides?.appendDmTurn ?? ((): Promise<void> => Promise.resolve()),
      maxSeq: () => Promise.resolve(0),
      listAfterSeq: () =>
        overrides?.listAfterSeqRejects
          ? Promise.reject(overrides.listAfterSeqRejects)
          : Promise.resolve(trailing),
    },
    sessions: {
      getById: () => Promise.resolve(session),
      budgetSummary: () => Promise.resolve(budget),
    },
    sessionPreps: {
      getBy: () => Promise.resolve(prep),
    },
    campaigns: {
      // MYT-72: the world-id lookup `resolveWorldId` reads on the fresh-run arm.
      // Default a stable world id so the fresh-run tests resolve cleanly.
      getWorldId: () => Promise.resolve('w-fake'),
    },
    characters: {
      findSessionParticipantCharacterByName: () => Promise.resolve({ outcome: 'not_found' }),
      listSessionParticipantCharacters: () => Promise.resolve(overrides?.participants ?? []),
      readPartyLedgerSnapshot: (sessionId: string) => {
        overrides?.partyLedgerCalls?.push(sessionId)
        return Promise.resolve(overrides?.partyLedger ?? [])
      },
    },
    // myth-dwyuw canon surface — no entities/facts by default, so
    // augmentFtContextWithEntityCards is a clean no-op (returns base ft_context).
    entities: {
      listByWorld: (worldId: string) => {
        overrides?.augmentWorldIds?.push(worldId)
        return Promise.resolve([...(overrides?.canonEntities ?? [])])
      },
    },
    facts: { listByEntities: () => Promise.resolve([...(overrides?.canonFacts ?? [])]) },
  }
}

/** A §7.2/D6 correction-turn payload: no trigger messages, the vetted
 *  secret-free `Z` on `correctionText`, and a maxConsumedSeq equal to the
 *  CURRENT responded watermark (it must NOT advance past unresponded seqs). */
export function correctionPayload(
  correctionText: string,
  maxConsumedSeq: number,
): { data: TurnJobPayload } {
  return {
    data: {
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      turnId: TURN,
      triggerMessages: [],
      maxConsumedSeq,
      trigger: { kind: 'correction' },
      correctionText,
    },
  }
}

/** A §1 farewell-turn payload: player-less, `farewellText` as the RAW direction,
 *  and a worldId the §1.3 finalize resolves against. */
export function farewellPayload(opts?: {
  farewellText?: string
  worldId?: string
  maxConsumedSeq?: number
}): { data: TurnJobPayload } {
  return {
    data: {
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      turnId: TURN,
      triggerMessages: [],
      maxConsumedSeq: opts?.maxConsumedSeq ?? 0,
      trigger: { kind: 'farewell' },
      farewellText: opts?.farewellText ?? FAREWELL_DIRECTION,
      worldId: opts?.worldId ?? 'w-farewell',
    },
  }
}

/** An H8-boundary terminal-failure job for the `publishTerminalTurnError` gate:
 *  `attemptsMade`/`opts.attempts` drive the retries-exhausted check. */
export function terminalFailureJob(attemptsMade: number, attempts: number): TerminalFailureJob {
  return {
    attemptsMade,
    opts: { attempts },
    data: {
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      turnId: TURN,
      triggerMessages: [TRIGGER],
      maxConsumedSeq: 0,
      trigger: { kind: 'explicit' },
    },
  }
}

/** A claim fn that always wins the latch (the single-publisher case). */
export const alwaysClaim = (): Promise<boolean> => Promise.resolve(true)
