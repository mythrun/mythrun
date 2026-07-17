import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render, within } from '@testing-library/react'
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
