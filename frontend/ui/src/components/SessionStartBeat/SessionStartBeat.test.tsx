import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render, within } from '@testing-library/react'
import { axe } from 'jest-axe'
import { SessionStartBeat } from './SessionStartBeat.tsx'

// The resolved labels the shell supplies (props are DATA — the component renders
// them verbatim). Real MYT-100 copy (play.start.prep / play.start.connecting); the
// heading is a realistic fixture (the app wires its own key).
const HEADING = 'The table gathers'
const PREP_LABEL = "The DM is preparing today's session…"
const CONNECTING_LABEL = 'Joining the table…'

function renderBeat(phase: 'prep' | 'connecting', reducedMotion = false) {
  return render(
    <SessionStartBeat
      phase={phase}
      reducedMotion={reducedMotion}
      heading={HEADING}
      prepLabel={PREP_LABEL}
      connectingLabel={CONNECTING_LABEL}
    />,
  )
}

describe('SessionStartBeat', () => {
  it('renders both phase labels as rows, prep then connecting', () => {
    const rows = renderBeat('prep').getAllByTestId('session-start-beat-row')
    expect(rows.map((r) => r.textContent)).toEqual([PREP_LABEL, CONNECTING_LABEL])
    expect(rows.map((r) => r.getAttribute('data-phase'))).toEqual(['prep', 'connecting'])
  })

  it('reflects the active phase on the root', () => {
    const { getByTestId, rerender } = renderBeat('prep')
    expect(getByTestId('session-start-beat')).toHaveAttribute('data-phase', 'prep')
    rerender(
      <SessionStartBeat
        phase="connecting"
        reducedMotion={false}
        heading={HEADING}
        prepLabel={PREP_LABEL}
        connectingLabel={CONNECTING_LABEL}
      />,
    )
    expect(getByTestId('session-start-beat')).toHaveAttribute('data-phase', 'connecting')
  })

  it('derives each row state from the phase (active/pending in prep; done/active in connecting)', () => {
    const prep = within(renderBeat('prep').container)
    expect(
      prep.getAllByTestId('session-start-beat-row').map((r) => r.getAttribute('data-state')),
    ).toEqual(['active', 'pending'])

    const connecting = within(renderBeat('connecting').container)
    expect(
      connecting.getAllByTestId('session-start-beat-row').map((r) => r.getAttribute('data-state')),
    ).toEqual(['done', 'active'])
  })

  it('styles the three row states distinctly, with a SOLID pending token (never a sub-AA opacity dim)', () => {
    const prepRows = within(renderBeat('prep').container).getAllByTestId('session-start-beat-row')
    const active = prepRows[0]?.className ?? ''
    const pending = prepRows[1]?.className ?? ''
    const done = within(renderBeat('connecting').container).getAllByTestId('session-start-beat-row')[0]?.className ?? ''

    // Distinct treatments per state.
    expect(active).not.toEqual(pending)
    expect(done).not.toEqual(pending)
    // Active reads emphasized (ember accent); pending reads muted via the SOLID tertiary-ink
    // token — NOT a static `opacity-NN` dim (which fell below the 4.5:1 contrast floor on paper).
    expect(active).toMatch(/accent/)
    expect(pending).toMatch(/ink-tertiary/)
    expect(pending).not.toMatch(/opacity-\d/)
  })

  it('announces the ACTIVE phase label through an SR live region', () => {
    const { getByTestId, rerender } = renderBeat('prep')
    const live = getByTestId('session-start-beat-live')
    expect(live).toHaveAttribute('role', 'status')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live).toHaveTextContent(PREP_LABEL)

    rerender(
      <SessionStartBeat
        phase="connecting"
        reducedMotion={false}
        heading={HEADING}
        prepLabel={PREP_LABEL}
        connectingLabel={CONNECTING_LABEL}
      />,
    )
    expect(getByTestId('session-start-beat-live')).toHaveTextContent(CONNECTING_LABEL)
  })

  it('drives the fill meter toward completion: prep underway, connecting fully landed', () => {
    const prepFigure = within(renderBeat('prep').container).getByTestId('session-start-beat-figure')
    expect(prepFigure).toHaveAttribute('data-beat-mode', 'fill')
    const prepLevel = Number(prepFigure.getAttribute('data-beat-level'))
    // Underway, not complete.
    expect(prepLevel).toBeGreaterThan(0)
    expect(prepLevel).toBeLessThan(1)

    const connectFigure = within(renderBeat('connecting').container).getByTestId('session-start-beat-figure')
    // Landed at completion.
    expect(connectFigure).toHaveAttribute('data-beat-level', '1')
    // The prep→connecting rise is the beat accelerating toward completion.
    expect(Number(connectFigure.getAttribute('data-beat-level'))).toBeGreaterThan(prepLevel)
  })

  it('is aria-busy (a loading beat is busy the whole time it is mounted)', () => {
    expect(renderBeat('prep').getByTestId('session-start-beat')).toHaveAttribute('aria-busy', 'true')
  })

  it('threads reduced motion to the beat so it lands instantly (no churn)', () => {
    const motion = within(renderBeat('prep', false).container)
    expect(motion.getByTestId('session-start-beat')).toHaveAttribute('data-reduced-motion', 'false')
    const still = within(renderBeat('prep', true).container)
    expect(still.getByTestId('session-start-beat')).toHaveAttribute('data-reduced-motion', 'true')
  })

  it('is flat 1-bit / square (no rounded corners)', () => {
    expect(renderBeat('prep').getByTestId('session-start-beat').className).toContain('rounded-none')
  })

  it('forwards the ref to the root element', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <SessionStartBeat
        ref={ref}
        phase="prep"
        reducedMotion={false}
        heading={HEADING}
        prepLabel={PREP_LABEL}
        connectingLabel={CONNECTING_LABEL}
      />,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations (both phases)', async () => {
    expect(await axe(renderBeat('prep').container)).toHaveNoViolations()
    expect(await axe(renderBeat('connecting', true).container)).toHaveNoViolations()
  })
})
