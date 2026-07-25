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

  // ux-run2 myth-wbd89: the spell list is grouped by level as prose ("Level 1 ·
  // names…"), one line per level — a reveal, not a receipt of per-spell rows.
  it('groups spells by level as label·value prose lines', () => {
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
      { name: 'Cantrips', gloss: 'Fire Bolt' },
      { name: 'Level 1', gloss: 'Magic Missile' },
    ])
    expect(full.spells).toEqual(curated.spells)
  })

  it('orders the level groups ascending and joins names with a middot, preserving in-level order', () => {
    const { curated } = sheetViewModel(
      baseSheet({
        class: 'Cleric',
        spells: [
          { name: 'Cure Wounds', level: 1 },
          { name: 'Hold Person', level: 2 },
          { name: 'Guidance', level: 0 },
          { name: 'Detect Magic', level: 1 },
        ],
      }),
    )
    expect(curated.spells).toEqual([
      { name: 'Cantrips', gloss: 'Guidance' },
      { name: 'Level 1', gloss: 'Cure Wounds · Detect Magic' },
      { name: 'Level 2', gloss: 'Hold Person' },
    ])
  })
})

describe('sheetViewModel — stats stripe + full sheet', () => {
  it('always shows AC/HP/Proficiency and adds Hit Die + Speed when present', () => {
    const { curated } = sheetViewModel(baseSheet({ hitDie: 8, speed: 30 }))
    expect(curated.stats).toEqual([
      { label: 'AC', value: '14' },
      { label: 'HP', value: '21' },
      { label: 'Proficiency', value: '+2' },
      { label: 'Hit Die', value: 'd8' },
      { label: 'Speed', value: '30 ft' },
    ])
  })

  it('omits Hit Die and Speed when absent', () => {
    const { curated } = sheetViewModel(baseSheet())
    expect(curated.stats.map((s) => s.label)).toEqual(['AC', 'HP', 'Proficiency'])
  })

  // ux-run2 myth-8ps4n: current-slash-max is mid-combat state — at full health
  // the HP cell reads as the single number; the slash appears once damage exists.
  it('shows current / max HP only once damaged', () => {
    const damaged = sheetViewModel(baseSheet({ hitPoints: 13 }))
    expect(damaged.curated.stats.find((s) => s.label === 'HP')?.value).toBe('13 / 21')
    const rested = sheetViewModel(baseSheet())
    expect(rested.curated.stats.find((s) => s.label === 'HP')?.value).toBe('21')
  })

  // ux-run2 myth-8ps4n: the caster's spellcasting ability is marked on its tile
  // — nothing else tells a newcomer WHY their spells work. Gated on the sheet
  // actually carrying spells; a martial (or unresolvable class) shows no mark.
  it('marks the casting ability tile for a caster with spells, and never otherwise', () => {
    const caster = sheetViewModel(
      baseSheet({ class: 'Cleric', spells: [{ name: 'Cure Wounds', level: 1 }] }),
    )
    const marked = caster.curated.abilities.filter((tile) => tile.casting === true)
    expect(marked.map((tile) => tile.abbrev)).toEqual(['WIS'])
    // The same class WITHOUT spells (nothing prepared yet) shows no mark…
    const spellless = sheetViewModel(baseSheet({ class: 'Cleric' }))
    expect(spellless.curated.abilities.some((tile) => tile.casting === true)).toBe(false)
    // …and a martial never does.
    const martial = sheetViewModel(baseSheet({ class: 'Fighter' }))
    expect(martial.curated.abilities.some((tile) => tile.casting === true)).toBe(false)
    // A class with no casting ability keeps no mark even WITH spells attached
    // (freeform drift), and an unresolvable freeform class degrades the same way.
    const oddMartial = sheetViewModel(
      baseSheet({ class: 'Fighter', spells: [{ name: 'Cure Wounds', level: 1 }] }),
    )
    expect(oddMartial.curated.abilities.some((tile) => tile.casting === true)).toBe(false)
    const freeform = sheetViewModel(
      baseSheet({ class: 'Gloom Warden', spells: [{ name: 'Cure Wounds', level: 1 }] }),
    )
    expect(freeform.curated.abilities.some((tile) => tile.casting === true)).toBe(false)
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
