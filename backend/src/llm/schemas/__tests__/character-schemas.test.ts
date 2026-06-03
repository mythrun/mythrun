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
  skills: [{ name: 'Insight', proficient: true, expertise: false }],
  features: [{ name: 'Divine Domain: Life', description: 'extra healing' }],
  equipment: [{ name: 'Mace', quantity: 1 }],
  spells: [{ name: 'Cure Wounds', level: 1, prepared: true }],
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
})

