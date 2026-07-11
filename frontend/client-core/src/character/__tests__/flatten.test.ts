import { describe, it, expect } from 'vitest'
import { flattenToConceptText } from '../index.ts'
import type { GuidedChoice } from '../../contract/index.ts'

// flattenToConceptText folds the guided picks into a well-formed English concept
// sentence for the backend LLM, using the CANONICAL English SRD class name (never
// localized display copy — client-core carries locale-independent LLM input).

describe('flattenToConceptText', () => {
  it('composes the full concept sentence using the canonical SRD class name', () => {
    const choice: GuidedChoice = {
      className: 'fighter',
      subclass: 'Champion',
      species: 'Human',
      background: 'Toll-clerk',
      notes: 'never stops counting',
    }
    expect(flattenToConceptText(choice, 3)).toBe(
      'I am a Fighter, a Champion. I am a Human with a Toll-clerk background. never stops counting',
    )
  })

  it('omits the subclass clause when subclassOfferedAt is false (fighter below level 3)', () => {
    const choice: GuidedChoice = {
      className: 'fighter',
      // present in the accumulated draft but NOT offered at level 1 — must not leak
      subclass: 'Champion',
      species: 'Elf',
      background: 'Sage',
    }
    expect(flattenToConceptText(choice, 1)).toBe('I am a Fighter. I am a Elf with a Sage background.')
  })

  it('includes the subclass clause for a class that gains it at level 1 (cleric)', () => {
    const choice: GuidedChoice = {
      className: 'cleric',
      subclass: 'Life Domain',
      species: 'Dwarf',
      background: 'Acolyte',
    }
    expect(flattenToConceptText(choice, 1)).toBe(
      'I am a Cleric, a Life Domain. I am a Dwarf with a Acolyte background.',
    )
  })

  it('omits the subclass clause when no subclass is chosen even if the level offers it', () => {
    const choice: GuidedChoice = {
      className: 'cleric',
      species: 'Gnome',
      background: 'Hermit',
    }
    expect(flattenToConceptText(choice, 3)).toBe('I am a Cleric. I am a Gnome with a Hermit background.')
  })

  it('appends notes only when present and non-empty', () => {
    const withEmpty: GuidedChoice = {
      className: 'rogue',
      species: 'Halfling',
      background: 'Criminal',
      notes: '',
    }
    expect(flattenToConceptText(withEmpty, 1)).toBe(
      'I am a Rogue. I am a Halfling with a Criminal background.',
    )
  })
})
