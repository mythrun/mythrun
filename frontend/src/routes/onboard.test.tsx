import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, act, cleanup } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import { ApiClientProvider, HttpError, useSessionStore, type ApiContext } from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'

// ENVIRONMENT shim (Node 25 vs jsdom), not production code. The screen mounts
// @mythrun/ui's <ThemeProvider>, which reads `localStorage` on mount to resolve
// the initial theme (and the beforeEach `localStorage.clear()` needs it too).
// Node 25 ships the experimental Web Storage API on by default, installing a
// non-functional builtin `localStorage` (no getItem/clear) that SHADOWS the real
// `Storage` jsdom would provide. Install a functional in-memory `Storage` so the
// stack renders. Mirrors `signin.test.tsx` / `providers.test.tsx`.
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

const checkUsername = vi.fn()
const register = vi.fn()

vi.mock('@mythrun/client-core', async (orig) => {
  const actual = await orig<typeof import('@mythrun/client-core')>()
  return {
    ...actual,
    checkUsername: (...a: unknown[]) => checkUsername(...a),
    register: (...a: unknown[]) => register(...a),
    isLocalPath: () => true,
  }
})
const { OnboardRoute } = await import('./onboard.tsx')

// A dummy ApiContext so the route's `useApiContext()` read resolves (register is
// mocked, so this ctx is just threaded through as the 2nd arg the test matches on).
const CTX: ApiContext = { baseUrl: 'http://test.invalid', getAuthHeaders: () => Promise.resolve({}) }

function setMatch(): void {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: (q: string) => ({ matches: false, media: q, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }) })
}

function renderOnboard(state?: { name?: string | null; returnTo?: string }): void {
  const router = createMemoryRouter(
    [
      { path: '/auth/onboard', element: <OnboardRoute /> },
      { path: '/home', element: <div data-testid="at-home" /> },
      { path: '/join/:code', element: <div data-testid="at-join" /> },
    ],
    { initialEntries: [{ pathname: '/auth/onboard', state }] },
  )
  render(
    <ThemeProvider>
      <ApiClientProvider value={CTX}>
        <I18nextProvider i18n={i18n}>
          <RouterProvider router={router} />
        </I18nextProvider>
      </ApiClientProvider>
    </ThemeProvider>,
  )
}

beforeEach(() => {
  setMatch(); localStorage.clear()
  useSessionStore.setState({ status: 'onboarding-required', sub: 'cognito-1', suspended: false })
  checkUsername.mockReset().mockResolvedValue({ available: true })
  register.mockReset().mockResolvedValue({ user: { id: 'db1' }, created: true })
})
// Web's vitest config sets no `globals`, so testing-library's auto-cleanup is not
// registered — `cleanup()` must UNMOUNT the prior render (mirrors signin.test).
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('OnboardRoute', () => {
  it('pre-fills the name from location state', () => {
    renderOnboard({ name: 'Aria Thorne', returnTo: '/home' })
    expect(screen.getByDisplayValue('Aria Thorne')).toBeDefined()
  })

  it('happy path: derive → check available → register once → ready → return-to', async () => {
    renderOnboard({ name: 'Aria Thorne', returnTo: '/join/abc' })
    act(() => { screen.getByRole('button', { name: /continue/i }).click() })
    await waitFor(() => { expect(screen.getByTestId('at-join')).toBeDefined() })
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith({ username: 'ariathorne', displayName: 'Aria Thorne' }, expect.anything())
    expect(useSessionStore.getState().status).toBe('ready')
  })

  it('display_name_invalid (400) → inline error, no navigation', async () => {
    register.mockRejectedValue(new HttpError(400, 'Bad Request', 'display_name_invalid'))
    renderOnboard({ name: 'Aria', returnTo: '/home' })
    act(() => { screen.getByRole('button', { name: /continue/i }).click() })
    await waitFor(() => { expect(screen.getByTestId('onboard-field-error')).toBeDefined() })
    expect(screen.queryByTestId('at-home')).toBeNull()
  })

  it('already_onboarded (409) → setReady → return-to (no loop)', async () => {
    register.mockRejectedValue(new HttpError(409, 'Conflict', 'already_onboarded'))
    renderOnboard({ name: 'Aria', returnTo: '/home' })
    act(() => { screen.getByRole('button', { name: /continue/i }).click() })
    await waitFor(() => { expect(screen.getByTestId('at-home')).toBeDefined() })
    expect(useSessionStore.getState().status).toBe('ready')
  })

  it('username_taken (409) → re-probe + register again, bounded', async () => {
    register
      .mockRejectedValueOnce(new HttpError(409, 'Conflict', 'username_taken'))
      .mockResolvedValueOnce({ user: { id: 'db1' }, created: true })
    renderOnboard({ name: 'Aria', returnTo: '/home' })
    act(() => { screen.getByRole('button', { name: /continue/i }).click() })
    await waitFor(() => { expect(screen.getByTestId('at-home')).toBeDefined() })
    expect(register.mock.calls.length).toBeGreaterThanOrEqual(2)
    // The 2nd register used a DIFFERENT candidate (local mutation, not the same taken slug).
    expect((register.mock.calls[1]?.[0] as { username: string }).username)
      .not.toBe((register.mock.calls[0]?.[0] as { username: string }).username)
  })

  it('429 → friendly rate-limit error, no loop', async () => {
    register.mockRejectedValue(new HttpError(429, 'Too Many Requests', 'rate_limited'))
    renderOnboard({ name: 'Aria', returnTo: '/home' })
    act(() => { screen.getByRole('button', { name: /continue/i }).click() })
    await waitFor(() => { expect(screen.getByTestId('onboard-error')).toBeDefined() })
  })

  it('gracefully renders with an empty pre-fill (reload — no location state)', () => {
    renderOnboard(undefined)
    expect(screen.getByTestId('route-onboard')).toBeDefined()
  })
})
