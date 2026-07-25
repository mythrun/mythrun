import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
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
// entity_relationships → world_introduction, myth-zaqxh). The PREP stages live in
// the WorldGenLoading screen and get NO bar; the SILENT TAIL stages
// (entity_consolidation → embed_world) run behind the wiki reveal and get NO bar
// either — the bars hit 100% exactly at the reveal moment. A prep or tail entry in the stream's `stages[]` is ignored. The
// stream only ADVANCES each bar's fill. It shows: the CURRENT (running) stage's
// friendly label (the consumer composes any stage-scope framing into it), an
// optional COUNTDOWN (`countdownLabel` — the consumer ticks + formats it;
// aria-hidden, the progressbar carries the semantics) or its `stalledLabel`
// stand-in, an optional quiet RETURN link (myth-t11az — back to the calm wait),
// and a PAPER-REGISTER segmented SQUARE bar whose running cell pulses (opacity
// fade, the brand's only sanctioned motion). Hard brand rule: NO circles /
// spinners / dots. NO percent numeral (ux-run2 myth-uz1bn: "0%" over six named
// markers and a numeral contradicting the bar fill are honesty defects — the
// bars + stage line carry within-wait progress; percent lives only in the
// progressbar's machine values). Cost is NOT rendered (audit ⑥). These tests pin
// the fixed bar count, the prep/tail exclusion, 100%-at-the-reveal-moment, the
// running-vs-done label, the square (non-circular) indicator, the stage-label
// resolution + titleLabel fallback, the countdown/stalled line, and the return
// link.

const TOTAL = WATCHED_ENTITY_STAGES.length // 4 (myth-zaqxh added world_introduction)

const stage = (id: string, status: StageProgress['status']): StageProgress => ({
  stage: id,
  status,
  userId: null,
  costUsd: 0,
  startedAt: null,
  completedAt: null,
})

// A SHORT stream: only the first watched entity stage has appeared (running). The
// card must still render all 4 bars — the taxonomy seeds the count, the stream
// only advances fills. 0 completed / 4 → 0%.
const SHORT: readonly StageProgress[] = [stage('world_and_factions', 'running')]

// Mid-wait: 2 of the 4 watched entity stages completed, a mid entity stage
// running (the boundary is now world_introduction, not yet reached). 2 / 4 → 50%.
const MID: readonly StageProgress[] = [
  stage('world_and_factions', 'completed'),
  stage('locations_and_npcs', 'completed'),
  stage('entity_relationships', 'running'),
]

const EXPECTED_MID_PERCENT = Math.round((2 / TOTAL) * 100) // 50

// Every watched entity stage completed → 100%, the done state — the wiki-reveal
// moment, even though the silent tail has not run at all.
const DONE: readonly StageProgress[] = WATCHED_ENTITY_STAGES.map((s) => stage(s, 'completed'))

// The resolved chrome labels the shell supplies (real MYT-100 copy). The stage map
// covers the running stage in the MID fixture; `titleLabel` doubles as the defensive
// fallback for any unmapped stage id.
const LABELS = {
  stageLabels: {
    entity_relationships: 'Drawing the connections',
  },
  titleLabel: 'Weaving your world',
  doneLabel: 'Your world is ready',
  progressLabel: 'World generation progress',
}

describe('WorldGenStatusCard — FIXED bars from the WATCHED_ENTITY_STAGES taxonomy', () => {
  it('renders all 4 watched-entity bars from frame one even when the stream is short', () => {
    const { container } = render(<WorldGenStatusCard stages={SHORT} {...LABELS} />)
    expect(container.querySelectorAll('[data-cell-state]')).toHaveLength(TOTAL)
    expect(container.querySelectorAll('[data-cell-state="running"]')).toHaveLength(1)
    // The remaining watched entity stages have not appeared in the stream → pending.
    expect(container.querySelectorAll('[data-cell-state="pending"]')).toHaveLength(TOTAL - 1)
  })

  it('renders 4 pending bars before the first snapshot frame (empty stream)', () => {
    const { container } = render(<WorldGenStatusCard stages={[]} {...LABELS} />)
    expect(container.querySelectorAll('[data-cell-state]')).toHaveLength(TOTAL)
    expect(container.querySelectorAll('[data-cell-state="pending"]')).toHaveLength(TOTAL)
  })

  it('IGNORES prep-stage stream entries — no bar exists for them (the two-act cut)', () => {
    // The whole prep act completed + the first entity stage running: no completed
    // bar (no prep bar exists to fill), exactly one running entity bar.
    const withPrep: readonly StageProgress[] = [
      ...PREP_STAGES.map((s) => stage(s, 'completed')),
      stage('world_and_factions', 'running'),
    ]
    const { container, getByRole } = render(<WorldGenStatusCard stages={withPrep} {...LABELS} />)
    expect(container.querySelectorAll('[data-cell-state]')).toHaveLength(TOTAL)
    expect(container.querySelectorAll('[data-cell-state="completed"]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-cell-state="running"]')).toHaveLength(1)
    expect(getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
  })

  it('IGNORES silent-tail stream entries — the tail is nobody’s wait (reveal timing)', () => {
    // Everything through the boundary completed AND tail stages underway: the card
    // holds full with no extra bars and no running cell — a tail entry never
    // renders as progress-to-come.
    const withTail: readonly StageProgress[] = [
      ...DONE,
      stage('entity_consolidation', 'completed'),
      stage('coherence_pass', 'running'),
    ]
    const { container, getByRole } = render(<WorldGenStatusCard stages={withTail} {...LABELS} />)
    expect(container.querySelectorAll('[data-cell-state]')).toHaveLength(TOTAL)
    expect(container.querySelectorAll('[data-cell-state="completed"]')).toHaveLength(TOTAL)
    expect(container.querySelectorAll('[data-cell-state="running"]')).toHaveLength(0)
    expect(getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
  })

  it('computes the progressbar percent as completed / 4 (fixed denominator), NOT over the stream length', () => {
    const { getByRole } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    expect(getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(EXPECTED_MID_PERCENT))
  })

  it('renders NO percent numeral — the bars + stage line carry progress (ux-run2 myth-uz1bn)', () => {
    // Run 2: "0%" rendered over six named markers already on the canvas, and the
    // numeral contradicted the bar fill. The numeral is gone in every state;
    // percent lives only in the progressbar's machine values.
    for (const stages of [[], SHORT, MID, DONE]) {
      const { queryByText, unmount } = render(<WorldGenStatusCard stages={stages} {...LABELS} />)
      expect(queryByText(/%/)).toBeNull()
      unmount()
    }
  })

  it('shows the RUNNING stage friendly label', () => {
    const { getByText } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    expect(getByText('Drawing the connections')).toBeInTheDocument()
  })

  it('falls back to the card titleLabel for an unmapped stage (DS owns no copy — never a placeholder)', () => {
    // No stageLabels, so the running stage (entity_relationships) has no friendly
    // label — it resolves to the generic `titleLabel` caption instead of any invented
    // placeholder. In the overlay variant that title shows twice: once as the framing
    // caption, once as the fallback running label.
    const { getAllByText } = render(
      <WorldGenStatusCard
        stages={MID}
        titleLabel="Weaving your world"
        doneLabel="Your world is ready"
        progressLabel="World generation progress"
      />,
    )
    expect(getAllByText('Weaving your world')).toHaveLength(2)
  })

  it('exposes the percent through a determinate progressbar', () => {
    const { getByRole } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    const bar = getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
  })
})

describe('WorldGenStatusCard — done state (the wiki-reveal moment)', () => {
  it('shows the done label when the BOUNDARY stage completes — the tail not required', () => {
    // No tail entry in the stream at all: the bars rest full the instant
    // connection-weaving lands, which is exactly when the route fires the reveal.
    const { getByText, getByRole } = render(<WorldGenStatusCard stages={DONE} {...LABELS} />)
    expect(getByText('Your world is ready')).toBeInTheDocument()
    expect(getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
  })

  it('stops the working indicator at full (no running cell, no pulse)', () => {
    const { container } = render(<WorldGenStatusCard stages={DONE} {...LABELS} />)
    expect(container.querySelector('[data-cell-state="running"]')).toBeNull()
    expect(container.querySelector('.animate-pulse')).toBeNull()
  })

  it('never shows the done state before the boundary stage (world_introduction) completes', () => {
    const { queryByText, getByRole } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    expect(queryByText('Your world is ready')).toBeNull()
    expect(getByRole('progressbar')).not.toHaveAttribute('aria-valuenow', '100')
  })
})

describe('WorldGenStatusCard — the per-second countdown (MYT-89 waiting-feedback)', () => {
  it('renders the ticking countdown line when supplied, aria-hidden (the progressbar carries AT semantics)', () => {
    const { getByTestId } = render(
      <WorldGenStatusCard stages={MID} countdownLabel="~2:14 left" {...LABELS} />,
    )
    const countdown = getByTestId('worldgen-status-countdown')
    expect(countdown).toHaveTextContent('~2:14 left')
    expect(countdown).toHaveAttribute('aria-hidden', 'true')
  })

  it('re-renders the countdown as the consumer ticks it (the per-second walk)', () => {
    const { getByTestId, rerender } = render(
      <WorldGenStatusCard stages={MID} countdownLabel="~2:14 left" {...LABELS} />,
    )
    rerender(<WorldGenStatusCard stages={MID} countdownLabel="~2:13 left" {...LABELS} />)
    expect(getByTestId('worldgen-status-countdown')).toHaveTextContent('~2:13 left')
  })

  it('renders NO countdown when countdownLabel is omitted (cold-start / no history)', () => {
    const { queryByText } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    expect(queryByText(/left/)).toBeNull()
  })
})

describe('WorldGenStatusCard — the stalled stand-in (ux-run2 myth-uz1bn: degrade in language, never sit)', () => {
  it('renders the stalled line in the countdown slot when the estimate exhausts', () => {
    // The consumer swaps the countdown for the stalled reassurance the instant
    // the estimate exhausts — the number never sits frozen at its floor.
    const { getByTestId, queryByTestId } = render(
      <WorldGenStatusCard stages={MID} stalledLabel="Still working. This is taking longer than usual." {...LABELS} />,
    )
    expect(getByTestId('worldgen-status-stalled')).toHaveTextContent(
      'Still working. This is taking longer than usual.',
    )
    expect(queryByTestId('worldgen-status-countdown')).toBeNull()
  })

  it('is meaningful content (a one-time state change) — NOT aria-hidden', () => {
    const { getByTestId } = render(
      <WorldGenStatusCard stages={MID} stalledLabel="Still working." {...LABELS} />,
    )
    expect(getByTestId('worldgen-status-stalled')).not.toHaveAttribute('aria-hidden')
  })

  it('prefers the live countdown when both are supplied (defensive — the consumer passes at most one)', () => {
    const { getByTestId, queryByTestId } = render(
      <WorldGenStatusCard stages={MID} countdownLabel="Ready in about 2 min" stalledLabel="Still working." {...LABELS} />,
    )
    expect(getByTestId('worldgen-status-countdown')).toBeInTheDocument()
    expect(queryByTestId('worldgen-status-stalled')).toBeNull()
  })
})

describe('WorldGenStatusCard — the quiet return link (ux-run2 myth-t11az: no one-way door)', () => {
  it('renders the return link and fires onReturn when pressed', () => {
    const onReturn = vi.fn()
    const { getByRole } = render(
      <WorldGenStatusCard stages={MID} returnLabel="Wait quietly instead" onReturn={onReturn} {...LABELS} />,
    )
    const link = getByRole('button', { name: 'Wait quietly instead' })
    fireEvent.click(link)
    expect(onReturn).toHaveBeenCalledTimes(1)
  })

  it('re-enables pointer events on the link (the card itself is a pointer-transparent readout)', () => {
    const { getByRole } = render(
      <WorldGenStatusCard stages={MID} returnLabel="Wait quietly instead" onReturn={() => undefined} {...LABELS} />,
    )
    expect(getByRole('button', { name: 'Wait quietly instead' }).className).toMatch(/pointer-events-auto/)
  })

  it('renders no link when the consumer omits it (the reveal moment / non-returnable hosts)', () => {
    const { queryByRole } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    expect(queryByRole('button')).toBeNull()
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

describe('WorldGenStatusCard — footer variant (MYT-89 audit v2: the mobile status footer)', () => {
  // On a narrow viewport the graph pane goes full-bleed and the status leaves the
  // canvas for a compact bottom bar: the SUBSTANCE (running-stage label, percent,
  // the FIXED segmented square bars, the per-second countdown) is kept; the framing
  // caption is dropped (the footer reclaims real estate, it doesn't relocate the
  // card verbatim). The overlay stays the default — the shipped desktop card.

  it('keeps the substance: running label, progressbar, all bars, the countdown', () => {
    const { container, getByText, getByTestId, getByRole } = render(
      <WorldGenStatusCard
        variant="footer"
        stages={MID}
        countdownLabel="~2:14 left"
        {...LABELS}
      />,
    )
    expect(container.querySelector('[data-variant="footer"]')).not.toBeNull()
    expect(getByText('Drawing the connections')).toBeInTheDocument()
    expect(getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(EXPECTED_MID_PERCENT))
    expect(container.querySelectorAll('[data-cell-state]')).toHaveLength(TOTAL)
    expect(getByTestId('worldgen-status-countdown')).toHaveTextContent('~2:14 left')
  })

  it('keeps the return link available in the footer (mobile is not a one-way door either)', () => {
    const { getByRole } = render(
      <WorldGenStatusCard
        variant="footer"
        stages={MID}
        returnLabel="Wait quietly instead"
        onReturn={() => undefined}
        {...LABELS}
      />,
    )
    expect(getByRole('button', { name: 'Wait quietly instead' })).toBeInTheDocument()
  })

  it('drops the framing caption (compact — the title is overlay chrome)', () => {
    const { queryByText } = render(
      <WorldGenStatusCard variant="footer" stages={MID} {...LABELS} />,
    )
    // LABELS.titleLabel ("Weaving your world") is the overlay caption; the footer
    // drops it, and the running stage is mapped, so the title appears nowhere.
    expect(queryByText('Weaving your world')).toBeNull()
  })

  it('is a full-width in-flow bar, NOT an absolute overlay', () => {
    const { container } = render(<WorldGenStatusCard variant="footer" stages={MID} {...LABELS} />)
    const root = container.querySelector('[data-variant="footer"]')
    expect(root?.className).not.toMatch(/absolute/)
    expect(root?.className).toMatch(/w-full/)
  })

  it('defaults to the overlay variant — the shipped desktop card, unchanged', () => {
    const { container } = render(<WorldGenStatusCard stages={MID} {...LABELS} />)
    const overlay = container.querySelector('[data-variant="overlay"]')
    expect(overlay).not.toBeNull()
    expect(overlay?.className).toMatch(/absolute/)
    expect(container.querySelector('[data-variant="footer"]')).toBeNull()
  })

  it('keeps the paper register (square cells, pulse only on the running cell)', () => {
    const { container } = render(<WorldGenStatusCard variant="footer" stages={MID} {...LABELS} />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('.rounded-full')).toBeNull()
    expect(container.querySelector('[data-cell-state="running"]')).toHaveClass('animate-pulse')
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <WorldGenStatusCard
        variant="footer"
        stages={MID}
        countdownLabel="~2:14 left"
        {...LABELS}
      />,
    )
    expect(await axe(container)).toHaveNoViolations()
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
      <WorldGenStatusCard stages={MID} countdownLabel="~2:14 left" {...LABELS} />,
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
