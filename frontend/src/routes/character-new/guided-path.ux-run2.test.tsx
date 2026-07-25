import { describe, expect, it, vi } from 'vitest'
import { screen, fireEvent, within } from '@testing-library/react'
import {
  registerGuidedPathTestHooks,
  renderGuided,
  pickOption,
  next,
  q,
} from './guided-path.fixtures.tsx'

// The ux-run2 additions to the guided path (fix cycle 2): the "plays like"
// decision-criteria glosses (myth-334oz), the stable-station step counter
// (myth-udhp3), the honest notes scaffolding (myth-z45sb), and the world
// panel's selection needle (myth-ehcf4). The core behaviour contract lives in
// guided-path.test.tsx; the shared harness in guided-path.fixtures.tsx.

registerGuidedPathTestHooks()

describe('GuidedPath — ux-run2 decision criteria + honest chrome', () => {
  it('renders a one-line "plays like" gloss on every class card (myth-334oz)', () => {
    const { container } = renderGuided()
    const warlock = container.querySelector('[data-option-id="warlock"]')
    expect(warlock?.textContent).toContain(q('characterCreate.guided.class.options.warlock.gloss'))
    const cleric = container.querySelector('[data-option-id="cleric"]')
    expect(cleric?.textContent).toContain(q('characterCreate.guided.class.options.cleric.gloss'))
  })

  it('renders the gloss on species and background cards too', () => {
    const { container } = renderGuided({ startingLevel: 1 })
    pickOption(container, 'fighter')
    next() // → species (subclass skipped at L1)
    expect(container.querySelector('[data-option-id="Tiefling"]')?.textContent).toContain(
      q('characterCreate.guided.species.options.Tiefling.gloss'),
    )
    pickOption(container, 'Human')
    next() // → background
    expect(container.querySelector('[data-option-id="Hermit"]')?.textContent).toContain(
      q('characterCreate.guided.background.options.Hermit.gloss'),
    )
  })

  it('shows the quiet step counter on the rail, counting the stable stations (myth-udhp3)', () => {
    const { container } = renderGuided({ startingLevel: 3 })
    // Five stations regardless of the subclass sub-question: class, species,
    // background, notes, arrival.
    expect(screen.getByTestId('guided-rail-counter').textContent).toBe('Step 1 of 5')
    pickOption(container, 'fighter')
    next() // → subclass sub-question: still station 1 (the CLASS rung stays now)
    expect(screen.getByTestId('guided-rail-counter').textContent).toBe('Step 1 of 5')
    next() // preselected subclass → species
    expect(screen.getByTestId('guided-rail-counter').textContent).toBe('Step 2 of 5')
  })

  it('relabels the notes control Skip ↔ Continue with the field state (myth-z45sb)', () => {
    const { container } = renderGuided({ startingLevel: 1 })
    pickOption(container, 'fighter')
    next()
    pickOption(container, 'Human')
    next()
    pickOption(container, 'Soldier')
    next() // → notes
    const prompt = within(screen.getByTestId('freeform-prompt'))
    // Empty field: the sanctioned skip is the button itself.
    expect(prompt.getByRole('button', { name: 'Skip' })).toBeDefined()
    // The example placeholder shows the shape of a good answer.
    expect(prompt.getByRole('textbox').getAttribute('placeholder')).toBe(
      q('characterCreate.guided.notes.placeholder'),
    )
    fireEvent.change(prompt.getByRole('textbox'), { target: { value: 'keeps a raven' } })
    expect(prompt.getByRole('button', { name: 'Continue' })).toBeDefined()
  })

  it('reports the selection needle for the world panel seam (myth-ehcf4)', () => {
    const onStepContext = vi.fn()
    const { container } = renderGuided({ startingLevel: 1, onStepContext })
    // Nothing selected yet — the panel's context strip stands down.
    expect(onStepContext).toHaveBeenLastCalledWith(undefined)
    // Selecting a class reports its CANONICAL name (the panel's match needle).
    pickOption(container, 'fighter')
    expect(onStepContext).toHaveBeenLastCalledWith('Fighter')
    next() // → species (subclass skipped at L1); selection resets
    expect(onStepContext).toHaveBeenLastCalledWith(undefined)
    pickOption(container, 'Human')
    expect(onStepContext).toHaveBeenLastCalledWith('Human')
    next()
    pickOption(container, 'Soldier')
    expect(onStepContext).toHaveBeenLastCalledWith('Soldier')
    next() // → notes (free text): the needle stands down again
    expect(onStepContext).toHaveBeenLastCalledWith(undefined)
  })
})
