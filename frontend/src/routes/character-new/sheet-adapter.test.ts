import { describe, it, expect } from 'vitest'
import type { CharacterFull } from '@mythrun/client-core'
import { toCharacterSheetSource, toRevealViewModel } from './sheet-adapter.ts'

// The RAW getCharacter → reveal view-model adapter (MYT-90 D6). These tests pin the
// deterministic derivations the adapter owns: ability modifiers by formula, the AC /
// HP / Proficiency / Hit Die / Speed(30) stripe, the identity line (with a graceful
// subclass OMIT — the raw shape carries no structured subclass, and the free `class`
// string is NEVER split, per ZFC), caster-only spells, the CLASS_SAVES-driven saving
// throws, and the skills / features / equipment reshape.

const BASE_CHARACTER: CharacterFull['character'] = {
  id: 'char-1',
  user_id: 'u1',
  entity_id: null,
  name: 'Kessa Vurm',
  level: 3,
  class: 'Fighter',
  species: 'Human',
  background: 'Toll-clerk of Greenward',
  str: 16,
  dex: 13,
  con: 15,
  int: 12,
  wis: 11,
  cha: 9,
  hit_points: 28,
  max_hit_points: 28,
  armor_class: 16,
  proficiency_bonus: 2,
  gold: 9,
  hit_die: 10,
  hit_dice_remaining: 3,
  spellcasting_progression: 'none',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

const DEFAULT_SKILLS: CharacterFull['skills'] = [
  { skill_name: 'Athletics', proficiency_level: 'proficient' },
  { skill_name: 'Intimidation', proficiency_level: 'expertise' },
  { skill_name: 'Arcana', proficiency_level: 'none' },
]

const DEFAULT_FEATURES: CharacterFull['features'] = [
  { feature_name: 'Second Wind', feature_source: 'Fighter', description: 'Recover a burst of HP once per rest.' },
]

const DEFAULT_EQUIPMENT: CharacterFull['equipment'] = [
  { item_name: 'Longsword', quantity: 1, equipped: true },
  { item_name: 'Javelin', quantity: 4, equipped: false },
]

const CASTER_SPELLS: CharacterFull['spells'] = [
  { spell_name: 'Fire Bolt', spell_level: 0, prepared: true },
  { spell_name: 'Magic Missile', spell_level: 1, prepared: true },
]

const DEFAULT_CONCEPT: NonNullable<CharacterFull['concept']> = {
  physical_description: 'A broad-shouldered woman with a toll-clerk’s ledger scars on her knuckles.',
  personality_traits: ['I count coins the way others count breaths.'],
  ideals: ['A debt is a debt, whoever owes it.'],
  bonds: ['Greenward fed me when no one else would.'],
  flaws: ['I cannot walk past an unbalanced tally.'],
  situation_grounding_text: 'I came to the tavern to collect a toll I was never paid.',
}

function makeRaw(over: {
  character?: Partial<CharacterFull['character']>
  skills?: CharacterFull['skills']
  features?: CharacterFull['features']
  equipment?: CharacterFull['equipment']
  spells?: CharacterFull['spells']
  concept?: CharacterFull['concept']
} = {}): CharacterFull {
  return {
    character: { ...BASE_CHARACTER, ...over.character },
    skills: over.skills ?? DEFAULT_SKILLS,
    features: over.features ?? DEFAULT_FEATURES,
    equipment: over.equipment ?? DEFAULT_EQUIPMENT,
    spells: over.spells ?? [],
    concept: over.concept,
  }
}

describe('toRevealViewModel — the curated field-guide view', () => {
  it('derives signed ability modifiers by floor((score − 10) / 2)', () => {
    const { curated } = toRevealViewModel(makeRaw())
    expect(curated.abilities).toEqual([
      { abbrev: 'STR', score: 16, modifier: 3 },
      { abbrev: 'DEX', score: 13, modifier: 1 },
      { abbrev: 'CON', score: 15, modifier: 2 },
      { abbrev: 'INT', score: 12, modifier: 1 },
      { abbrev: 'WIS', score: 11, modifier: 0 },
      { abbrev: 'CHA', score: 9, modifier: -1 },
    ])
  })

  it('builds the AC / HP / Proficiency / Hit Die / Speed(30) stat stripe', () => {
    const { curated } = toRevealViewModel(makeRaw())
    expect(curated.stats).toEqual([
      { label: 'AC', value: '16' },
      { label: 'HP', value: '28 / 28' },
      { label: 'Proficiency', value: '+2' },
      { label: 'Hit Die', value: 'd10' },
      { label: 'Speed', value: '30 ft' },
    ])
  })

  it('builds the identity line and OMITS the subclass (no structured field)', () => {
    const { curated } = toRevealViewModel(makeRaw())
    expect(curated.identityLine).toBe('Level 3 · Human Fighter · Toll-clerk of Greenward')
  })

  it('NEVER splits a subclass out of the free class string (ZFC) — it passes through verbatim', () => {
    const { curated } = toRevealViewModel(makeRaw({ character: { class: 'Fighter (Champion)' } }))
    expect(curated.identityLine).toBe('Level 3 · Human Fighter (Champion) · Toll-clerk of Greenward')
  })

  it('shows NO curated spell panel for a non-caster (empty spells)', () => {
    const { curated } = toRevealViewModel(makeRaw())
    expect(curated.spells).toBeUndefined()
  })

  it('shows the curated spell panel with derived slot glosses for a caster', () => {
    const { curated } = toRevealViewModel(
      makeRaw({ character: { class: 'Wizard', int: 17 }, spells: CASTER_SPELLS }),
    )
    expect(curated.spells).toEqual([
      { name: 'Fire Bolt', gloss: 'Cantrip' },
      { name: 'Magic Missile', gloss: 'Level 1' },
    ])
  })

  it('reshapes features (name + description gloss) and equipment (stack count gloss)', () => {
    const { curated } = toRevealViewModel(makeRaw())
    expect(curated.features).toEqual([
      { name: 'Second Wind', gloss: 'Recover a burst of HP once per rest.' },
    ])
    expect(curated.equipment).toEqual([{ name: 'Longsword' }, { name: 'Javelin', gloss: '×4' }])
  })
})

describe('toRevealViewModel — the expanded mechanical view', () => {
  it('adds the proficiency bonus to the class\'s two proficient saves (fighter: STR, CON)', () => {
    const { full } = toRevealViewModel(makeRaw())
    expect(full.savingThrows).toEqual([
      'Strength +5', // 16 → +3, +2 prof
      'Dexterity +1', // 13 → +1
      'Constitution +4', // 15 → +2, +2 prof
      'Intelligence +1', // 12 → +1
      'Wisdom +0', // 11 → +0
      'Charisma −1', // 9 → −1 (typographic minus)
    ])
  })

  it('proficiency follows the class (wizard: INT, WIS) — case-insensitive class match', () => {
    const { full } = toRevealViewModel(
      makeRaw({ character: { class: 'wizard', int: 17 }, spells: CASTER_SPELLS }),
    )
    expect(full.savingThrows).toEqual([
      'Strength +3', // 16 → +3
      'Dexterity +1', // 13 → +1
      'Constitution +2', // 15 → +2
      'Intelligence +5', // 17 → +3, +2 prof
      'Wisdom +2', // 11 → +0, +2 prof
      'Charisma −1', // 9 → −1
    ])
  })

  it('gives an unrecognized class no proficient saves (graceful bare modifiers)', () => {
    const { full } = toRevealViewModel(makeRaw({ character: { class: 'Fighter (Champion)' } }))
    expect(full.savingThrows).toEqual([
      'Strength +3',
      'Dexterity +1',
      'Constitution +2',
      'Intelligence +1',
      'Wisdom +0',
      'Charisma −1',
    ])
  })

  it('maps skill proficiency tiers (expertise implies proficient)', () => {
    const { full } = toRevealViewModel(makeRaw())
    expect(full.skills).toEqual([
      { name: 'Athletics', proficient: true, expertise: false },
      { name: 'Intimidation', proficient: true, expertise: true },
      { name: 'Arcana', proficient: false, expertise: false },
    ])
  })
})

describe('toCharacterSheetSource', () => {
  it('emits empty prose when the character has no concept narrative (and omits the subclass)', () => {
    const source = toCharacterSheetSource(makeRaw())
    expect(source.prose).toEqual([])
    expect(source.subclass).toBeUndefined()
    expect(source.speed).toBe(30)
  })

  it('composes the concept prose: physical description + a connection paragraph (personality + grounding)', () => {
    const source = toCharacterSheetSource(makeRaw({ concept: DEFAULT_CONCEPT }))
    expect(source.prose).toEqual([
      'A broad-shouldered woman with a toll-clerk’s ledger scars on her knuckles.',
      'I count coins the way others count breaths. A debt is a debt, whoever owes it. ' +
        'Greenward fed me when no one else would. I cannot walk past an unbalanced tally. ' +
        'I came to the tavern to collect a toll I was never paid.',
    ])
  })

  it('drops an empty physical description but still emits the connection paragraph', () => {
    const source = toCharacterSheetSource(
      makeRaw({ concept: { ...DEFAULT_CONCEPT, physical_description: '  ' } }),
    )
    expect(source.prose).toEqual([
      'I count coins the way others count breaths. A debt is a debt, whoever owes it. ' +
        'Greenward fed me when no one else would. I cannot walk past an unbalanced tally. ' +
        'I came to the tavern to collect a toll I was never paid.',
    ])
  })

  it('tolerates a null physical description (concept_output not yet populated)', () => {
    const source = toCharacterSheetSource(
      makeRaw({ concept: { ...DEFAULT_CONCEPT, physical_description: null } }),
    )
    expect(source.prose).toEqual([
      'I count coins the way others count breaths. A debt is a debt, whoever owes it. ' +
        'Greenward fed me when no one else would. I cannot walk past an unbalanced tally. ' +
        'I came to the tavern to collect a toll I was never paid.',
    ])
  })

  it('emits only the physical description when the concept has no personality or grounding', () => {
    const source = toCharacterSheetSource(
      makeRaw({
        concept: {
          physical_description: 'A slight figure in a rain-dark cloak.',
          personality_traits: [],
          ideals: [],
          bonds: [],
          flaws: [],
          situation_grounding_text: '   ',
        },
      }),
    )
    expect(source.prose).toEqual(['A slight figure in a rain-dark cloak.'])
  })

  it('surfaces the composed prose on the curated view the reveal renders', () => {
    const { curated } = toRevealViewModel(makeRaw({ concept: DEFAULT_CONCEPT }))
    expect(curated.prose.length).toBeGreaterThan(0)
    expect(curated.prose[0]).toContain('toll-clerk')
  })
})
