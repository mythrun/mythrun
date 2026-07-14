import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render, within } from '@testing-library/react'
import { axe } from 'jest-axe'
import { SessionStartBeat } from './SessionStartBeat.tsx'

// The two resolved [ph:] labels the shell supplies (props are DATA — the component
// renders them verbatim). Sample strings kept clearly placeholder-shaped.
const PREP_LABEL = '[ph: the DM is preparing tonight’s session…]'
const CONNECTING_LABEL = '[ph: connecting to the table…]'

describe('SessionStartBeat', () => {
  it('renders both phase labels as rows, prep then connecting', () => {
    const { getAllByTestId } = render(
      <SessionStartBeat
        phase="prep"
        reducedMotion={false}
        prepLabel={PREP_LABEL}
        connectingLabel={CONNECTING_LABEL}
      />,
    )
    const rows = getAllByTestId('session-start-beat-row')
    expect(rows.map((r) => r.textContent)).toEqual([PREP_LABEL, CONNECTING_LABEL])
    expect(rows.map((r) => r.getAttribute('data-phase'))).toEqual(['prep', 'connecting'])
  })

  it('reflects the active phase on the root', () => {
    const { getByTestId, rerender } = render(
      <SessionStartBeat
        phase="prep"
        reducedMotion={false}
        prepLabel={PREP_LABEL}
        connectingLabel={CONNECTING_LABEL}
      />,
    )
    expect(getByTestId('session-start-beat')).toHaveAttribute('data-phase', 'prep')
    rerender(
      <SessionStartBeat
        phase="connecting"
        reducedMotion={false}
        prepLabel={PREP_LABEL}
        connectingLabel={CONNECTING_LABEL}
      />,
    )
    expect(getByTestId('session-start-beat')).toHaveAttribute('data-phase', 'connecting')
  })

  it('derives each row state from the phase (active/pending in prep; done/active in connecting)', () => {
    const prep = within(
      render(
        <SessionStartBeat
          phase="prep"
          reducedMotion={false}
          prepLabel={PREP_LABEL}
          connectingLabel={CONNECTING_LABEL}
        />,
      ).container,
    )
    expect(
      prep.getAllByTestId('session-start-beat-row').map((r) => r.getAttribute('data-state')),
    ).toEqual(['active', 'pending'])

    const connecting = within(
      render(
        <SessionStartBeat
          phase="connecting"
          reducedMotion={false}
          prepLabel={PREP_LABEL}
          connectingLabel={CONNECTING_LABEL}
        />,
      ).container,
    )
    expect(
      connecting.getAllByTestId('session-start-beat-row').map((r) => r.getAttribute('data-state')),
    ).toEqual(['done', 'active'])
  })

  it('styles the three row states distinctly, with a SOLID pending token (never a sub-AA opacity dim)', () => {
    // In the connecting phase all three states are present at once (prep=done,
    // connecting=active) — plus a prep render for the pending state.
    const prep = within(
      render(
        <SessionStartBeat
          phase="prep"
          reducedMotion={false}
          prepLabel={PREP_LABEL}
          connectingLabel={CONNECTING_LABEL}
        />,
      ).container,
    )
    const prepRows = prep.getAllByTestId('session-start-beat-row')
    const active = prepRows[0]?.className ?? ''
    const pending = prepRows[1]?.className ?? ''

    const connecting = within(
      render(
        <SessionStartBeat
          phase="connecting"
          reducedMotion={false}
          prepLabel={PREP_LABEL}
          connectingLabel={CONNECTING_LABEL}
        />,
      ).container,
    )
    const done = connecting.getAllByTestId('session-start-beat-row')[0]?.className ?? ''

    // Distinct treatments per state.
    expect(active).not.toEqual(pending)
    expect(done).not.toEqual(pending)
    // Active reads emphasized (ember accent); pending reads muted via the SOLID
    // tertiary-ink token — NOT a static `opacity-NN` dim (which fell below the
    // 4.5:1 contrast floor on paper — the CharacterLoadingBeat contrast lesson).
    expect(active).toMatch(/accent/)
    expect(pending).toMatch(/ink-tertiary/)
    expect(pending).not.toMatch(/opacity-\d/)
  })

  it('announces the ACTIVE phase label through an SR live region', () => {
    const { getByTestId, rerender } = render(
      <SessionStartBeat
        phase="prep"
        reducedMotion={false}
        prepLabel={PREP_LABEL}
        connectingLabel={CONNECTING_LABEL}
      />,
    )
    const live = getByTestId('session-start-beat-live')
    expect(live).toHaveAttribute('role', 'status')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live).toHaveTextContent(PREP_LABEL)

    rerender(
      <SessionStartBeat
        phase="connecting"
        reducedMotion={false}
        prepLabel={PREP_LABEL}
        connectingLabel={CONNECTING_LABEL}
      />,
    )
    expect(getByTestId('session-start-beat-live')).toHaveTextContent(CONNECTING_LABEL)
  })

  it('accelerates the fill toward completion: prep underway, connecting fully landed', () => {
    const prep = within(
      render(
        <SessionStartBeat
          phase="prep"
          reducedMotion={false}
          prepLabel={PREP_LABEL}
          connectingLabel={CONNECTING_LABEL}
        />,
      ).container,
    )
    const prepFill = prep.getByTestId('session-start-beat-fill')
    const prepPct = Number(prepFill.getAttribute('data-fill-pct'))
    // Underway, not complete.
    expect(prepPct).toBeGreaterThan(0)
    expect(prepPct).toBeLessThan(100)
    expect(prepFill.style.height).toBe(`${String(prepPct)}%`)

    const connecting = within(
      render(
        <SessionStartBeat
          phase="connecting"
          reducedMotion={false}
          prepLabel={PREP_LABEL}
          connectingLabel={CONNECTING_LABEL}
        />,
      ).container,
    )
    const connectFill = connecting.getByTestId('session-start-beat-fill')
    // Landed at completion.
    expect(connectFill).toHaveAttribute('data-fill-pct', '100')
    expect(connectFill.style.height).toBe('100%')
  })

  it('is aria-busy (a loading beat is busy the whole time it is mounted)', () => {
    const { getByTestId } = render(
      <SessionStartBeat
        phase="prep"
        reducedMotion={false}
        prepLabel={PREP_LABEL}
        connectingLabel={CONNECTING_LABEL}
      />,
    )
    expect(getByTestId('session-start-beat')).toHaveAttribute('aria-busy', 'true')
  })

  it('animates the fill by default but freezes it under reduced motion (lands instantly)', () => {
    const motion = within(
      render(
        <SessionStartBeat
          phase="prep"
          reducedMotion={false}
          prepLabel={PREP_LABEL}
          connectingLabel={CONNECTING_LABEL}
        />,
      ).container,
    )
    expect(motion.getByTestId('session-start-beat-fill').className).toMatch(/transition/)
    expect(motion.getByTestId('session-start-beat')).toHaveAttribute('data-reduced-motion', 'false')

    const still = within(
      render(
        <SessionStartBeat
          phase="prep"
          reducedMotion
          prepLabel={PREP_LABEL}
          connectingLabel={CONNECTING_LABEL}
        />,
      ).container,
    )
    expect(still.getByTestId('session-start-beat-fill').className).not.toMatch(/transition/)
    expect(still.getByTestId('session-start-beat')).toHaveAttribute('data-reduced-motion', 'true')
  })

  it('is flat 1-bit / square (no rounded corners)', () => {
    const { getByTestId } = render(
      <SessionStartBeat
        phase="prep"
        reducedMotion={false}
        prepLabel={PREP_LABEL}
        connectingLabel={CONNECTING_LABEL}
      />,
    )
    expect(getByTestId('session-start-beat').className).toContain('rounded-none')
  })

  it('forwards the ref to the root element', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <SessionStartBeat
        ref={ref}
        phase="prep"
        reducedMotion={false}
        prepLabel={PREP_LABEL}
        connectingLabel={CONNECTING_LABEL}
      />,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations (both phases)', async () => {
    const prep = render(
      <SessionStartBeat
        phase="prep"
        reducedMotion={false}
        prepLabel={PREP_LABEL}
        connectingLabel={CONNECTING_LABEL}
      />,
    )
    expect(await axe(prep.container)).toHaveNoViolations()
    const connecting = render(
      <SessionStartBeat
        phase="connecting"
        reducedMotion
        prepLabel={PREP_LABEL}
        connectingLabel={CONNECTING_LABEL}
      />,
    )
    expect(await axe(connecting.container)).toHaveNoViolations()
  })
})
