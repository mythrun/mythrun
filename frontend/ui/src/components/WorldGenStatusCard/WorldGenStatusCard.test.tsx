import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { ENTITY_STAGES, PREP_STAGES, type StageProgress } from '@mythrun/contract/events'
import { WorldGenStatusCard } from './WorldGenStatusCard.tsx'

// WorldGenStatusCard is a DOM overlay (top-left of the graph pane) that turns the
// entity-generation act into legible PROGRESS. Since the two-act cut it renders a
// FIXED 8-bar indicator seeded from the canonical ENTITY_STAGES slice (known from
// frame one, audit ③) — the PREP stages (concept_intake / world_color /
// vocabulary_intake) live in the WorldGenLoading screen now and get NO bar here; a
// prep entry in the stream's `stages[]` is ignored. The stream only ADVANCES each
// bar's fill. It shows: the CURRENT (running) stage's friendly label, a completed/8
// percent, an optional data-driven "time left", and a PAPER-REGISTER segmented SQUARE
// bar whose running cell pulses (opacity fade, the brand's only sanctioned motion).
// Hard brand rule: NO circles / spinners / dots. Cost is NOT rendered (audit ⑥).
// These tests pin the fixed 8-bar count + %/8 math, the prep-stage exclusion, the
// running-vs-done label, the square (non-circular) indicator, the stage-label
// resolution + `[ph:]` fallback, and the ETA.

const TOTAL = ENTITY_STAGES.length // 8

const stage = (id: string, status: StageProgress['status']): StageProgress => ({
  stage: id,
  status,
  userId: null,
  costUsd: 0,
  startedAt: null,
  completedAt: null,
})

// A SHORT stream: only 3 canonical entity stages have appeared (2 completed, 1
// running). The card must still render 8 bars — the taxonomy seeds the count, the
// stream only advances fills. 2 completed / 8 → 25%.
const SHORT: readonly StageProgress[] = [
  stage('world_and_factions', 'completed'),
  stage('locations_and_npcs', 'completed'),
  stage('entity_relationships', 'running'),
]

const EXPECTED_SHORT_PERCENT = Math.round((2 / TOTAL) * 100) // 25

// Every canonical entity stage completed → 100%, the done state.
const DONE: readonly StageProgress[] = ENTITY_STAGES.map((s) => stage(s, 'completed'))

const LABELS = {
  stageLabels: {
    entity_relationships: '[ph: drawing the ties]',
  },
  doneLabel: '[ph: world ready]',
}

describe('WorldGenStatusCard — FIXED 8 bars from the ENTITY_STAGES taxonomy (audit ③)', () => {
  it('renders all 8 entity-stage bars from frame one even when the stream is short', () => {
    const { container } = render(<WorldGenStatusCard stages={SHORT} {...LABELS} />)
    expect(container.querySelectorAll('[data-cell-state]')).toHaveLength(TOTAL)
    expect(container.querySelectorAll('[data-cell-state="completed"]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-cell-state="running"]')).toHaveLength(1)
    // The remaining 5 canonical entity stages have not appeared in the stream → pending.
    expect(container.querySelectorAll('[data-cell-state="pending"]')).toHaveLength(TOTAL - 3)
  })

  it('renders 8 pending bars at 0% before the first snapshot frame (empty stream)', () => {
    const { container, getByText } = render(<WorldGenStatusCard stages={[]} {...LABELS} />)
    expect(container.querySelectorAll('[data-cell-state]')).toHaveLength(TOTAL)
    expect(container.querySelectorAll('[data-cell-state="pending"]')).toHaveLength(TOTAL)
    expect(getByText('0%')).toBeInTheDocument()
  })

  it('IGNORES prep-stage stream entries — no bar, no percent movement (the two-act cut)', () => {
    // The whole prep act completed + the first entity stage running: the card still
    // shows 0% (no prep bar exists to fill) with exactly one running entity bar.
    const withPrep: readonly StageProgress[] = [
      ...PREP_STAGES.map((s) => stage(s, 'completed')),
      stage('world_and_factions', 'running'),
    ]
    const { container, getByText } = render(<WorldGenStatusCard stages={withPrep} {...LABELS} />)
    expect(container.querySelectorAll('[data-cell-state]')).toHaveLength(TOTAL)
    expect(container.querySelectorAll('[data-cell-state="completed"]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-cell-state="running"]')).toHaveLength(1)
    expect(getByText('0%')).toBeInTheDocument()
  })

  it('computes percent as completed / 8 (fixed denominator), NOT over the stream length', () => {
    const { getByText, getByRole } = render(<WorldGenStatusCard stages={SHORT} {...LABELS} />)
    expect(getByText(`${String(EXPECTED_SHORT_PERCENT)}%`)).toBeInTheDocument()
    expect(getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(EXPECTED_SHORT_PERCENT))
  })

  it('shows the RUNNING stage friendly label', () => {
    const { getByText } = render(<WorldGenStatusCard stages={SHORT} {...LABELS} />)
    expect(getByText('[ph: drawing the ties]')).toBeInTheDocument()
  })

  it('falls back to a `[ph: <stage>]` placeholder for an unmapped stage (DS owns no copy)', () => {
    const { getByText } = render(<WorldGenStatusCard stages={SHORT} />)
    expect(getByText('[ph: entity_relationships]')).toBeInTheDocument()
  })

  it('exposes the percent through a determinate progressbar', () => {
    const { getByRole } = render(<WorldGenStatusCard stages={SHORT} {...LABELS} />)
    const bar = getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
  })
})

describe('WorldGenStatusCard — done state', () => {
  it('shows 100% and the done label when every canonical entity stage has completed', () => {
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
