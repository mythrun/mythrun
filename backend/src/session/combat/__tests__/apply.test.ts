// backend/src/session/combat/__tests__/apply.test.ts
//
// MYT-75 Task 5 — the D13 envelope reconciler. The dice are authoritative: the
// FT's resolve_combat deltas are proposals, and reconcileDeltas clamps/augments
// them to satisfy the CombatOutcome.envelope (minDownedPcs / aggregate HP loss /
// partyWins / death-narration). reconcileDeltas + assembleSummary are pure; the
// applyToLedger test drives the REAL resolveAdjustHp against an in-memory
// LedgerOps fake so the loop's payload extraction (hpBefore/hpAfter/maxHp) is
// exercised end-to-end, not stubbed away.

import { describe, it, expect } from 'vitest'
import type { CombatOutcome, CombatSummaryL1 } from '../../../redis/session-state.js'
import type { RulesLawyerDeps } from '../../rules-lawyer.js'
import type {
  FindLedgerCharacterResult,
  LedgerEventInput,
  LedgerOps,
  PartyLedgerSnapshot,
} from '../../../repo/characters-ledger.js'
import type { Character } from '../../../repo/types.js'
import {
  reconcileDeltas,
  applyToLedger,
  assembleSummary,
  type FtCombatDeltas,
  type ReconcilePc,
  type ReconciledCombat,
} from '../apply.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMPTY_FT: FtCombatDeltas = {
  hp_changes: [],
  conditions_applied: [],
  conditions_removed: [],
  casualties: [],
}

/** Build a CombatOutcome around an explicit envelope (the only field the
 *  reconciler reads beyond `tier`). */
function outcomeWith(envelope: CombatOutcome['envelope'], tier: CombatOutcome['tier'] = 'costly'): CombatOutcome {
  return { tier, dc: 15, roll: 10, total: 15, tierProse: 'the seed prose', envelope }
}

const DECISIVE_ENV = { partyWins: true, minDownedPcs: 0, minAggregateHpLossFraction: 0, allowPcDeathNarration: false }

// ---------------------------------------------------------------------------
// reconcileDeltas — partition
// ---------------------------------------------------------------------------

describe('reconcileDeltas — partition', () => {
  it('routes a PC name to pcDamage, an enemy name to enemyCasualties, and DROPS an unknown name', () => {
    const party: readonly ReconcilePc[] = [{ characterId: 'a', name: 'Bram', hp: 40, maxHp: 40 }]
    const ft: FtCombatDeltas = {
      hp_changes: [
        { combatant_name: '  bram ', damage: 10, healing: 0 }, // case-insensitive + trimmed → PC
        { combatant_name: 'Goblin', damage: 99, healing: 0 }, // enemy → no PC damage
        { combatant_name: 'Ghost', damage: 5, healing: 0 }, // unknown → dropped
      ],
      conditions_applied: [],
      conditions_removed: [],
      casualties: [
        { combatant_name: 'Goblin', fate: 'dead' },
        { combatant_name: 'Nobody', fate: 'fled' }, // unknown → dropped
      ],
    }
    const r = reconcileDeltas(outcomeWith(DECISIVE_ENV), ft, party, ['Goblin'])
    expect(r.pcDamage).toEqual([{ characterId: 'a', name: 'Bram', amount: 10, hpBefore: 40 }])
    expect(r.enemyCasualties).toEqual([{ name: 'Goblin', fate: 'dead' }])
  })

  it('nets damage minus healing floored at 0, capped at current hp', () => {
    const party: readonly ReconcilePc[] = [
      { characterId: 'a', name: 'Bram', hp: 30, maxHp: 40 },
      { characterId: 'b', name: 'Sel', hp: 8, maxHp: 30 },
    ]
    const ft: FtCombatDeltas = {
      hp_changes: [
        { combatant_name: 'Bram', damage: 12, healing: 5 }, // net 7
        { combatant_name: 'Bram', damage: 3, healing: 0 }, // sums to 10
        { combatant_name: 'Sel', damage: 100, healing: 0 }, // capped at hp 8
      ],
      conditions_applied: [],
      conditions_removed: [],
      casualties: [],
    }
    const r = reconcileDeltas(outcomeWith(DECISIVE_ENV), ft, party, [])
    expect(r.pcDamage).toContainEqual({ characterId: 'a', name: 'Bram', amount: 10, hpBefore: 30 })
    expect(r.pcDamage).toContainEqual({ characterId: 'b', name: 'Sel', amount: 8, hpBefore: 8 })
  })

  it('floors net at 0 when healing exceeds damage (no negative damage)', () => {
    const party: readonly ReconcilePc[] = [{ characterId: 'a', name: 'Bram', hp: 40, maxHp: 40 }]
    const ft: FtCombatDeltas = {
      hp_changes: [{ combatant_name: 'Bram', damage: 2, healing: 9 }],
      conditions_applied: [],
      conditions_removed: [],
      casualties: [],
    }
    const r = reconcileDeltas(outcomeWith(DECISIVE_ENV), ft, party, [])
    expect(r.pcDamage).toEqual([{ characterId: 'a', name: 'Bram', amount: 0, hpBefore: 40 }])
  })
})

// ---------------------------------------------------------------------------
// reconcileDeltas — the D13 adversarial case (envelope enforcement)
// ---------------------------------------------------------------------------

describe('reconcileDeltas — envelope enforcement (D13)', () => {
  it('clamps to the envelope when the FT under-reports (pyrrhic, no casualties → forces ≥1 PC to 0 hp)', () => {
    const outcome = {
      tier: 'pyrrhic',
      envelope: { partyWins: true, minDownedPcs: 1, minAggregateHpLossFraction: 0.3, allowPcDeathNarration: false },
      dc: 15,
      roll: 6,
      total: 11,
      tierProse: 'x',
    } as CombatOutcome
    const party: readonly ReconcilePc[] = [
      { characterId: 'a', name: 'Bram', hp: 40, maxHp: 40 },
      { characterId: 'b', name: 'Sel', hp: 12, maxHp: 30 },
    ]
    const reconciled = reconcileDeltas(outcome, EMPTY_FT, party, ['Goblin'])
    // Sel (lowest hp) is downed to satisfy minDownedPcs.
    expect(reconciled.pcDamage.some((d) => d.amount >= 12)).toBe(true)
    expect(reconciled.pcCasualties.length).toBeGreaterThanOrEqual(1)
    expect(reconciled.pcCasualties).toContainEqual({ name: 'Sel', fate: 'unconscious' })
  })

  it('honours an already-downed PC and does not down a second one for minDownedPcs:1', () => {
    const party: readonly ReconcilePc[] = [
      { characterId: 'a', name: 'Bram', hp: 40, maxHp: 40 },
      { characterId: 'b', name: 'Sel', hp: 12, maxHp: 30 },
    ]
    const ft: FtCombatDeltas = {
      hp_changes: [{ combatant_name: 'Bram', damage: 40, healing: 0 }], // Bram already to 0
      conditions_applied: [],
      conditions_removed: [],
      casualties: [],
    }
    const env = { partyWins: true, minDownedPcs: 1, minAggregateHpLossFraction: 0, allowPcDeathNarration: false }
    const r = reconcileDeltas(outcomeWith(env, 'pyrrhic'), ft, party, [])
    // Bram satisfies the floor; Sel stays up (0 applied damage, not downed).
    expect(r.pcCasualties).toEqual([{ name: 'Bram', fate: 'unconscious' }])
    expect(r.pcDamage.find((d) => d.name === 'Sel')?.amount).toBe(0)
  })

  it('mechanically downs an FT-declared casualty the FT under-damaged (summary == ledger)', async () => {
    // The FT narrates Bram unconscious but only reports 5 damage off 40 hp.
    // reconcileDeltas must force Bram to 0 HP so the casualty list and the
    // ledger agree — otherwise the summary says "unconscious", the ledger says
    // conscious at 35/40.
    const party: readonly ReconcilePc[] = [
      { characterId: 'a', name: 'Bram', hp: 40, maxHp: 40 },
      { characterId: 'b', name: 'Sel', hp: 30, maxHp: 30 },
    ]
    const ft: FtCombatDeltas = {
      hp_changes: [{ combatant_name: 'Bram', damage: 5, healing: 0 }],
      conditions_applied: [],
      conditions_removed: [],
      casualties: [{ combatant_name: 'Bram', fate: 'unconscious' }],
    }
    const env = { partyWins: true, minDownedPcs: 1, minAggregateHpLossFraction: 0, allowPcDeathNarration: false }
    const r = reconcileDeltas(outcomeWith(env, 'pyrrhic'), ft, party, [])
    // Bram's applied damage is now his full current hp (forced to 0) — Sel is untouched.
    expect(r.pcDamage.find((d) => d.name === 'Bram')?.amount).toBe(40)
    expect(r.pcDamage.find((d) => d.name === 'Sel')?.amount).toBe(0)
    expect(r.pcCasualties).toEqual([{ name: 'Bram', fate: 'unconscious' }])
    // And the ledger agrees: applyToLedger lands Bram at hpAfter 0.
    const rows = new Map<string, FakeRow>([
      ['a', { hp: 40, maxHp: 40, name: 'Bram' }],
      ['b', { hp: 30, maxHp: 30, name: 'Sel' }],
    ])
    const hpChanges = await applyToLedger(makeDeps(makeFakeLedger(rows)), r)
    expect(hpChanges).toContainEqual({ combatant: 'Bram', hpBefore: 40, hpAfter: 0, maxHp: 40 })
  })

  it('augments aggregate HP loss across the highest-hp PCs until the fraction is met', () => {
    // total maxHp = 100; need >= 30% = 30 HP of damage. FT reports 5.
    const party: readonly ReconcilePc[] = [
      { characterId: 'a', name: 'Bram', hp: 50, maxHp: 50 },
      { characterId: 'b', name: 'Sel', hp: 50, maxHp: 50 },
    ]
    const ft: FtCombatDeltas = {
      hp_changes: [{ combatant_name: 'Sel', damage: 5, healing: 0 }],
      conditions_applied: [],
      conditions_removed: [],
      casualties: [],
    }
    const env = { partyWins: true, minDownedPcs: 0, minAggregateHpLossFraction: 0.3, allowPcDeathNarration: false }
    const r = reconcileDeltas(outcomeWith(env, 'costly'), ft, party, [])
    const total = r.pcDamage.reduce((s, d) => s + d.amount, 0)
    expect(total).toBeGreaterThanOrEqual(30)
    // No PC is downed (the fraction is met well before anyone hits 0).
    expect(r.pcCasualties).toEqual([])
  })

  it('caps aggregate augmentation when every PC is at 0 (cannot exceed total hp)', () => {
    const party: readonly ReconcilePc[] = [
      { characterId: 'a', name: 'Bram', hp: 4, maxHp: 50 },
      { characterId: 'b', name: 'Sel', hp: 4, maxHp: 50 },
    ]
    const env = { partyWins: true, minDownedPcs: 0, minAggregateHpLossFraction: 0.99, allowPcDeathNarration: false }
    const r = reconcileDeltas(outcomeWith(env, 'costly'), EMPTY_FT, party, [])
    // Only 8 HP of damage is even possible; the loop terminates, doesn't spin.
    const total = r.pcDamage.reduce((s, d) => s + d.amount, 0)
    expect(total).toBe(8)
    expect(r.pcCasualties.length).toBe(2)
  })

  it('skips an already-maxed PC during aggregate augmentation (room <= 0)', () => {
    // Both PCs at 2/10 (total max 20); an unachievable 0.99 fraction (needs ~19.8
    // but only 4 HP of damage is possible). Bram is FT-downed (2 damage, room 0);
    // the aggregate loop revisits him with no room and must skip, not loop.
    const party: readonly ReconcilePc[] = [
      { characterId: 'a', name: 'Bram', hp: 2, maxHp: 10 },
      { characterId: 'b', name: 'Sel', hp: 2, maxHp: 10 },
    ]
    const ft: FtCombatDeltas = {
      hp_changes: [{ combatant_name: 'Bram', damage: 2, healing: 0 }],
      conditions_applied: [],
      conditions_removed: [],
      casualties: [],
    }
    const env = { partyWins: true, minDownedPcs: 0, minAggregateHpLossFraction: 0.99, allowPcDeathNarration: false }
    const r = reconcileDeltas(outcomeWith(env, 'costly'), ft, party, [])
    const total = r.pcDamage.reduce((s, d) => s + d.amount, 0)
    expect(total).toBe(4) // both PCs maxed at their 2 hp; loop terminates cleanly
    expect(r.pcCasualties.length).toBe(2)
  })

  it('handles an empty party without dividing by zero', () => {
    const env = { partyWins: true, minDownedPcs: 0, minAggregateHpLossFraction: 0.5, allowPcDeathNarration: false }
    const r = reconcileDeltas(outcomeWith(env, 'costly'), EMPTY_FT, [], [])
    expect(r.pcDamage).toEqual([])
    expect(r.pcCasualties).toEqual([])
    expect(r.outcomeKind).toBe('victory')
  })
})

// ---------------------------------------------------------------------------
// reconcileDeltas — outcomeKind + casualties + conditions
// ---------------------------------------------------------------------------

describe('reconcileDeltas — outcomeKind / casualties / conditions', () => {
  it("maps !partyWins to outcomeKind 'defeat'", () => {
    const env = { partyWins: false, minDownedPcs: 0, minAggregateHpLossFraction: 0.2, allowPcDeathNarration: true }
    const r = reconcileDeltas(outcomeWith(env, 'routed'), EMPTY_FT, [], [])
    expect(r.outcomeKind).toBe('defeat')
  })

  it('records a dead PC fate when allowPcDeathNarration is set', () => {
    const party: readonly ReconcilePc[] = [{ characterId: 'a', name: 'Bram', hp: 5, maxHp: 40 }]
    const ft: FtCombatDeltas = {
      hp_changes: [{ combatant_name: 'Bram', damage: 5, healing: 0 }],
      conditions_applied: [],
      conditions_removed: [],
      casualties: [{ combatant_name: 'Bram', fate: 'dead' }],
    }
    const env = { partyWins: false, minDownedPcs: 0, minAggregateHpLossFraction: 0, allowPcDeathNarration: true }
    const r = reconcileDeltas(outcomeWith(env, 'routed'), ft, party, [])
    expect(r.pcCasualties).toEqual([{ name: 'Bram', fate: 'dead' }])
  })

  it('downgrades an FT-claimed dead PC to unconscious without allowPcDeathNarration', () => {
    const party: readonly ReconcilePc[] = [{ characterId: 'a', name: 'Bram', hp: 5, maxHp: 40 }]
    const ft: FtCombatDeltas = {
      hp_changes: [{ combatant_name: 'Bram', damage: 5, healing: 0 }],
      conditions_applied: [],
      conditions_removed: [],
      casualties: [{ combatant_name: 'Bram', fate: 'dead' }],
    }
    const env = { partyWins: true, minDownedPcs: 0, minAggregateHpLossFraction: 0, allowPcDeathNarration: false }
    const r = reconcileDeltas(outcomeWith(env, 'pyrrhic'), ft, party, [])
    expect(r.pcCasualties).toEqual([{ name: 'Bram', fate: 'unconscious' }])
  })

  it('drops an FT-claimed dead PC that was NOT actually reduced to 0 (no damage)', () => {
    const party: readonly ReconcilePc[] = [{ characterId: 'a', name: 'Bram', hp: 40, maxHp: 40 }]
    const ft: FtCombatDeltas = {
      hp_changes: [],
      conditions_applied: [],
      conditions_removed: [],
      casualties: [{ combatant_name: 'Bram', fate: 'fled' }], // fled, not downed
    }
    const r = reconcileDeltas(outcomeWith(DECISIVE_ENV), ft, party, [])
    expect(r.pcCasualties).toEqual([])
  })

  it('passes through PC conditions as apply/remove and ignores enemy/unknown conditions', () => {
    const party: readonly ReconcilePc[] = [{ characterId: 'a', name: 'Bram', hp: 40, maxHp: 40 }]
    const ft: FtCombatDeltas = {
      hp_changes: [],
      conditions_applied: [
        { combatant_name: 'Bram', condition: 'poisoned' },
        { combatant_name: 'Goblin', condition: 'prone' }, // enemy → ignored
      ],
      conditions_removed: [{ combatant_name: 'Bram', condition: 'frightened' }],
      casualties: [],
    }
    const r = reconcileDeltas(outcomeWith(DECISIVE_ENV), ft, party, ['Goblin'])
    expect(r.conditions).toContainEqual({ name: 'Bram', condition: 'poisoned', action: 'apply' })
    expect(r.conditions).toContainEqual({ name: 'Bram', condition: 'frightened', action: 'remove' })
    expect(r.conditions.some((c) => c.name === 'Goblin')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// applyToLedger — real resolveAdjustHp against an in-memory LedgerOps fake
// ---------------------------------------------------------------------------

/** Build a full Character so the projection is real (no `as`). */
function makeCharacter(id: string, name: string, hp: number, maxHp: number): Character {
  return {
    id, userId: 'u', entityId: null, name, level: 1,
    class: 'Fighter', species: 'Human', background: 'Soldier',
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
    hitPoints: hp, maxHitPoints: maxHp, armorClass: 10, proficiencyBonus: 2,
    createdAt: new Date(0), updatedAt: new Date(0),
  }
}

interface FakeRow {
  hp: number
  readonly maxHp: number
  readonly name: string
}

/** An in-memory LedgerOps covering the methods applyToLedger touches:
 *  findLedgerCharacterByName, readPartyLedgerSnapshot, writeHp, and the §10
 *  journal pair (findLedgerEvent / writeLedgerEvent — backed by a real
 *  `journal` store so the audit-row + idempotency assertions are observable).
 *  Throws on every unused method so an accidental call is loud. The optional
 *  `journal` array (shared with the caller) records every committed event;
 *  `findLedgerEvent` reads it back so a re-run is detected as already-applied. */
function makeFakeLedger(rows: Map<string, FakeRow>, journal: LedgerEventInput[] = []): LedgerOps {
  const unsupported = (m: string): never => {
    throw new Error(`fake LedgerOps: ${m} not implemented`)
  }
  const findId = (name: string): string | undefined => {
    for (const [id, r] of rows) if (r.name.trim().toLowerCase() === name.trim().toLowerCase()) return id
    return undefined
  }
  const resolveFind = (name: string): FindLedgerCharacterResult => {
    const id = findId(name)
    const row = id === undefined ? undefined : rows.get(id)
    if (id === undefined || row === undefined) return { outcome: 'not_found' }
    const character = makeCharacter(id, row.name, row.hp, row.maxHp)
    return {
      outcome: 'found',
      projection: { character, gold: 0, hitDie: 8, hitDiceRemaining: 1, spellcastingProgression: 'none', conMod: 0 },
    }
  }
  const snapshot = (): PartyLedgerSnapshot =>
    [...rows.entries()].map(([id, r]) => ({
      characterId: id, name: r.name, hitPoints: r.hp, maxHitPoints: r.maxHp,
      hitDie: 8, hitDiceRemaining: 1, level: 1, gold: 0,
      slots: [], conditions: [], trackedFeatures: [], spells: [], equipment: [],
    }))
  const setHp = (characterId: string, newHp: number): { hp: number; maxHp: number } => {
    const row = rows.get(characterId)
    if (row === undefined) throw new Error('fake writeHp: no row')
    const clamped = Math.max(0, Math.min(newHp, row.maxHp))
    row.hp = clamped
    return { hp: clamped, maxHp: row.maxHp }
  }
  const hasEvent = (turnId: string, toolCallId: string, characterId: string): boolean =>
    journal.some(
      (e) => e.turnId === turnId && e.toolCallId === toolCallId && e.characterId === characterId,
    )
  const recordEvent = (input: LedgerEventInput): string | null => {
    // Mirror the UNIQUE (turn_id, tool_call_id, character_id) constraint: an
    // existing row is a no-op insert (NULL RETURNING), else append + return id.
    if (hasEvent(input.turnId, input.toolCallId, input.characterId)) return null
    journal.push(input)
    return 'evt'
  }
  return {
    findLedgerCharacterByName: (_sessionId, name) => Promise.resolve(resolveFind(name)),
    readPartyLedgerSnapshot: () => Promise.resolve(snapshot()),
    readConditions: () => Promise.resolve([]),
    writeHp: (characterId, newHp) => Promise.resolve(setHp(characterId, newHp)),
    findLedgerEvent: (turnId, toolCallId, characterId) =>
      Promise.resolve(hasEvent(turnId, toolCallId, characterId)),
    writeLedgerEvent: (input) => Promise.resolve(recordEvent(input)),
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

function makeDeps(ledger: LedgerOps): RulesLawyerDeps {
  return {
    ledger,
    runInTx: async (fn) => fn(ledger),
    sessionId: 's',
    turnId: 't',
    toolCallId: 'tc',
  }
}

describe('applyToLedger', () => {
  it('applies each pcDamage entry, returns hpBefore/hpAfter/maxHp, and journals one audit row per PC', async () => {
    const rows = new Map<string, FakeRow>([
      ['a', { hp: 40, maxHp: 40, name: 'Bram' }],
      ['b', { hp: 12, maxHp: 30, name: 'Sel' }],
    ])
    const journal: LedgerEventInput[] = []
    const ledger = makeFakeLedger(rows, journal)
    const reconciled: ReconciledCombat = {
      outcomeKind: 'victory',
      pcDamage: [
        { characterId: 'a', name: 'Bram', amount: 10, hpBefore: 40 },
        { characterId: 'b', name: 'Sel', amount: 12, hpBefore: 12 },
      ],
      pcCasualties: [{ name: 'Sel', fate: 'unconscious' }],
      enemyCasualties: [],
      conditions: [],
    }
    const hpChanges = await applyToLedger(makeDeps(ledger), reconciled)
    expect(hpChanges).toContainEqual({ combatant: 'Bram', hpBefore: 40, hpAfter: 30, maxHp: 40 })
    expect(hpChanges).toContainEqual({ combatant: 'Sel', hpBefore: 12, hpAfter: 0, maxHp: 30 })
    // Combat HP is AUDITED like every other HP-mutation path: one ledger_events
    // row per PC, under the synthetic combat-resolve toolCallId, with the applied
    // HP delta in `delta` (magnitude = HP removed; kind tags the combat path).
    expect(journal).toHaveLength(2)
    expect(journal).toContainEqual({
      characterId: 'a', sessionId: 's', turnId: 't', toolCallId: 'tc',
      tool: 'resolve_combat', delta: { kind: 'combat', magnitude: 10, hp: 30 },
    })
    expect(journal).toContainEqual({
      characterId: 'b', sessionId: 's', turnId: 't', toolCallId: 'tc',
      tool: 'resolve_combat', delta: { kind: 'combat', magnitude: 12, hp: 0 },
    })
  })

  it('skips a zero-amount damage entry (no resolver call needed)', async () => {
    const rows = new Map<string, FakeRow>([['a', { hp: 40, maxHp: 40, name: 'Bram' }]])
    const ledger = makeFakeLedger(rows)
    const reconciled: ReconciledCombat = {
      outcomeKind: 'victory',
      pcDamage: [{ characterId: 'a', name: 'Bram', amount: 0, hpBefore: 40 }],
      pcCasualties: [],
      enemyCasualties: [],
      conditions: [],
    }
    const hpChanges = await applyToLedger(makeDeps(ledger), reconciled)
    expect(hpChanges).toEqual([])
  })

  it('SETS to the combat target (hpBefore − amount), NOT a delta — subsumes a prior in-turn adjust_hp (double-application regression)', async () => {
    // MYT-75 L1: in one combat turn the FT called BOTH resolve_combat (reporting
    // a wound) AND the standalone adjust_hp ledger tool for the same PC. The
    // wound was applied TWICE — once live by adjust_hp during the render, once by
    // the worker's post-turn applyCombat (a delta on top). Bram ended at 0 instead
    // of his real target. The fix makes the combat outcome authoritative: SET HP
    // to the target (combat-start HP − reconciled damage), which subsumes any
    // in-turn adjust_hp and is idempotent.
    //
    // Snapshot HP 28, combat damage 16 → target 12. The live ledger is ALREADY at
    // 12 (a prior adjust_hp this turn took 28 → 12). A delta would land Bram at
    // 12 − 16 = 0 (double-counted); SETTING to 12 is correct.
    const rows = new Map<string, FakeRow>([
      ['a', { hp: 12, maxHp: 28, name: 'Bram' }], // live ledger already at 12 from a prior adjust_hp
    ])
    const journal: LedgerEventInput[] = []
    const ledger = makeFakeLedger(rows, journal)
    const deps = makeDeps(ledger) // stable synthetic toolCallId across re-runs
    const reconciled: ReconciledCombat = {
      outcomeKind: 'victory',
      pcDamage: [{ characterId: 'a', name: 'Bram', amount: 16, hpBefore: 28 }], // snapshot 28, dmg 16 → target 12
      pcCasualties: [],
      enemyCasualties: [],
      conditions: [],
    }
    const hpChanges = await applyToLedger(deps, reconciled)
    // The PC ends at the combat TARGET (12), NOT double-counted to 0.
    expect(hpChanges).toEqual([{ combatant: 'Bram', hpBefore: 28, hpAfter: 12, maxHp: 28 }])
    expect(rows.get('a')?.hp).toBe(12)
    // Exactly ONE audit row was journaled for the wound (16 HP removed).
    expect(journal).toHaveLength(1)
    expect(journal[0]).toMatchObject({
      characterId: 'a', toolCallId: 'tc', tool: 'resolve_combat',
      delta: { kind: 'combat', magnitude: 16, hp: 12 },
    })

    // IDEMPOTENT under §10 find-first: a BullMQ re-run with the SAME deps finds
    // the existing journal row and SKIPS — no second ledger_events row, the set
    // is a no-op (the PC is still at the target). hpChanges is empty (skipped).
    const replay = await applyToLedger(deps, reconciled)
    expect(replay).toEqual([])
    expect(journal).toHaveLength(1) // still exactly one row — not double-journaled
    expect(rows.get('a')?.hp).toBe(12)
  })

  it('clamps the SET target at 0 (damage at/above hpBefore downs the PC, never negative)', async () => {
    // hpBefore 10, damage 40 → Math.max(0, 10 − 40) = 0; writeHp clamps + auto-downs.
    const rows = new Map<string, FakeRow>([['a', { hp: 10, maxHp: 40, name: 'Bram' }]])
    const ledger = makeFakeLedger(rows)
    const reconciled: ReconciledCombat = {
      outcomeKind: 'victory',
      pcDamage: [{ characterId: 'a', name: 'Bram', amount: 40, hpBefore: 10 }],
      pcCasualties: [{ name: 'Bram', fate: 'unconscious' }],
      enemyCasualties: [],
      conditions: [],
    }
    const hpChanges = await applyToLedger(makeDeps(ledger), reconciled)
    expect(hpChanges).toEqual([{ combatant: 'Bram', hpBefore: 10, hpAfter: 0, maxHp: 40 }])
  })
})

// ---------------------------------------------------------------------------
// assembleSummary
// ---------------------------------------------------------------------------

describe('assembleSummary', () => {
  const reconciled: ReconciledCombat = {
    outcomeKind: 'victory',
    pcDamage: [],
    pcCasualties: [{ name: 'Sel', fate: 'unconscious' }],
    enemyCasualties: [{ name: 'Goblin', fate: 'dead' }],
    conditions: [{ name: 'Bram', condition: 'poisoned', action: 'apply' }],
  }
  const hpChanges = [{ combatant: 'Sel', hpBefore: 12, hpAfter: 0, maxHp: 30 }]

  it('assembles a CombatSummaryL1 with PC + NPC casualties and the FT narration', () => {
    const summary: CombatSummaryL1 = assembleSummary(
      outcomeWith(DECISIVE_ENV),
      reconciled,
      hpChanges,
      'The dust settles.',
    )
    expect(summary.outcome).toBe('victory')
    expect(summary.outcomeDescription).toBe('The dust settles.')
    expect(summary.casualties).toContainEqual({ name: 'Sel', type: 'pc', fate: 'unconscious' })
    expect(summary.casualties).toContainEqual({ name: 'Goblin', type: 'npc', fate: 'dead' })
    expect(summary.hpChanges).toEqual(hpChanges)
    expect(summary.conditionsRemaining).toEqual([{ combatant: 'Bram', condition: 'poisoned' }])
    expect(summary.loot).toEqual([])
  })

  it('falls back to outcome.tierProse when the narration is whitespace-only', () => {
    const summary = assembleSummary(outcomeWith(DECISIVE_ENV), reconciled, hpChanges, '   ')
    expect(summary.outcomeDescription).toBe('the seed prose')
  })

  it('maps known enemy fates through and defaults an unknown enemy fate to dead', () => {
    const r: ReconciledCombat = {
      outcomeKind: 'victory',
      pcDamage: [],
      pcCasualties: [],
      enemyCasualties: [
        { name: 'Wolf', fate: 'fled' },
        { name: 'Bandit', fate: 'captured' },
        { name: 'Ghoul', fate: 'unconscious' },
        { name: 'Imp', fate: 'banished' }, // unrecognised → dead
      ],
      conditions: [],
    }
    const summary = assembleSummary(outcomeWith(DECISIVE_ENV), r, [], 'done')
    expect(summary.casualties).toContainEqual({ name: 'Wolf', type: 'npc', fate: 'fled' })
    expect(summary.casualties).toContainEqual({ name: 'Bandit', type: 'npc', fate: 'captured' })
    expect(summary.casualties).toContainEqual({ name: 'Ghoul', type: 'npc', fate: 'unconscious' })
    expect(summary.casualties).toContainEqual({ name: 'Imp', type: 'npc', fate: 'dead' })
  })
})
