import { act, cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '../i18n/config.ts'
import { HeaderCredits } from './header-credits.tsx'

// HeaderCredits — the persistent chrome's balance readout. The load-bearing pin
// here is the NAVIGATION-refresh contract (myth-bsyu9): the header never
// remounts across routes, so a balance spent mid-route (ending a session)
// survived as a stale readout on the next surface (the hub header briefly
// showed the pre-end number). The slot invalidates the shared balance cache on
// every pathname change — freshness is a chrome-level contract, not something
// each mutation site must remember. The data hooks are mocked; the invalidation
// callback is the observable.

const invalidateBalance = vi.fn()

vi.mock('@mythrun/client-core', () => ({
  useBalance: () => ({ data: { session: 5, world_gen: 0, active_subscription: null } }),
  useInvalidateBalance: () => invalidateBalance,
}))

afterEach(() => {
  cleanup()
  invalidateBalance.mockClear()
})

function renderAt(initialPath: string): ReturnType<typeof createMemoryRouter> {
  const router = createMemoryRouter([{ path: '*', element: <HeaderCredits /> }], {
    initialEntries: [initialPath],
  })
  render(
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  )
  return router
}

describe('HeaderCredits — navigation-refresh contract (myth-bsyu9)', () => {
  it('renders the labeled session balance', () => {
    renderAt('/home')
    expect(screen.getByTestId('frame-credits').textContent).toContain('5')
  })

  it('does NOT invalidate on first mount (the suspense query just fetched)', () => {
    renderAt('/home')
    expect(invalidateBalance).not.toHaveBeenCalled()
  })

  it('invalidates the balance cache when the route changes', async () => {
    const router = renderAt('/campaigns/c-1/play')
    await act(async () => {
      await router.navigate('/campaigns/c-1')
    })
    expect(invalidateBalance).toHaveBeenCalledTimes(1)
    // A further navigation refreshes again; same-path re-renders do not.
    await act(async () => {
      await router.navigate('/home')
    })
    expect(invalidateBalance).toHaveBeenCalledTimes(2)
  })
})
