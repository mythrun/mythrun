import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render, within } from '@testing-library/react'
import { axe } from 'jest-axe'
import type { LoadingBeat } from '@mythrun/client-core/contract'
import { CharacterLoadingBeat } from './CharacterLoadingBeat.tsx'

// The resolved kicker the shell supplies — since ux-run3 myth-1yxfr the shell
// passes the FACTUAL stage counter (the old "Bringing them to life…" eyebrow
// doubled the screen H1 and carried a second live ellipsis).
const HEADING = 'Stage 3 of 4'

// Four ordered beats mid-progress: two done, one surfacing, one still pending —
// the real stage-ladder copy (praise-ledger — reused verbatim).
const MID_BEATS: LoadingBeat[] = [
  { id: 'name', label: 'A name surfaces', state: 'done' },
  { id: 'class', label: 'A calling takes shape', state: 'done' },
  { id: 'scores', label: 'Ability scores settle', state: 'active' },
  { id: 'kit', label: 'Equipment is gathered', state: 'pending' },
]

const ALL_DONE: LoadingBeat[] = MID_BEATS.map((b) => ({ ...b, state: 'done' }))
const ALL_PENDING: LoadingBeat[] = MID_BEATS.map((b) => ({ ...b, state: 'pending' }))

describe('CharacterLoadingBeat', () => {
  it('renders every beat label, in order — DONE rows settle into a period, the ACTIVE row alone carries the ellipsis', () => {
    // (The active beat's label also appears in the SR live region, so assert via
    // the rows rather than a document-wide text query.) The wait grammar
    // (ux-run3 myth-1yxfr): a completed stage RESOLVES its sentence ("A name
    // surfaces."), the one thing happening now trails the working ellipsis, and
    // a pending stage stays a bare muted phrase — run 3 could not tell DONE from
    // ACTIVE when two dark lines both trailed dots.
    const { getAllByTestId } = render(<CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} />)
    const rows = getAllByTestId('character-loading-beat-row')
    expect(rows.map((r) => r.textContent)).toEqual([
      'A name surfaces.',
      'A calling takes shape.',
      'Ability scores settle…',
      'Equipment is gathered',
    ])
  })

  it('EXACTLY ONE line on screen carries the ellipsis — even when supplied labels already end with one (ux-run3 myth-1yxfr)', () => {
    // Defensive against copy drift: a done label arriving with its own trailing
    // ellipsis resolves to a period; only the active row ends with "…".
    const dotted: LoadingBeat[] = [
      { id: 'name', label: 'A name surfaces…', state: 'done' },
      { id: 'class', label: 'A calling takes shape…', state: 'active' },
      { id: 'scores', label: 'Ability scores settle…', state: 'pending' },
    ]
    const { getAllByTestId } = render(<CharacterLoadingBeat heading={HEADING} beats={dotted} reducedMotion={false} />)
    const texts = getAllByTestId('character-loading-beat-row').map((r) => r.textContent)
    expect(texts).toEqual(['A name surfaces.', 'A calling takes shape…', 'Ability scores settle'])
    expect(texts.filter((t) => t.endsWith('…'))).toHaveLength(1)
  })

  it('tags each row with its beat state so done/active/pending style distinctly', () => {
    const { getAllByTestId } = render(<CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} />)
    const rows = getAllByTestId('character-loading-beat-row')
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['done', 'done', 'active', 'pending'])
    const classByState = new Map(rows.map((r) => [r.dataset.state, r.className]))
    expect(classByState.get('active')).not.toEqual(classByState.get('pending'))
    expect(classByState.get('done')).not.toEqual(classByState.get('pending'))
    // Pending reads muted via the solid AA tertiary-ink token — NOT a static `opacity-NN` dim.
    expect(classByState.get('pending')).toMatch(/ink-tertiary/)
    expect(classByState.get('pending')).not.toMatch(/opacity-\d/)
    // The three-state read (ux-run2 myth-8ddt4): done settles into QUIET ACCENT;
    // ACTIVE is the emphasized ink line (the one thing happening right now).
    expect(classByState.get('done')).toMatch(/accent/)
    expect(classByState.get('active')).toMatch(/font-medium/)
    expect(classByState.get('active')).toMatch(/text-ink/)
  })

  it('is a plain typographic list — no bordered rows (the button-cosplay fix, ux-run2 myth-8ddt4)', () => {
    // Run 2: four full-width bordered rectangles read as disabled BUTTONS in this
    // square-cornered register. The ladder is now a typographic list: no row
    // borders; a small leading FILLED square marks completed stages instead.
    const { getAllByTestId } = render(<CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} />)
    for (const row of getAllByTestId('character-loading-beat-row')) {
      expect(row.className).not.toMatch(/border/)
    }
    const markers = getAllByTestId('character-loading-beat-marker')
    expect(markers).toHaveLength(MID_BEATS.length)
    const fillByState = getAllByTestId('character-loading-beat-row').map((row, i) => [
      row.dataset.state,
      markers[i]?.className ?? '',
    ])
    for (const [state, cls] of fillByState) {
      if (state === 'done') expect(cls).toMatch(/bg-accent/)
      else expect(cls).toMatch(/bg-transparent/)
    }
  })

  it('sets the meter level from the done/total ratio', () => {
    // 2 of 4 done → 0.5.
    const { getByTestId } = render(<CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} />)
    const figure = getByTestId('character-loading-beat-figure')
    expect(figure).toHaveAttribute('data-beat-mode', 'fill')
    expect(figure).toHaveAttribute('data-beat-level', '0.5')
  })

  it('drives the meter to full when every beat is done', () => {
    const { getByTestId } = render(<CharacterLoadingBeat heading={HEADING} beats={ALL_DONE} reducedMotion={false} />)
    expect(getByTestId('character-loading-beat-figure')).toHaveAttribute('data-beat-level', '1')
  })

  it('IDLES at zero progress — a nearly blank poised shimmer, emptier than any accretion state (ux-run3 myth-c96rf)', () => {
    // Run 2 fixed the dead empty rectangle with the breathe field (myth-zyk6o);
    // run 3 caught the over-correction: breathing at ~half density made the band
    // read near-FULL at second zero, so the first real beat landing EMPTIED it —
    // a progress bar promising 90% at t=0. The zero-state is now the faint IDLE
    // shimmer at the fill's origin: still alive from frame one, but unmistakably
    // empty-and-waiting; the determinate fill takes over on the first done beat
    // and density only ever increases.
    const { getByTestId } = render(
      <CharacterLoadingBeat heading={HEADING} beats={ALL_PENDING} reducedMotion={false} />,
    )
    const figure = getByTestId('character-loading-beat-figure')
    expect(figure).toHaveAttribute('data-beat-mode', 'idle')
    expect(figure).not.toHaveAttribute('data-beat-level')
  })

  it('frames the figure with the panel-weight border, never the heaviest stroke on the page', () => {
    // "Border must not outweigh the containing panel" (myth-zyk6o): the figure
    // wears the muted tone (panel border-border), not the ink frame.
    const { getByTestId } = render(<CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} />)
    const figure = getByTestId('character-loading-beat-figure')
    expect(figure.className).toMatch(/border-border/)
    expect(figure.className).not.toMatch(/border-ink/)
  })

  it('caps the panel width — a readout, not an admin table (ux-run2 myth-8ddt4)', () => {
    const { getByTestId } = render(<CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} />)
    expect(getByTestId('character-loading-beat').className).toMatch(/max-w-\[38rem\]/)
  })

  it('is aria-busy while any beat is unfinished, and settles once all are done', () => {
    const { getByTestId, rerender } = render(
      <CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} />,
    )
    expect(getByTestId('character-loading-beat')).toHaveAttribute('aria-busy', 'true')
    rerender(<CharacterLoadingBeat heading={HEADING} beats={ALL_DONE} reducedMotion={false} />)
    expect(getByTestId('character-loading-beat')).toHaveAttribute('aria-busy', 'false')
  })

  it('announces the active beat through an SR live region (plain label — the ellipsis is visual pacing)', () => {
    const { getByTestId } = render(<CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} />)
    const live = getByTestId('character-loading-beat-live')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live.textContent).toBe('Ability scores settle')
  })

  it('threads reduced motion to the beat so the fill lands instantly', () => {
    const motion = within(render(<CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} />).container)
    expect(motion.getByTestId('character-loading-beat')).toHaveAttribute('data-reduced-motion', 'false')
    const still = within(render(<CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion />).container)
    expect(still.getByTestId('character-loading-beat')).toHaveAttribute('data-reduced-motion', 'true')
  })

  it('is flat 1-bit / square (no rounded corners)', () => {
    const { getByTestId } = render(<CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} />)
    expect(getByTestId('character-loading-beat').className).toContain('rounded-none')
  })

  it('renders the countdown label as a quiet aria-hidden tabular line when provided', () => {
    const { getByTestId } = render(
      <CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} countdownLabel="Ready in about 2 min" />,
    )
    const countdown = getByTestId('character-loading-beat-countdown')
    expect(countdown.textContent).toBe('Ready in about 2 min')
    // aria-hidden: the SR live region stays the single AT source of truth.
    expect(countdown).toHaveAttribute('aria-hidden', 'true')
    // The world-gen countdown register: quiet tertiary ink, tabular digits, wrap-safe.
    expect(countdown.className).toMatch(/tabular-nums/)
    expect(countdown.className).toMatch(/text-ink-tertiary/)
    expect(countdown.className).toMatch(/break-words/)
  })

  it('seats the estimate on the kicker line, label·value — never floating attached to nothing (ux-run2 myth-8ddt4)', () => {
    const { getByTestId, getByText } = render(
      <CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} countdownLabel="Ready in about 2 min" />,
    )
    const header = getByTestId('character-loading-beat-header')
    expect(header).toContainElement(getByText(HEADING))
    expect(header).toContainElement(getByTestId('character-loading-beat-countdown'))
  })

  it('omits the countdown line entirely when no label is provided (no fake estimate)', () => {
    const { queryByTestId } = render(<CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} />)
    expect(queryByTestId('character-loading-beat-countdown')).toBeNull()
  })

  it('renders the stalled line as meaningful (NOT aria-hidden) content when the estimate exhausts', () => {
    // The never-dead-zero fix: once the estimate exhausts the surface swaps the
    // countdown for this indeterminate reassurance. Unlike the per-second-ish
    // countdown it is a one-time state change, so it is real (non-aria-hidden)
    // content, styled as a calm secondary-ink line.
    const { getByTestId } = render(
      <CharacterLoadingBeat
        heading={HEADING}
        beats={MID_BEATS}
        reducedMotion={false}
        stalledLabel="Still working. This one's taking a while."
      />,
    )
    const stalled = getByTestId('character-loading-beat-stalled')
    expect(stalled.textContent).toBe("Still working. This one's taking a while.")
    expect(stalled).not.toHaveAttribute('aria-hidden')
    expect(stalled.className).toMatch(/text-ink-secondary/)
  })

  it('shows the stalled line IN PLACE OF the countdown (never both — no dead 0:00 alongside it)', () => {
    // The consumer passes at most one, but assert the precedence so a stalled
    // wait can never render a dead countdown next to the reassurance.
    const { getByTestId, queryByTestId } = render(
      <CharacterLoadingBeat
        heading={HEADING}
        beats={MID_BEATS}
        reducedMotion={false}
        countdownLabel="under a minute remaining"
        stalledLabel="Still working. This one's taking a while."
      />,
    )
    expect(getByTestId('character-loading-beat-stalled')).toBeInTheDocument()
    expect(queryByTestId('character-loading-beat-countdown')).toBeNull()
  })

  it('forwards the ref to the root element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<CharacterLoadingBeat ref={ref} heading={HEADING} beats={MID_BEATS} reducedMotion={false} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations (mid-progress, complete, and with the countdown)', async () => {
    const mid = render(<CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} />)
    expect(await axe(mid.container)).toHaveNoViolations()
    const done = render(<CharacterLoadingBeat heading={HEADING} beats={ALL_DONE} reducedMotion />)
    expect(await axe(done.container)).toHaveNoViolations()
    const counting = render(
      <CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} countdownLabel="2 min remaining" />,
    )
    expect(await axe(counting.container)).toHaveNoViolations()
    const stalled = render(
      <CharacterLoadingBeat
        heading={HEADING}
        beats={MID_BEATS}
        reducedMotion={false}
        stalledLabel="Still working. This one's taking a while."
      />,
    )
    expect(await axe(stalled.container)).toHaveNoViolations()
  })
})
