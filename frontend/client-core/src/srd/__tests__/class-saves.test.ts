import { describe, it, expect } from 'vitest'
import { CLASS_SAVES, CLASSES } from '../index.ts'

// CLASS_SAVES is the SRD 2014 saving-throw proficiency map the character-reveal's
// expanded sheet (MYT-90 D6) consults: each of the 12 classes is proficient in
// exactly TWO saving throws, and those two abilities get the proficiency bonus added
// to their save modifier. It MUST agree with the backend's mechanics, so it is
// pinned here exactly (not derived). Imported through the subpath barrel
// (`../index.ts`) so a barrel that drops the re-export also fails.
describe('CLASS_SAVES', () => {
  it('is the exact SRD 2014 saving-throw proficiency pair for each of the 12 classes', () => {
    expect(CLASS_SAVES).toEqual({
      barbarian: ['str', 'con'],
      bard: ['dex', 'cha'],
      cleric: ['wis', 'cha'],
      druid: ['int', 'wis'],
      fighter: ['str', 'con'],
      monk: ['str', 'dex'],
      paladin: ['wis', 'cha'],
      ranger: ['str', 'dex'],
      rogue: ['dex', 'int'],
      sorcerer: ['con', 'cha'],
      warlock: ['wis', 'cha'],
      wizard: ['int', 'wis'],
    })
  })

  it('covers exactly the 12 class ids in CLASSES', () => {
    expect(CLASSES).toHaveLength(12)
    expect(Object.keys(CLASS_SAVES).sort()).toEqual([...CLASSES].sort())
  })

  it('gives every class two DISTINCT proficiencies drawn from the six abilities', () => {
    const abilities = new Set(['str', 'dex', 'con', 'int', 'wis', 'cha'])
    for (const saves of Object.values(CLASS_SAVES)) {
      expect(saves).toHaveLength(2)
      expect(saves[0]).not.toBe(saves[1])
      for (const ability of saves) expect(abilities.has(ability)).toBe(true)
    }
  })
})
