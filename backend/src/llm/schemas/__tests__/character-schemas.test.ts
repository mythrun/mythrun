// Note: the MYT-53 single-PC `CharacterIntegrationOutputSchema` was removed
// in MYT-54 T7. The whole-party `IntegrationResultSchema` is exercised in
// its own test file: `character-integration.test.ts`.

import { describe, expect, it } from 'vitest'
import { CharacterConceptOutputSchema } from '../character-concept.js'
import { CharacterSheetOutputSchema } from '../character-sheet.js'

const validConcept = {
  name: 'Bran of the Hollow',
  race: 'human',
  class: 'cleric',
  background: 'acolyte',
  level: 1,
  alignment: 'lawful neutral',
  age: 27,
  gender: 'man',
  physical_description:
    'A tall man, weather-worn from years on the road, with a shaved scalp and a faded sept-mark on the back of his left hand.',
  personality_traits: [
    'speaks in measured tones',
    'pauses before answering, as if listening to something else first',
  ],
  ideals: ['order serves the weak'],
  bonds: ['the temple that raised him'],
  flaws: ['quick to suspect deception'],
  backstory:
    'Bran was apprenticed at the Bone Sept in his twelfth year, when the priests took him in after a winter on the moors orphaned him. Twenty years later, when the Sept burned, he walked out with a tin ladle and a name he was no longer sure was his. He has been on the road since, doing temple work for coin, telling himself he is still a cleric of the Hollow, listening for the small voice that used to answer him at the altar.',
}

describe('CharacterConceptOutputSchema', () => {
  it('accepts a valid concept', () => {
    expect(CharacterConceptOutputSchema.safeParse(validConcept).success).toBe(true)
  })
  it('rejects a name shorter than 2 chars', () => {
    expect(
      CharacterConceptOutputSchema.safeParse({ ...validConcept, name: 'B' }).success,
    ).toBe(false)
  })
  it('rejects a backstory shorter than 300 chars', () => {
    expect(
      CharacterConceptOutputSchema.safeParse({ ...validConcept, backstory: 'short' }).success,
    ).toBe(false)
  })
  it('rejects an empty personality_traits array', () => {
    expect(
      CharacterConceptOutputSchema.safeParse({ ...validConcept, personality_traits: [] }).success,
    ).toBe(false)
  })
  it('rejects personality_traits with more than 4 entries', () => {
    expect(
      CharacterConceptOutputSchema.safeParse({
        ...validConcept,
        personality_traits: ['a', 'b', 'c', 'd', 'e'].map((s) => `${s} trait that is long enough`),
      }).success,
    ).toBe(false)
  })
  it('accepts a backstory far longer than the old 2000-char cap (min-only — no max on LLM prose; myth-vimk)', () => {
    expect(
      CharacterConceptOutputSchema.safeParse({ ...validConcept, backstory: 'x'.repeat(4000) })
        .success,
    ).toBe(true)
  })
})

const validSheet = {
  str: 12,
  dex: 10,
  con: 14,
  int: 13,
  wis: 16,
  cha: 11,
  hit_points: 9,
  max_hit_points: 9,
  armor_class: 14,
  proficiency_bonus: 2,
  starting_gold: 15,
  hit_die: 8,
  spellcasting_progression: 'full',
  skills: [{ name: 'Insight', proficient: true, expertise: false }],
  features: [
    {
      name: 'Second Wind',
      description: 'recover hit points as a bonus action',
      max_uses: 1,
      recharge: 'short_rest',
    },
  ],
  equipment: [{ name: 'Mace', quantity: 1, consumable: false }],
  spells: [{ name: 'Cure Wounds', level: 1, prepared: true, ritual: false }],
}

describe('CharacterSheetOutputSchema', () => {
  it('accepts a valid sheet', () => {
    expect(CharacterSheetOutputSchema.safeParse(validSheet).success).toBe(true)
  })
  it('rejects ability score above 20', () => {
    expect(CharacterSheetOutputSchema.safeParse({ ...validSheet, str: 30 }).success).toBe(false)
  })
  it('rejects negative hit points', () => {
    expect(
      CharacterSheetOutputSchema.safeParse({ ...validSheet, hit_points: -1 }).success,
    ).toBe(false)
  })
  it('rejects empty skills array', () => {
    expect(CharacterSheetOutputSchema.safeParse({ ...validSheet, skills: [] }).success).toBe(false)
  })

  // --- MYT-70 §3.2: prep emits ledger structure ---
  it('rejects negative starting_gold', () => {
    expect(
      CharacterSheetOutputSchema.safeParse({ ...validSheet, starting_gold: -1 }).success,
    ).toBe(false)
  })
  it('rejects starting_gold above 500', () => {
    expect(
      CharacterSheetOutputSchema.safeParse({ ...validSheet, starting_gold: 501 }).success,
    ).toBe(false)
  })
  it('rejects a non-SRD hit_die (7)', () => {
    expect(CharacterSheetOutputSchema.safeParse({ ...validSheet, hit_die: 7 }).success).toBe(false)
  })
  it('rejects an unknown spellcasting_progression', () => {
    expect(
      CharacterSheetOutputSchema.safeParse({ ...validSheet, spellcasting_progression: 'arcane' })
        .success,
    ).toBe(false)
  })
  it('accepts spellcasting_progression "pact"', () => {
    expect(
      CharacterSheetOutputSchema.safeParse({ ...validSheet, spellcasting_progression: 'pact' })
        .success,
    ).toBe(true)
  })
  it('rejects a feature with max_uses of 0', () => {
    expect(
      CharacterSheetOutputSchema.safeParse({
        ...validSheet,
        features: [
          { name: 'Second Wind', description: 'd10 heal', max_uses: 0, recharge: 'short_rest' },
        ],
      }).success,
    ).toBe(false)
  })
  it('rejects a feature with an unknown recharge', () => {
    expect(
      CharacterSheetOutputSchema.safeParse({
        ...validSheet,
        features: [
          { name: 'Second Wind', description: 'd10 heal', max_uses: 1, recharge: 'daily' },
        ],
      }).success,
    ).toBe(false)
  })
  it('accepts an unlimited feature (max_uses null, recharge none)', () => {
    expect(
      CharacterSheetOutputSchema.safeParse({
        ...validSheet,
        features: [
          { name: 'Darkvision', description: 'see in the dark', max_uses: null, recharge: 'none' },
        ],
      }).success,
    ).toBe(true)
  })
  it('rejects equipment missing the consumable flag', () => {
    expect(
      CharacterSheetOutputSchema.safeParse({
        ...validSheet,
        equipment: [{ name: 'Mace', quantity: 1 }],
      }).success,
    ).toBe(false)
  })
  it('rejects a spell missing the ritual flag', () => {
    expect(
      CharacterSheetOutputSchema.safeParse({
        ...validSheet,
        spells: [{ name: 'Cure Wounds', level: 1, prepared: true }],
      }).success,
    ).toBe(false)
  })
})

