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
const conditionFrame = (summary: string): LedgerFrame => ({
  type: 'ledger_update', turnId: 't1', characterName: 'Cee',
  kind: 'condition', summary, condition: 'poisoned',
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
  it('is all-null values with an empty conditionLog', () => {
    expect(emptyOverlay).toEqual({ hp: null, maxHp: null, gold: null, conditionLog: [] })
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

  it('produces an identical result whether the frame carries seq (replay) or not (live)', () => {
    const live = hpFrame(5, 8)
    const replay = hpFrame(5, 8, { seq: 21 })
    expect(reduceLedger(emptyOverlay, replay)).toEqual(reduceLedger(emptyOverlay, live))
  })

  it('does not mutate the input overlay', () => {
    const frozen: CharacterOverlay = Object.freeze({
      hp: 5, maxHp: 8, gold: null, conditionLog: [],
    })
    const next = reduceLedger(frozen, hpFrame(3, 8))
    expect(next).not.toBe(frozen)
    expect(frozen.hp).toBe(5) // input untouched
  })
})
