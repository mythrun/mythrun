import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render, within } from '@testing-library/react'
import { axe } from 'jest-axe'
import type { LoadingBeat } from '@mythrun/client-core/contract'
import { CharacterLoadingBeat } from './CharacterLoadingBeat.tsx'

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
    const { getAllByTestId } = render(<CharacterLoadingBeat beats={MID_BEATS} reducedMotion={false} />)
    const rows = getAllByTestId('character-loading-beat-row')
    expect(rows.map((r) => r.textContent)).toEqual(MID_BEATS.map((b) => b.label))
  })

  it('tags each row with its beat state so done/active/pending style distinctly', () => {
    const { getAllByTestId } = render(<CharacterLoadingBeat beats={MID_BEATS} reducedMotion={false} />)
    const rows = getAllByTestId('character-loading-beat-row')
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['done', 'done', 'active', 'pending'])
    // The three states resolve to distinct treatments (assert class tokens, not pixels).
    const classByState = new Map(rows.map((r) => [r.dataset.state, r.className]))
    expect(classByState.get('active')).not.toEqual(classByState.get('pending'))
    expect(classByState.get('done')).not.toEqual(classByState.get('pending'))
    // Pending reads muted; active reads emphasized (ember).
    expect(classByState.get('pending')).toMatch(/opacity/)
    expect(classByState.get('active')).toMatch(/accent/)
  })

  it('sets the dither fill proportion from the done/total ratio', () => {
    // 2 of 4 done → 50%.
    const { getByTestId } = render(<CharacterLoadingBeat beats={MID_BEATS} reducedMotion={false} />)
    const fill = getByTestId('character-loading-beat-fill')
    expect(fill).toHaveAttribute('data-fill-pct', '50')
    expect(fill.style.height).toBe('50%')
  })

  it('shows a full fill when every beat is done', () => {
    const { getByTestId } = render(<CharacterLoadingBeat beats={ALL_DONE} reducedMotion={false} />)
    const fill = getByTestId('character-loading-beat-fill')
    expect(fill).toHaveAttribute('data-fill-pct', '100')
    expect(fill.style.height).toBe('100%')
  })

  it('is aria-busy while any beat is unfinished, and settles once all are done', () => {
    const { getByTestId, rerender } = render(
      <CharacterLoadingBeat beats={MID_BEATS} reducedMotion={false} />,
    )
    expect(getByTestId('character-loading-beat')).toHaveAttribute('aria-busy', 'true')
    rerender(<CharacterLoadingBeat beats={ALL_DONE} reducedMotion={false} />)
    expect(getByTestId('character-loading-beat')).toHaveAttribute('aria-busy', 'false')
  })

  it('announces the active beat through an SR live region', () => {
    const { getByTestId } = render(<CharacterLoadingBeat beats={MID_BEATS} reducedMotion={false} />)
    const live = getByTestId('character-loading-beat-live')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live).toHaveTextContent('rolling ability scores…')
  })

  it('animates the fill by default but freezes it under reduced motion', () => {
    // Two renders in one test → scope each query to its own container.
    const motion = within(render(<CharacterLoadingBeat beats={MID_BEATS} reducedMotion={false} />).container)
    expect(motion.getByTestId('character-loading-beat-fill').className).toMatch(/transition/)
    expect(motion.getByTestId('character-loading-beat')).toHaveAttribute('data-reduced-motion', 'false')

    const still = within(render(<CharacterLoadingBeat beats={MID_BEATS} reducedMotion />).container)
    expect(still.getByTestId('character-loading-beat-fill').className).not.toMatch(/transition/)
    expect(still.getByTestId('character-loading-beat')).toHaveAttribute('data-reduced-motion', 'true')
  })

  it('is flat 1-bit / square (no rounded corners)', () => {
    const { getByTestId } = render(<CharacterLoadingBeat beats={MID_BEATS} reducedMotion={false} />)
    expect(getByTestId('character-loading-beat').className).toContain('rounded-none')
  })

  it('forwards the ref to the root element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<CharacterLoadingBeat ref={ref} beats={MID_BEATS} reducedMotion={false} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations (mid-progress and complete)', async () => {
    const mid = render(<CharacterLoadingBeat beats={MID_BEATS} reducedMotion={false} />)
    expect(await axe(mid.container)).toHaveNoViolations()
    const done = render(<CharacterLoadingBeat beats={ALL_DONE} reducedMotion />)
    expect(await axe(done.container)).toHaveNoViolations()
  })
})
