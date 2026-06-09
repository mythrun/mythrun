import { describe, expect, it } from 'vitest'
import {
  calculateModifier,
  resolveRollType,
  rollD20WithType,
  rollDice,
  proficiencyBonusByLevel,
} from '../engine.js'

/** Deterministic RNG: pops values off a script. */
const scripted = (...vals: number[]) => {
  let i = 0
  return (_min: number, _maxExclusive: number): number => {
    const v = vals[i]
    i += 1
    if (v === undefined) throw new Error('scripted RNG exhausted')
    return v
  }
}

describe('calculateModifier', () => {
  it.each([
    [1, -5], [8, -1], [10, 0], [11, 0], [15, 2], [20, 5],
  ])('score %i → %i', (score, mod) => {
    expect(calculateModifier(score)).toBe(mod)
  })
})

describe('resolveRollType (5e RAW: any adv + any dis cancel)', () => {
  it('cancels to normal when both flags set', () => {
    expect(resolveRollType(true, true)).toBe('normal')
  })
  it('advantage alone', () => { expect(resolveRollType(true, false)).toBe('advantage') })
  it('disadvantage alone', () => { expect(resolveRollType(false, true)).toBe('disadvantage') })
  it('neither → normal', () => { expect(resolveRollType(false, false)).toBe('normal') })
})

describe('rollD20WithType', () => {
  it('normal: one die, kept as-is', () => {
    expect(rollD20WithType('normal', scripted(14))).toEqual({
      roll: 14, roll2: null, keptRoll: 14, rollType: 'normal',
    })
  })
  it('advantage keeps the higher', () => {
    expect(rollD20WithType('advantage', scripted(6, 17)).keptRoll).toBe(17)
  })
  it('disadvantage keeps the lower', () => {
    expect(rollD20WithType('disadvantage', scripted(6, 17)).keptRoll).toBe(6)
  })
  it('real RNG stays in 1..20', () => {
    const r = rollD20WithType('normal')
    expect(r.roll).toBeGreaterThanOrEqual(1)
    expect(r.roll).toBeLessThanOrEqual(20)
  })
})

describe('rollDice', () => {
  it('returns count results + total', () => {
    expect(rollDice(3, 6, scripted(2, 4, 6))).toEqual({ results: [2, 4, 6], total: 12 })
  })
  it('throws on out-of-bound count (worker-stall guard)', () => {
    expect(() => rollDice(0, 6)).toThrow()
    expect(() => rollDice(101, 6)).toThrow()
  })
  it('throws on a non-standard die', () => {
    expect(() => rollDice(1, 7)).toThrow()
  })
})

describe('proficiencyBonusByLevel', () => {
  it.each([[1, 2], [4, 2], [5, 3], [9, 4], [13, 5], [17, 6], [20, 6]])(
    'level %i → +%i', (level, pb) => { expect(proficiencyBonusByLevel(level)).toBe(pb) },
  )
  it('throws outside 1-20', () => {
    expect(() => proficiencyBonusByLevel(0)).toThrow()
    expect(() => proficiencyBonusByLevel(21)).toThrow()
  })
})
