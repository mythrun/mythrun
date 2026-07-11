import { describe, it, expect } from 'vitest'
import { sheetViewModel, type CharacterSheetSource } from '../index.ts'

// sheetViewModel maps the normalized backend character-sheet into the curated
// field-guide view + the full mechanical view: ability tiles with computed
// modifiers, the AC/HP/Proficiency/Hit-Die/Speed stripe, the caster-only spells
// panel, and the "Level N · <species> <class> · <subclass> · <background>" line.

function baseSheet(overrides: Partial<CharacterSheetSource> = {}): CharacterSheetSource {
  return {
    name: 'Bramble',
    level: 3,
    species: 'Halfling',
    class: 'Rogue',
    background: 'Criminal',
    abilities: { str: 8, dex: 17, con: 12, int: 13, wis: 10, cha: 15 },
    armorClass: 14,
    hitPoints: 21,
    maxHitPoints: 21,
    proficiencyBonus: 2,
    prose: ['A quiet cutpurse with a conscience.'],
    features: [{ name: 'Sneak Attack', gloss: '2d6' }],
    equipment: [{ name: 'Dagger', gloss: '×2' }],
    spells: [],
    skills: [{ name: 'Stealth', proficient: true, expertise: true }],
    savingThrows: ['Dexterity', 'Intelligence'],
    ...overrides,
  }
}

describe('sheetViewModel — ability tiles', () => {
  it('computes modifiers as floor((score - 10) / 2)', () => {
    const { curated } = sheetViewModel(
      baseSheet({ abilities: { str: 8, dex: 17, con: 12, int: 13, wis: 10, cha: 20 } }),
    )
    expect(curated.abilities).toEqual([
      { abbrev: 'STR', score: 8, modifier: -1 },
      { abbrev: 'DEX', score: 17, modifier: 3 },
      { abbrev: 'CON', score: 12, modifier: 1 },
      { abbrev: 'INT', score: 13, modifier: 1 },
      { abbrev: 'WIS', score: 10, modifier: 0 },
      { abbrev: 'CHA', score: 20, modifier: 5 },
    ])
  })
})

describe('sheetViewModel — identity line', () => {
  it('reads "Level N · <species> <class> · <subclass> · <background>" with a subclass', () => {
    const { curated } = sheetViewModel(baseSheet({ subclass: 'Thief' }))
    expect(curated.identityLine).toBe('Level 3 · Halfling Rogue · Thief · Criminal')
  })

  it('omits the subclass segment when there is no subclass', () => {
    const { curated } = sheetViewModel(baseSheet({ level: 1 }))
    expect(curated.identityLine).toBe('Level 1 · Halfling Rogue · Criminal')
  })
})

describe('sheetViewModel — caster spells panel', () => {
  it('omits the curated spells panel for a non-caster and keeps full.spells empty', () => {
    const { curated, full } = sheetViewModel(baseSheet({ spells: [] }))
    expect(curated.spells).toBeUndefined()
    expect(full.spells).toEqual([])
  })

  it('includes the curated spells panel when the sheet has cantrip or leveled spells', () => {
    const { curated, full } = sheetViewModel(
      baseSheet({
        class: 'Wizard',
        spells: [
          { name: 'Fire Bolt', level: 0 },
          { name: 'Magic Missile', level: 1 },
        ],
      }),
    )
    expect(curated.spells).toEqual([
      { name: 'Fire Bolt', gloss: 'Cantrip' },
      { name: 'Magic Missile', gloss: 'Level 1' },
    ])
    expect(full.spells).toEqual(curated.spells)
  })
})

describe('sheetViewModel — stats stripe + full sheet', () => {
  it('always shows AC/HP/Proficiency and adds Hit Die + Speed when present', () => {
    const { curated } = sheetViewModel(baseSheet({ hitDie: 8, speed: 30 }))
    expect(curated.stats).toEqual([
      { label: 'AC', value: '14' },
      { label: 'HP', value: '21 / 21' },
      { label: 'Proficiency', value: '+2' },
      { label: 'Hit Die', value: 'd8' },
      { label: 'Speed', value: '30 ft' },
    ])
  })

  it('omits Hit Die and Speed when absent', () => {
    const { curated } = sheetViewModel(baseSheet())
    expect(curated.stats.map((s) => s.label)).toEqual(['AC', 'HP', 'Proficiency'])
  })

  it('carries skills, saving throws, and equipment onto the full sheet', () => {
    const { full } = sheetViewModel(baseSheet())
    expect(full.skills).toEqual([{ name: 'Stealth', proficient: true, expertise: true }])
    expect(full.savingThrows).toEqual(['Dexterity', 'Intelligence'])
    expect(full.equipment).toEqual([{ name: 'Dagger', gloss: '×2' }])
  })

  it('carries prose and features onto the curated sheet', () => {
    const { curated } = sheetViewModel(baseSheet())
    expect(curated.prose).toEqual(['A quiet cutpurse with a conscience.'])
    expect(curated.features).toEqual([{ name: 'Sneak Attack', gloss: '2d6' }])
  })
})
