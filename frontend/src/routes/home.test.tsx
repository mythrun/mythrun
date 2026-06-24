import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { render, screen, waitFor, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ApiClientProvider, useSessionStore, type ApiContext } from '@mythrun/client-core'
import { routes } from '../app/router.tsx'
import { i18n } from '../i18n/config.ts'

// The wired home hub (done-when #3 — "renders real backend data behind a loading
// state"), driven through the REAL `routes` array and the REAL provider stack so
// the test exercises the actual shipped tree: <RequireAuth> (seeded `ready`) →
// <AppFrame> → <HomeRoute>'s <Suspense>(<useMyCampaigns>). MSW stands in for the
// backend at the wire level (the same network-layer fake the client-core hook
// tests use), so each case proves a different arm of the loading → data/empty/
// error path:
//
//   - a two-campaign payload resolves AFTER the <Spinner/> suspense fallback;
//   - an empty list renders the empty-state placeholder;
//   - a 500 propagates as an HttpError to the W3c route error boundary, whose
//     retry copy renders (the error didn't get swallowed inside the screen).
//
// The session store is a module-level global with no provider, so it bleeds
// across tests — seed it `ready` per case and reset to the unauthenticated
// default after each (mirrors router.test.tsx + the store's own tests).

const BASE_URL = 'http://api.test'
const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  server.resetHandlers()
  act(() => {
    useSessionStore.getState().setUnauthenticated()
  })
})
afterAll(() => {
  server.close()
})

const testCtx: ApiContext = {
  baseUrl: BASE_URL,
  getAuthHeaders: () => Promise.resolve({}),
}

const campaignA = {
  id: 'c-1',
  worldId: 'w-1',
  name: 'The Sunken Coast',
  status: 'active' as const,
  language: 'en',
  createdAt: '2026-06-24T10:00:00.000Z',
  updatedAt: '2026-06-24T11:00:00.000Z',
}
const campaignB = {
  id: 'c-2',
  worldId: 'w-2',
  name: 'Ashfall Reach',
  status: 'setup' as const,
  language: 'en',
  createdAt: '2026-06-24T12:00:00.000Z',
  updatedAt: '2026-06-24T13:00:00.000Z',
}

// Render the real route tree at /home through the real provider stack. A fresh
// QueryClient per render (retry: false → the 500 case errors immediately, no
// retry storm) keeps each test's cache isolated.
function renderHome(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(routes, { initialEntries: ['/home'] })
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={client}>
      <ApiClientProvider value={testCtx}>
        <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
      </ApiClientProvider>
    </QueryClientProvider>
  )
  render(wrapper({ children: <RouterProvider router={router} /> }))
}

describe('home hub (wired)', () => {
  it('renders the campaign list behind the Suspense fallback', async () => {
    act(() => {
      useSessionStore.getState().setReady('dev-user-1')
    })
    server.use(
      http.get(`${BASE_URL}/api/campaigns/mine`, () =>
        HttpResponse.json({ campaigns: [campaignA, campaignB] }),
      ),
    )

    renderHome()

    // The <Spinner/> suspense fallback paints first (data has not resolved yet).
    expect(screen.getByTestId('home-loading')).toBeDefined()

    // Then the data resolves and both campaign names render inside the frame.
    await waitFor(() => {
      expect(screen.getByText(campaignA.name)).toBeDefined()
    })
    expect(screen.getByText(campaignB.name)).toBeDefined()
    expect(screen.getByTestId('app-frame')).toBeDefined()
    // The loading fallback is gone once the data is in.
    expect(screen.queryByTestId('home-loading')).toBeNull()
  })

  it('renders the empty state when there are no campaigns', async () => {
    act(() => {
      useSessionStore.getState().setReady('dev-user-1')
    })
    server.use(
      http.get(`${BASE_URL}/api/campaigns/mine`, () => HttpResponse.json({ campaigns: [] })),
    )

    renderHome()

    await waitFor(() => {
      expect(screen.getByTestId('home-empty')).toBeDefined()
    })
  })

  it('propagates a 500 to the route error boundary (retry copy renders)', async () => {
    act(() => {
      useSessionStore.getState().setReady('dev-user-1')
    })
    server.use(
      http.get(`${BASE_URL}/api/campaigns/mine`, () => new HttpResponse(null, { status: 500 })),
    )

    renderHome()

    // The HttpError(500) reaches the W3c route error boundary → its generic
    // retryable screen (retry affordance), NOT the 401 / contract-drift arms.
    await waitFor(() => {
      expect(screen.getByTestId('error-retry')).toBeDefined()
    })
    expect(screen.getByTestId('error-retryable')).toBeDefined()
  })
})
