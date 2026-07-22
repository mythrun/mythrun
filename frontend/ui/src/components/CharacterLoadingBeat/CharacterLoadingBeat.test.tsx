import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render, within } from '@testing-library/react'
import { axe } from 'jest-axe'
import type { LoadingBeat } from '@mythrun/client-core/contract'
import { CharacterLoadingBeat } from './CharacterLoadingBeat.tsx'

// The resolved beat heading the shell supplies (real MYT-100 copy).
const HEADING = 'Bringing them to life…'

// Four ordered beats mid-progress: two done, one surfacing, one still pending —
// the mockup's "a name surfaces / class settles / rolling scores / gathering kit".
const MID_BEATS: LoadingBeat[] = [
  { id: 'name', label: 'Kessa Vurm — a name surfaces', state: 'done' },
  { id: 'class', label: 'Human · Fighter — Champion', state: 'done' },
  { id: 'scores', label: 'rolling ability scores…', state: 'active' },
  { id: 'kit', label: 'gathering equipment…', state: 'pending' },
]

const ALL_DONE: LoadingBeat[] = MID_BEATS.map((b) => ({ ...b, state: 'done' }))

describe('CharacterLoadingBeat', () => {
  it('renders every beat label, in order, as a row', () => {
    // (The active beat's label also appears in the SR live region, so assert via
    // the rows rather than a document-wide text query.)
    const { getAllByTestId } = render(<CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} />)
    const rows = getAllByTestId('character-loading-beat-row')
    expect(rows.map((r) => r.textContent)).toEqual(MID_BEATS.map((b) => b.label))
  })

  it('tags each row with its beat state so done/active/pending style distinctly', () => {
    const { getAllByTestId } = render(<CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} />)
    const rows = getAllByTestId('character-loading-beat-row')
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['done', 'done', 'active', 'pending'])
    const classByState = new Map(rows.map((r) => [r.dataset.state, r.className]))
    expect(classByState.get('active')).not.toEqual(classByState.get('pending'))
    expect(classByState.get('done')).not.toEqual(classByState.get('pending'))
    // Pending reads muted via the solid AA tertiary-ink token — NOT a static `opacity-NN` dim.
    // Active reads emphasized (ember).
    expect(classByState.get('pending')).toMatch(/ink-tertiary/)
    expect(classByState.get('pending')).not.toMatch(/opacity-\d/)
    expect(classByState.get('active')).toMatch(/accent/)
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

  it('is aria-busy while any beat is unfinished, and settles once all are done', () => {
    const { getByTestId, rerender } = render(
      <CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} />,
    )
    expect(getByTestId('character-loading-beat')).toHaveAttribute('aria-busy', 'true')
    rerender(<CharacterLoadingBeat heading={HEADING} beats={ALL_DONE} reducedMotion={false} />)
    expect(getByTestId('character-loading-beat')).toHaveAttribute('aria-busy', 'false')
  })

  it('announces the active beat through an SR live region', () => {
    const { getByTestId } = render(<CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} />)
    const live = getByTestId('character-loading-beat-live')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live).toHaveTextContent('rolling ability scores…')
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
      <CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} countdownLabel="~2:10 left" />,
    )
    const countdown = getByTestId('character-loading-beat-countdown')
    expect(countdown.textContent).toBe('~2:10 left')
    // aria-hidden: the SR live region stays the single AT source of truth.
    expect(countdown).toHaveAttribute('aria-hidden', 'true')
    // The world-gen countdown register: quiet tertiary ink, tabular digits, wrap-safe.
    expect(countdown.className).toMatch(/tabular-nums/)
    expect(countdown.className).toMatch(/text-ink-tertiary/)
    expect(countdown.className).toMatch(/break-words/)
  })

  it('omits the countdown line entirely when no label is provided (no fake estimate)', () => {
    const { queryByTestId } = render(<CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} />)
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
      <CharacterLoadingBeat heading={HEADING} beats={MID_BEATS} reducedMotion={false} countdownLabel="~2:10 left" />,
    )
    expect(await axe(counting.container)).toHaveNoViolations()
  })
})
