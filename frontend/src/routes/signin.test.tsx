import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import { useSessionStore } from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'

// ENVIRONMENT shim (Node 25 vs jsdom), not production code. The screen mounts
// @mythrun/ui's <ThemeProvider>, which reads `localStorage` on mount to resolve
// the initial theme (and the beforeEach `localStorage.clear()` below needs it
// too). Node 25 ships the experimental Web Storage API on by default, installing
// a non-functional builtin `localStorage` (no getItem/setItem/clear) that SHADOWS
// the real `Storage` jsdom would provide. The provider legitimately uses the
// browser's real `localStorage` (works in a real browser); here we install a
// functional in-memory `Storage` onto the global so the stack renders. Mirrors
// the `providers.test.tsx` / `secure-storage.test.ts` precedent in this package.
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

// Typed off the REAL module so each wrapper forwards a properly-typed value, not
// `any` (no-unsafe-return).
type ClientCore = typeof import('@mythrun/client-core')
const createAuthState = vi.fn<(...a: unknown[]) => ReturnType<ClientCore['createAuthState']>>()
const buildAuthorizeUrl = vi.fn<(...a: unknown[]) => ReturnType<ClientCore['buildAuthorizeUrl']>>()
const redirectTo = vi.fn<(...a: unknown[]) => void>()

vi.mock('@mythrun/client-core', async (orig) => {
  const actual = await orig<typeof import('@mythrun/client-core')>()
  return {
    ...actual,
    createAuthState: (...a: unknown[]) => createAuthState(...a),
    buildAuthorizeUrl: (...a: unknown[]) => buildAuthorizeUrl(...a),
    isLocalPath: () => true,
  }
})
vi.mock('../platform/web/navigation.ts', () => ({ redirectTo: (...a: unknown[]) => { redirectTo(...a) } }))

const { SigninRoute } = await import('./signin.tsx')

function setMatch(): void {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: (q: string) => ({ matches: false, media: q, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }) })
}

function renderSignin(entry = '/auth/signin'): void {
  const router = createMemoryRouter([{ path: '/auth/signin', element: <SigninRoute /> }], { initialEntries: [entry] })
  render(<ThemeProvider><I18nextProvider i18n={i18n}><RouterProvider router={router} /></I18nextProvider></ThemeProvider>)
}

beforeEach(() => {
  setMatch(); localStorage.clear()
  useSessionStore.setState({ status: 'unauthenticated', sub: null, suspended: false })
  // createAuthState is async (PKCE digest) → resolve the {state, challenge}.
  createAuthState.mockReset().mockResolvedValue({ state: 'st', challenge: 'ch' })
  buildAuthorizeUrl.mockReset().mockReturnValue('https://cognito/authorize?x=1')
  redirectTo.mockReset()
})
// Web's vitest config sets no `globals`, so testing-library's auto-cleanup
// afterEach is not registered — `cleanup()` must UNMOUNT the prior render or the
// next case trips over duplicate buttons (mirrors callback.test.tsx).
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('SigninRoute', () => {
  it('Google button → createAuthState + buildAuthorizeUrl(google) + redirect', async () => {
    renderSignin()
    // `begin` is async (awaits createAuthState); the async act flushes the chain.
    await act(() => { screen.getByRole('button', { name: /google/i }).click(); return Promise.resolve() })
    expect(createAuthState).toHaveBeenCalledWith({ provider: 'google', returnTo: '/home' })
    expect(buildAuthorizeUrl).toHaveBeenCalledWith({ provider: 'google', state: 'st', challenge: 'ch' })
    expect(redirectTo).toHaveBeenCalledWith('https://cognito/authorize?x=1')
  })

  it('Discord button passes provider=discord', async () => {
    renderSignin()
    await act(() => { screen.getByRole('button', { name: /discord/i }).click(); return Promise.resolve() })
    expect(createAuthState).toHaveBeenCalledWith({ provider: 'discord', returnTo: '/home' })
  })

  it('threads a validated ?returnTo into the auth state', async () => {
    renderSignin('/auth/signin?returnTo=/join/abc')
    await act(() => { screen.getByRole('button', { name: /google/i }).click(); return Promise.resolve() })
    expect(createAuthState).toHaveBeenCalledWith({ provider: 'google', returnTo: '/join/abc' })
  })

  it('shows the suspended notice when the store is suspended', () => {
    act(() => { useSessionStore.getState().setSuspended() })
    renderSignin()
    expect(screen.getByTestId('signin-suspended')).toBeDefined()
  })
})
