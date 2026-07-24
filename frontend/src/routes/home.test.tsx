import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { render, screen, waitFor, act, fireEvent, configure } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  useSessionStore,
  type ApiContext,
  type BalanceResponse,
  type CampaignSummary,
} from '@mythrun/client-core'
import { routes } from '../app/router.tsx'
import { i18n } from '../i18n/config.ts'

// The hub renders every campaign TWICE (desktop grid + mobile index — both stay in
// the DOM, toggled by Show's CSS `display`), each with a CoverDither's full-field SVG
// (~600 <rect>s per band cover). Rendering that many nodes in jsdom is slow — a browser
// GPU-paints it instantly, but on CI's slower CPU it overruns testing-library's 1000ms
// waitFor default (the balance case measured 1312ms in CI vs ~350ms locally, so the
// element appeared AFTER waitFor gave up → "Unable to find element"). The render
// completes; it's just cut off. Bump the async + test timeouts (scoped to this file).
vi.setConfig({ testTimeout: 15000 })
configure({ asyncUtilTimeout: 10000 })

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

// ENVIRONMENT shim (Node 25 vs jsdom), not production code. `renderHome` now wraps
// the route tree in @mythrun/ui's <ThemeProvider> (the 500/error-boundary path —
// and the afterEach `setUnauthenticated` bounce on a still-mounted tree — resolve
// to SigninRoute, which consumes `useTheme` for its theme-driven Dither crown,
// MYT-84), which reads `localStorage` on mount. Node 25 ships the experimental Web
// Storage API on by default, installing a non-functional builtin `localStorage`
// (no getItem) that SHADOWS the real `Storage` jsdom would provide. Install a
// functional in-memory `Storage` so the stack renders. Mirrors the
// `providers.test.tsx` / `secure-storage.test.ts` precedent in this package.
class MemStorage {
  private readonly store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  clear(): void {
    this.store.clear()
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null
  }
  get length(): number {
    return this.store.size
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemStorage(),
    configurable: true,
    writable: true,
  })
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

// A full widened hub-card row (MYT-87 T11). `make` overrides the fields a case
// cares about; the rest default to a plausible ready campaign.
function make(overrides: Partial<CampaignSummary> = {}): CampaignSummary {
  return {
    id: 'c-1',
    worldId: 'w-1',
    name: 'The Sunken Coast',
    status: 'active',
    language: 'en',
    createdAt: '2026-06-24T10:00:00.000Z',
    updatedAt: '2026-06-24T11:00:00.000Z',
    worldName: 'Aerthmoor',
    worldColors: { from: 'lapis-100', to: 'slate-800' },
    creator: null,
    party: [{ userId: 'u-1', displayName: 'Ada', hasCharacter: true }],
    sessionCount: 0,
    lastPlayedAt: null,
    cardPhase: 'not-played',
    ...overrides,
  }
}

const campaignA = make({ id: 'c-1', name: 'The Sunken Coast', cardPhase: 'not-played' })
const campaignB = make({
  id: 'c-2',
  name: 'Ashfall Reach',
  status: 'setup',
  cardPhase: 'generating',
  worldColors: null,
})

const BALANCE: BalanceResponse = { session: 120, world_gen: 4, active_subscription: null }

// MSW handlers. The app frame now reads the balance on every authed route, so a
// balance handler is registered in EVERY case (an unhandled request would fail
// the `onUnhandledRequest: 'error'` server); the value defaults to `BALANCE`.
function campaignsOk(campaigns: readonly CampaignSummary[]) {
  return http.get(`${BASE_URL}/api/campaigns/mine`, () => HttpResponse.json({ campaigns }))
}
function balanceOk(balance: BalanceResponse = BALANCE) {
  return http.get(`${BASE_URL}/api/billing/balance`, () => HttpResponse.json(balance))
}

// Render the real route tree at /home through the real provider stack. A fresh
// QueryClient per render (retry: false → a 500 case errors immediately, no retry
// storm) keeps each test's cache isolated. `queryDefaults` lets a case mirror the
// PRODUCTION default set (providers.tsx) — the focus-refetch case pins
// `refetchOnWindowFocus:false` globally to prove the hub query overrides it.
function renderHome(queryDefaults: Record<string, unknown> = {}): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, ...queryDefaults } },
  })
  const router = createMemoryRouter(routes, { initialEntries: ['/home'] })
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <ApiClientProvider value={testCtx}>
          <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
        </ApiClientProvider>
      </QueryClientProvider>
    </ThemeProvider>
  )
  render(wrapper({ children: <RouterProvider router={router} /> }))
}

function seedReady(): void {
  act(() => {
    useSessionStore.getState().setReady('dev-user-1')
  })
}

describe('home hub (wired)', () => {
  it('renders the campaign grid ⊕ index behind the Suspense fallback', async () => {
    seedReady()
    server.use(campaignsOk([campaignA, campaignB]), balanceOk())

    renderHome()

    // The <Spinner/> suspense fallback paints first (data has not resolved yet).
    expect(screen.getByTestId('home-loading')).toBeDefined()

    // Then the data resolves. jsdom renders BOTH breakpoint layouts (the media
    // query never resolves), so each campaign is present as a grid COVER CARD and a
    // mobile INDEX ROW — assert the per-layout testids, not the (doubled) name text.
    await waitFor(() => {
      expect(screen.getByTestId('campaign-card-c-1')).toBeDefined()
    })
    expect(screen.getByTestId('campaign-card-c-2')).toBeDefined()
    expect(screen.getByTestId('campaign-index-row-c-1')).toBeDefined()
    expect(screen.getByTestId('campaign-index-row-c-2')).toBeDefined()
    expect(screen.getByTestId('app-frame')).toBeDefined()
    // The loading fallback is gone once the data is in.
    expect(screen.queryByTestId('home-loading')).toBeNull()
  })

  it('renders the first-run empty shelf when there are no campaigns', async () => {
    seedReady()
    server.use(campaignsOk([]), balanceOk())

    renderHome()

    await waitFor(() => {
      expect(screen.getByTestId('home-empty')).toBeDefined()
    })
    // The dashed "Unwritten" ghost cover + the create CTA, and no cards.
    expect(screen.getByTestId('home-empty-cover')).toBeDefined()
    expect(screen.getByTestId('home-empty-cta')).toBeDefined()
    expect(screen.queryByTestId('campaign-card-c-1')).toBeNull()
  })

  it('renders every campaign /mine returns, including failed (archived is filtered server-side)', async () => {
    seedReady()
    // /mine already excludes archived campaigns (T11, backend). The hub applies NO
    // client-side status filter — it renders exactly what the endpoint returns,
    // failed campaigns included (as a failed-phase card).
    const active = make({ id: 'c-1', cardPhase: 'not-played' })
    const setup = make({ id: 'c-2', status: 'setup', cardPhase: 'needs-character' })
    const failed = make({ id: 'c-3', status: 'failed', cardPhase: 'failed' })
    server.use(campaignsOk([active, setup, failed]), balanceOk())

    renderHome()

    await waitFor(() => {
      expect(screen.getByTestId('campaign-card-c-1')).toBeDefined()
    })
    expect(screen.getByTestId('campaign-card-c-2')).toBeDefined()
    expect(screen.getByTestId('campaign-card-c-3')).toBeDefined()
  })

  it('shows the live session balance in the header', async () => {
    seedReady()
    server.use(campaignsOk([campaignA]), balanceOk({ ...BALANCE, session: 1250 }))

    renderHome()

    // The header credit slot resolves the live balance and renders the
    // locale-formatted session number.
    await waitFor(() => {
      expect(screen.getByTestId('frame-credits')).toBeDefined()
    })
    expect(screen.getByTestId('frame-credits').textContent).toContain('1,250')
  })

  it('the New Campaign CTA navigates to the creation route', async () => {
    seedReady()
    server.use(campaignsOk([]), balanceOk())

    renderHome()

    await waitFor(() => {
      expect(screen.getByTestId('home-empty-cta')).toBeDefined()
    })
    fireEvent.click(screen.getByTestId('home-empty-cta'))
    // The interim campaign-create stub (MYT-89 owns the real screen).
    await waitFor(() => {
      expect(screen.getByTestId('route-campaign-new')).toBeDefined()
    })
  })

  it('the header New Campaign button navigates to the creation route (MYT-3jb55)', async () => {
    seedReady()
    server.use(campaignsOk([campaignA]), balanceOk())

    renderHome()

    // The primary create affordance is a header button present on every hub state
    // (loading/empty/full), where a returning player looks — the run-1 blocker was
    // that create was a buried bottom text-link. It routes to /campaigns/new.
    await waitFor(() => {
      expect(screen.getByTestId('home-new-campaign')).toBeDefined()
    })
    fireEvent.click(screen.getByTestId('home-new-campaign'))
    await waitFor(() => {
      expect(screen.getByTestId('route-campaign-new')).toBeDefined()
    })
  })

  it('the campaign card links to the detail route (interim)', async () => {
    seedReady()
    server.use(campaignsOk([campaignA]), balanceOk())

    renderHome()

    await waitFor(() => {
      expect(screen.getByTestId('campaign-card-c-1')).toBeDefined()
    })
    // The whole card is a link to the canonical `/campaigns/:id` detail URL (an
    // interim target the detail-surface ticket fills — no dead click).
    expect(screen.getByTestId('campaign-card-c-1').getAttribute('href')).toBe('/campaigns/c-1')
  })

  it('degrades ONLY the credits slot when the balance fetch fails (frame + hub survive)', async () => {
    seedReady()
    // Campaigns resolve; the balance 500s. The header credit slot's local error
    // boundary must contain the failure — the frame and the hub still render, and
    // the route-level error boundary is NOT triggered.
    server.use(
      campaignsOk([campaignA]),
      http.get(`${BASE_URL}/api/billing/balance`, () => new HttpResponse(null, { status: 500 })),
    )

    renderHome()

    await waitFor(() => {
      expect(screen.getByTestId('campaign-card-c-1')).toBeDefined()
      expect(screen.queryByTestId('frame-credits-loading')).toBeNull()
    })
    expect(screen.getByTestId('app-frame')).toBeDefined()
    // The credits degraded to empty; the route error boundary did NOT fire.
    expect(screen.queryByTestId('frame-credits')).toBeNull()
    expect(screen.queryByTestId('error-retryable')).toBeNull()
  })

  it('propagates a campaigns 500 to the route error boundary (retry copy renders)', async () => {
    seedReady()
    server.use(
      http.get(`${BASE_URL}/api/campaigns/mine`, () => new HttpResponse(null, { status: 500 })),
      balanceOk(),
    )

    renderHome()

    // The HttpError(500) reaches the W3c route error boundary → its generic
    // retryable screen (retry affordance), NOT the 401 / contract-drift arms.
    await waitFor(() => {
      expect(screen.getByTestId('error-retry')).toBeDefined()
    })
    expect(screen.getByTestId('error-retryable')).toBeDefined()
  })

  it('re-fetches the hub on window focus (the hub query overrides the global refetchOnWindowFocus:false)', async () => {
    seedReady()
    // Count the /mine hits so the focus-refetch is observable as a second request.
    let mineCalls = 0
    server.use(
      http.get(`${BASE_URL}/api/campaigns/mine`, () => {
        mineCalls += 1
        return HttpResponse.json({ campaigns: [campaignA] })
      }),
      balanceOk(),
    )

    // Mirror production: providers.tsx disables refetch-on-focus app-wide, so the
    // hub's per-query `refetchOnWindowFocus:true` must OVERRIDE it — otherwise a
    // just-joined member never surfaces on the hub without a manual reload.
    renderHome({ refetchOnWindowFocus: false })

    await waitFor(() => {
      expect(screen.getByTestId('campaign-card-c-1')).toBeDefined()
    })
    const callsBeforeFocus = mineCalls

    // useSuspenseQuery clamps staleTime to a 1s floor (ensureSuspenseTimers), so a
    // focus in that first second sees a still-fresh query and won't refetch. A real
    // user tabs back well after 1s; wait past the floor so the query is stale.
    await new Promise((resolve) => setTimeout(resolve, 1100))

    // Simulate the tab regaining focus deterministically via the focusManager
    // singleton (raw visibilitychange/focus event dispatch is flaky in jsdom):
    // toggle away then back so the manager fires a focus change.
    act(() => {
      focusManager.setFocused(false)
    })
    act(() => {
      focusManager.setFocused(true)
    })

    await waitFor(() => {
      expect(mineCalls).toBeGreaterThan(callsBeforeFocus)
    })

    // Restore auto-detected focus so the singleton doesn't bleed into later tests.
    act(() => {
      focusManager.setFocused(undefined)
    })
  })
})
