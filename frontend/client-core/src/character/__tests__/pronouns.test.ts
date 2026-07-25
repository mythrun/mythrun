import { describe, expect, it } from 'vitest'
import {
  PRONOUN_CHOICES,
  DEFAULT_PRONOUN_CHOICE,
  toPronounChoice,
  pronounsPick,
} from '../pronouns.ts'

// myth-gdycq — the pronoun ask's brain half. The load-bearing behaviour is the
// asymmetry between the UI's five options and the wire's four: the default is a
// real, selectable answer that sends NOTHING, because its absence is what tells
// the chargen prompt to read the description (and fall back to they/them)
// instead of taking a pin.

describe('PRONOUN_CHOICES', () => {
  it('offers the default first, then the four committing answers', () => {
    expect(PRONOUN_CHOICES).toEqual(['unset', 'she_her', 'he_him', 'they_them', 'name_only'])
    expect(PRONOUN_CHOICES[0]).toBe(DEFAULT_PRONOUN_CHOICE)
  })
})

describe('toPronounChoice', () => {
  it('passes through every known choice', () => {
    for (const choice of PRONOUN_CHOICES) {
      expect(toPronounChoice(choice)).toBe(choice)
    }
  })

  it('falls back to the default for an absent or foreign value', () => {
    // A restored draft written by an older build, or a hand-edited store.
    expect(toPronounChoice(undefined)).toBe('unset')
    expect(toPronounChoice('')).toBe('unset')
    expect(toPronounChoice('he/him')).toBe('unset')
  })
})

describe('pronounsPick', () => {
  it('contributes nothing for the default', () => {
    // Present-only field: `{}`, never `{ pronouns: undefined }` — the create
    // route drops an empty payload rather than sending a hollow one.
    expect(pronounsPick('unset')).toEqual({})
    expect('pronouns' in pronounsPick('unset')).toBe(false)
  })

  it('carries the token for every committing choice', () => {
    expect(pronounsPick('she_her')).toEqual({ pronouns: 'she_her' })
    expect(pronounsPick('he_him')).toEqual({ pronouns: 'he_him' })
    expect(pronounsPick('they_them')).toEqual({ pronouns: 'they_them' })
    expect(pronounsPick('name_only')).toEqual({ pronouns: 'name_only' })
  })
})
