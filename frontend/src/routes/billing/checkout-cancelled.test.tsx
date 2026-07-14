import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { i18n } from '../../i18n/config.ts'
import { CheckoutCancelledRoute } from './checkout-cancelled.tsx'

// The checkout-cancelled screen is the Stripe "abandoned Checkout" landing. It is
// deliberately NOT an error surface (no charge was made): a calm notice + a quiet
// path back to the billing settings.
function renderCancelled(): void {
  const router = createMemoryRouter(
    [
      { path: '/billing/cancelled', element: <CheckoutCancelledRoute /> },
      { path: '/settings', element: <div data-testid="settings-stub" /> },
    ],
    { initialEntries: ['/billing/cancelled'] },
  )
  render(
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  )
}

afterEach(cleanup)

describe('CheckoutCancelledRoute — calm, non-error notice', () => {
  it('renders the cancelled title + body copy', () => {
    renderCancelled()
    expect(screen.getByTestId('route-checkout-cancelled')).toBeDefined()
    expect(screen.getByText(i18n.t('billing.cancelled.title'))).toBeDefined()
    expect(screen.getByText(i18n.t('billing.cancelled.body'))).toBeDefined()
  })

  it('is NOT an error surface (nothing announced as an alert)', () => {
    renderCancelled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers a back-to-billing affordance that navigates to the settings surface', async () => {
    renderCancelled()
    const back = screen.getByTestId('checkout-cancelled-back')
    expect(back.textContent).toContain(i18n.t('billing.cancelled.back'))
    fireEvent.click(back)
    expect(await screen.findByTestId('settings-stub')).toBeDefined()
  })
})
