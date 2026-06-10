// MYT-70 §9.1 — SRD 5e spell-slot progression tables. Authored directly from
// the public SRD 5e tables (no prototype slot tables to port). Every row pinned
// against the SRD; the pact progression is the easiest to get wrong, so it gets
// the most explicit coverage.

import { describe, expect, it } from 'vitest'
import {
  SPELLCASTING_PROGRESSIONS,
  maxSlotLevel,
  spellSlotsFor,
  type SpellcastingProgression,
} from '../spell-slots.js'

/** Compact `{slotLevel, max}[]` → `[slotLevelMax, ...]` slot-1-first array for
 *  pinning against the SRD's "2/3/4/2" style notation. Pact rows (single slot
 *  level that may be > 1) are pinned with their explicit slotLevel instead. */
const maxima = (rows: readonly { slotLevel: number; max: number }[]): number[] =>
  rows.map((r) => r.max)

describe('SPELLCASTING_PROGRESSIONS', () => {
  it('is the closed five-value set', () => {
    expect(SPELLCASTING_PROGRESSIONS).toEqual(['full', 'half', 'third', 'pact', 'none'])
  })
})

describe('full caster (wizard/cleric/druid/sorcerer/bard)', () => {
  // SRD full-caster table, pinned slot-1-first.
  it.each<[number, number[]]>([
    [1, [2]],
    [2, [3]],
    [3, [4, 2]],
    [4, [4, 3]],
    [5, [4, 3, 2]],
    [6, [4, 3, 3]],
    [7, [4, 3, 3, 1]],
    [8, [4, 3, 3, 2]],
    [9, [4, 3, 3, 3, 1]],
    [10, [4, 3, 3, 3, 2]],
    [11, [4, 3, 3, 3, 2, 1]],
    [12, [4, 3, 3, 3, 2, 1]],
    [13, [4, 3, 3, 3, 2, 1, 1]],
    [14, [4, 3, 3, 3, 2, 1, 1]],
    [15, [4, 3, 3, 3, 2, 1, 1, 1]],
    [16, [4, 3, 3, 3, 2, 1, 1, 1]],
    [17, [4, 3, 3, 3, 2, 1, 1, 1, 1]],
    [18, [4, 3, 3, 3, 3, 1, 1, 1, 1]],
    [19, [4, 3, 3, 3, 3, 2, 1, 1, 1]],
    [20, [4, 3, 3, 3, 3, 2, 2, 1, 1]],
  ])('level %i', (level, expected) => {
    expect(maxima(spellSlotsFor('full', level))).toEqual(expected)
  })

  it('rows carry ascending contiguous slot levels from 1', () => {
    const rows = spellSlotsFor('full', 20)
    expect(rows.map((r) => r.slotLevel)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})

describe('half caster (paladin/ranger) — slots from character level 2', () => {
  it('level 1 has no slots', () => {
    expect(spellSlotsFor('half', 1)).toEqual([])
  })
  // SRD half-caster table.
  it.each<[number, number[]]>([
    [2, [2]],
    [3, [3]],
    [4, [3]],
    [5, [4, 2]],
    [6, [4, 2]],
    [7, [4, 3]],
    [8, [4, 3]],
    [9, [4, 3, 2]],
    [10, [4, 3, 2]],
    [11, [4, 3, 3]],
    [12, [4, 3, 3]],
    [13, [4, 3, 3, 1]],
    [14, [4, 3, 3, 1]],
    [15, [4, 3, 3, 2]],
    [16, [4, 3, 3, 2]],
    [17, [4, 3, 3, 3, 1]],
    [18, [4, 3, 3, 3, 1]],
    [19, [4, 3, 3, 3, 2]],
    [20, [4, 3, 3, 3, 2]],
  ])('level %i', (level, expected) => {
    expect(maxima(spellSlotsFor('half', level))).toEqual(expected)
  })
})

describe('third caster (Eldritch Knight/Arcane Trickster) — slots from character level 3', () => {
  it('levels 1 and 2 have no slots', () => {
    expect(spellSlotsFor('third', 1)).toEqual([])
    expect(spellSlotsFor('third', 2)).toEqual([])
  })
  // SRD third-caster table.
  it.each<[number, number[]]>([
    [3, [2]],
    [4, [3]],
    [5, [3]],
    [6, [3]],
    [7, [4, 2]],
    [8, [4, 2]],
    [9, [4, 2]],
    [10, [4, 3]],
    [11, [4, 3]],
    [12, [4, 3]],
    [13, [4, 3, 2]],
    [14, [4, 3, 2]],
    [15, [4, 3, 2]],
    [16, [4, 3, 3]],
    [17, [4, 3, 3]],
    [18, [4, 3, 3]],
    [19, [4, 3, 3, 1]],
    [20, [4, 3, 3, 1]],
  ])('level %i', (level, expected) => {
    expect(maxima(spellSlotsFor('third', level))).toEqual(expected)
  })
})

describe('pact (warlock) — N slots of a SINGLE pact-slot level', () => {
  // SRD warlock table: slot level rises 1→5 at levels 1/3/5/7/9; count is
  // 1 at L1, 2 from L2, 3 from L11, 4 from L17.
  it.each<[number, number, number]>([
    // [characterLevel, expectedSlotLevel, expectedCount]
    [1, 1, 1],
    [2, 1, 2],
    [3, 2, 2],
    [4, 2, 2],
    [5, 3, 2],
    [6, 3, 2],
    [7, 4, 2],
    [8, 4, 2],
    [9, 5, 2],
    [10, 5, 2],
    [11, 5, 3],
    [12, 5, 3],
    [16, 5, 3],
    [17, 5, 4],
    [20, 5, 4],
  ])('level %i → %i slot(s) of level %i', (level, slotLevel, count) => {
    const rows = spellSlotsFor('pact', level)
    expect(rows).toEqual([{ slotLevel, max: count }])
  })

  it('always returns exactly one row (single pact-slot level)', () => {
    for (let level = 1; level <= 20; level += 1) {
      expect(spellSlotsFor('pact', level)).toHaveLength(1)
    }
  })
})

describe('none', () => {
  it('returns no rows at any level', () => {
    expect(spellSlotsFor('none', 1)).toEqual([])
    expect(spellSlotsFor('none', 20)).toEqual([])
  })
})

describe('out-of-range levels throw (generation-time data error, not a runtime arm)', () => {
  const progressions: SpellcastingProgression[] = ['full', 'half', 'third', 'pact', 'none']
  it.each(progressions)('level 0 throws for %s', (p) => {
    expect(() => spellSlotsFor(p, 0)).toThrow()
  })
  it.each(progressions)('level 21 throws for %s', (p) => {
    expect(() => spellSlotsFor(p, 21)).toThrow()
  })
  it('non-integer level throws', () => {
    expect(() => spellSlotsFor('full', 1.5)).toThrow()
  })
})

describe('maxSlotLevel', () => {
  it('full caster ceilings (highest non-zero slot level)', () => {
    expect(maxSlotLevel('full', 1)).toBe(1)
    expect(maxSlotLevel('full', 5)).toBe(3)
    expect(maxSlotLevel('full', 11)).toBe(6)
    expect(maxSlotLevel('full', 17)).toBe(9)
    expect(maxSlotLevel('full', 20)).toBe(9)
  })
  it('half caster ceiling, including the slot-less level 1', () => {
    expect(maxSlotLevel('half', 1)).toBe(0)
    expect(maxSlotLevel('half', 2)).toBe(1)
    expect(maxSlotLevel('half', 20)).toBe(5)
  })
  it('third caster ceiling, including the slot-less levels 1–2', () => {
    expect(maxSlotLevel('third', 2)).toBe(0)
    expect(maxSlotLevel('third', 3)).toBe(1)
    expect(maxSlotLevel('third', 20)).toBe(4)
  })
  it('pact ceiling is the single pact-slot level', () => {
    expect(maxSlotLevel('pact', 1)).toBe(1)
    expect(maxSlotLevel('pact', 5)).toBe(3)
    expect(maxSlotLevel('pact', 20)).toBe(5)
  })
  it('none is always 0', () => {
    expect(maxSlotLevel('none', 1)).toBe(0)
    expect(maxSlotLevel('none', 20)).toBe(0)
  })
  it('out-of-range level throws', () => {
    expect(() => maxSlotLevel('full', 0)).toThrow()
    expect(() => maxSlotLevel('full', 21)).toThrow()
  })
})
