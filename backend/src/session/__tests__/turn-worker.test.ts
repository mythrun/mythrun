import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import type { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  makeSessionState,
  type CombatOutcome,
  type SessionState,
  type SessionStateBlob,
} from '../../redis/session-state.js'
import type { LedgerOps } from '../../repo/characters-ledger.js'
import type { Character } from '../../repo/types.js'
import type { CombatEvent } from '../combat/events.js'
import type { ReconciledCombat } from '../combat/apply.js'
import type { CombatEnemy } from '../combat/outcome.js'
import { sessionChannelPattern } from '../../contract/session-channel.js'
import { SessionController } from '../session-controller.js'
import { StubFastThinker } from '../tiers/stubs.js'
import type {
  AssistantMessage,
  FastThinker,
  FtTurnContext,
  PartyLedgerSnapshot,
  TriggerMessage,
  TurnEmitter,
} from '../tiers/types.js'
import type { SessionLock, SessionLockHandle } from '../session-lock.js'
import { makeTriggerState, type TriggerState } from '../trigger-state.js'
import type { TurnPublisher } from '../turn-publisher.js'
import { FAREWELL_DIRECTION, TURN_JOB_NAME, type TurnJobPayload, type TurnQueueLike } from '../turn-queue.js'
import { type DmTriggerQueueLike } from '../dm-trigger-queue.js'
import {
  ST_EVAL_JOB_NAME,
  type StEvalPayload,
  type StEvalQueueLike,
} from '../st-eval-queue.js'
import { SCRIBE_JOB_NAME, type ScribeJobPayload, type ScribeQueueLike } from '../scribe-queue.js'
import type { WorkingSetProposal } from '../working-set/types.js'
import { QUIET_WINDOW_MS } from '../dm-trigger-config.js'
import { SESSION_TOKEN_BUDGET } from '../st-config.js'
import { UnrecoverableError } from 'bullmq'
import {
  buildSessionTurnWorker,
  makeLatchedEmitter,
  processTurnJob,
  publishTerminalTurnError,
  reloadFtContext,
  resolveWorldId,
  type TerminalFailureJob,
  type TurnProcessorDeps,
  type TurnWorkerRepo,
} from '../turn-worker.js'
import type { VoyageEmbedder } from '../../llm/embed.js'

// `buildSessionTurnWorker` is boot-wiring around `new BullmqWorker(...)`. To
// exercise its body WITHOUT a broker, mock `bullmq` so the `Worker` constructor
// captures the processor fn + every `.on(event, handler)` registration. The
// captured processor is then invoked with a real payload (running `processTurnJob`
// over ioredis-mock, which covers the `makeTiers` closure), and the captured
// `'failed'` handler is invoked directly (covering the arrow that delegates to
// `publishTerminalTurnError`). The `processTurnJob` unit tests above don't touch
// `bullmq` at runtime (the module only imports the type), so this mock is inert
// for them.
//
// The captured processor + handlers are typed structurally (not as bullmq's
// `Job`): the builder passes a `(job: Job | undefined, err) => void`, but every
// field the 'failed' arrow reads is already on `TerminalFailureJob`, so storing
// the handler against that narrower view lets us invoke it with a plain fake —
// no `as Job` cast. The mock's `on` accepts `unknown` args so the wider builder
// handler still type-checks at the registration call site.
type ProcessorFn = (job: { data: TurnJobPayload }) => Promise<{ ran: boolean }>
type FailedHandler = (job: TerminalFailureJob | undefined, err: Error) => void
interface CapturedWorker {
  readonly processor: ProcessorFn
  readonly handlers: Map<string, FailedHandler>
}
const captured: { worker: CapturedWorker | null } = { worker: null }

// Every `add(name, data)` the builder's explicit-drain `Queue` receives, so the
// buildSessionTurnWorker drain path is assertable without a broker.
const capturedQueueAdds: { name: string; data: TurnJobPayload }[] = []

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation((_name: string, processor: ProcessorFn) => {
    const handlers = new Map<string, FailedHandler>()
    const instance = {
      processor,
      handlers,
      on: (event: string, handler: FailedHandler) => {
        handlers.set(event, handler)
      },
    }
    captured.worker = { processor, handlers }
    return instance
  }),
  // The builder constructs ONE `Queue` for the explicit drain. Mock it as a thin
  // recorder so `new Queue(...)` doesn't touch a real connection.
  Queue: vi.fn().mockImplementation(() => ({
    add: (name: string, data: TurnJobPayload) => {
      capturedQueueAdds.push({ name, data })
      return Promise.resolve(undefined)
    },
  })),
  // The §5 latch-terminal arm throws `UnrecoverableError`; the processor + tests
  // both reference it, so the mock must export a real throwable subclass (not a
  // bare vi.fn) so `instanceof` checks hold.
  UnrecoverableError: class UnrecoverableError extends Error {},
}))

// processTurnJob is UNIT-tested with INJECTED fakes (a fake SessionLock, a
// recording TurnPublisher, stub tiers) and a real `makeSessionState` over
// ioredis-mock so the flush is asserted via `loadTurnState`. The end-to-end run
// with a real BullMQ Worker is Tasks 10/11 — we never construct one here.

const KEY_PREFIX = 'tw:'
const CAMPAIGN = 'c-tw-1'
const TURN = 't-tw-1'
const SESSION = 's-tw-1'

const TRIGGER: TriggerMessage = { userId: 'u1', characterName: 'Mara', text: 'I open the door' }

function payload(): { data: TurnJobPayload } {
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

interface PublisherCalls {
  readonly order: string[]
  /** Args of each turnError call, so the H8 assertions read from a plain array
   *  rather than `expect(publisher.turnError)` (which detaches the method —
   *  `@typescript-eslint/unbound-method`). */
  readonly turnErrorArgs: { campaignId: string; turnId: string; message: string }[]
}

function newCalls(): PublisherCalls {
  return { order: [], turnErrorArgs: [] }
}

function recordingPublisher(calls: PublisherCalls): TurnPublisher {
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
      }
    }),
  }
}

/** A fake lock handle. `extend` returns whatever the test wants; `release`
 *  records that it was called (the finally-block invariant). */
function fakeHandle(opts: {
  extendReturns: boolean
  release: ReturnType<typeof vi.fn>
}): SessionLockHandle {
  return {
    token: 'tok',
    extend: vi.fn((): Promise<boolean> => Promise.resolve(opts.extendReturns)),
    release: opts.release,
  }
}

function fakeLock(handle: SessionLockHandle | null): SessionLock {
  return {
    tryAcquire: vi.fn((): Promise<SessionLockHandle | null> => Promise.resolve(handle)),
  }
}

const silentLogger = { warn: vi.fn(), error: vi.fn() }

/** Install a SLOW `processDmTurn` on the controller so a tiny-interval heartbeat
 *  fires (flipping lockLost) DURING the turn body, before its next lock-gate
 *  checkpoint. The in-turn SlowThinker seam is retired (MYT-69), so the slow
 *  phase that used to be a stubbed `st.evaluate` is now the controller's render
 *  step. Returns the spy so the caller can restore it (a describe-wide
 *  restoreAllMocks would tear down the module-level `bullmq` mock). */
function installSlowProcessDmTurn(): MockInstance<(maxConsumedSeq: number) => Promise<void>> {
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

function makeTiers(): ReturnType<TurnProcessorDeps['makeTiers']> {
  // MYT-75: makeTiers now returns the per-turn combatEvents accumulator (the
  // combat tools push into it; the worker reads it post-turn at T7).
  return { ft: new StubFastThinker(), combatEvents: [] }
}

/** A minimal in-memory `TurnWorkerRepo`. Overrides let a test set
 *  `turnRowsExist`/`wasTurnEmitted`-adjacent behavior, the member roster, etc.
 *  Defaults: no durable rows, empty transcript, no roster, no prep, no
 *  participant character — the fresh-run path against the stub tiers. */
function fakeRepo(overrides?: {
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
}): TurnWorkerRepo {
  const session = overrides?.session === undefined ? { sessionNumber: 1 } : overrides.session
  const prep = overrides?.ftContext == null ? null : { ftContext: overrides.ftContext }
  const trailing = overrides?.trailingRows ?? []
  const budget = overrides?.budgetSummary ?? null
  return {
    sessionMessages: {
      turnRowsExist: () => Promise.resolve(overrides?.turnRowsExist ?? false),
      listFtContextRows: () => Promise.resolve([]),
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
  }
}

/** Records the `(name, data, opts)` of every enqueued explicit-drain follow-up
 *  turn so the §4.7 drain assertions read the payload off a plain array. */
interface QueueCall {
  readonly name: string
  readonly data: TurnJobPayload
}

function recordingTurnQueue(calls: QueueCall[]): TurnQueueLike {
  const add = vi.fn((name: string, data: TurnJobPayload): Promise<never> => {
    calls.push({ name, data })
    // The real `add` resolves to a BullMQ `Job`; the worker discards it, so a
    // resolved sentinel is enough.
    return Promise.resolve(undefined as never)
  })
  return { add }
}

/** A no-op trigger queue for the paths that never drain (the default case). */
function inertTurnQueue(): TurnQueueLike {
  return recordingTurnQueue([])
}

/** Records every `(name, data, opts)` the §4.7 post-turn re-mature producer
 *  receives, so the re-arm assertions read the dedup opt + delay off a plain
 *  array. */
interface DmTriggerCall {
  readonly name: string
  readonly data: { campaignId: string }
  readonly opts: unknown
}

function recordingDmTriggerQueue(calls: DmTriggerCall[]): DmTriggerQueueLike {
  const add = vi.fn(
    (name: string, data: { campaignId: string }, opts: unknown): Promise<never> => {
      calls.push({ name, data, opts })
      return Promise.resolve(undefined as never)
    },
  )
  return { add }
}

/** A no-op dm-trigger queue for the paths that never re-arm (the default case). */
function inertDmTriggerQueue(): DmTriggerQueueLike {
  return recordingDmTriggerQueue([])
}

/** Records every `(name, data)` the §2 st-evaluation producer receives, so the
 *  success-path enqueue assertions read the payload off a plain array. */
interface StEvalCall {
  readonly name: string
  readonly data: StEvalPayload
}

function recordingStEvalQueue(calls: StEvalCall[]): StEvalQueueLike {
  const add = vi.fn((name: string, data: StEvalPayload): Promise<never> => {
    calls.push({ name, data })
    return Promise.resolve(undefined as never)
  })
  return { add }
}

/** A no-op st-eval queue for the paths that never enqueue (the default case). */
function inertStEvalQueue(): StEvalQueueLike {
  return recordingStEvalQueue([])
}

/** Records every `(name, data)` the §2.4 Scribe producer receives, so the
 *  flushed-success enqueue assertions read the payload off a plain array. */
interface ScribeCall {
  readonly name: string
  readonly data: ScribeJobPayload
}

function recordingScribeQueue(calls: ScribeCall[]): ScribeQueueLike {
  const add = vi.fn((name: string, data: ScribeJobPayload): Promise<never> => {
    calls.push({ name, data })
    return Promise.resolve(undefined as never)
  })
  return { add }
}

/** A no-op scribe queue for the paths that never enqueue (the default case). */
function inertScribeQueue(): ScribeQueueLike {
  return recordingScribeQueue([])
}

/** MYT-74a T12 — a no-op budget auto-end for the paths that never reach the
 *  budget threshold (the default case). The budget-end tests inject a `vi.fn()`
 *  spy in its place to assert the call. */
function inertEndSession(): TurnProcessorDeps['endSession'] {
  return (): Promise<void> => Promise.resolve()
}

/** MYT-74b §1.3 — a no-op farewell finalize for the paths that never run the
 *  unconditional finalize (every non-farewell turn). The farewell tests inject a
 *  `vi.fn()` spy in its place to assert the (single) finalize call. Each call
 *  returns a fresh `vi.fn()` so a test can pass one literal AND keep a handle. */
function inertFinalize(): TurnProcessorDeps['finalizeEndedSession'] {
  return vi.fn((): Promise<void> => Promise.resolve())
}

/** MYT-75 T7 — an inert `LedgerOps` for the paths that never apply combat (the
 *  StubFastThinker records no combat events, so `applyCombat` early-returns and
 *  the ledger is never dereferenced). Every method throws so an accidental call
 *  is LOUD. The combat-application tests build a real in-memory ledger instead. */
function inertCombatLedger(): LedgerOps {
  const unsupported = (m: string): never => {
    throw new Error(`inert LedgerOps: ${m} called on a non-combat path`)
  }
  return {
    findLedgerCharacterByName: () => unsupported('findLedgerCharacterByName'),
    readPartyLedgerSnapshot: () => unsupported('readPartyLedgerSnapshot'),
    writeHp: () => unsupported('writeHp'),
    findLedgerEvent: () => unsupported('findLedgerEvent'),
    writeLedgerEvent: () => unsupported('writeLedgerEvent'),
    debitGold: () => unsupported('debitGold'),
    creditGold: () => unsupported('creditGold'),
    debitItem: () => unsupported('debitItem'),
    acquireItem: () => unsupported('acquireItem'),
    debitFeatureUse: () => unsupported('debitFeatureUse'),
    debitSpellSlot: () => unsupported('debitSpellSlot'),
    readSpellSlots: () => unsupported('readSpellSlots'),
    readCharacterSpells: () => unsupported('readCharacterSpells'),
    applyCondition: () => unsupported('applyCondition'),
    clearCondition: () => unsupported('clearCondition'),
    shortRest: () => unsupported('shortRest'),
    longRest: () => unsupported('longRest'),
    readRestParticipants: () => unsupported('readRestParticipants'),
  }
}

/** MYT-75 T7 — an inert ledger tx runner: passes the inert ledger straight to the
 *  callback (no real transaction). Never invoked on a non-combat path (applyCombat
 *  early-returns), so the inert ledger inside is never touched. */
function inertLedgerTx(): TurnProcessorDeps['ledgerTx'] {
  return (fn) => fn(inertCombatLedger())
}

// ── MYT-75 T7 — combat-application test fixtures ──────────────────────────────

/** A rolled enemy roster the initiate event carries onto the CombatState blob. */
const GOBLIN_ENEMIES: readonly CombatEnemy[] = [
  { name: 'Goblin', description: 'a scrawny cave goblin', count: 1 },
]

/** A deterministic CombatOutcome for a tier — the same envelopes the real
 *  resolver assigns. `tierProse` is the fallback narration the force-resolve path
 *  uses when there is no FT close-out. */
function combatOutcome(tier: 'pyrrhic' | 'costly'): CombatOutcome {
  const envelope =
    tier === 'pyrrhic'
      ? { partyWins: true, minDownedPcs: 1, minAggregateHpLossFraction: 0.3, allowPcDeathNarration: false }
      : { partyWins: true, minDownedPcs: 0, minAggregateHpLossFraction: 0.3, allowPcDeathNarration: false }
  return {
    tier,
    dc: 15,
    roll: 11,
    total: 13,
    tierProse: `The party prevails, ${tier === 'pyrrhic' ? 'but at brutal cost' : 'though bloodied'}.`,
    envelope,
  }
}

interface CombatLedgerRow {
  hp: number
  readonly maxHp: number
  readonly name: string
}

/** Build a full Character so the ledger projection is real (no `as`). */
function combatCharacter(id: string, name: string, hp: number, maxHp: number): Character {
  return {
    id,
    userId: 'u',
    entityId: null,
    name,
    level: 3,
    class: 'Fighter',
    species: 'Human',
    background: 'Soldier',
    str: 10,
    dex: 10,
    con: 10,
    int: 10,
    wis: 10,
    cha: 10,
    hitPoints: hp,
    maxHitPoints: maxHp,
    armorClass: 10,
    proficiencyBonus: 2,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }
}

/** A real in-memory LedgerOps covering the methods `applyToLedger` →
 *  `resolveAdjustHp` touches (resolve, journal idempotency check + write, HP
 *  write). Every unused method throws so an accidental call is loud. Mirrors
 *  apply.test.ts's makeFakeLedger — the apply path runs for real here. */
function makeCombatLedger(rows: Map<string, CombatLedgerRow>): LedgerOps {
  const unsupported = (m: string): never => {
    throw new Error(`combat LedgerOps: ${m} not implemented`)
  }
  const findId = (name: string): string | undefined => {
    for (const [id, r] of rows) {
      if (r.name.trim().toLowerCase() === name.trim().toLowerCase()) return id
    }
    return undefined
  }
  return {
    findLedgerCharacterByName: (_sessionId, name) => {
      const id = findId(name)
      const row = id === undefined ? undefined : rows.get(id)
      if (id === undefined || row === undefined) return Promise.resolve({ outcome: 'not_found' })
      return Promise.resolve({
        outcome: 'found',
        projection: {
          character: combatCharacter(id, row.name, row.hp, row.maxHp),
          gold: 0,
          hitDie: 8,
          hitDiceRemaining: 2,
          spellcastingProgression: 'none',
          conMod: 0,
        },
      })
    },
    writeHp: (characterId, newHp) => {
      const row = rows.get(characterId)
      if (row === undefined) throw new Error('combat writeHp: no row')
      row.hp = Math.max(0, Math.min(newHp, row.maxHp))
      return Promise.resolve({ hp: row.hp, maxHp: row.maxHp })
    },
    findLedgerEvent: () => Promise.resolve(false),
    writeLedgerEvent: () => Promise.resolve('evt'),
    // resolveAdjustHp's pre-write readHp reads the live HP off this snapshot, so
    // it must reflect the current rows (the writeHp mutates them in place).
    readPartyLedgerSnapshot: () =>
      Promise.resolve(
        [...rows.entries()].map(([id, r]) => ({
          characterId: id,
          name: r.name,
          hitPoints: r.hp,
          maxHitPoints: r.maxHp,
          hitDie: 8,
          hitDiceRemaining: 2,
          level: 3,
          gold: 0,
          slots: [],
          conditions: [],
          trackedFeatures: [],
          spells: [],
          equipment: [],
        })),
      ),
    debitGold: () => unsupported('debitGold'),
    creditGold: () => unsupported('creditGold'),
    debitItem: () => unsupported('debitItem'),
    acquireItem: () => unsupported('acquireItem'),
    debitFeatureUse: () => unsupported('debitFeatureUse'),
    debitSpellSlot: () => unsupported('debitSpellSlot'),
    readSpellSlots: () => unsupported('readSpellSlots'),
    readCharacterSpells: () => unsupported('readCharacterSpells'),
    applyCondition: () => unsupported('applyCondition'),
    clearCondition: () => unsupported('clearCondition'),
    shortRest: () => unsupported('shortRest'),
    longRest: () => unsupported('longRest'),
    readRestParticipants: () => unsupported('readRestParticipants'),
  }
}

/** Build a full processor deps for a combat-application test: the real ledger +
 *  a tx runner that passes it straight through (the ledger's writeHp mutates the
 *  shared rows map, so the apply path is observable). The per-test `sessionState`
 *  / `triggerState` (reassigned in `beforeEach`) are threaded in. */
function combatDeps(opts: {
  calls: PublisherCalls
  handle: SessionLockHandle
  ledger: LedgerOps
  makeTiers: TurnProcessorDeps['makeTiers']
  sessionState: SessionState
  triggerState: TriggerState
  /** The party-ledger snapshot the fresh-run arm reads + threads into
   *  `applyCombat` (the force-resolve path reconciles against it). Defaults to []
   *  for the no-combat test (the apply path early-returns). */
  partyLedger?: PartyLedgerSnapshot
}): TurnProcessorDeps {
  return {
    lock: fakeLock(opts.handle),
    sessionState: opts.sessionState,
    repo: fakeRepo(opts.partyLedger ? { partyLedger: opts.partyLedger } : {}),
    triggerState: opts.triggerState,
    sessionTurnQueue: inertTurnQueue(),
    dmTriggerQueue: inertDmTriggerQueue(),
    stEvalQueue: inertStEvalQueue(),
    scribeQueue: inertScribeQueue(),
    endSession: inertEndSession(),
    finalizeEndedSession: inertFinalize(),
    combatLedger: opts.ledger,
    ledgerTx: (fn) => fn(opts.ledger),
    publisher: recordingPublisher(opts.calls),
    makeTiers: opts.makeTiers,
    heartbeatMs: 10_000,
    logger: silentLogger,
  }
}

describe('processTurnJob', () => {
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

  it('happy path: acquires the lock, runs the turn, flushes state, releases', async () => {
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval')
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

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    // dm_thinking precedes the streamed delta(s) which precede turn_end.
    expect(calls.order[0]).toBe('dm_thinking')
    expect(calls.order).toContain('text_delta')
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    expect(calls.order).not.toContain('turn_error')

    // The mutated turn state was flushed (turn_end above is the cross-process
    // completion signal). ft_history retired — PG-direct (MYT-68 §3.7); only
    // summary/usage round-trip through Redis, and the stub tiers leave them at
    // their zero values.
    const turnState = await sessionState.loadTurnState(CAMPAIGN)
    expect(turnState.summary).toBe('')
    expect(turnState.usage).toEqual({ input: 0, output: 0 })

    expect(release).toHaveBeenCalledTimes(1)
    // The heartbeat timer is cleared in `finally` — no leaked interval.
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
  })

  it('contention: tryAcquire returns null → {ran:false}, no publish, no flush', async () => {
    const calls = newCalls()
    const deps: TurnProcessorDeps = {
      lock: fakeLock(null),
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

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: false })
    expect(calls.order).toEqual([])

    const turnState = await sessionState.loadTurnState(CAMPAIGN)
    // ft_history retired — PG-direct (MYT-68 §3.7); the no-flush invariant now
    // reads on summary/usage staying at the pre-turn (zero) snapshot.
    expect(turnState.summary).toBe('')
    expect(turnState.usage).toEqual({ input: 0, output: 0 })
  })

  it('lock-lost at the FIRST checkpoint (right after loadFromRedis) aborts before processDmTurn', async () => {
    // The L118 checkpoint: lock loss detected immediately after loadFromRedis.
    // Make loadFromRedis slow so the tiny-interval heartbeat (extend→false)
    // flips lockLost DURING the load — the turn then throws LockLostError at
    // L118, before processDmTurn ever runs.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: false, release })

    const loadSpy = vi
      .spyOn(SessionController.prototype, 'loadFromRedis')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve()
            }, 40)
          }),
      )
    const processSpy = vi.spyOn(SessionController.prototype, 'processDmTurn')

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

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(loadSpy).toHaveBeenCalled()
    // Aborted at L118 — processDmTurn was never reached.
    expect(processSpy).not.toHaveBeenCalled()
    expect(calls.order).not.toContain('turn_error')
    expect(release).toHaveBeenCalledTimes(1)

    // Restore the prototype spies HERE (not via a describe-wide restoreAllMocks,
    // which would also tear down the module-level `bullmq` Worker mock the
    // buildSessionTurnWorker suite depends on).
    loadSpy.mockRestore()
    processSpy.mockRestore()
  })

  it('heartbeat extend() REJECTS → treated as lock-lost: warns, aborts without flushing, releases', async () => {
    // The heartbeat's `.catch` arm (a rejected `extend()`, distinct from a
    // resolved `false`): we can no longer prove we hold the lock, so the flag
    // flips lost and the turn aborts at its next checkpoint — same observable
    // outcome as extend()→false, but reached through the catch path.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle: SessionLockHandle = {
      token: 'tok',
      extend: vi.fn((): Promise<boolean> => Promise.reject(new Error('redis down'))),
      release,
    }

    // A slow render step so the tiny-interval heartbeat fires (flipping
    // lockLost via the rejecting extend) BEFORE the turn body reaches its next
    // lockLost checkpoint.
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

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(calls.order).not.toContain('turn_error')
    // The catch arm logs the heartbeat failure (L106) AND the lock-lost abort.
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, turnId: TURN }),
      'turn lock heartbeat failed',
    )
    const turnState = await sessionState.loadTurnState(CAMPAIGN)
    // ft_history retired — PG-direct (MYT-68 §3.7); the no-flush invariant now
    // reads on summary/usage staying at the pre-turn (zero) snapshot.
    expect(turnState.summary).toBe('')
    expect(turnState.usage).toEqual({ input: 0, output: 0 })
    expect(release).toHaveBeenCalledTimes(1)

    processSpy.mockRestore()
  })

  it('a real (non-lock-lost) error RETHROWS so BullMQ owns the retry; lock still released', async () => {
    // The catch arm's `throw err` (L135) + its `instanceof LockLostError ||
    // isLockLost()` false branch: a tier throws a plain Error while the lock is
    // healthy (extend→true). processTurnJob must propagate it (not swallow it),
    // and finally still clears the heartbeat + releases the lock.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    const boom = new Error('fast thinker exploded')
    const ft = new StubFastThinker()
    vi.spyOn(ft, 'render').mockRejectedValue(boom)

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
      makeTiers: () => ({ ft, combatEvents: [] }),
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    await expect(processTurnJob(deps, payload())).rejects.toThrow('fast thinker exploded')

    // Not a lock-lost abort: never published turn_error, never flushed.
    expect(calls.order).not.toContain('turn_error')
    const turnState = await sessionState.loadTurnState(CAMPAIGN)
    // ft_history retired — PG-direct (MYT-68 §3.7); the no-flush invariant now
    // reads on summary/usage staying at the pre-turn (zero) snapshot.
    expect(turnState.summary).toBe('')
    expect(turnState.usage).toEqual({ input: 0, output: 0 })
    // finally still released the lock on the error path.
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('lock-lost: heartbeat extend()→false aborts the turn without flushing; release still called', async () => {
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: false, release })

    // A slow render step so the tiny-interval heartbeat fires (flipping lockLost)
    // BEFORE the turn body reaches its next lockLost checkpoint.
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

    const result = await processTurnJob(deps, payload())

    // It ran but aborted on lock loss: never flushed, never published turn_error.
    expect(result).toEqual({ ran: true })
    expect(processSpy).toHaveBeenCalled()
    expect(calls.order).not.toContain('turn_error')

    const turnState = await sessionState.loadTurnState(CAMPAIGN)
    // ft_history retired — PG-direct (MYT-68 §3.7); the no-flush invariant now
    // reads on summary/usage staying at the pre-turn (zero) snapshot.
    expect(turnState.summary).toBe('')
    expect(turnState.usage).toEqual({ input: 0, output: 0 })

    // The lock-lost branch warns and still releases in finally.
    expect(silentLogger.warn).toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)

    processSpy.mockRestore()
  })

  it('sets dm_responding during the turn body and clears it after release (§4.7)', async () => {
    // The drain guard: the worker flags `dm_responding` while a turn runs so the
    // dm-trigger worker won't enqueue a colliding turn, then clears it on
    // release. Observe "set during the body" by reading the flag inside the
    // publisher's dmThinking (which runs AFTER setResponding, inside the body),
    // and "cleared after" by reading it once processTurnJob resolves.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    let respondingDuringBody: boolean | null = null
    // Override dmThinking (which runs in the body, AFTER setResponding) to snapshot
    // the flag — typed via spread so no `any` cast is needed.
    const publisher: TurnPublisher = {
      ...recordingPublisher(calls),
      dmThinking: vi.fn(async (): Promise<void> => {
        respondingDuringBody = await triggerState.isResponding(CAMPAIGN)
        calls.order.push('dm_thinking')
      }),
    }

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
      publisher,
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    // dm_responding was live while the turn body ran…
    expect(respondingDuringBody).toBe(true)
    // …and is cleared once the turn (and its finally) completes.
    expect(await triggerState.isResponding(CAMPAIGN)).toBe(false)
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
  it('fresh run takes the one-shot direction (GETDEL) and READS the standing directive (§6)', async () => {
    // The fresh-run arm resolves both direction slots AFTER the converge/latch
    // exits and passes them into the controller deps. Seed both on the trigger
    // state; capture what the controller received.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    await triggerState.setOneShotDirection(CAMPAIGN, 'D')
    await triggerState.setStandingDirection(CAMPAIGN, 'S')

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

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    // The controller was constructed with both slots threaded in. `this.deps` is
    // captured off the controller instance the spy's `this` is bound to.
    const ctorDeps = (captureSpy.mock.instances[0] as unknown as {
      deps: { pendingDirection?: string; standingDirective?: string }
    }).deps
    expect(ctorDeps.pendingDirection).toBe('D')
    expect(ctorDeps.standingDirective).toBe('S')

    // The one-shot was CONSUMED (GETDEL): a second read sees nothing.
    expect(await triggerState.takeOneShotDirection(CAMPAIGN)).toBeNull()
    // The standing directive was READ, not cleared — it survives the turn.
    expect(await triggerState.readStandingDirection(CAMPAIGN)).toBe('S')

    captureSpy.mockRestore()
  })

  it('the converge path does NOT take the one-shot direction (a take on a non-rendering path burns a reveal, §6)', async () => {
    // A take before the converge exit would consume a sanctioned one-shot reveal
    // on a turn that never renders. The converge arm must leave the slot intact.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    await triggerState.setOneShotDirection(CAMPAIGN, 'D')

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
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(calls.order).toEqual(['turn_end'])
    // The one-shot was NOT consumed by the converge path — it survives.
    expect(await triggerState.takeOneShotDirection(CAMPAIGN)).toBe('D')
  })

  it('the latch-terminal path does NOT take the one-shot direction (§6)', async () => {
    // The §5 latch-terminal exits before the fresh-run take, so a streamed-but-
    // uncommitted turn leaves the one-shot intact for the next real render.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    await triggerState.setOneShotDirection(CAMPAIGN, 'D')
    await triggerState.markTurnEmitted(TURN)

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
    // The one-shot survives the terminal.
    expect(await triggerState.takeOneShotDirection(CAMPAIGN)).toBe('D')
  })

  it('a contention loser (no lock) does NOT take the one-shot direction (§6)', async () => {
    const calls = newCalls()

    await triggerState.setOneShotDirection(CAMPAIGN, 'D')

    const deps: TurnProcessorDeps = {
      lock: fakeLock(null),
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

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: false })
    // A contention loser never renders, so it never burns the one-shot — it
    // survives for the lock holder.
    expect(await triggerState.takeOneShotDirection(CAMPAIGN)).toBe('D')
  })

  it('a flushed success bumps the ST floor counter, then enqueues the st-evaluation, after the watermark (§2/§8)', async () => {
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const stEvalCalls: StEvalCall[] = []

    // Record the relative order of the watermark advance, the floor-counter bump,
    // and the enqueue.
    const order: string[] = []
    const recordingTrigger: TriggerState = {
      ...triggerState,
      setRespondedSeq: vi.fn((c: string, seq: number): Promise<void> => {
        order.push('watermark')
        return triggerState.setRespondedSeq(c, seq)
      }),
      incrTurnsSinceSt: vi.fn((c: string): Promise<number> => {
        order.push('incr')
        return triggerState.incrTurnsSinceSt(c)
      }),
    }
    const stEvalQueue: StEvalQueueLike = {
      add: vi.fn((name: string, data: StEvalPayload): Promise<never> => {
        order.push('enqueue')
        stEvalCalls.push({ name, data })
        return Promise.resolve(undefined as never)
      }),
    }

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState: recordingTrigger,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue,
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
    // The §2 enqueue carries the campaign + session ids.
    expect(stEvalCalls).toHaveLength(1)
    expect(stEvalCalls[0]?.name).toBe(ST_EVAL_JOB_NAME)
    expect(stEvalCalls[0]?.data).toEqual({ campaignId: CAMPAIGN, sessionId: SESSION })
    // Order: watermark (setRespondedSeq) → floor bump → enqueue.
    expect(order).toEqual(['watermark', 'incr', 'enqueue'])
  })

  it('the converge path does NOT enqueue an st-evaluation (only a fresh flushed turn has an FT response, §2)', async () => {
    // Converge advances the watermark but does NOT enqueue — there is no fresh FT
    // response to evaluate.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const stEvalCalls: StEvalCall[] = []

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({ turnRowsExist: true }),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: recordingStEvalQueue(stEvalCalls),
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
    expect(stEvalCalls).toHaveLength(0)
  })

  it('a lock-lost abort does NOT enqueue an st-evaluation (no fresh FT response, §2)', async () => {
    // A lock-lost run never flushes, so the gated enqueue never fires.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: false, release })
    const stEvalCalls: StEvalCall[] = []

    const processSpy = installSlowProcessDmTurn()

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: recordingStEvalQueue(stEvalCalls),
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
    expect(calls.order).not.toContain('turn_end')
    expect(stEvalCalls).toHaveLength(0)

    processSpy.mockRestore()
  })

  it('an st-evaluation enqueue failure is isolated: logged, turn still returns {ran:true} (§2)', async () => {
    // The enqueue is in its own try/catch — an enqueue hiccup never masks the
    // turn outcome (the turn already flushed; a rethrow would re-run it).
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const logger = { warn: vi.fn(), error: vi.fn() }

    const boom = new Error('st-eval queue unreachable')
    const stEvalQueue: StEvalQueueLike = {
      add: vi.fn((): Promise<never> => Promise.reject(boom)),
    }

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue,
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

    // The turn itself succeeded; the enqueue failure didn't surface.
    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, turnId: TURN }),
      'failed to enqueue st-evaluation',
    )
  })

  // ── MYT-73 §2.4 — the post-turn Scribe enqueue (flushed-success gating) ────
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
  function correctionPayload(
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
  function farewellPayload(opts?: {
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

  it('a farewell turn renders via the silent-consume seam: RAW farewell text as pendingDirection, triggerKind:farewell (§1.2)', async () => {
    // The farewell is the player-less end-of-session send-off. Its direction is the
    // RAW farewell text (NOT a `[[DM CORRECTION:]]` marker) — the controller/FT
    // fuses it via the single-bracket silent-consume seam. Capture the controller
    // deps to prove BOTH: pendingDirection is the raw text and triggerKind is
    // 'farewell'.
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
      farewellPayload({ farewellText: 'Wind down the scene and give everyone a quiet goodbye.' }),
    )

    expect(result).toEqual({ ran: true })
    // The full render lifecycle ran (player-less is intentional, like a correction).
    expect(calls.order[0]).toBe('dm_thinking')
    expect(calls.order).toContain('text_delta')
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    const ctorDeps = (captureSpy.mock.instances[0] as unknown as {
      deps: { pendingDirection?: string; triggerKind?: string }
    }).deps
    // The RAW farewell text reached pendingDirection — NOT a [[DM CORRECTION:]] marker.
    expect(ctorDeps.pendingDirection).toBe('Wind down the scene and give everyone a quiet goodbye.')
    expect(ctorDeps.pendingDirection).not.toContain('[[DM CORRECTION:')
    // The controller config carried the farewell trigger kind.
    expect(ctorDeps.triggerKind).toBe('farewell')

    captureSpy.mockRestore()
  })

  it('a farewell turn with no farewellText falls back to FAREWELL_DIRECTION as pendingDirection (§1.2)', async () => {
    // Defensive: `farewellText` is optional on the payload; the worker coalesces a
    // missing value to the fixed FAREWELL_DIRECTION rather than `undefined`.
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

    // A farewell payload with NO farewellText (the `?? FAREWELL_DIRECTION` arm).
    const noTextFarewell: { data: TurnJobPayload } = {
      data: {
        campaignId: CAMPAIGN,
        sessionId: SESSION,
        turnId: TURN,
        triggerMessages: [],
        maxConsumedSeq: 0,
        trigger: { kind: 'farewell' },
        worldId: 'w-farewell',
      },
    }

    const result = await processTurnJob(deps, noTextFarewell)

    expect(result).toEqual({ ran: true })
    const ctorDeps = (captureSpy.mock.instances[0] as unknown as {
      deps: { pendingDirection?: string }
    }).deps
    expect(ctorDeps.pendingDirection).toBe(FAREWELL_DIRECTION)

    captureSpy.mockRestore()
  })

  it('a farewell turn does NOT advance the watermark, enqueue Scribe, or run the budget auto-end (isPlayerless gates, §1)', async () => {
    // A farewell is player-less (like a correction): it consumed no player message,
    // so the !isPlayerless gates suppress setRespondedSeq, the Scribe enqueue, and
    // the budget auto-end. Seed a non-zero watermark + at-budget usage so each
    // "skipped" assertion is meaningful.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const scribeCalls: ScribeCall[] = []
    const endSession = vi.fn((): Promise<void> => Promise.resolve())

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
      // At-budget usage — a real turn would auto-end here; a farewell must not.
      repo: fakeRepo({
        budgetSummary: { inputTokens: SESSION_TOKEN_BUDGET, outputTokens: 5_000 },
      }),
      triggerState: recordingTrigger,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: recordingScribeQueue(scribeCalls),
      endSession,
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, farewellPayload({ maxConsumedSeq: 2 }))

    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    // Watermark advance SKIPPED (player-less): never re-asserted, stays at 2.
    expect(setRespondedSpy).not.toHaveBeenCalled()
    expect(await triggerState.respondedSeq(CAMPAIGN)).toBe(2)
    // Scribe enqueue SKIPPED.
    expect(scribeCalls).toHaveLength(0)
    // Budget auto-end SKIPPED even at-budget.
    expect(endSession).not.toHaveBeenCalled()
  })

  it('a farewell turn that renders cleanly finalizes exactly once with the resolved ids (Eddystone-C1, §1.3)', async () => {
    // The unconditional finalize runs in the `finally` on the clean-render path:
    // exactly one finalize call with {campaignId, sessionId, worldId} (worldId off
    // the farewell payload, no PG re-resolve).
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

    const result = await processTurnJob(deps, farewellPayload({ worldId: 'w-fin' }))

    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledWith({
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      worldId: 'w-fin',
    })
  })

  it('a farewell turn whose FT render THROWS still finalizes exactly once (Eddystone-C1 guard, §1.3)', async () => {
    // The load-bearing invariant: a thrown/timed-out farewell render must NEVER
    // leave a session permanently un-ended. Because the finalize lives in the
    // shared `finally`, a render that throws still finalizes exactly once. The
    // turn itself rethrows (real failure → BullMQ owns the retry policy).
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const finalize = vi.fn((): Promise<void> => Promise.resolve())

    const boom = new Error('farewell render exploded')
    const ft = new StubFastThinker()
    vi.spyOn(ft, 'render').mockRejectedValue(boom)

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
      makeTiers: () => ({ ft, combatEvents: [] }),
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    // The render throw propagates (real failure), but the finally still finalized.
    await expect(processTurnJob(deps, farewellPayload({ worldId: 'w-fin' }))).rejects.toThrow(
      'farewell render exploded',
    )

    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledWith({
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      worldId: 'w-fin',
    })
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('a farewell finalize failure is swallowed and does not mask the turn outcome (§1.3)', async () => {
    // The finalize is in its own try/catch in the finally: a finalize throw never
    // masks the turn outcome (the turn already flushed; a rethrow would re-run an
    // already-flushed farewell via BullMQ attempts). Logged, not rethrown.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const logger = { warn: vi.fn(), error: vi.fn() }
    const finalize = vi.fn((): Promise<void> => Promise.reject(new Error('reconcile unreachable')))

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
      logger,
    }

    const result = await processTurnJob(deps, farewellPayload())

    // The turn itself succeeded; the finalize failure didn't surface.
    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, turnId: TURN }),
      'failed to finalize ended session',
    )
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
  it('applies combat: reconciled ledger deltas, resolved CombatState, mode flip, combat_resolved', async () => {
    // A turn whose makeTiers records an `initiate` + a `resolve` event. The
    // post-flush block must: apply the FT's reconciled PC damage through the
    // ledger (hpChanges flow into the summary), write the resolved CombatState
    // blob, durably flip mode→combat, and emit combat_resolved.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    // Seed the :state blob so the durable mode flip has something to flip.
    await sessionState.setState(CAMPAIGN, {
      participants: ['u1'],
      mode: 'exploration',
      status: 'active',
    })

    // A real in-memory ledger: Mara at 11/14 HP. applyToLedger → resolveAdjustHp
    // writes through it, so the returned hpChanges are real.
    const rows = new Map<string, CombatLedgerRow>([['ch1', { name: 'Mara', hp: 11, maxHp: 14 }]])
    const ledger = makeCombatLedger(rows)

    const reconciled: ReconciledCombat = {
      outcomeKind: 'victory',
      // hpBefore 11, amount 4 → applyToLedger SETS Mara to 11 − 4 = 7 (authoritative).
      pcDamage: [{ characterId: 'ch1', name: 'Mara', amount: 4, hpBefore: 11 }],
      pcCasualties: [],
      enemyCasualties: [{ name: 'Goblin', fate: 'dead' }],
      conditions: [],
    }
    const combatEvents: CombatEvent[] = [
      {
        kind: 'initiate',
        outcome: combatOutcome('costly'),
        enemies: GOBLIN_ENEMIES,
        environment: 'a damp cave mouth',
        surprise: 'none',
        initiative: [{ combatant: 'Mara', roll: 14 }],
      },
      { kind: 'resolve', reconciled, narration: 'Mara stands over the fallen goblin.' },
    ]

    const deps = combatDeps({
      calls,
      handle,
      ledger,
      makeTiers: () => ({ ft: new StubFastThinker(), combatEvents }),
      sessionState,
      triggerState,
    })

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })

    // The resolved CombatState blob was written with the summary.
    const combat = await sessionState.getCombatState(CAMPAIGN)
    expect(combat?.status).toBe('resolved')
    expect(combat?.enemies).toEqual(GOBLIN_ENEMIES)
    expect(combat?.environment).toBe('a damp cave mouth')
    expect(combat?.result?.summary.outcome).toBe('victory')
    // hpChanges flowed from the real ledger write into the summary (11 → 7).
    expect(combat?.result?.summary.hpChanges).toContainEqual({
      combatant: 'Mara',
      hpBefore: 11,
      hpAfter: 7,
      maxHp: 14,
    })
    // The ledger actually moved (the apply path ran, not just the summary).
    expect(rows.get('ch1')?.hp).toBe(7)

    // The durable mode flip landed on the :state blob.
    const state = await sessionState.getState(CAMPAIGN)
    expect(state?.mode).toBe('combat')

    // combat_resolved was emitted (the latched emitter routes it to the publisher).
    expect(calls.order).toContain('combat_resolved')
  })

  it('force-resolves a cap-hit: initiate WITHOUT resolve fills the envelope floors and applies', async () => {
    // The recovery path: the FT initiated combat but its tool loop hit the cap
    // before resolving. With no `resolve` event, the worker reconciles EMPTY FT
    // deltas against the envelope — pyrrhic's floors (minDownedPcs:1 +
    // minAggregateHpLossFraction:0.30) still down a PC and apply HP loss.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    await sessionState.setState(CAMPAIGN, {
      participants: ['u1'],
      mode: 'exploration',
      status: 'active',
    })

    // One PC at full HP; pyrrhic forces it down (minDownedPcs:1).
    const rows = new Map<string, CombatLedgerRow>([['ch1', { name: 'Mara', hp: 14, maxHp: 14 }]])
    const ledger = makeCombatLedger(rows)
    // The force-resolve path reconciles EMPTY FT deltas against the per-turn party
    // snapshot — so the worker must read a roster matching the ledger to know whom
    // to down (the snapshot is the fresh-run arm's `readPartyLedgerSnapshot`).
    const partyLedger: PartyLedgerSnapshot = [
      {
        characterId: 'ch1',
        name: 'Mara',
        hitPoints: 14,
        maxHitPoints: 14,
        hitDie: 8,
        hitDiceRemaining: 2,
        level: 3,
        gold: 0,
        slots: [],
        conditions: [],
        trackedFeatures: [],
        spells: [],
        equipment: [],
      },
    ]

    const combatEvents: CombatEvent[] = [
      {
        kind: 'initiate',
        outcome: combatOutcome('pyrrhic'),
        enemies: GOBLIN_ENEMIES,
        environment: 'a damp cave mouth',
        surprise: 'none',
        initiative: [{ combatant: 'Mara', roll: 9 }],
      },
      // No resolve event — the cap-hit case.
    ]

    const deps = combatDeps({
      calls,
      handle,
      ledger,
      partyLedger,
      makeTiers: () => ({ ft: new StubFastThinker(), combatEvents }),
      sessionState,
      triggerState,
    })

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })

    const combat = await sessionState.getCombatState(CAMPAIGN)
    expect(combat?.status).toBe('resolved')
    // The narration fell back to the deterministic tier prose (no FT close-out).
    expect(combat?.result?.summary.outcomeDescription).toBe(combatOutcome('pyrrhic').tierProse)
    // The envelope's minDownedPcs:1 floor downed Mara → 0 HP in the ledger.
    expect(rows.get('ch1')?.hp).toBe(0)
    // The summary lists the downed PC as a casualty.
    expect(combat?.result?.summary.casualties).toContainEqual({
      name: 'Mara',
      type: 'pc',
      fate: 'unconscious',
    })

    const state = await sessionState.getState(CAMPAIGN)
    expect(state?.mode).toBe('combat')
    expect(calls.order).toContain('combat_resolved')
  })

  it('no combat events → none of the combat writes happen', async () => {
    // The exploration-only turn: makeTiers records no combat events, so the
    // post-flush block early-returns — no CombatState blob, no mode flip, no
    // combat_resolved emit.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    await sessionState.setState(CAMPAIGN, {
      participants: ['u1'],
      mode: 'exploration',
      status: 'active',
    })

    const deps = combatDeps({
      calls,
      handle,
      // The inert ledger throws on any call — proving the apply path never ran.
      ledger: inertCombatLedger(),
      makeTiers: () => ({ ft: new StubFastThinker(), combatEvents: [] }),
      sessionState,
      triggerState,
    })

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    // No combat blob was written.
    expect(await sessionState.getCombatState(CAMPAIGN)).toBeNull()
    // The :state blob stayed in exploration (no durable flip).
    const state = await sessionState.getState(CAMPAIGN)
    expect(state?.mode).toBe('exploration')
    // No combat_resolved frame.
    expect(calls.order).not.toContain('combat_resolved')
  })

  it('a combat-apply failure is logged but does NOT crash the turn (own try/catch)', async () => {
    // The turn already persisted before applyCombat runs, so a throw there must
    // NOT re-run the turn via BullMQ attempts. Force a throw by making the blob
    // write reject; the catch arm logs and the turn still completes (turn_end).
    const calls = newCalls()
    const errorLogger = { warn: vi.fn(), error: vi.fn() }
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    await sessionState.setState(CAMPAIGN, {
      participants: ['u1'],
      mode: 'exploration',
      status: 'active',
    })

    const rows = new Map<string, CombatLedgerRow>([['ch1', { name: 'Mara', hp: 11, maxHp: 14 }]])
    const ledger = makeCombatLedger(rows)
    const combatEvents: CombatEvent[] = [
      {
        kind: 'initiate',
        outcome: combatOutcome('costly'),
        enemies: GOBLIN_ENEMIES,
        environment: 'a damp cave mouth',
        surprise: 'none',
        initiative: [{ combatant: 'Mara', roll: 14 }],
      },
      {
        kind: 'resolve',
        reconciled: {
          outcomeKind: 'victory',
          pcDamage: [],
          pcCasualties: [],
          enemyCasualties: [],
          conditions: [],
        },
        narration: 'It is over.',
      },
    ]

    // Make the durable CombatState write reject — applyCombat throws past the
    // ledger apply, into the worker's combat try/catch.
    const setCombatSpy = vi
      .spyOn(sessionState, 'setCombatState')
      .mockRejectedValue(new Error('redis write failed'))

    const deps: TurnProcessorDeps = {
      ...combatDeps({
        calls,
        handle,
        ledger,
        makeTiers: () => ({ ft: new StubFastThinker(), combatEvents }),
        sessionState,
        triggerState,
      }),
      logger: errorLogger,
    }

    const result = await processTurnJob(deps, payload())

    // The turn still completed (not rethrown) and reached turn_end.
    expect(result).toEqual({ ran: true })
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    // The failure was logged at error.
    expect(errorLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, turnId: TURN }),
      'failed to apply post-turn combat',
    )

    setCombatSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// makeLatchedEmitter — the §5 set-before-publish ordering, unit-tested directly.
// ---------------------------------------------------------------------------

describe('makeLatchedEmitter', () => {
  it('marks the latch BEFORE the first inner emit, and only once', async () => {
    const order: string[] = []
    const inner: TurnEmitter = {
      emitText: (): Promise<void> => {
        order.push('inner.emitText')
        return Promise.resolve()
      },
      emitSkillCheck: (): Promise<void> => {
        order.push('inner.emitSkillCheck')
        return Promise.resolve()
      },
      emitDiceRoll: (): Promise<void> => {
        order.push('inner.emitDiceRoll')
        return Promise.resolve()
      },
      emitLedgerUpdate: (): Promise<void> => {
        order.push('inner.emitLedgerUpdate')
        return Promise.resolve()
      },
      emitModeChange: (): Promise<void> => Promise.resolve(),
      emitCombatStarted: (): Promise<void> => Promise.resolve(),
      emitCombatResolved: (): Promise<void> => Promise.resolve(),
    }
    const mark = vi.fn((): Promise<void> => {
      order.push('mark')
      return Promise.resolve()
    })

    const latched = makeLatchedEmitter(inner, mark)
    await latched.emitText('a')
    await latched.emitText('b')
    await latched.emitDiceRoll({ count: 1, sides: 6, results: [3], total: 3 })

    // The FIRST emit marks BEFORE publishing; subsequent emits don't re-mark.
    expect(order).toEqual(['mark', 'inner.emitText', 'inner.emitText', 'inner.emitDiceRoll'])
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('marks before the first inner emit when the first frame is a ledger_update', async () => {
    const order: string[] = []
    const inner: TurnEmitter = {
      emitText: (): Promise<void> => Promise.resolve(),
      emitSkillCheck: (): Promise<void> => Promise.resolve(),
      emitDiceRoll: (): Promise<void> => Promise.resolve(),
      emitLedgerUpdate: (): Promise<void> => {
        order.push('inner.emitLedgerUpdate')
        return Promise.resolve()
      },
      emitModeChange: (): Promise<void> => Promise.resolve(),
      emitCombatStarted: (): Promise<void> => Promise.resolve(),
      emitCombatResolved: (): Promise<void> => Promise.resolve(),
    }
    const mark = vi.fn((): Promise<void> => {
      order.push('mark')
      return Promise.resolve()
    })

    const latched = makeLatchedEmitter(inner, mark)
    await latched.emitLedgerUpdate({
      characterName: 'Mara',
      kind: 'gold',
      summary: 'Mara spends 5gp.',
      gold: 42,
    })

    expect(order).toEqual(['mark', 'inner.emitLedgerUpdate'])
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('marks before the first inner emit when the first frame is a skill_check', async () => {
    const order: string[] = []
    const inner: TurnEmitter = {
      emitText: (): Promise<void> => Promise.resolve(),
      emitSkillCheck: (): Promise<void> => {
        order.push('inner.emitSkillCheck')
        return Promise.resolve()
      },
      emitDiceRoll: (): Promise<void> => Promise.resolve(),
      emitLedgerUpdate: (): Promise<void> => Promise.resolve(),
      emitModeChange: (): Promise<void> => Promise.resolve(),
      emitCombatStarted: (): Promise<void> => Promise.resolve(),
      emitCombatResolved: (): Promise<void> => Promise.resolve(),
    }
    const mark = vi.fn((): Promise<void> => {
      order.push('mark')
      return Promise.resolve()
    })

    const latched = makeLatchedEmitter(inner, mark)
    await latched.emitSkillCheck({
      characterName: 'Mara',
      skill: 'Stealth',
      context: 'sneaking',
      roll: 12,
      roll2: null,
      rollType: 'normal',
      modifier: 3,
      total: 15,
      dc: 12,
      outcomeTier: 'success',
      constraint: 'She slips past.',
    })

    expect(order).toEqual(['mark', 'inner.emitSkillCheck'])
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('marks before — and passes through — the combat/mode frame kinds (MYT-75)', async () => {
    // The §combat frame arrows: emitModeChange / emitCombatStarted /
    // emitCombatResolved each await the latch BEFORE the inner publish, then pass
    // their payloads straight through.
    const order: string[] = []
    const seen: { mode?: unknown; started?: unknown; resolved?: unknown } = {}
    const inner: TurnEmitter = {
      emitText: (): Promise<void> => Promise.resolve(),
      emitSkillCheck: (): Promise<void> => Promise.resolve(),
      emitDiceRoll: (): Promise<void> => Promise.resolve(),
      emitLedgerUpdate: (): Promise<void> => Promise.resolve(),
      emitModeChange: (p): Promise<void> => {
        order.push('inner.emitModeChange')
        seen.mode = p
        return Promise.resolve()
      },
      emitCombatStarted: (p): Promise<void> => {
        order.push('inner.emitCombatStarted')
        seen.started = p
        return Promise.resolve()
      },
      emitCombatResolved: (p): Promise<void> => {
        order.push('inner.emitCombatResolved')
        seen.resolved = p
        return Promise.resolve()
      },
    }
    const mark = vi.fn((): Promise<void> => {
      order.push('mark')
      return Promise.resolve()
    })

    const latched = makeLatchedEmitter(inner, mark)
    await latched.emitModeChange({ from: 'exploration', to: 'combat', reason: 'enemies attack' })
    await latched.emitCombatStarted({
      enemies: [{ name: 'Goblin', description: 'a scrawny goblin', count: 1 }],
      initiative: [{ combatant: 'Mara', roll: 14 }],
    })
    await latched.emitCombatResolved({
      narration: 'It is over.',
      outcome: 'victory',
      casualties: [],
      hpChanges: [],
    })

    // The FIRST emit marks; the rest don't re-mark; all three passed through in order.
    expect(order).toEqual([
      'mark',
      'inner.emitModeChange',
      'inner.emitCombatStarted',
      'inner.emitCombatResolved',
    ])
    expect(mark).toHaveBeenCalledTimes(1)
    expect(seen.mode).toEqual({ from: 'exploration', to: 'combat', reason: 'enemies attack' })
    expect((seen.resolved as { outcome: string }).outcome).toBe('victory')
  })
})

// ---------------------------------------------------------------------------
// reloadFtContext — the §3.10 PG fallback for ftContext, unit-tested directly.
// ---------------------------------------------------------------------------

describe('reloadFtContext', () => {
  it('reads the session row → prep ftContext when the prep exists', async () => {
    const repo = fakeRepo({ session: { sessionNumber: 2 }, ftContext: 'PREP DOC FROM PG' })
    const result = await reloadFtContext(repo, CAMPAIGN, SESSION, silentLogger)
    expect(result).toBe('PREP DOC FROM PG')
  })

  it('returns "" + warns when the prep row is absent', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    const repo = fakeRepo({ session: { sessionNumber: 2 }, ftContext: null })
    const result = await reloadFtContext(repo, CAMPAIGN, SESSION, logger)
    expect(result).toBe('')
    expect(logger.warn).toHaveBeenCalled()
  })

  it('returns "" + warns when the session row is absent', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    const repo = fakeRepo({ session: null })
    const result = await reloadFtContext(repo, CAMPAIGN, SESSION, logger)
    expect(result).toBe('')
    expect(logger.warn).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// resolveWorldId — the MYT-72 worldId cache seam, unit-tested directly. The blob
// is the cache; a hit skips the PG read, a miss reads getWorldId + back-fills the
// blob, and a null blob (session not fully initialized) reads without caching.
// ---------------------------------------------------------------------------

describe('resolveWorldId', () => {
  /** A fake SessionState narrowed to getState/setState, backed by a mutable cell
   *  so a back-fill is observable. `getStateSpy`/`setStateSpy` record the calls. */
  function fakeWorldIdState(initial: SessionStateBlob | null) {
    const cell: { blob: SessionStateBlob | null } = { blob: initial }
    const getStateSpy = vi.fn((): Promise<SessionStateBlob | null> => Promise.resolve(cell.blob))
    const setStateSpy = vi.fn((_c: string, s: SessionStateBlob): Promise<void> => {
      cell.blob = s
      return Promise.resolve()
    })
    return {
      sessionState: { getState: getStateSpy, setState: setStateSpy },
      cell,
      getStateSpy,
      setStateSpy,
    }
  }

  function fakeCampaigns(worldId: string | null) {
    return {
      campaigns: { getWorldId: vi.fn((): Promise<string | null> => Promise.resolve(worldId)) },
    }
  }

  it('returns the cached worldId from the blob without reading PG or re-writing the blob', async () => {
    const { sessionState, getStateSpy, setStateSpy } = fakeWorldIdState({
      participants: ['u1'],
      mode: 'exploration',
      status: 'active',
      worldId: 'w-cached',
    })
    const repo = fakeCampaigns('w-pg')

    const result = await resolveWorldId({ sessionState, repo }, CAMPAIGN, SESSION)

    expect(result).toBe('w-cached')
    expect(getStateSpy).toHaveBeenCalledTimes(1)
    // A cache hit never touches PG and never re-writes the blob.
    expect(repo.campaigns.getWorldId).not.toHaveBeenCalled()
    expect(setStateSpy).not.toHaveBeenCalled()
  })

  it('on a cache miss reads getWorldId once and back-fills the blob with the merged worldId', async () => {
    const { sessionState, cell, setStateSpy } = fakeWorldIdState({
      participants: ['u1', 'u2'],
      mode: 'exploration',
      status: 'active',
      ftContext: 'PREP',
    })
    const repo = fakeCampaigns('w-resolved')

    const result = await resolveWorldId({ sessionState, repo }, CAMPAIGN, SESSION)

    expect(result).toBe('w-resolved')
    expect(repo.campaigns.getWorldId).toHaveBeenCalledTimes(1)
    expect(repo.campaigns.getWorldId).toHaveBeenCalledWith(CAMPAIGN)
    // The blob was re-written ONCE, merging the resolved worldId onto the prior fields.
    expect(setStateSpy).toHaveBeenCalledTimes(1)
    expect(cell.blob).toEqual({
      participants: ['u1', 'u2'],
      mode: 'exploration',
      status: 'active',
      ftContext: 'PREP',
      worldId: 'w-resolved',
    })
  })

  it('on a null state blob reads getWorldId, returns the value, and does NOT cache', async () => {
    // A null blob means the session is not fully initialized (an edge) — resolve
    // the worldId for this turn but skip the back-fill (nothing to merge onto).
    const { sessionState, setStateSpy } = fakeWorldIdState(null)
    const repo = fakeCampaigns('w-edge')

    const result = await resolveWorldId({ sessionState, repo }, CAMPAIGN, SESSION)

    expect(result).toBe('w-edge')
    expect(repo.campaigns.getWorldId).toHaveBeenCalledTimes(1)
    // No blob to merge onto → no setState.
    expect(setStateSpy).not.toHaveBeenCalled()
  })

  it('returns "" (not null) when the campaign has no world_id, so the lookup deps stay typed', async () => {
    const { sessionState } = fakeWorldIdState({
      participants: ['u1'],
      mode: 'exploration',
      status: 'active',
    })
    const repo = fakeCampaigns(null)

    const result = await resolveWorldId({ sessionState, repo }, CAMPAIGN, SESSION)

    // getWorldId → null coalesces to '' (worldId is always a string for the tools).
    expect(result).toBe('')
  })
})

// ---------------------------------------------------------------------------
// FT-side boundary assertion (MYT-69/§9): TurnWorkerRepo.sessionPreps.getBy
// stays {ftContext}-only — it must NOT have been widened to carry sdPlaybook
// when T9 added the dedicated LookupVetRepo surface. A fake whose getBy returns
// ONLY { ftContext } still satisfies TurnWorkerRepo; that it type-checks is the
// proof the secret-bearing read lives on a SEPARATE surface, not this one.
// ---------------------------------------------------------------------------

describe('TurnWorkerRepo FT-side boundary', () => {
  it('a sessionPreps.getBy returning only { ftContext } satisfies TurnWorkerRepo (no sdPlaybook leak)', () => {
    // A compile-time assertion: this object is typed as TurnWorkerRepo. If the
    // FT-side surface had been widened to require sdPlaybook, this would fail to
    // type-check (getBy returns no sdPlaybook). The runtime expectation is a
    // formality — the binding is the real test.
    const ftSideRepo: TurnWorkerRepo = fakeRepo({ ftContext: 'PREP DOC' })
    expect(ftSideRepo.sessionPreps).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// H8 boundary — the terminal-failure gate, unit-tested directly (no broker).
// `publishTerminalTurnError` publishes a turn_error ONLY when retries are
// exhausted. Locks the gate so a future edit can't silently start publishing on
// a non-final attempt (a premature give-up) or stop publishing on the final one.
// ---------------------------------------------------------------------------

function terminalFailureJob(attemptsMade: number, attempts: number): TerminalFailureJob {
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
const alwaysClaim = (): Promise<boolean> => Promise.resolve(true)

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
      turnEnd: vi.fn((): Promise<void> => Promise.resolve()),
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

// ---------------------------------------------------------------------------
// buildSessionTurnWorker — boot-wiring. The `bullmq` mock (top of file) captures
// the processor fn + the 'failed' handler the builder registers, so both the
// `makeTiers` closure (reached by running the captured processor through a real
// turn) and the `worker.on('failed')` arrow (reached by invoking the captured
// handler) are exercised without a broker.
// ---------------------------------------------------------------------------

/** A fake `pg.Pool` for the builder tests: the builder calls `createRepo(pool)`
 *  (no queries at construction). `query` is routed so the §5 converge probe
 *  (`turnRowsExist` → `SELECT 1 … LIMIT 1`) reports a durable turn — the
 *  processor then converges (turn_end + watermark) WITHOUT constructing/​running
 *  the now-REAL SonnetFastThinker, so no real LLM call fires in a unit test. Any
 *  other query resolves empty. Cast to `Pool` (the builder only ever calls
 *  `.query`). */
/** A fake Voyage embedder for the builder tests. The builder threads it into the
 *  (c8-ignored, real-LLM) makeTiers closure ONLY; the converge-path builder tests
 *  never construct the FT, so this is never invoked — a typed stub suffices. */
function fakeEmbedder(): VoyageEmbedder {
  return {
    embedDocuments: () => Promise.resolve([]),
    embedQuery: () => Promise.resolve([]),
  }
}

function convergePool(): Pool {
  const query = (text: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    // turnRowsExist: `SELECT 1 FROM session_messages WHERE turn_id = $1 LIMIT 1`.
    if (text.includes('FROM session_messages') && text.includes('turn_id')) {
      return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 })
    }
    return Promise.resolve({ rows: [], rowCount: 0 })
  }
  return { query } as unknown as Pool
}

/** Like `convergePool`, but the §4.7 re-mature probe (`listAfterSeq` → `SELECT *
 *  … WHERE session_id = $1 AND seq > $2`) returns ONE unanswered player_message
 *  row, so the worker's `finally` re-arms the quiet window through the REAL
 *  builder-wired `dmTriggerQueue.add` arrow. */
function convergePoolWithTrailingPlayer(): Pool {
  const query = (text: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    if (text.includes('FROM session_messages') && text.includes('turn_id')) {
      return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 })
    }
    // listAfterSeq: a single trailing player row above the watermark.
    if (text.includes('FROM session_messages') && text.includes('seq >')) {
      return Promise.resolve({
        rows: [
          {
            id: 'm1',
            session_id: SESSION,
            seq: 1,
            user_id: 'u1',
            message_type: 'player_message',
            content: 'still here?',
            created_at: new Date(),
            turn_id: null,
            turn_ordinal: null,
          },
        ],
        rowCount: 1,
      })
    }
    return Promise.resolve({ rows: [], rowCount: 0 })
  }
  return { query } as unknown as Pool
}

describe('buildSessionTurnWorker', () => {
  let redisBatch: Redis
  let redisRealtime: Redis

  beforeEach(async () => {
    captured.worker = null
    capturedQueueAdds.length = 0
    redisBatch = new IoRedisMock()
    redisRealtime = new IoRedisMock()
    await redisRealtime.flushall()
  })
  afterEach(async () => {
    await redisBatch.quit()
    await redisRealtime.quit()
    vi.clearAllMocks()
  })

  it('runs a turn through the captured processor (converge path) and advances the watermark', async () => {
    // The builder now wires the REAL SonnetFastThinker via makeTiers, so a
    // FRESH-RUN turn would hit the real LLM — not a unit test. We instead drive
    // the §5 converge path: a fake pool reports the turnId already durable in PG,
    // so the processor converges (turn_end + watermark) WITHOUT constructing or
    // running the FT. This still exercises the builder's deps wiring (lock,
    // triggerState, repo, publisher) and the makeTiers closure is not reached —
    // the real-FT render is covered by the E2E smoke, not here.
    const logger = { warn: vi.fn(), error: vi.fn() }
    const worker = buildSessionTurnWorker(redisBatch, redisRealtime, 'bw:', logger, convergePool(), fakeEmbedder())
    expect(worker).not.toBeNull()

    const cap = captured.worker
    if (cap === null) throw new Error('Worker constructor was not captured')

    const job = payload()
    ;(job.data as { maxConsumedSeq: number }).maxConsumedSeq = 3

    const result = await cap.processor(job)
    expect(result).toEqual({ ran: true })

    // The §4.7 watermark advanced to maxConsumedSeq (proving triggerState was
    // wired into the deps and the converge arm advanced it).
    expect(await makeTriggerState(redisRealtime, 'bw:').respondedSeq(CAMPAIGN)).toBe(3)
  })

  it('wires triggerState + sessionTurnQueue: an in-flight explicit summon drains on release (§4.7)', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    buildSessionTurnWorker(redisBatch, redisRealtime, 'bw:', logger, convergePool(), fakeEmbedder())

    const cap = captured.worker
    if (cap === null) throw new Error('Worker constructor was not captured')

    // Seed the explicit-pending flag on the SAME keyspace the builder's
    // triggerState reads (redisRealtime), as the server would on an in-flight @dm.
    await makeTriggerState(redisRealtime, 'bw:').setExplicitPending(CAMPAIGN)

    const result = await cap.processor(payload())
    expect(result).toEqual({ ran: true })

    // The drain enqueued exactly one explicit follow-up on the builder's Queue.
    expect(capturedQueueAdds).toHaveLength(1)
    expect(capturedQueueAdds[0]?.data.trigger.kind).toBe('explicit')
    expect(capturedQueueAdds[0]?.data.campaignId).toBe(CAMPAIGN)
    expect(capturedQueueAdds[0]?.data.triggerMessages).toEqual([])
  })

  it('wires dmTriggerQueue: a trailing player row re-arms the quiet window on release (§4.7)', async () => {
    // The builder-constructed dm-trigger producer: a converged turn with an
    // unanswered player row above the watermark re-arms the debounce through the
    // REAL `dmTriggerQueue.add` arrow (the mocked Queue records the add).
    const logger = { warn: vi.fn(), error: vi.fn() }
    buildSessionTurnWorker(redisBatch, redisRealtime, 'bw:', logger, convergePoolWithTrailingPlayer(), fakeEmbedder())

    const cap = captured.worker
    if (cap === null) throw new Error('Worker constructor was not captured')

    const result = await cap.processor(payload())
    expect(result).toEqual({ ran: true })

    // The re-mature enqueued the debounce job ('evaluate') on the builder's Queue.
    const rearm = capturedQueueAdds.find((a) => a.name === 'evaluate')
    expect(rearm).toBeDefined()
    expect((rearm?.data as unknown as { campaignId: string }).campaignId).toBe(CAMPAIGN)
  })

  it("registers a 'failed' handler that delegates to publishTerminalTurnError", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    buildSessionTurnWorker(redisBatch, redisRealtime, 'bw:', logger, convergePool(), fakeEmbedder())

    const cap = captured.worker
    if (cap === null) throw new Error('Worker constructor was not captured')
    const failedHandler = cap.handlers.get('failed')
    if (failedHandler === undefined) throw new Error("no 'failed' handler registered")

    // Invoke the captured arrow (L213) on a terminal (retries-exhausted) job.
    // It delegates to publishTerminalTurnError, which publishes a turn_error
    // frame on redisRealtime. Assert via a subscriber on the SAME ioredis-mock
    // instance the publisher uses (same-instance pub/sub delivers reliably).
    const sub = redisRealtime.duplicate()
    const messages: string[] = []
    sub.on('pmessage', (_pattern: string, _channel: string, message: string) => {
      messages.push(message)
    })
    await sub.psubscribe(sessionChannelPattern('bw:'))

    failedHandler(terminalFailureJob(3, 3), new Error('terminal turn failure'))

    await vi.waitFor(() => {
      expect(messages.some((m) => m.includes('turn_error'))).toBe(true)
    })
    await sub.quit()
  })

  it("the 'failed' handler is a no-op on a non-terminal job (retries remain)", () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    buildSessionTurnWorker(redisBatch, redisRealtime, 'bw:', logger, convergePool(), fakeEmbedder())

    const cap = captured.worker
    if (cap === null) throw new Error('Worker constructor was not captured')
    const failedHandler = cap.handlers.get('failed')
    if (failedHandler === undefined) throw new Error("no 'failed' handler registered")

    // attemptsMade < attempts → publishTerminalTurnError returns early; the
    // arrow still runs (covering L213) but publishes nothing.
    expect(() => {
      failedHandler(terminalFailureJob(1, 3), new Error('retryable failure'))
    }).not.toThrow()
    expect(logger.error).not.toHaveBeenCalled()
  })
})
