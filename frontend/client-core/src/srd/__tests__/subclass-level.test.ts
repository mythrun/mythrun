import { describe, it, expect } from 'vitest'
import { SUBCLASS_LEVEL, subclassOfferedAt, CLASSES } from '../index.ts'

// The subclass-at-level table is the ONE authority the guided character builder
// (MYT-90) consults to decide whether it shows a Subclass step at the party's
// starting level. It MUST agree with the backend's level-scaling assumptions
// (SRD 2014: subclass granted at L1 / L2 / L3 depending on class), so it is
// pinned here exactly rather than derived. Imported through the subpath barrel
// (`../index.ts`) so a barrel that drops a re-export also fails.
describe('SUBCLASS_LEVEL', () => {
  it('is the exact SRD 2014 subclass-grant level for each of the 12 classes', () => {
    expect(SUBCLASS_LEVEL).toEqual({
      cleric: 1,
      sorcerer: 1,
      warlock: 1,
      druid: 2,
      wizard: 2,
      barbarian: 3,
      bard: 3,
      fighter: 3,
      monk: 3,
      paladin: 3,
      ranger: 3,
      rogue: 3,
    })
  })

  it('covers exactly the 12 class ids in CLASSES', () => {
    expect(CLASSES).toHaveLength(12)
    expect(Object.keys(SUBCLASS_LEVEL).sort()).toEqual([...CLASSES].sort())
  })
})

describe('subclassOfferedAt', () => {
  it('gates the Subclass step on the class-specific grant level', () => {
    expect(subclassOfferedAt('druid', 2)).toBe(true)
    expect(subclassOfferedAt('fighter', 2)).toBe(false)
    expect(subclassOfferedAt('cleric', 1)).toBe(true)
    expect(subclassOfferedAt('rogue', 3)).toBe(true)
  })

  it('is true exactly when the party level reaches the grant level (all 12 classes × L1..5)', () => {
    for (const className of CLASSES) {
      for (let level = 1; level <= 5; level += 1) {
        expect(subclassOfferedAt(className, level)).toBe(SUBCLASS_LEVEL[className] <= level)
      }
    }
  })
})
