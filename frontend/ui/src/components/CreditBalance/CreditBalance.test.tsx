import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { CreditBalance } from './CreditBalance.tsx'

// The i18n'd copy the settings shell passes (copy lives in the shell, not the DS).
// Realistic interim strings — the component only reflects what it's given.
const SESSION_LABEL = 'Session credits'
const SESSION_HELP = 'One credit starts one session.'
const SESSION_ZERO = "At zero, you can't start a session."
const WORLD_GEN_LABEL = 'World credits'
const WORLD_GEN_HELP = 'One credit builds one world and its characters.'
const WORLD_GEN_ZERO = "At zero, you can't start a new campaign."

const COPY = {
  sessionLabel: SESSION_LABEL,
  sessionHelp: SESSION_HELP,
  sessionZeroHelp: SESSION_ZERO,
  worldGenLabel: WORLD_GEN_LABEL,
  worldGenHelp: WORLD_GEN_HELP,
  worldGenZeroHelp: WORLD_GEN_ZERO,
} as const

describe('CreditBalance', () => {
  it('itemises BOTH buckets — each number beside its own passed label', () => {
    const { getByText, getByTestId } = render(<CreditBalance session={12} worldGen={5} {...COPY} />)
    // Both labels render.
    expect(getByText(SESSION_LABEL)).toBeInTheDocument()
    expect(getByText(WORLD_GEN_LABEL)).toBeInTheDocument()
    // Both values render, each in its own readout.
    expect(getByTestId('credit-balance-session-value')).toHaveTextContent('12')
    expect(getByTestId('credit-balance-world-gen-value')).toHaveTextContent('5')
  })

  // myth-9jrh9: run-1 rendered one full-width justified row per bucket, so the label
  // sat ~1200px from its number with nothing binding them ("two unrelated things that
  // happen to share a row"). Each bucket is now a BOUNDED tile that owns its label,
  // its number, and its explainers — the binding is structural, not a leader line.
  it('binds each label, value and explainer inside its OWN bucket tile', () => {
    const { getByTestId } = render(<CreditBalance session={12} worldGen={5} {...COPY} />)

    const sessionTile = getByTestId('credit-balance-session')
    expect(sessionTile).toHaveTextContent(SESSION_LABEL)
    expect(sessionTile).toHaveTextContent('12')
    expect(sessionTile).toHaveTextContent(SESSION_HELP)
    expect(sessionTile).toHaveTextContent(SESSION_ZERO)
    // The session tile carries NOTHING belonging to the other currency.
    expect(sessionTile).not.toHaveTextContent(WORLD_GEN_LABEL)
    expect(sessionTile).not.toHaveTextContent(WORLD_GEN_HELP)

    const worldTile = getByTestId('credit-balance-world-gen')
    expect(worldTile).toHaveTextContent(WORLD_GEN_LABEL)
    expect(worldTile).toHaveTextContent('5')
    expect(worldTile).toHaveTextContent(WORLD_GEN_HELP)
    expect(worldTile).toHaveTextContent(WORLD_GEN_ZERO)
    expect(worldTile).not.toHaveTextContent(SESSION_LABEL)
    expect(worldTile).not.toHaveTextContent(SESSION_HELP)
  })

  // The zero-state line is ALWAYS visible, not conditional on the count: the point is
  // to teach the currency before the player hits the wall, not after.
  it('shows both explainer lines at a healthy balance, not only at zero', () => {
    const { getByText } = render(<CreditBalance session={148} worldGen={32} {...COPY} />)
    expect(getByText(SESSION_ZERO)).toBeInTheDocument()
    expect(getByText(WORLD_GEN_ZERO)).toBeInTheDocument()
  })

  // The tiles ride an auto-FILL track: they HOLD their width rather than stretching to
  // half a 1200px settings column each, which is what would re-open the label→value
  // reading gap the tiles exist to close. Pinned — auto-fit here would look correct in
  // jsdom and be wrong on the real screen.
  it('lays the tiles out on a width-holding auto-fill track, not a stretching one', () => {
    const { getByTestId } = render(<CreditBalance session={12} worldGen={5} {...COPY} />)
    const track = getByTestId('credit-balance')
    expect(track.className).toMatch(/\bgrid\b/)
    expect(track.getAttribute('style')).toMatch(/auto-fill/)
  })

  it('renders each value in the mono `role="data"` register', () => {
    const { getByTestId } = render(<CreditBalance session={12} worldGen={5} {...COPY} />)
    // role="data" resolves to the machine-mono family (font-ui) — the brand's
    // data/chrome face, distinct from the serif prose face.
    for (const id of ['credit-balance-session-value', 'credit-balance-world-gen-value']) {
      expect(getByTestId(id).className).toMatch(/font-ui/)
    }
  })

  it('NEVER renders a summed total (the two buckets are not conflated)', () => {
    const { queryByText } = render(<CreditBalance session={12} worldGen={5} {...COPY} />)
    // 12 + 5 = 17 must appear nowhere — no surface ever sums the buckets (spec §4).
    expect(queryByText('17')).not.toBeInTheDocument()
    // And no "total" affordance sneaks in.
    expect(queryByText(/total/i)).not.toBeInTheDocument()
  })

  it('renders a zero balance as the number 0 (not blank / not a fallback)', () => {
    const { getByTestId } = render(<CreditBalance session={0} worldGen={0} {...COPY} />)
    expect(getByTestId('credit-balance-session-value')).toHaveTextContent('0')
    expect(getByTestId('credit-balance-world-gen-value')).toHaveTextContent('0')
  })

  it('is square / paper register — no circles, no chip fills on the readouts', () => {
    const { container, getByTestId } = render(<CreditBalance session={12} worldGen={5} {...COPY} />)
    // No circular marks anywhere (rounded-full is banned brand-wide).
    expect(container.querySelector('.rounded-full')).toBeNull()
    // The numbers are bare mono readouts — never a bordered/filled chip.
    for (const id of ['credit-balance-session-value', 'credit-balance-world-gen-value']) {
      const value = getByTestId(id)
      expect(value.className).not.toMatch(/\bbg-/)
      expect(value.className).not.toMatch(/border/)
    }
  })

  it('defaults the root test id and lets it be overridden', () => {
    const { getByTestId, rerender } = render(<CreditBalance session={1} worldGen={2} {...COPY} />)
    expect(getByTestId('credit-balance')).toBeInTheDocument()
    rerender(<CreditBalance session={1} worldGen={2} {...COPY} data-testid="settings-credits" />)
    expect(getByTestId('settings-credits')).toBeInTheDocument()
  })

  it('forwards the ref to the root element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<CreditBalance ref={ref} session={1} worldGen={2} {...COPY} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<CreditBalance session={12} worldGen={5} {...COPY} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
