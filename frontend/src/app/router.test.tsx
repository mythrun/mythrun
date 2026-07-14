import { render, screen, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  useSessionStore,
  type ApiContext,
  type WorldGenStream,
} from '@mythrun/client-core'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { routes } from './router.tsx'
import { i18n } from '../i18n/config.ts'

// Mock ONLY the world-gen stream off the client-core barrel; `importOriginal` +
// spread keeps every other export real, so the app tree — `useSessionStore` (the
// gate), `ApiClientProvider`, `useBalance` (the authed header) — still mounts
// through the actual stack. This routing check must stay HERMETIC: the real
// `useWorldGenStream` would (a) open a live SSE with backoff-reconnect timers
// against the test baseUrl (a leak past this cleanup-free file's teardown), and
// (b) start in `generating`, mounting <WorldGenGraph> → `canvas.getContext`,
// which jsdom throws on ('Not implemented'). Returning a fully-active campaign
// (`complete/complete`) renders CampaignDetailRoute's fall-through detail arm
// (`route-campaign-detail`) — a stable, canvas-free surface that still proves the
// route resolved. The phase-aware branching itself is exercised end-to-end in
// `routes/campaign-detail.test.tsx`.
vi.mock('@mythrun/client-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mythrun/client-core')>()
  return {
    ...actual,
    useWorldGenStream: vi.fn(
      (): WorldGenStream => ({
        phase: 'complete',
        nodes: [],
        edges: [],
        status: 'complete',
        stages: [],
        costUsd: null,
        resumedMidGen: false,
        retry: () => Promise.resolve(),
      }),
    ),
    // The `/campaigns/:id` case now mounts <CampaignPage>, which fires a real
    // `getMyCampaigns` on mount to resolve the world identity. Stub it (mirrors
    // campaign-page.test.tsx / campaign-detail.test.tsx) so no live network attempt
    // escapes this cleanup-free file. The one campaign carries the SAME `c-1` id the
    // `/campaigns/c-1` case navigates to, so the page finds it and renders cleanly.
    getMyCampaigns: vi.fn().mockResolvedValue({
      campaigns: [
        {
          id: 'c-1',
          worldId: 'w-1',
          name: 'The Ashfen Pact',
          status: 'setup',
          language: 'en',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          worldName: 'Emberdeep Hollow',
          worldColors: { from: 'moss-100', to: 'verdigris-800' },
          creator: null,
          party: [],
          sessionCount: 0,
          lastPlayedAt: null,
          cardPhase: 'needs-character',
        },
      ],
    }),
  }
})

// The shell's routing contract, proven through `createMemoryRouter` over the
// SAME `routes` array the app ships (so the test exercises the real tree, not a
// parallel one). Each case drives the four-state `<RequireAuth>` gate by
// seeding the module-level Zustand session store, then asserts the screen that
// the gate + route tree resolve to.
//
// The store is a module-level global with no provider, so it bleeds across
// tests — reset it to the unauthenticated default after each case (mirrors the
// store's own tests).
afterEach(() => {
  act(() => {
    useSessionStore.getState().setUnauthenticated()
  })
})

// ENVIRONMENT shim (Node 25 vs jsdom), not production code. `renderAt` now wraps
// the route tree in @mythrun/ui's <ThemeProvider> (the SigninRoute consumes
// `useTheme` to pick its theme-driven Dither crown — MYT-84), which reads
// `localStorage` on mount to resolve the initial theme. Node 25 ships the
// experimental Web Storage API on by default, installing a non-functional builtin
// `localStorage` (no getItem) that SHADOWS the real `Storage` jsdom would provide.
// Install a functional in-memory `Storage` so the stack renders. Mirrors the
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
})

const TEST_CTX: ApiContext = { baseUrl: 'http://api.test', getAuthHeaders: () => Promise.resolve({}) }

// The harness mirrors the real composition root (AppProviders → ThemeProvider →
// QueryClient → ApiContext → i18n → the router). The QueryClient + ApiContext are
// now load-bearing for the authed frame: <AppFrame> reads the live balance
// (`useBalance`, MYT-87) in its header, so the frame needs the data stack even for
// a data-free authed STUB. We PRE-SEED the balance cache (staleTime:Infinity → no
// fetch fires) so the routing check stays hermetic — no MSW, no network — while the
// header credits resolve from cache. (The loading→data→error paths are exercised in
// `routes/home.test.tsx` with the full stack + MSW.)
function renderAt(initialPath: string): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  client.setQueryData(['billing', 'balance'], { session: 120, world_gen: 0, active_subscription: null })
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] })
  render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <ApiClientProvider value={TEST_CTX}>
          <I18nextProvider i18n={i18n}>
            <RouterProvider router={router} />
          </I18nextProvider>
        </ApiClientProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  )
}

describe('app router', () => {
  it('redirects a protected route to the sign-in stub when unauthenticated', () => {
    // The store default is now `initializing` (jwt boot), which renders the
    // splash — so seed `unauthenticated` explicitly to exercise the redirect:
    // <RequireAuth> must bounce /home → /auth/signin.
    act(() => {
      useSessionStore.getState().setUnauthenticated()
    })
    renderAt('/home')
    expect(screen.getByTestId('route-signin')).toBeDefined()
    // The authed frame must NOT have rendered.
    expect(screen.queryByTestId('app-frame')).toBeNull()
  })

  it('renders the authed frame for a protected route when ready', () => {
    act(() => {
      useSessionStore.getState().setReady('dev-user-1')
    })
    // Use a DATA-FREE authed stub (`/settings`) here: this test proves only the
    // routing contract — <RequireAuth> (ready) → <AppFrame> → the matched authed
    // screen — under the bare I18nextProvider. The home hub (W3e) is now wired to
    // `useMyCampaigns` and needs the QueryClient + ApiContext stack, so its
    // loading → data path is exercised in `routes/home.test.tsx` (full stack +
    // MSW) instead, keeping this assertion a pure routing check.
    renderAt('/settings')
    // The quiet brand frame's header is present, wrapping the settings stub.
    expect(screen.getByTestId('app-frame')).toBeDefined()
    expect(screen.getByTestId('route-settings')).toBeDefined()
  })

  it('resolves the home-hub card target /campaigns/:id to the detail stub, NOT the 404', () => {
    // The hub card links to the canonical `/campaigns/:id` detail URL. Landing on
    // that URL (a full-page nav for the plain-anchor card, or a fresh boot) must
    // resolve to the interim CampaignDetailRoute — the guard against the launch
    // dead-click where the card fell through `*` → NotFound. This is the robust
    // regression check: a plain `<a href>` (the @mythrun/ui Link) is not an RR
    // Link, so a jsdom click on it can't SPA-navigate the memory router — but
    // rendering AT the card's target URL proves exactly what a click lands on.
    act(() => {
      useSessionStore.getState().setReady('dev-user-1')
    })
    renderAt('/campaigns/c-1')
    expect(screen.getByTestId('route-campaign-detail')).toBeDefined()
    // It resolved inside the authed frame, and did NOT fall through to the 404.
    // (Assert the NotFound's own testid is absent — not "no dither anywhere":
    // other screens carry dithers, and this file has no RTL cleanup so a prior
    // test's signin crown dither leaks into the document.)
    expect(screen.getByTestId('app-frame')).toBeDefined()
    expect(screen.queryByTestId('not-found')).toBeNull()
  })

  it('still resolves the static /campaigns/new above the dynamic :id route', () => {
    // Adding `campaigns/:id` must not shadow the static `campaigns/new` — RR ranks
    // static segments above dynamic, so the create stub still wins its own path.
    act(() => {
      useSessionStore.getState().setReady('dev-user-1')
    })
    renderAt('/campaigns/new')
    expect(screen.getByTestId('route-campaign-new')).toBeDefined()
    expect(screen.queryByTestId('route-campaign-detail')).toBeNull()
  })

  it('renders the dithered 404 for an unknown path', () => {
    renderAt('/no/such/route')
    // The Dither component paints an SVG carrying `data-dither-texture`; its
    // presence proves the full-bleed dithered 404 rendered.
    const dither = document.querySelector('[data-dither-texture]')
    expect(dither).not.toBeNull()
  })
})

// Recursively locate a route entry by its `path` in the (nested) route tree.
function findByPath(entries: readonly RouteObject[], path: string): RouteObject | undefined {
  for (const entry of entries) {
    if (entry.path === path) return entry
    const found = entry.children ? findByPath(entry.children, path) : undefined
    if (found) return found
  }
  return undefined
}

describe('app router — the play route full-bleed handle (MYT-92 T15)', () => {
  it('marks /campaigns/:id/play full-bleed so AppFrame drops the padded content box', () => {
    // The route-level opt-in AppFrame reads via useMatches() to render the live-play
    // stage edge-to-edge below the header (spec §2/§7). AppFrame owns the branch; the
    // route only declares the flag.
    const play = findByPath(routes, 'campaigns/:id/play')
    expect(play?.handle).toEqual({ fullBleed: true })
  })
})
