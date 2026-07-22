// Queue recorders, inert processor deps, and combat-application fixtures for the
// split `turn-worker` unit suites. Builds on the core fakes in
// `turn-worker-harness.ts`. See that file's header for the isolation note.
import { vi } from 'vitest'
import { type CombatOutcome, type SessionState } from '../../../redis/session-state.js'
import type { LedgerOps } from '../../../repo/characters-ledger.js'
import type { Character } from '../../../repo/types.js'
import type { CombatEnemy } from '../../combat/outcome.js'
import type { PartyLedgerSnapshot } from '../../tiers/types.js'
import type { SessionLockHandle } from '../../session-lock.js'
import type { TriggerState } from '../../trigger-state.js'
import type { TurnJobPayload, TurnQueueLike } from '../../turn-queue.js'
import type { DmTriggerQueueLike } from '../../dm-trigger-queue.js'
import type { StEvalPayload, StEvalQueueLike } from '../../st-eval-queue.js'
import type { ScribeJobPayload, ScribeQueueLike } from '../../scribe-queue.js'
import type { TurnProcessorDeps } from '../../turn-worker.js'
import {
  fakeLock,
  fakeRepo,
  recordingPublisher,
  silentLogger,
  type PublisherCalls,
} from './turn-worker-harness.js'

/** Records the `(name, data, opts)` of every enqueued explicit-drain follow-up
 *  turn so the §4.7 drain assertions read the payload off a plain array. */
export interface QueueCall {
  readonly name: string
  readonly data: TurnJobPayload
}

export function recordingTurnQueue(calls: QueueCall[]): TurnQueueLike {
  const add = vi.fn((name: string, data: TurnJobPayload): Promise<never> => {
    calls.push({ name, data })
    // The real `add` resolves to a BullMQ `Job`; the worker discards it, so a
    // resolved sentinel is enough.
    return Promise.resolve(undefined as never)
  })
  return { add }
}

/** A no-op trigger queue for the paths that never drain (the default case). */
export function inertTurnQueue(): TurnQueueLike {
  return recordingTurnQueue([])
}

/** Records every `(name, data, opts)` the §4.7 post-turn re-mature producer
 *  receives, so the re-arm assertions read the dedup opt + delay off a plain
 *  array. */
export interface DmTriggerCall {
  readonly name: string
  readonly data: { campaignId: string }
  readonly opts: unknown
}

export function recordingDmTriggerQueue(calls: DmTriggerCall[]): DmTriggerQueueLike {
  const add = vi.fn(
    (name: string, data: { campaignId: string }, opts: unknown): Promise<never> => {
      calls.push({ name, data, opts })
      return Promise.resolve(undefined as never)
    },
  )
  return { add }
}

/** A no-op dm-trigger queue for the paths that never re-arm (the default case). */
export function inertDmTriggerQueue(): DmTriggerQueueLike {
  return recordingDmTriggerQueue([])
}

/** Records every `(name, data)` the §2 st-evaluation producer receives, so the
 *  success-path enqueue assertions read the payload off a plain array. */
export interface StEvalCall {
  readonly name: string
  readonly data: StEvalPayload
}

export function recordingStEvalQueue(calls: StEvalCall[]): StEvalQueueLike {
  const add = vi.fn((name: string, data: StEvalPayload): Promise<never> => {
    calls.push({ name, data })
    return Promise.resolve(undefined as never)
  })
  return { add }
}

/** A no-op st-eval queue for the paths that never enqueue (the default case). */
export function inertStEvalQueue(): StEvalQueueLike {
  return recordingStEvalQueue([])
}

/** Records every `(name, data)` the §2.4 Scribe producer receives, so the
 *  flushed-success enqueue assertions read the payload off a plain array. */
export interface ScribeCall {
  readonly name: string
  readonly data: ScribeJobPayload
}

export function recordingScribeQueue(calls: ScribeCall[]): ScribeQueueLike {
  const add = vi.fn((name: string, data: ScribeJobPayload): Promise<never> => {
    calls.push({ name, data })
    return Promise.resolve(undefined as never)
  })
  return { add }
}

/** A no-op scribe queue for the paths that never enqueue (the default case). */
export function inertScribeQueue(): ScribeQueueLike {
  return recordingScribeQueue([])
}

/** MYT-74a T12 — a no-op budget auto-end for the paths that never reach the
 *  budget threshold (the default case). The budget-end tests inject a `vi.fn()`
 *  spy in its place to assert the call. */
export function inertEndSession(): TurnProcessorDeps['endSession'] {
  return (): Promise<void> => Promise.resolve()
}

/** MYT-74b §1.3 — a no-op farewell finalize for the paths that never run the
 *  unconditional finalize (every non-farewell turn). The farewell tests inject a
 *  `vi.fn()` spy in its place to assert the (single) finalize call. Each call
 *  returns a fresh `vi.fn()` so a test can pass one literal AND keep a handle. */
export function inertFinalize(): TurnProcessorDeps['finalizeEndedSession'] {
  return vi.fn((): Promise<void> => Promise.resolve())
}

/** MYT-75 T7 — an inert `LedgerOps` for the paths that never apply combat (the
 *  StubFastThinker records no combat events, so `applyCombat` early-returns and
 *  the ledger is never dereferenced). Every method throws so an accidental call
 *  is LOUD. The combat-application tests build a real in-memory ledger instead. */
export function inertCombatLedger(): LedgerOps {
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
export function inertLedgerTx(): TurnProcessorDeps['ledgerTx'] {
  return (fn) => fn(inertCombatLedger())
}

// ── MYT-75 T7 — combat-application test fixtures ──────────────────────────────

/** A rolled enemy roster the initiate event carries onto the CombatState blob. */
export const GOBLIN_ENEMIES: readonly CombatEnemy[] = [
  { name: 'Goblin', description: 'a scrawny cave goblin', count: 1 },
]

/** A deterministic CombatOutcome for a tier — the same envelopes the real
 *  resolver assigns. `tierProse` is the fallback narration the force-resolve path
 *  uses when there is no FT close-out. */
export function combatOutcome(tier: 'pyrrhic' | 'costly'): CombatOutcome {
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

export interface CombatLedgerRow {
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
export function makeCombatLedger(rows: Map<string, CombatLedgerRow>): LedgerOps {
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
export function combatDeps(opts: {
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
