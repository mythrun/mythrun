import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { useCheckoutReturn, type CheckoutReturnStatus } from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { CheckoutReturnRoute } from './checkout-return.tsx'

// The checkout-return screen renders one of three CALM terminal beats driven by
// `useCheckoutReturn` (Task 6). The hook itself (poll → settled / processing) is
// exhaustively covered by its own client-core test, so here we mock its return
// off the barrel and assert each beat in isolation — the route's job is a
// status→beat mapping, with `processing` a NON-error state that offers a quiet
// path to the `/billing` purchase history.
vi.mock('@mythrun/client-core', async (importActual) => {
  const actual = await importActual<typeof import('@mythrun/client-core')>()
  return { ...actual, useCheckoutReturn: vi.fn() }
})

const mockUseCheckoutReturn = vi.mocked(useCheckoutReturn)

// A prod-shaped mount: the route inside a data router with a `/billing` stub so
// the history affordance's real navigation can be observed.
function renderReturn(status: CheckoutReturnStatus): void {
  mockUseCheckoutReturn.mockReturnValue({ status })
  const router = createMemoryRouter(
    [
      { path: '/billing/return', element: <CheckoutReturnRoute /> },
      { path: '/billing', element: <div data-testid="billing-stub" /> },
    ],
    { initialEntries: ['/billing/return'] },
  )
  render(
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('CheckoutReturnRoute — pinned terminal states', () => {
  it('renders the polling beat while the balance is being polled', () => {
    renderReturn('polling')
    expect(screen.getByTestId('checkout-return-polling')).toBeDefined()
    expect(screen.getByText(i18n.t('billing.return.polling'))).toBeDefined()
    expect(screen.queryByTestId('checkout-return-settled')).toBeNull()
    expect(screen.queryByTestId('checkout-return-processing')).toBeNull()
  })

  it('renders the settled beat once the credits have landed', () => {
    renderReturn('settled')
    expect(screen.getByTestId('checkout-return-settled')).toBeDefined()
    expect(screen.getByText(i18n.t('billing.return.settled'))).toBeDefined()
    expect(screen.queryByTestId('checkout-return-polling')).toBeNull()
    expect(screen.queryByTestId('checkout-return-processing')).toBeNull()
  })

  it('renders the processing beat WITH the history link and NO error framing', () => {
    renderReturn('processing')
    expect(screen.getByTestId('checkout-return-processing')).toBeDefined()
    expect(screen.getByText(i18n.t('billing.return.processing'))).toBeDefined()
    // The calm billing-history path (a completed payment awaiting its webhook).
    expect(screen.getByText(i18n.t('billing.return.viewHistory'))).toBeDefined()
    // A NON-error surface: nothing is announced as an alert.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('navigates to the billing history from the processing beat', async () => {
    renderReturn('processing')
    fireEvent.click(screen.getByTestId('checkout-return-history'))
    expect(await screen.findByTestId('billing-stub')).toBeDefined()
  })
})
