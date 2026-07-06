import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { WORLD_GEN_STAGES, type StageProgress } from '@mythrun/contract/events'
import { WorldGenStatusCard } from './WorldGenStatusCard.tsx'

// WorldGenStatusCard is a DOM overlay (top-left of the graph pane) that turns the
// long pre-entity generation stretch into legible PROGRESS. It renders a FIXED
// 11-bar indicator seeded from the canonical WORLD_GEN_STAGES taxonomy (known from
// frame one, audit ③) — the stream's `stages[]` only ADVANCES each bar's fill. It
// shows: the CURRENT (running) stage's friendly label, a completed/11 percent, an
// optional data-driven "time left", and a PAPER-REGISTER segmented SQUARE bar whose
// running cell pulses (opacity fade, the brand's only sanctioned motion). Hard brand
// rule: NO circles / spinners / dots. Cost is NOT rendered (audit ⑥). These tests pin
// the fixed 11-bar count + %/11 math, the running-vs-done label, the square (non-
// circular) indicator, the stage-label resolution + `[ph:]` fallback, and the ETA.

const TOTAL = WORLD_GEN_STAGES.length // 11

const stage = (id: string, status: StageProgress['status']): StageProgress => ({
  stage: id,
  status,
  userId: null,
  costUsd: 0,
  startedAt: null,
  completedAt: null,
})

// A SHORT stream: only 3 canonical stages have appeared (2 completed, 1 running).
// The card must still render 11 bars — the taxonomy seeds the count, the stream only
// advances fills. 2 completed / 11 → 18%.
const SHORT: readonly StageProgress[] = [
  stage('concept_intake', 'completed'),
  stage('world_color', 'completed'),
  stage('vocabulary_intake', 'running'),
]

const EXPECTED_SHORT_PERCENT = Math.round((2 / TOTAL) * 100) // 18

// Every canonical stage completed → 100%, the done state.
const DONE: readonly StageProgress[] = WORLD_GEN_STAGES.map((s) => stage(s, 'completed'))

const LABELS = {
  stageLabels: {
    vocabulary_intake: '[ph: naming things]',
  },
  doneLabel: '[ph: world ready]',
}

describe('WorldGenStatusCard — FIXED 11 bars from the taxonomy (audit ③)', () => {
  it('renders all 11 bars from frame one even when the stream is short', () => {
    const { container } = render(<WorldGenStatusCard stages={SHORT} {...LABELS} />)
    expect(container.querySelectorAll('[data-cell-state]')).toHaveLength(TOTAL)
    expect(container.querySelectorAll('[data-cell-state="completed"]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-cell-state="running"]')).toHaveLength(1)
    // The remaining 8 canonical stages have not appeared in the stream → pending.
    expect(container.querySelectorAll('[data-cell-state="pending"]')).toHaveLength(TOTAL - 3)
  })

  it('renders 11 pending bars at 0% before the first snapshot frame (empty stream)', () => {
    const { container, getByText } = render(<WorldGenStatusCard stages={[]} {...LABELS} />)
    expect(container.querySelectorAll('[data-cell-state]')).toHaveLength(TOTAL)
    expect(container.querySelectorAll('[data-cell-state="pending"]')).toHaveLength(TOTAL)
    expect(getByText('0%')).toBeInTheDocument()
  })

  it('computes percent as completed / 11 (fixed denominator), NOT over the stream length', () => {
    const { getByText, getByRole } = render(<WorldGenStatusCard stages={SHORT} {...LABELS} />)
    expect(getByText(`${String(EXPECTED_SHORT_PERCENT)}%`)).toBeInTheDocument()
    expect(getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(EXPECTED_SHORT_PERCENT))
  })

  it('shows the RUNNING stage friendly label', () => {
    const { getByText } = render(<WorldGenStatusCard stages={SHORT} {...LABELS} />)
    expect(getByText('[ph: naming things]')).toBeInTheDocument()
  })

  it('falls back to a `[ph: <stage>]` placeholder for an unmapped stage (DS owns no copy)', () => {
    const { getByText } = render(<WorldGenStatusCard stages={SHORT} />)
    expect(getByText('[ph: vocabulary_intake]')).toBeInTheDocument()
  })

  it('exposes the percent through a determinate progressbar', () => {
    const { getByRole } = render(<WorldGenStatusCard stages={SHORT} {...LABELS} />)
    const bar = getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
  })
})

describe('WorldGenStatusCard — done state', () => {
  it('shows 100% and the done label when every canonical stage has completed', () => {
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

describe('WorldGenStatusCard — data-driven ETA (audit ③)', () => {
  it('renders the resolved "time left" when supplied', () => {
    const { getByText } = render(
      <WorldGenStatusCard stages={SHORT} etaLabel="[ph: ~2m left]" {...LABELS} />,
    )
    expect(getByText('[ph: ~2m left]')).toBeInTheDocument()
  })

  it('renders NO estimate when etaLabel is omitted (cold-start / no history)', () => {
    const { queryByText } = render(<WorldGenStatusCard stages={SHORT} {...LABELS} />)
    expect(queryByText(/left/)).toBeNull()
  })
})

describe('WorldGenStatusCard — cost removed (audit ⑥)', () => {
  it('never renders an API-spend readout (no `$…`)', () => {
    // No `costUsd` prop exists anymore; assert no dollar figure leaks under any state.
    const { queryByText } = render(<WorldGenStatusCard stages={SHORT} {...LABELS} />)
    expect(queryByText(/\$/)).toBeNull()
  })
})

describe('WorldGenStatusCard — paper register (NO circle / spinner)', () => {
  it('the working indicator is a SQUARE segmented bar, never a circle or spinner', () => {
    const { container, getByTestId } = render(<WorldGenStatusCard stages={SHORT} {...LABELS} />)
    expect(getByTestId('worldgen-status-bar')).toBeInTheDocument()
    expect(container.querySelector('[data-spinner-grid]')).toBeNull()
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('.rounded-full')).toBeNull()
    for (const cell of container.querySelectorAll('[data-cell-state]')) {
      expect(cell).toHaveClass('rounded-none')
    }
  })

  it('pulses (opacity fade) ONLY the running cell — the brand-sanctioned motion', () => {
    const { container } = render(<WorldGenStatusCard stages={SHORT} {...LABELS} />)
    expect(container.querySelector('[data-cell-state="running"]')).toHaveClass('animate-pulse')
    for (const cell of container.querySelectorAll('[data-cell-state="completed"]')) {
      expect(cell).not.toHaveClass('animate-pulse')
    }
    const html = container.innerHTML
    expect(html).not.toMatch(/animate-spin|animate-bounce|animate-ping|translate|rotate|scale-/)
  })
})

describe('WorldGenStatusCard — chrome', () => {
  it('passes through a data-testid', () => {
    const { getByTestId } = render(
      <WorldGenStatusCard stages={SHORT} data-testid="status-card" {...LABELS} />,
    )
    expect(getByTestId('status-card')).toBeInTheDocument()
  })

  it('has no a11y violations (generating + done)', async () => {
    const generating = render(
      <WorldGenStatusCard stages={SHORT} etaLabel="[ph: ~2m left]" {...LABELS} />,
    )
    expect(await axe(generating.container)).toHaveNoViolations()
    generating.unmount()
    const done = render(<WorldGenStatusCard stages={DONE} {...LABELS} />)
    expect(await axe(done.container)).toHaveNoViolations()
  })
})
