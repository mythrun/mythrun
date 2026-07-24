import { describe, it, expect } from 'vitest'
import {
  initialGuidedState,
  guidedReducer,
  guidedRail,
  guidedChoice,
  hydrateGuidedState,
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
    expect(rail.map((r) => r.step)).toEqual([
      'class',
      'species',
      'background',
      'notes',
      'grounding',
    ])
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
      'grounding',
    ])
  })

  // The grounding rung (MYT-102): the screen AFTER the builder is a first-class
  // rung of the same journey — `todo` while the builder runs, `now` once the flow
  // completes and the route shows the grounding prompt. It is NOT a reducer step
  // (back/advance never land on it); only the rail models it.
  it('carries a final grounding rung — todo during the builder, with no chosen value', () => {
    const rail = guidedRail(initialGuidedState(1))
    expect(rail.at(-1)).toEqual({ step: 'grounding', label: 'Grounding', state: 'todo' })
  })

  it('marks every builder rung done and the grounding rung NOW when the flow is complete', () => {
    let s = initialGuidedState(1)
    s = guidedReducer(s, { type: 'choose', value: 'fighter' })
    s = guidedReducer(s, { type: 'choose', value: 'Human' })
    s = guidedReducer(s, { type: 'choose', value: 'Soldier' })
    s = guidedReducer(s, { type: 'choose', value: 'stoic' })
    const rail = guidedRail(s)
    expect(rail.slice(0, -1).every((r) => r.state === 'done')).toBe(true)
    expect(rail.at(-1)).toEqual({ step: 'grounding', label: 'Grounding', state: 'now' })
  })

  it('returns the grounding rung to todo when the player steps back out of completion', () => {
    let s = initialGuidedState(1)
    s = guidedReducer(s, { type: 'choose', value: 'fighter' })
    s = guidedReducer(s, { type: 'choose', value: 'Human' })
    s = guidedReducer(s, { type: 'choose', value: 'Soldier' })
    s = guidedReducer(s, { type: 'choose', value: 'stoic' })
    s = guidedReducer(s, { type: 'back' }) // complete → notes
    expect(guidedRail(s).at(-1)).toEqual({ step: 'grounding', label: 'Grounding', state: 'todo' })
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

describe('hydrateGuidedState — restore the reducer from a persisted draft', () => {
  it('returns the initial state for an undefined seed', () => {
    expect(hydrateGuidedState(1, undefined)).toEqual(initialGuidedState(1))
  })

  it('resumes on the first un-drafted step (only class drafted → species, subclass skipped at L1)', () => {
    const s = hydrateGuidedState(1, { className: 'fighter' })
    expect(s.step).toBe('species')
    expect(s.choice).toEqual({ className: 'fighter' })
    expect(s.complete).toBe(false)
  })

  it('restores a drafted SUBCLASS through the subclass step (class gains it at L3)', () => {
    const s = hydrateGuidedState(3, { className: 'cleric', subclass: 'Life Domain' })
    expect(s.choice).toEqual({ className: 'cleric', subclass: 'Life Domain' })
    expect(s.step).toBe('species')
    expect(s.complete).toBe(false)
  })

  it('reconstructs to the notes step when class + species + background are drafted', () => {
    const s = hydrateGuidedState(1, { className: 'fighter', species: 'Human', background: 'Sage' })
    expect(s.step).toBe('notes')
    expect(s.complete).toBe(false)
    expect(s.choice).toMatchObject({ className: 'fighter', species: 'Human', background: 'Sage' })
  })

  it('reconstructs to complete once notes are also drafted', () => {
    const s = hydrateGuidedState(1, {
      className: 'fighter',
      species: 'Human',
      background: 'Sage',
      notes: 'quiet and watchful',
    })
    expect(s.complete).toBe(true)
  })

  it('stops at the class step on a foreign/invalid class (no advance, no spin)', () => {
    const s = hydrateGuidedState(1, { className: 'not-a-real-class', species: 'Human' })
    expect(s.step).toBe('class')
    expect(s.choice).toEqual({})
  })

  it('round-trips a live mid-sequence state (drive the reducer, then hydrate its choice)', () => {
    let live = initialGuidedState(1)
    live = guidedReducer(live, { type: 'choose', value: 'fighter' })
    live = guidedReducer(live, { type: 'choose', value: 'Human' })
    const restored = hydrateGuidedState(1, live.choice)
    expect(restored.step).toBe(live.step)
    expect(restored.choice).toEqual(live.choice)
  })
})
