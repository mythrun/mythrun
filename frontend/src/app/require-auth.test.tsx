import { render, screen, act, cleanup } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import { useSessionStore } from '@mythrun/client-core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { routes } from './router.tsx'
import { i18n } from '../i18n/config.ts'

// RequireAuth is the four-state auth gate. The `initializing` boot state must
// render a neutral SPLASH (not a redirect) so the on-load refresh isn't raced to
// sign-in; once the state settles to `unauthenticated`, the gate bounces. These
// cases drive the real `routes` tree (not a parallel one) by seeding the
// module-level Zustand session store, then asserting what the gate resolves to.
//
// The store is a module-level global with no provider, so it bleeds across
// tests. `cleanup()` UNMOUNTS the prior render BEFORE we reset the store — both
// these cases assert the SAME testid (`route-signin`), so without the unmount a
// still-mounted gate re-navigating to sign-in under `setUnauthenticated` would
// leave a phantom second `route-signin` for the next case to trip over. (This
// suite has no global testing-library auto-cleanup; the other shell tests dodge
// it by only ever querying unique testids per case.)
afterEach(() => {
  cleanup()
  act(() => {
    useSessionStore.getState().setUnauthenticated()
  })
})

// ENVIRONMENT shim (Node 25 vs jsdom), not production code. `renderAt` now wraps
// the route tree in @mythrun/ui's <ThemeProvider> (the unauthenticated bounce
// resolves to SigninRoute, which consumes `useTheme` for its theme-driven Dither
// crown — MYT-84), which reads `localStorage` on mount to resolve the initial
// theme. Node 25 ships the experimental Web Storage API on by default, installing
// a non-functional builtin `localStorage` (no getItem) that SHADOWS the real
// `Storage` jsdom would provide. Install a functional in-memory `Storage` so the
// stack renders. Mirrors the `providers.test.tsx` / `secure-storage.test.ts`
// precedent in this package.
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
// the router): the sign-in screen the gate bounces to consumes `useTheme`, so the
// provider must be present, the same way the shipped app supplies it.
function renderAt(path: string): void {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(
    <ThemeProvider>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </ThemeProvider>,
  )
}

describe('RequireAuth — initializing splash (MYT-84)', () => {
  it('renders the splash (no redirect) while initializing', () => {
    act(() => {
      useSessionStore.getState().setInitializing()
    })
    renderAt('/home')
    expect(screen.getByTestId('auth-splash')).toBeDefined()
    // It must NOT have bounced to the sign-in screen.
    expect(screen.queryByTestId('route-signin')).toBeNull()
  })

  it('redirects to sign-in once unauthenticated', () => {
    act(() => {
      useSessionStore.getState().setUnauthenticated()
    })
    renderAt('/home')
    expect(screen.getByTestId('route-signin')).toBeDefined()
  })
})
