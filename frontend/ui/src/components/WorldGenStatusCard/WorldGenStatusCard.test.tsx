import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import type { StageProgress } from '@mythrun/contract/events'
import { WorldGenStatusCard } from './WorldGenStatusCard.tsx'

// WorldGenStatusCard is a DOM overlay (top-left of the graph pane) that turns the
// long pre-entity generation stretch into legible PROGRESS. It reads the stream's
// `stages[]` (B4 `StageProgress`) + `costUsd` and renders: the CURRENT (running)
// stage's friendly label, a completed/total percent, and a PAPER-REGISTER working
// indicator — a segmented SQUARE bar whose running cell pulses (opacity fade, the
// brand's only sanctioned motion). Hard brand rule: NO circles / spinners / dots.
// These tests pin the percent math, the running-vs-done label, the square (non-
// circular) indicator, the stage-label resolution + `[ph:]` fallback, and cost.

const stage = (id: string, status: StageProgress['status']): StageProgress => ({
  stage: id,
  status,
  userId: null,
  costUsd: 0,
  startedAt: null,
  completedAt: null,
})

// 5 stages, 2 completed, 1 running → 40%. The running one is the "current" stage.
const MID: readonly StageProgress[] = [
  stage('concept_intake', 'completed'),
  stage('world_color', 'completed'),
  stage('vocabulary_intake', 'running'),
  stage('entity_relationships', 'pending'),
  stage('entity_details', 'pending'),
]

const DONE: readonly StageProgress[] = MID.map((s) => stage(s.stage, 'completed'))

const LABELS = {
  stageLabels: {
    vocabulary_intake: '[ph: naming things]',
  },
  doneLabel: '[ph: world ready]',
}

describe('WorldGenStatusCard — progress', () => {
  it('shows the RUNNING stage friendly label + completed/total percent', () => {
    const { getByText } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    expect(getByText('[ph: naming things]')).toBeInTheDocument()
    expect(getByText('40%')).toBeInTheDocument()
  })

  it('falls back to a `[ph: <stage>]` placeholder for an unmapped stage (DS owns no copy)', () => {
    const { getByText } = render(<WorldGenStatusCard stages={MID} />)
    expect(getByText('[ph: vocabulary_intake]')).toBeInTheDocument()
  })

  it('exposes the percent through a determinate progressbar (aria-valuenow)', () => {
    const { getByRole } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    const bar = getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '40')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
  })

  it('renders one segmented cell per stage, the running one flagged', () => {
    const { container } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    expect(container.querySelectorAll('[data-cell-state]')).toHaveLength(MID.length)
    expect(container.querySelectorAll('[data-cell-state="completed"]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-cell-state="running"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-cell-state="pending"]')).toHaveLength(2)
  })
})

describe('WorldGenStatusCard — done state', () => {
  it('shows 100% and the done label when every stage has completed', () => {
    const { getByText, getByRole } = render(<WorldGenStatusCard stages={DONE} {...LABELS} />)
    expect(getByText('100%')).toBeInTheDocument()
    expect(getByText('[ph: world ready]')).toBeInTheDocument()
    expect(getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
  })

  it('stops the working indicator at 100% (no running cell, no pulse)', () => {
    const { container } = render(<WorldGenStatusCard stages={DONE} {...LABELS} />)
    expect(container.querySelector('[data-cell-state="running"]')).toBeNull()
    expect(container.querySelector('.animate-pulse')).toBeNull()
  })
})

describe('WorldGenStatusCard — paper register (NO circle / spinner)', () => {
  it('the working indicator is a SQUARE segmented bar, never a circle or spinner', () => {
    const { container, getByTestId } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    // The bar exists and is the working-indicator surface.
    expect(getByTestId('worldgen-status-bar')).toBeInTheDocument()
    // No spinner grid, no SVG icon, no circular (rounded-full) element anywhere.
    expect(container.querySelector('[data-spinner-grid]')).toBeNull()
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('.rounded-full')).toBeNull()
    // Every segmented cell is square (0px radius).
    for (const cell of container.querySelectorAll('[data-cell-state]')) {
      expect(cell).toHaveClass('rounded-none')
    }
  })

  it('pulses (opacity fade) ONLY the running cell — the brand-sanctioned motion', () => {
    const { container } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    expect(container.querySelector('[data-cell-state="running"]')).toHaveClass('animate-pulse')
    for (const cell of container.querySelectorAll('[data-cell-state="completed"]')) {
      expect(cell).not.toHaveClass('animate-pulse')
    }
    // Never a rotating/sliding/scaling animation (the §4 motion rule).
    const html = container.innerHTML
    expect(html).not.toMatch(/animate-spin|animate-bounce|animate-ping|translate|rotate|scale-/)
  })
})

describe('WorldGenStatusCard — cost + chrome', () => {
  it('renders the cumulative cost when supplied, hides it when null', () => {
    const { getByText, queryByText, rerender } = render(
      <WorldGenStatusCard stages={MID} costUsd={0.42} {...LABELS} />,
    )
    expect(getByText('$0.42')).toBeInTheDocument()
    rerender(<WorldGenStatusCard stages={MID} costUsd={null} {...LABELS} />)
    expect(queryByText(/\$/)).toBeNull()
  })

  it('passes through a data-testid', () => {
    const { getByTestId } = render(
      <WorldGenStatusCard stages={MID} data-testid="status-card" {...LABELS} />,
    )
    expect(getByTestId('status-card')).toBeInTheDocument()
  })

  it('renders nothing for an empty stage set (before the first snapshot frame)', () => {
    const { container } = render(<WorldGenStatusCard stages={[]} {...LABELS} />)
    expect(container.querySelector('[data-testid="worldgen-status-bar"]')).toBeNull()
  })

  it('has no a11y violations (generating + done)', async () => {
    const generating = render(<WorldGenStatusCard stages={MID} costUsd={0.42} {...LABELS} />)
    expect(await axe(generating.container)).toHaveNoViolations()
    generating.unmount()
    const done = render(<WorldGenStatusCard stages={DONE} {...LABELS} />)
    expect(await axe(done.container)).toHaveNoViolations()
  })
})
