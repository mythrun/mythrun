import { describe, it, expect } from 'vitest'
import { createMachine, createTransition } from '../index.ts'

// The character-creation flow as a small pure state machine (states + transitions,
// no network): chooser → (freeform | guided) → submit → processing → reveal →
// (confirm → staging | startOver → chooser).

describe('createMachine', () => {
  it('starts at the chooser', () => {
    expect(createMachine.initial).toBe('chooser')
  })

  it('forks the chooser into freeform or guided', () => {
    expect(createTransition('chooser', 'chooseFreeform')).toBe('freeform')
    expect(createTransition('chooser', 'chooseGuided')).toBe('guided')
  })

  it('submits either input fork into processing', () => {
    expect(createTransition('freeform', 'submit')).toBe('processing')
    expect(createTransition('guided', 'submit')).toBe('processing')
  })

  it('lets the guided fork skip to the freeform fork', () => {
    expect(createTransition('guided', 'skipToFreeform')).toBe('freeform')
  })

  it('reveals the sheet once processing is ready', () => {
    expect(createTransition('processing', 'ready')).toBe('reveal')
  })

  it('confirms the reveal into staging', () => {
    expect(createTransition('reveal', 'confirm')).toBe('staging')
  })

  it('starts over from the reveal back to the chooser', () => {
    expect(createTransition('reveal', 'startOver')).toBe('chooser')
  })

  it('exposes the transition function on the machine object', () => {
    expect(createMachine.transition('reveal', 'startOver')).toBe('chooser')
  })

  it('is a no-op for an event with no transition from the current state', () => {
    expect(createTransition('staging', 'submit')).toBe('staging')
    expect(createTransition('reveal', 'submit')).toBe('reveal')
  })
})
