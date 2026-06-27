import { render, screen, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import { useSessionStore } from '@mythrun/client-core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { routes } from './router.tsx'
import { i18n } from '../i18n/config.ts'

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

// The harness mirrors the real composition root (AppProviders → ThemeProvider →
// the router): screens that consume `useTheme` (SigninRoute's theme-driven crown)
// need the provider present, the same way the shipped app supplies it.
function renderAt(initialPath: string): void {
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] })
  render(
    <ThemeProvider>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
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

  it('renders the dithered 404 for an unknown path', () => {
    renderAt('/no/such/route')
    // The Dither component paints an SVG carrying `data-dither-texture`; its
    // presence proves the full-bleed dithered 404 rendered.
    const dither = document.querySelector('[data-dither-texture]')
    expect(dither).not.toBeNull()
  })
})
