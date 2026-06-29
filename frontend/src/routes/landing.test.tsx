import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import { i18n } from '../i18n/config.ts'
import { LandingRoute } from './landing.tsx'

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

function setMatch(): void {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: (q: string) => ({ matches: false, media: q, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }) })
}

function renderLanding(): void {
  const router = createMemoryRouter(
    [
      { path: '/', element: <LandingRoute /> },
      { path: '/auth/signin', element: <div data-testid="signin-stub" /> },
    ],
    { initialEntries: ['/'] },
  )
  render(<ThemeProvider><I18nextProvider i18n={i18n}><RouterProvider router={router} /></I18nextProvider></ThemeProvider>)
}

beforeEach(() => { setMatch(); localStorage.clear() })
// Web's vitest config sets no `globals`, so testing-library's auto-cleanup
// afterEach is not registered — `cleanup()` must UNMOUNT the prior render or the
// next case trips over duplicate landmarks (mirrors signin.test.tsx).
afterEach(() => { cleanup() })

describe('LandingRoute', () => {
  it('renders a <nav> landmark with wordmark, theme toggle, and sign-in', () => {
    renderLanding()
    expect(screen.getByTestId('route-landing')).toBeDefined()
    expect(screen.getByTestId('landing-nav').tagName).toBe('NAV')
    expect(screen.getByTestId('landing-wordmark')).toBeDefined()
    expect(screen.getByTestId('landing-theme-toggle')).toBeDefined()
    expect(screen.getByTestId('landing-signin')).toBeDefined()
  })

  it('navigates to /auth/signin when nav Sign in is pressed', () => {
    renderLanding()
    act(() => { screen.getByTestId('landing-signin').click() })
    expect(screen.getByTestId('signin-stub')).toBeDefined()
  })

  it('renders a <main> landmark with a hidden h1, lockup, tagline, CTA, and pricing', () => {
    renderLanding()
    expect(screen.getByTestId('landing-hero').tagName).toBe('MAIN')
    expect(screen.getByRole('heading', { level: 1 })).toBeDefined()
    expect(screen.getByTestId('landing-hero-lockup')).toBeDefined()
    expect(screen.getByTestId('landing-tagline')).toBeDefined()
    expect(screen.getByTestId('landing-pricing')).toBeDefined()
  })

  it('navigates to /auth/signin when the hero CTA is pressed', () => {
    renderLanding()
    act(() => { screen.getByTestId('landing-cta').click() })
    expect(screen.getByTestId('signin-stub')).toBeDefined()
  })

  it('renders a <footer> landmark with Terms / Privacy / Questions links wired to their destinations', () => {
    renderLanding()
    expect(screen.getByTestId('landing-footer').tagName).toBe('FOOTER')
    // assert the hrefs, not just presence — this is what verifies the <Trans> slot→destination wiring
    expect(screen.getByTestId('landing-terms').getAttribute('href')).toBe('/terms')
    expect(screen.getByTestId('landing-privacy').getAttribute('href')).toBe('/privacy')
    expect(screen.getByTestId('landing-questions').getAttribute('href')).toBe('mailto:hello@mythrun.dev')
  })

  it('renders the page→footer dither in BOTH themes (it flips direction, never hides)', () => {
    renderLanding()
    expect(screen.getByTestId('landing-dither')).toBeDefined()        // light (default)
    act(() => { screen.getByTestId('landing-theme-toggle').click() }) // → dark
    expect(screen.getByTestId('landing-dither')).toBeDefined()        // still present in dark (flipped, not hidden)
  })
})
