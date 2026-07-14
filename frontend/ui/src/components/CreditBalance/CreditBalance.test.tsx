import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { CreditBalance } from './CreditBalance.tsx'

// The two i18n'd labels the settings shell passes (copy lives in the shell, not
// the DS). Realistic interim strings — the component only reflects what it's given.
const SESSION_LABEL = 'session credits'
const WORLD_GEN_LABEL = 'world credits'

describe('CreditBalance', () => {
  it('itemises BOTH buckets — each number beside its own passed label', () => {
    const { getByText, getByTestId } = render(
      <CreditBalance
        session={12}
        sessionLabel={SESSION_LABEL}
        worldGen={5}
        worldGenLabel={WORLD_GEN_LABEL}
      />,
    )
    // Both labels render.
    expect(getByText(SESSION_LABEL)).toBeInTheDocument()
    expect(getByText(WORLD_GEN_LABEL)).toBeInTheDocument()
    // Both values render, each in its own readout.
    expect(getByTestId('credit-balance-session-value')).toHaveTextContent('12')
    expect(getByTestId('credit-balance-world-gen-value')).toHaveTextContent('5')
  })

  it('renders each value in the mono `role="data"` register', () => {
    const { getByTestId } = render(
      <CreditBalance
        session={12}
        sessionLabel={SESSION_LABEL}
        worldGen={5}
        worldGenLabel={WORLD_GEN_LABEL}
      />,
    )
    // role="data" resolves to the machine-mono family (font-ui) — the brand's
    // data/chrome face, distinct from the serif prose face.
    for (const id of ['credit-balance-session-value', 'credit-balance-world-gen-value']) {
      expect(getByTestId(id).className).toMatch(/font-ui/)
    }
  })

  it('NEVER renders a summed total (the two buckets are not conflated)', () => {
    const { queryByText } = render(
      <CreditBalance
        session={12}
        sessionLabel={SESSION_LABEL}
        worldGen={5}
        worldGenLabel={WORLD_GEN_LABEL}
      />,
    )
    // 12 + 5 = 17 must appear nowhere — no surface ever sums the buckets (spec §4).
    expect(queryByText('17')).not.toBeInTheDocument()
    // And no "total" affordance sneaks in.
    expect(queryByText(/total/i)).not.toBeInTheDocument()
  })

  it('renders a zero balance as the number 0 (not blank / not a fallback)', () => {
    const { getByTestId } = render(
      <CreditBalance session={0} sessionLabel={SESSION_LABEL} worldGen={0} worldGenLabel={WORLD_GEN_LABEL} />,
    )
    expect(getByTestId('credit-balance-session-value')).toHaveTextContent('0')
    expect(getByTestId('credit-balance-world-gen-value')).toHaveTextContent('0')
  })

  it('is square / paper register — no circles, no chip fills on the readouts', () => {
    const { container, getByTestId } = render(
      <CreditBalance session={12} sessionLabel={SESSION_LABEL} worldGen={5} worldGenLabel={WORLD_GEN_LABEL} />,
    )
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
    const { getByTestId, rerender } = render(
      <CreditBalance session={1} sessionLabel={SESSION_LABEL} worldGen={2} worldGenLabel={WORLD_GEN_LABEL} />,
    )
    expect(getByTestId('credit-balance')).toBeInTheDocument()
    rerender(
      <CreditBalance
        session={1}
        sessionLabel={SESSION_LABEL}
        worldGen={2}
        worldGenLabel={WORLD_GEN_LABEL}
        data-testid="settings-credits"
      />,
    )
    expect(getByTestId('settings-credits')).toBeInTheDocument()
  })

  it('forwards the ref to the root element', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <CreditBalance
        ref={ref}
        session={1}
        sessionLabel={SESSION_LABEL}
        worldGen={2}
        worldGenLabel={WORLD_GEN_LABEL}
      />,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <CreditBalance session={12} sessionLabel={SESSION_LABEL} worldGen={5} worldGenLabel={WORLD_GEN_LABEL} />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
