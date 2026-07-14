import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { PurchasePrompt } from './PurchasePrompt.tsx'

// Interim i18n'd copy — the shell owns the real strings; the component only
// reflects what it's given (copy lives in the settings/play shell, not the DS).
const OWNER_HEADING = 'You are out of session credits'
const OWNER_BODY = 'Starting a session spends one credit. Add more to pick up where you left off.'
const NON_OWNER_HEADING = 'The session cannot start yet'
const NON_OWNER_BODY = "This campaign's owner is out of session credits — they'll need to top up."
const BUY_LABEL = 'Buy session credits'
const DISMISS_LABEL = 'Dismiss'
const PRESETS = [1, 4, 8] as const

describe('PurchasePrompt', () => {
  it('owner: renders heading + body + the buy affordance (one button per preset)', () => {
    render(
      <PurchasePrompt
        variant="owner"
        heading={OWNER_HEADING}
        body={OWNER_BODY}
        buyLabel={BUY_LABEL}
        quantityPresets={PRESETS}
        onBuy={vi.fn()}
      />,
    )
    expect(screen.getByText(OWNER_HEADING)).toBeInTheDocument()
    expect(screen.getByText(OWNER_BODY)).toBeInTheDocument()
    // The presets sit inside a group named by the buy verb (no interpolated copy).
    const group = screen.getByRole('group', { name: BUY_LABEL })
    expect(group).toBeInTheDocument()
    for (const q of PRESETS) {
      expect(screen.getByTestId(`purchase-prompt-buy-${String(q)}`)).toBeInTheDocument()
    }
  })

  it('owner: onBuy fires with the pressed preset quantity', async () => {
    const onBuy = vi.fn()
    const user = userEvent.setup()
    render(
      <PurchasePrompt
        variant="owner"
        heading={OWNER_HEADING}
        body={OWNER_BODY}
        buyLabel={BUY_LABEL}
        quantityPresets={PRESETS}
        onBuy={onBuy}
      />,
    )
    await user.click(screen.getByTestId('purchase-prompt-buy-4'))
    expect(onBuy).toHaveBeenCalledTimes(1)
    expect(onBuy).toHaveBeenCalledWith(4)
  })

  it('owner: clamps each preset quantity to [1, 100] (label AND callback agree)', async () => {
    const onBuy = vi.fn()
    const user = userEvent.setup()
    render(
      <PurchasePrompt
        variant="owner"
        heading={OWNER_HEADING}
        body={OWNER_BODY}
        buyLabel={BUY_LABEL}
        quantityPresets={[0, 250]}
        onBuy={onBuy}
      />,
    )
    // 0 floors to 1, 250 caps to 100 — the rendered label is the clamped value.
    const floor = screen.getByTestId('purchase-prompt-buy-1')
    const cap = screen.getByTestId('purchase-prompt-buy-100')
    expect(floor).toHaveTextContent('1')
    expect(cap).toHaveTextContent('100')
    await user.click(cap)
    expect(onBuy).toHaveBeenCalledWith(100)
    await user.click(floor)
    expect(onBuy).toHaveBeenCalledWith(1)
  })

  it('nonOwner: renders heading + body but NO buy CTA — even when buy props are passed', () => {
    // The guard is on `variant`, NOT prop presence: a nonOwner who is handed the
    // full buy vocabulary still gets a calm notice. Buying here would credit the
    // wrong (non-owner) ledger and never unblock the owner's session.
    render(
      <PurchasePrompt
        variant="nonOwner"
        heading={NON_OWNER_HEADING}
        body={NON_OWNER_BODY}
        buyLabel={BUY_LABEL}
        quantityPresets={PRESETS}
        onBuy={vi.fn()}
      />,
    )
    expect(screen.getByText(NON_OWNER_HEADING)).toBeInTheDocument()
    expect(screen.getByText(NON_OWNER_BODY)).toBeInTheDocument()
    // No buy group, no preset buttons — with no dismiss passed, ZERO buttons at all.
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.queryByTestId('purchase-prompt-buy')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('fires onDismiss from the labelled dismiss control (owner variant)', async () => {
    const onDismiss = vi.fn()
    const user = userEvent.setup()
    render(
      <PurchasePrompt
        variant="owner"
        heading={OWNER_HEADING}
        body={OWNER_BODY}
        buyLabel={BUY_LABEL}
        quantityPresets={PRESETS}
        onBuy={vi.fn()}
        onDismiss={onDismiss}
        dismissLabel={DISMISS_LABEL}
      />,
    )
    await user.click(screen.getByRole('button', { name: DISMISS_LABEL }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('allows a nonOwner to dismiss the calm notice (dismiss is not owner-gated)', async () => {
    const onDismiss = vi.fn()
    const user = userEvent.setup()
    render(
      <PurchasePrompt
        variant="nonOwner"
        heading={NON_OWNER_HEADING}
        body={NON_OWNER_BODY}
        onDismiss={onDismiss}
        dismissLabel={DISMISS_LABEL}
      />,
    )
    await user.click(screen.getByRole('button', { name: DISMISS_LABEL }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('does NOT render a dismiss control without a dismissLabel (never a nameless button)', () => {
    render(
      <PurchasePrompt
        variant="nonOwner"
        heading={NON_OWNER_HEADING}
        body={NON_OWNER_BODY}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('defaults the root test id and lets it be overridden', () => {
    const { rerender } = render(
      <PurchasePrompt variant="nonOwner" heading={NON_OWNER_HEADING} body={NON_OWNER_BODY} />,
    )
    expect(screen.getByTestId('purchase-prompt')).toBeInTheDocument()
    rerender(
      <PurchasePrompt
        variant="nonOwner"
        heading={NON_OWNER_HEADING}
        body={NON_OWNER_BODY}
        data-testid="oop-credits"
      />,
    )
    expect(screen.getByTestId('oop-credits')).toBeInTheDocument()
  })

  it('forwards the ref to the root element', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <PurchasePrompt ref={ref} variant="nonOwner" heading={NON_OWNER_HEADING} body={NON_OWNER_BODY} />,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('is square / paper register — no circular marks, no chip fills', () => {
    const { container } = render(
      <PurchasePrompt
        variant="owner"
        heading={OWNER_HEADING}
        body={OWNER_BODY}
        buyLabel={BUY_LABEL}
        quantityPresets={PRESETS}
        onBuy={vi.fn()}
      />,
    )
    expect(container.querySelector('.rounded-full')).toBeNull()
  })

  it('has no axe violations (owner: buy path + dismiss)', async () => {
    const { container } = render(
      <PurchasePrompt
        variant="owner"
        heading={OWNER_HEADING}
        body={OWNER_BODY}
        buyLabel={BUY_LABEL}
        quantityPresets={PRESETS}
        onBuy={vi.fn()}
        onDismiss={vi.fn()}
        dismissLabel={DISMISS_LABEL}
      />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations (nonOwner: calm notice)', async () => {
    const { container } = render(
      <PurchasePrompt variant="nonOwner" heading={NON_OWNER_HEADING} body={NON_OWNER_BODY} />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
