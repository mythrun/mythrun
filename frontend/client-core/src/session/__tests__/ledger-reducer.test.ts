import { describe, it, expect } from 'vitest'
import type { ServerFrame } from '@mythrun/contract/events'
import { emptyOverlay, reduceLedger, type CharacterOverlay } from '../ledger-reducer.ts'

// The ledger_update frame, narrowed from the shipped ServerFrame union (contract
// events/session-events.ts) — consumed, not redeclared. Live frames carry NO seq;
// reconnect-replay rows carry one.
type LedgerFrame = Extract<ServerFrame, { type: 'ledger_update' }>

const hpFrame = (hp: number, maxHp: number, extra: Partial<LedgerFrame> = {}): LedgerFrame => ({
  type: 'ledger_update', turnId: 't1', characterName: 'Cee',
  kind: 'hp', summary: `now ${String(hp)}/${String(maxHp)} HP`, hp, maxHp, ...extra,
})
const goldFrame = (gold: number): LedgerFrame => ({
  type: 'ledger_update', turnId: 't1', characterName: 'Cee',
  kind: 'gold', summary: `${String(gold)} gold remaining`, gold,
})
const conditionFrame = (summary: string, extra: Partial<LedgerFrame> = {}): LedgerFrame => ({
  type: 'ledger_update', turnId: 't1', characterName: 'Cee',
  kind: 'condition', summary, condition: 'poisoned', ...extra,
})
// A take_rest frame ALSO carries authoritative post-rest hp/maxHp (a rest heals).
const restFrame = (hp: number, maxHp: number): LedgerFrame => ({
  type: 'ledger_update', turnId: 't1', characterName: 'Cee',
  kind: 'rest', summary: `rested to ${String(hp)}/${String(maxHp)} HP`, hp, maxHp,
})
// A value-less kind (no hp/maxHp/gold, not a condition) — a no-op for the overlay.
const itemFrame = (): LedgerFrame => ({
  type: 'ledger_update', turnId: 't1', characterName: 'Cee',
  kind: 'item', summary: 'picks up a coil of rope', itemName: 'rope', quantity: 1,
})

describe('emptyOverlay', () => {
  it('is all-null values with an empty conditionLog and an UNKNOWN active set', () => {
    expect(emptyOverlay).toEqual({
      hp: null, maxHp: null, gold: null, conditionLog: [], activeConditions: null,
    })
  })

  it('starts activeConditions as null (unknown), NOT as an empty array (known-none)', () => {
    // The distinction is load-bearing: `null` means "no frame has spoken yet, so
    // the base sheet stands"; `[]` means "the character has none right now".
    expect(emptyOverlay.activeConditions).toBeNull()
  })
})

describe('reduceLedger', () => {
  it('folds a kind:hp frame as an authoritative SET of hp + maxHp', () => {
    const next = reduceLedger(emptyOverlay, hpFrame(5, 8))
    expect(next.hp).toBe(5)
    expect(next.maxHp).toBe(8)
    expect(next.gold).toBeNull()
    expect(next.conditionLog).toEqual([])
  })

  it('overwrites on a second hp frame (SET, never accumulate)', () => {
    const once = reduceLedger(emptyOverlay, hpFrame(5, 8))
    const twice = reduceLedger(once, hpFrame(2, 8))
    expect(twice.hp).toBe(2) // not 5 + 2
    expect(twice.maxHp).toBe(8)
  })

  it('is idempotent when the same hp frame is re-applied (reconnect replay is harmless)', () => {
    const frame = hpFrame(5, 8)
    const once = reduceLedger(emptyOverlay, frame)
    const twice = reduceLedger(once, frame)
    expect(twice).toEqual(once)
  })

  it('folds a kind:gold frame as an authoritative SET of gold, leaving hp untouched', () => {
    const withHp = reduceLedger(emptyOverlay, hpFrame(5, 8))
    const next = reduceLedger(withHp, goldFrame(42))
    expect(next.gold).toBe(42)
    expect(next.hp).toBe(5) // no hp on a gold frame → prior value kept
    expect(next.maxHp).toBe(8)
  })

  it('appends a kind:condition frame summary to the chronological conditionLog', () => {
    const next = reduceLedger(emptyOverlay, conditionFrame('Cee is now poisoned.'))
    expect(next.conditionLog).toEqual(['Cee is now poisoned.'])
    expect(next.hp).toBeNull() // a condition frame carries no hp/gold
    expect(next.gold).toBeNull()
  })

  it('logs conditions chronologically — no dedup, no derived active set', () => {
    const a = reduceLedger(emptyOverlay, conditionFrame('Cee is now poisoned.'))
    const b = reduceLedger(a, conditionFrame('Cee is no longer poisoned.'))
    expect(b.conditionLog).toEqual(['Cee is now poisoned.', 'Cee is no longer poisoned.'])
  })

  it('folds hp from a kind:rest frame (a rest heals — the live sheet must not go stale)', () => {
    const damaged = reduceLedger(emptyOverlay, hpFrame(2, 8))
    const rested = reduceLedger(damaged, restFrame(8, 8))
    expect(rested.hp).toBe(8)
    expect(rested.maxHp).toBe(8)
  })

  it('leaves the overlay unchanged for a value-less kind (e.g. item)', () => {
    const withState = reduceLedger(reduceLedger(emptyOverlay, hpFrame(5, 8)), goldFrame(10))
    const next = reduceLedger(withState, itemFrame())
    expect(next.hp).toBe(5)
    expect(next.maxHp).toBe(8)
    expect(next.gold).toBe(10)
    expect(next.conditionLog).toEqual([])
  })

  it('folds activeConditions as an authoritative SET of the whole set', () => {
    const next = reduceLedger(
      emptyOverlay,
      conditionFrame('Cee is now poisoned.', {
        activeConditions: [{ condition: 'poisoned', level: null }],
      }),
    )
    expect(next.activeConditions).toEqual([{ condition: 'poisoned', level: null }])
  })

  it('replaces the whole set on the next frame (SET, never merge)', () => {
    const poisoned = reduceLedger(
      emptyOverlay,
      conditionFrame('Cee is now poisoned.', {
        activeConditions: [{ condition: 'poisoned', level: null }],
      }),
    )
    const cured = reduceLedger(
      poisoned,
      conditionFrame('The venom passes.', {
        activeConditions: [{ condition: 'exhaustion', level: 3 }],
      }),
    )
    expect(cured.activeConditions).toEqual([{ condition: 'exhaustion', level: 3 }])
  })

  it('an EMPTY activeConditions array clears the set — "currently none" is a statement', () => {
    const poisoned = reduceLedger(
      emptyOverlay,
      conditionFrame('Cee is now poisoned.', {
        activeConditions: [{ condition: 'poisoned', level: null }],
      }),
    )
    const cured = reduceLedger(poisoned, conditionFrame('The venom passes.', { activeConditions: [] }))
    expect(cured.activeConditions).toEqual([]) // NOT the stale [poisoned]
  })

  it('holds the last known set when the frame OMITS activeConditions (absence != empty)', () => {
    // A gold spend cannot touch conditions, so it makes no statement about them.
    // Treating absence as "clear" would silently wipe conditions on every purchase.
    const poisoned = reduceLedger(
      emptyOverlay,
      conditionFrame('Cee is now poisoned.', {
        activeConditions: [{ condition: 'poisoned', level: null }],
      }),
    )
    const afterSpend = reduceLedger(poisoned, goldFrame(12))
    expect(afterSpend.activeConditions).toEqual([{ condition: 'poisoned', level: null }])
  })

  it('folds activeConditions off an hp frame (every HP write syncs derived unconscious)', () => {
    const downed = reduceLedger(
      emptyOverlay,
      hpFrame(0, 8, { activeConditions: [{ condition: 'unconscious', level: null }] }),
    )
    expect(downed.activeConditions).toEqual([{ condition: 'unconscious', level: null }])
    const revived = reduceLedger(downed, hpFrame(4, 8, { activeConditions: [] }))
    expect(revived.activeConditions).toEqual([])
  })

  it('is idempotent when the same activeConditions frame is re-applied (replay is harmless)', () => {
    const frame = conditionFrame('Cee is now poisoned.', {
      activeConditions: [{ condition: 'poisoned', level: null }],
    })
    const once = reduceLedger(emptyOverlay, frame)
    const twice = reduceLedger(once, frame)
    expect(twice.activeConditions).toEqual(once.activeConditions)
  })

  it('produces an identical result whether the frame carries seq (replay) or not (live)', () => {
    const live = hpFrame(5, 8)
    const replay = hpFrame(5, 8, { seq: 21 })
    expect(reduceLedger(emptyOverlay, replay)).toEqual(reduceLedger(emptyOverlay, live))
  })

  it('does not mutate the input overlay', () => {
    const frozen: CharacterOverlay = Object.freeze({
      hp: 5, maxHp: 8, gold: null, conditionLog: [], activeConditions: null,
    })
    const next = reduceLedger(frozen, hpFrame(3, 8))
    expect(next).not.toBe(frozen)
    expect(frozen.hp).toBe(5) // input untouched
  })
})
