import { describe, it, expect } from 'vitest'
import {
  initialGuidedState,
  guidedReducer,
  guidedRail,
  guidedChoice,
  type GuidedState,
} from '../index.ts'

// The guided builder's pure reducer: it advances Class → (Subclass) → Species →
// Background → Notes, SKIPPING the Subclass step when the class does not gain a
// subclass at the party's starting level, supports back (respecting the skip), and
// exposes the accumulated GuidedChoice + the progress rail as selectors.

describe('guidedReducer — advance + subclass skip', () => {
  it('advances class → species → background → notes, SKIPPING subclass for fighter at level 1', () => {
    let s = initialGuidedState(1)
    expect(s.step).toBe('class')
    s = guidedReducer(s, { type: 'choose', value: 'fighter' })
    expect(s.step).toBe('species') // subclass skipped (fighter gains it at 3)
    s = guidedReducer(s, { type: 'choose', value: 'Human' })
    expect(s.step).toBe('background')
    s = guidedReducer(s, { type: 'choose', value: 'Soldier' })
    expect(s.step).toBe('notes')
    s = guidedReducer(s, { type: 'choose', value: 'stoic' })
    expect(s.complete).toBe(true)
    expect(guidedChoice(s)).toEqual({
      className: 'fighter',
      species: 'Human',
      background: 'Soldier',
      notes: 'stoic',
    })
  })

  it('includes the subclass step for a class that gains it at the party level (cleric L1)', () => {
    let s = initialGuidedState(1)
    s = guidedReducer(s, { type: 'choose', value: 'cleric' })
    expect(s.step).toBe('subclass')
    s = guidedReducer(s, { type: 'choose', value: 'Life Domain' })
    expect(s.step).toBe('species')
    expect(guidedChoice(s)).toBeNull() // still incomplete
  })

  it('offers the subclass step once a fighter reaches level 3', () => {
    let s = initialGuidedState(3)
    s = guidedReducer(s, { type: 'choose', value: 'fighter' })
    expect(s.step).toBe('subclass')
  })

  it('ignores an invalid class id (defensive no-op at the class step)', () => {
    const s = initialGuidedState(1)
    expect(guidedReducer(s, { type: 'choose', value: 'not-a-class' })).toEqual(s)
  })
})

describe('guidedReducer — back', () => {
  it('steps back over the skipped subclass step (fighter L1: species → class)', () => {
    let s = initialGuidedState(1)
    s = guidedReducer(s, { type: 'choose', value: 'fighter' }) // → species
    s = guidedReducer(s, { type: 'back' }) // → class (skips subclass)
    expect(s.step).toBe('class')
  })

  it('steps back through the subclass step for cleric', () => {
    let s = initialGuidedState(1)
    s = guidedReducer(s, { type: 'choose', value: 'cleric' }) // → subclass
    s = guidedReducer(s, { type: 'choose', value: 'Life Domain' }) // → species
    s = guidedReducer(s, { type: 'back' }) // → subclass
    expect(s.step).toBe('subclass')
  })

  it('is a no-op at the first step', () => {
    const s = initialGuidedState(1)
    expect(guidedReducer(s, { type: 'back' })).toEqual(s)
  })

  it('returns to the last real step from a completed flow', () => {
    let s = initialGuidedState(1)
    s = guidedReducer(s, { type: 'choose', value: 'fighter' })
    s = guidedReducer(s, { type: 'choose', value: 'Human' })
    s = guidedReducer(s, { type: 'choose', value: 'Soldier' })
    s = guidedReducer(s, { type: 'choose', value: 'stoic' })
    expect(s.complete).toBe(true)
    s = guidedReducer(s, { type: 'back' })
    expect(s.step).toBe('background')
    expect(s.complete).toBe(false)
  })
})

describe('guidedRail', () => {
  it('shows all steps at the start with the class step active and no chosen values', () => {
    const rail = guidedRail(initialGuidedState(1))
    expect(rail.map((r) => r.step)).toEqual(['class', 'species', 'background', 'notes'])
    expect(rail[0]).toEqual({ step: 'class', label: 'Class', state: 'now' })
    expect(rail.slice(1).every((r) => r.state === 'todo')).toBe(true)
  })

  it('marks earlier steps done (with the canonical chosen label), the cursor now, later todo', () => {
    let s = initialGuidedState(1)
    s = guidedReducer(s, { type: 'choose', value: 'fighter' }) // at species
    const rail = guidedRail(s)
    expect(rail[0]).toEqual({ step: 'class', label: 'Class', chosen: 'Fighter', state: 'done' })
    expect(rail[1]?.state).toBe('now')
    expect(rail[1]?.chosen).toBeUndefined()
    expect(rail[2]?.state).toBe('todo')
  })

  it('includes a subclass rung for a subclass-granting class', () => {
    let s = initialGuidedState(1)
    s = guidedReducer(s, { type: 'choose', value: 'cleric' })
    expect(guidedRail(s).map((r) => r.step)).toEqual([
      'class',
      'subclass',
      'species',
      'background',
      'notes',
    ])
  })

  it('marks every rung done when the flow is complete', () => {
    let s = initialGuidedState(1)
    s = guidedReducer(s, { type: 'choose', value: 'fighter' })
    s = guidedReducer(s, { type: 'choose', value: 'Human' })
    s = guidedReducer(s, { type: 'choose', value: 'Soldier' })
    s = guidedReducer(s, { type: 'choose', value: 'stoic' })
    expect(guidedRail(s).every((r) => r.state === 'done')).toBe(true)
  })
})

describe('guidedChoice', () => {
  it('returns null until class, species, and background are all chosen', () => {
    let s = initialGuidedState(1)
    expect(guidedChoice(s)).toBeNull()
    s = guidedReducer(s, { type: 'choose', value: 'fighter' })
    expect(guidedChoice(s)).toBeNull()
  })

  it('drops a stale subclass when the chosen class does not offer one at this level', () => {
    const s: GuidedState = {
      level: 1,
      step: 'notes',
      complete: false,
      choice: { className: 'fighter', subclass: 'Champion', species: 'Human', background: 'Soldier' },
    }
    expect(guidedChoice(s)).toEqual({
      className: 'fighter',
      species: 'Human',
      background: 'Soldier',
    })
  })

  it('keeps the subclass when the class offers it at this level', () => {
    const s: GuidedState = {
      level: 1,
      step: 'notes',
      complete: false,
      choice: {
        className: 'cleric',
        subclass: 'Life Domain',
        species: 'Dwarf',
        background: 'Acolyte',
      },
    }
    expect(guidedChoice(s)).toEqual({
      className: 'cleric',
      subclass: 'Life Domain',
      species: 'Dwarf',
      background: 'Acolyte',
    })
  })
})
