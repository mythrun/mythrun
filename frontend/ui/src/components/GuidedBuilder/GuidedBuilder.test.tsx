import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { GuidedOption, RailStep } from '@mythrun/client-core/contract'
import { GuidedBuilder } from './GuidedBuilder.tsx'

// A realistic first-step (class) fixture: nothing chosen yet, so no rung is `done`.
const FIRST_RAIL: RailStep[] = [
  { step: 'class', label: 'Calling', state: 'now' },
  { step: 'species', label: 'Origin', state: 'todo' },
  { step: 'background', label: 'Background', state: 'todo' },
]

// A mid-sequence fixture: two prior picks carried as `done` rungs with `chosen`
// values, the current step ember, the rest muted.
const MID_RAIL: RailStep[] = [
  { step: 'class', label: 'Calling', chosen: 'Fighter', state: 'done' },
  { step: 'subclass', label: 'Practice', chosen: 'Champion', state: 'done' },
  { step: 'species', label: 'Origin', state: 'now' },
  { step: 'background', label: 'Background', state: 'todo' },
]

const CLASS_OPTIONS: GuidedOption[] = [
  { id: 'fighter', name: 'Fighter', description: 'The discipline of the blade.' },
  { id: 'rogue', name: 'Rogue', description: 'The door that was never locked to you.' },
  { id: 'wizard', name: 'Wizard', description: 'The world, written down and rewritten.' },
]

const SINGLE_OPTION: GuidedOption[] = [
  { id: 'life', name: 'Life Domain', description: 'The one subclass this class chooses at first level.' },
]

// A no-op that satisfies the required callbacks without being an empty function.
const noop = (): void => undefined

// The resolved nav labels the shell supplies (real MYT-100 copy).
const LABELS = { next: 'Next', back: 'Back', switchToFreeform: 'Describe them instead' }

function baseProps(overrides: Partial<React.ComponentProps<typeof GuidedBuilder>> = {}) {
  return {
    labels: LABELS,
    rail: FIRST_RAIL,
    question: 'What is your calling?',
    options: CLASS_OPTIONS,
    selectedId: null,
    onSelect: noop,
    onNext: noop,
    onBack: noop,
    onSkipToFreeform: noop,
    ...overrides,
  }
}

describe('GuidedBuilder', () => {
  it('renders the progress rail — each rung label and its chosen value', () => {
    const { getByTestId } = render(<GuidedBuilder {...baseProps({ rail: MID_RAIL })} />)
    // Scope to the rail so the "Fighter" rung value isn't confused with the
    // "Fighter" option card that shares the name.
    const rail = within(getByTestId('guided-builder-rail'))
    expect(rail.getByText('Calling')).toBeInTheDocument()
    expect(rail.getByText('Practice')).toBeInTheDocument()
    expect(rail.getByText('Origin')).toBeInTheDocument()
    // The prior picks are carried as the rung's chosen value.
    expect(rail.getByText('Fighter')).toBeInTheDocument()
    expect(rail.getByText('Champion')).toBeInTheDocument()
  })

  it('reflects each rung state via data-state (done / now / todo)', () => {
    const { getByTestId } = render(<GuidedBuilder {...baseProps({ rail: MID_RAIL })} />)
    const rail = getByTestId('guided-builder-rail')
    const states = Array.from(rail.querySelectorAll('[data-state]')).map((n) =>
      n.getAttribute('data-state'),
    )
    expect(states).toEqual(['done', 'done', 'now', 'todo'])
  })

  it('renders the question as a heading', () => {
    const { getByRole } = render(<GuidedBuilder {...baseProps()} />)
    expect(getByRole('heading', { name: 'What is your calling?' })).toBeInTheDocument()
  })

  it('renders one option card per option (name + description)', () => {
    const { getByRole, getByText } = render(<GuidedBuilder {...baseProps()} />)
    expect(getByRole('button', { name: /Fighter/ })).toBeInTheDocument()
    expect(getByRole('button', { name: /Rogue/ })).toBeInTheDocument()
    expect(getByRole('button', { name: /Wizard/ })).toBeInTheDocument()
    expect(getByText('The world, written down and rewritten.')).toBeInTheDocument()
  })

  it('marks the selectedId card as selected and leaves the others default', () => {
    const { getByRole } = render(<GuidedBuilder {...baseProps({ selectedId: 'rogue' })} />)
    const rogue = getByRole('button', { name: /Rogue/ })
    const fighter = getByRole('button', { name: /Fighter/ })
    expect(rogue).toHaveAttribute('data-state', 'selected')
    expect(rogue).toHaveAttribute('aria-pressed', 'true')
    expect(fighter).toHaveAttribute('data-state', 'default')
    expect(fighter).toHaveAttribute('aria-pressed', 'false')
  })

  it('fires onSelect with the option id on click', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<GuidedBuilder {...baseProps({ onSelect })} />)
    await user.click(getByRole('button', { name: /Wizard/ }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('wizard')
  })

  it('fires onSelect on keyboard activation (the card is a real button)', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<GuidedBuilder {...baseProps({ onSelect })} />)
    getByRole('button', { name: /Fighter/ }).focus()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('fighter')
  })

  it('does NOT advance the step on select — it only fires onSelect (parent drives the flow)', async () => {
    const onSelect = vi.fn()
    const onNext = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<GuidedBuilder {...baseProps({ onSelect, onNext })} />)
    await user.click(getByRole('button', { name: /Rogue/ }))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onNext).not.toHaveBeenCalled()
    // Same props → same step still on screen (no internal step state).
    expect(getByRole('heading', { name: 'What is your calling?' })).toBeInTheDocument()
  })

  it('selection is prop-driven — a rerender with a new selectedId moves the ember', () => {
    const { getByRole, rerender } = render(<GuidedBuilder {...baseProps({ selectedId: null })} />)
    expect(getByRole('button', { name: /Fighter/ })).toHaveAttribute('data-state', 'default')
    rerender(<GuidedBuilder {...baseProps({ selectedId: 'fighter' })} />)
    expect(getByRole('button', { name: /Fighter/ })).toHaveAttribute('data-state', 'selected')
  })

  it('fires onNext from the primary Next control once a selection exists', async () => {
    const onNext = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<GuidedBuilder {...baseProps({ onNext, selectedId: 'rogue' })} />)
    await user.click(getByRole('button', { name: /Next/i }))
    expect(onNext).toHaveBeenCalledOnce()
  })

  // ux-run2 myth-x9ugl / myth-skbzw call-site: Next must not dress as enabled
  // while the step has no answer — the accent fill is the reward for deciding.
  it('disables Next until the step has a selection', () => {
    const { getByRole, rerender } = render(<GuidedBuilder {...baseProps({ selectedId: null })} />)
    expect(getByRole('button', { name: /Next/i })).toBeDisabled()
    rerender(<GuidedBuilder {...baseProps({ selectedId: 'fighter' })} />)
    expect(getByRole('button', { name: /Next/i })).toBeEnabled()
  })

  it('fires onSkipToFreeform from the "describe them instead" escape hatch', async () => {
    const onSkipToFreeform = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<GuidedBuilder {...baseProps({ onSkipToFreeform })} />)
    await user.click(getByRole('button', { name: /describe them instead/i }))
    expect(onSkipToFreeform).toHaveBeenCalledOnce()
  })

  // ux-run2 myth-80an1: one Back, one meaning, one position — bottom-left in the
  // action row on EVERY step. On the first step the parent wires it to leave the
  // builder (back to the chooser); the control itself never teleports or hides.
  it('renders Back on every step (including the first) and fires onBack', async () => {
    const onBack = vi.fn()
    const user = userEvent.setup()
    const { rerender, getByRole } = render(
      <GuidedBuilder {...baseProps({ rail: FIRST_RAIL, onBack })} />,
    )
    await user.click(getByRole('button', { name: /^Back$/i }))
    expect(onBack).toHaveBeenCalledOnce()
    rerender(<GuidedBuilder {...baseProps({ rail: MID_RAIL, options: CLASS_OPTIONS, onBack })} />)
    await user.click(getByRole('button', { name: /^Back$/i }))
    expect(onBack).toHaveBeenCalledTimes(2)
  })

  it('forwards the step counter to the rail', () => {
    const { getByTestId } = render(<GuidedBuilder {...baseProps({ counter: 'Step 1 of 5' })} />)
    expect(getByTestId('guided-rail-counter')).toHaveTextContent('Step 1 of 5')
  })

  it('renders a single-option step as one confirm card', () => {
    const { getAllByRole, getByRole } = render(
      <GuidedBuilder
        {...baseProps({ question: 'How do you practice it?', options: SINGLE_OPTION })}
      />,
    )
    expect(getByRole('button', { name: /Life Domain/ })).toBeInTheDocument()
    // Only the single option card carries an option id.
    const optionCards = getAllByRole('button').filter((b) => b.hasAttribute('data-option-id'))
    expect(optionCards).toHaveLength(1)
  })

  it('option cards are flat / square (rounded-none, no circles)', () => {
    const { getByRole } = render(<GuidedBuilder {...baseProps()} />)
    expect(getByRole('button', { name: /Fighter/ }).className).toContain('rounded-none')
  })

  it('carries a data-testid on the root', () => {
    const { getByTestId } = render(<GuidedBuilder {...baseProps()} />)
    expect(getByTestId('guided-builder')).toBeInTheDocument()
  })

  it('forwards the ref to the root element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<GuidedBuilder ref={ref} {...baseProps()} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations (first step and a mid step)', async () => {
    const first = render(<GuidedBuilder {...baseProps({ rail: FIRST_RAIL })} />)
    expect(await axe(first.container)).toHaveNoViolations()
    const mid = render(
      <GuidedBuilder {...baseProps({ rail: MID_RAIL, selectedId: 'fighter' })} />,
    )
    expect(await axe(mid.container)).toHaveNoViolations()
  })
})
