import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { fireEvent, render, within } from '@testing-library/react'
import { axe } from 'jest-axe'
import type { RailStep } from '@mythrun/client-core/contract'
import { GuidedRail } from './GuidedRail.tsx'

// The guided journey's progress rail as a standalone component (MYT-102) —
// extracted from GuidedBuilder so the builder-less screens of the same flow
// (notes, grounding) keep the done/now/todo signposting. Non-interactive: a
// semantic ordered list of rungs, each carrying its label + chosen value and a
// data-state for the ember/ink/muted recoloring.

// A grounding-screen fixture: every builder rung done, the rail-only grounding
// rung `now` (the state guided-path renders after the builder completes).
const GROUNDING_RAIL: RailStep[] = [
  { step: 'class', label: 'Calling', chosen: 'Fighter', state: 'done' },
  { step: 'species', label: 'Origin', chosen: 'Human', state: 'done' },
  { step: 'background', label: 'Background', chosen: 'Soldier', state: 'done' },
  { step: 'notes', label: 'Notes', state: 'done' },
  { step: 'grounding', label: 'Grounding', state: 'now' },
]

describe('GuidedRail', () => {
  it('renders each rung label and its chosen value', () => {
    const { getByTestId } = render(<GuidedRail rail={GROUNDING_RAIL} />)
    const rail = within(getByTestId('guided-rail'))
    expect(rail.getByText('Calling')).toBeInTheDocument()
    expect(rail.getByText('Fighter')).toBeInTheDocument()
    expect(rail.getByText('Origin')).toBeInTheDocument()
    expect(rail.getByText('Human')).toBeInTheDocument()
    expect(rail.getByText('Grounding')).toBeInTheDocument()
  })

  it('reflects each rung state via data-state (done / now / todo)', () => {
    const { getByTestId } = render(<GuidedRail rail={GROUNDING_RAIL} />)
    const states = Array.from(getByTestId('guided-rail').querySelectorAll('[data-state]')).map(
      (n) => n.getAttribute('data-state'),
    )
    expect(states).toEqual(['done', 'done', 'done', 'done', 'now'])
  })

  it('is a semantic ordered list — one listitem per rung', () => {
    const { getByRole, getAllByRole } = render(<GuidedRail rail={GROUNDING_RAIL} />)
    expect(getByRole('list')).toBeInTheDocument()
    expect(getAllByRole('listitem')).toHaveLength(GROUNDING_RAIL.length)
  })

  it('hides the decorative separators from assistive tech', () => {
    const { getByTestId } = render(<GuidedRail rail={GROUNDING_RAIL} />)
    const separators = getByTestId('guided-rail').querySelectorAll('[aria-hidden="true"]')
    // One separator between each adjacent rung pair.
    expect(separators).toHaveLength(GROUNDING_RAIL.length - 1)
  })

  it('defaults its data-testid to guided-rail and honours an override', () => {
    const first = render(<GuidedRail rail={GROUNDING_RAIL} />)
    expect(first.getByTestId('guided-rail')).toBeInTheDocument()
    first.unmount()
    const second = render(<GuidedRail rail={GROUNDING_RAIL} data-testid="guided-builder-rail" />)
    expect(second.getByTestId('guided-builder-rail')).toBeInTheDocument()
  })

  it('is flat 1-bit / square: rungs carry rounded-none', () => {
    const { getByText } = render(<GuidedRail rail={GROUNDING_RAIL} />)
    // The rung box is the parent of the label span.
    expect(getByText('Grounding').parentElement?.className).toContain('rounded-none')
  })

  // ux-run2 myth-udhp3: a completed rung collapses to its chosen value — the
  // choices become the path. The category label survives for AT only.
  it('collapses a completed rung to its value: the label loses its visible chrome, the current rung keeps it', () => {
    const { getByText } = render(<GuidedRail rail={GROUNDING_RAIL} />)
    // Done rung ('Calling' → 'Fighter'): the label is visually hidden (no mono
    // uppercase chrome — it renders through the SR-only wrapper).
    expect(getByText('Calling').className).not.toContain('uppercase')
    // The current rung ('Grounding', state now) keeps its visible label.
    expect(getByText('Grounding').className).toContain('uppercase')
  })

  it('clamps a long chosen value to a one-line disclosure token that expands on click', () => {
    const longNotes = 'They call me Sable now, though that is only half of the story'
    const rail: RailStep[] = [
      { step: 'class', label: 'Class', chosen: 'Cleric', state: 'done' },
      { step: 'notes', label: 'Notes', chosen: longNotes, state: 'done' },
      { step: 'grounding', label: 'Arrival', state: 'now' },
    ]
    const { getByRole, getByText } = render(<GuidedRail rail={rail} />)
    // Only the long-value rung is a disclosure button; short rungs stay static.
    const toggle = getByRole('button')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(getByText(longNotes).className).toContain('truncate')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(getByText(longNotes).className).not.toContain('truncate')
  })

  it('renders the quiet step counter as the trailing rail item when provided', () => {
    const first = render(<GuidedRail rail={GROUNDING_RAIL} counter="Step 5 of 5" />)
    expect(first.getByTestId('guided-rail-counter')).toHaveTextContent('Step 5 of 5')
    first.unmount()
    const second = render(<GuidedRail rail={GROUNDING_RAIL} />)
    expect(second.queryByTestId('guided-rail-counter')).toBeNull()
  })

  it('forwards the ref to the list element', () => {
    const ref = createRef<HTMLOListElement>()
    render(<GuidedRail ref={ref} rail={GROUNDING_RAIL} />)
    expect(ref.current).toBeInstanceOf(HTMLOListElement)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<GuidedRail rail={GROUNDING_RAIL} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
