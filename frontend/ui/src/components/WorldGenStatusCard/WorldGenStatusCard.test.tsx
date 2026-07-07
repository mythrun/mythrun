import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import {
  PREP_STAGES,
  TAIL_STAGES,
  WATCHED_ENTITY_STAGES,
  type StageProgress,
} from '@mythrun/contract/events'
import { WorldGenStatusCard } from './WorldGenStatusCard.tsx'

// WorldGenStatusCard is a DOM overlay (top-left of the graph pane) that turns the
// VISIBLE WAIT into legible PROGRESS. Since the reveal-timing cut (MYT-89) it
// renders a FIXED bar indicator seeded from the canonical WATCHED_ENTITY_STAGES
// slice (known from frame one, audit ③) — the graph-act stages through the
// wiki-reveal boundary (world_and_factions → locations_and_npcs →
// entity_relationships). The PREP stages live in the WorldGenLoading screen and
// get NO bar; the SILENT TAIL stages (entity_consolidation → embed_world) run
// behind the wiki reveal and get NO bar either — the bars hit 100% exactly at the
// reveal moment. A prep or tail entry in the stream's `stages[]` is ignored. The
// stream only ADVANCES each bar's fill. It shows: the CURRENT (running) stage's
// friendly label, a completed/total percent, an optional data-driven "time left",
// and a PAPER-REGISTER segmented SQUARE bar whose running cell pulses (opacity
// fade, the brand's only sanctioned motion). Hard brand rule: NO circles /
// spinners / dots. Cost is NOT rendered (audit ⑥). These tests pin the fixed bar
// count + % math, the prep/tail exclusion, 100%-at-the-reveal-moment, the
// running-vs-done label, the square (non-circular) indicator, the stage-label
// resolution + `[ph:]` fallback, and the ETA.

const TOTAL = WATCHED_ENTITY_STAGES.length // 3

const stage = (id: string, status: StageProgress['status']): StageProgress => ({
  stage: id,
  status,
  userId: null,
  costUsd: 0,
  startedAt: null,
  completedAt: null,
})

// A SHORT stream: only the first watched entity stage has appeared (running). The
// card must still render all 3 bars — the taxonomy seeds the count, the stream
// only advances fills. 0 completed / 3 → 0%.
const SHORT: readonly StageProgress[] = [stage('world_and_factions', 'running')]

// Mid-wait: 2 of the 3 watched entity stages completed, the boundary stage
// running. 2 / 3 → 67%.
const MID: readonly StageProgress[] = [
  stage('world_and_factions', 'completed'),
  stage('locations_and_npcs', 'completed'),
  stage('entity_relationships', 'running'),
]

const EXPECTED_MID_PERCENT = Math.round((2 / TOTAL) * 100) // 67

// Every watched entity stage completed → 100%, the done state — the wiki-reveal
// moment, even though the silent tail has not run at all.
const DONE: readonly StageProgress[] = WATCHED_ENTITY_STAGES.map((s) => stage(s, 'completed'))

const LABELS = {
  stageLabels: {
    entity_relationships: '[ph: drawing the ties]',
  },
  doneLabel: '[ph: world ready]',
}

describe('WorldGenStatusCard — FIXED bars from the WATCHED_ENTITY_STAGES taxonomy', () => {
  it('renders all 3 watched-entity bars from frame one even when the stream is short', () => {
    const { container } = render(<WorldGenStatusCard stages={SHORT} {...LABELS} />)
    expect(container.querySelectorAll('[data-cell-state]')).toHaveLength(TOTAL)
    expect(container.querySelectorAll('[data-cell-state="running"]')).toHaveLength(1)
    // The remaining watched entity stages have not appeared in the stream → pending.
    expect(container.querySelectorAll('[data-cell-state="pending"]')).toHaveLength(TOTAL - 1)
  })

  it('renders 3 pending bars at 0% before the first snapshot frame (empty stream)', () => {
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

  it('IGNORES silent-tail stream entries — the tail is nobody’s wait (reveal timing)', () => {
    // Everything through the boundary completed AND tail stages underway: the card
    // holds at 100% with no extra bars and no running cell — a tail entry never
    // renders as progress-to-come.
    const withTail: readonly StageProgress[] = [
      ...DONE,
      stage('entity_consolidation', 'completed'),
      stage('coherence_pass', 'running'),
    ]
    const { container, getByText } = render(<WorldGenStatusCard stages={withTail} {...LABELS} />)
    expect(container.querySelectorAll('[data-cell-state]')).toHaveLength(TOTAL)
    expect(container.querySelectorAll('[data-cell-state="completed"]')).toHaveLength(TOTAL)
    expect(container.querySelectorAll('[data-cell-state="running"]')).toHaveLength(0)
    expect(getByText('100%')).toBeInTheDocument()
  })

  it('computes percent as completed / 3 (fixed denominator), NOT over the stream length', () => {
    const { getByText, getByRole } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    expect(getByText(`${String(EXPECTED_MID_PERCENT)}%`)).toBeInTheDocument()
    expect(getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(EXPECTED_MID_PERCENT))
  })

  it('shows the RUNNING stage friendly label', () => {
    const { getByText } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    expect(getByText('[ph: drawing the ties]')).toBeInTheDocument()
  })

  it('falls back to a `[ph: <stage>]` placeholder for an unmapped stage (DS owns no copy)', () => {
    const { getByText } = render(<WorldGenStatusCard stages={MID} />)
    expect(getByText('[ph: entity_relationships]')).toBeInTheDocument()
  })

  it('exposes the percent through a determinate progressbar', () => {
    const { getByRole } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    const bar = getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
  })
})

describe('WorldGenStatusCard — done state (the wiki-reveal moment)', () => {
  it('hits 100% + the done label when the BOUNDARY stage completes — the tail not required', () => {
    // No tail entry in the stream at all: the bars rest full the instant
    // connection-weaving lands, which is exactly when the route fires the reveal.
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

  it('never reaches 100% while the boundary stage is still running', () => {
    const { queryByText } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    expect(queryByText('100%')).toBeNull()
    expect(queryByText('[ph: world ready]')).toBeNull()
  })
})

describe('WorldGenStatusCard — data-driven ETA (audit ③)', () => {
  it('renders the resolved "time left" when supplied', () => {
    const { getByText } = render(
      <WorldGenStatusCard stages={MID} etaLabel="[ph: ~2m left]" {...LABELS} />,
    )
    expect(getByText('[ph: ~2m left]')).toBeInTheDocument()
  })

  it('renders NO estimate when etaLabel is omitted (cold-start / no history)', () => {
    const { queryByText } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    expect(queryByText(/left/)).toBeNull()
  })
})

describe('WorldGenStatusCard — cost removed (audit ⑥)', () => {
  it('never renders an API-spend readout (no `$…`)', () => {
    // No `costUsd` prop exists anymore; assert no dollar figure leaks under any state.
    const { queryByText } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    expect(queryByText(/\$/)).toBeNull()
  })
})

describe('WorldGenStatusCard — paper register (NO circle / spinner)', () => {
  it('the working indicator is a SQUARE segmented bar, never a circle or spinner', () => {
    const { container, getByTestId } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    expect(getByTestId('worldgen-status-bar')).toBeInTheDocument()
    expect(container.querySelector('[data-spinner-grid]')).toBeNull()
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('.rounded-full')).toBeNull()
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
    const html = container.innerHTML
    expect(html).not.toMatch(/animate-spin|animate-bounce|animate-ping|translate|rotate|scale-/)
  })
})

describe('WorldGenStatusCard — chrome', () => {
  it('passes through a data-testid', () => {
    const { getByTestId } = render(
      <WorldGenStatusCard stages={MID} data-testid="status-card" {...LABELS} />,
    )
    expect(getByTestId('status-card')).toBeInTheDocument()
  })

  it('has no a11y violations (generating + done)', async () => {
    const generating = render(
      <WorldGenStatusCard stages={MID} etaLabel="[ph: ~2m left]" {...LABELS} />,
    )
    expect(await axe(generating.container)).toHaveNoViolations()
    generating.unmount()
    const done = render(<WorldGenStatusCard stages={DONE} {...LABELS} />)
    expect(await axe(done.container)).toHaveNoViolations()
  })
})

// TAIL_STAGES is imported to keep the tail-exclusion fixture honest if the
// taxonomy ever grows; assert the fixture's tail ids really are tail stages.
describe('fixture honesty', () => {
  it('the tail fixture ids are canonical TAIL_STAGES members', () => {
    expect(TAIL_STAGES).toContain('entity_consolidation')
    expect(TAIL_STAGES).toContain('coherence_pass')
  })
})
