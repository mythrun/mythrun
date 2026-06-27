import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, act, cleanup } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ApiClientProvider, useSessionStore, type ApiContext } from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'

const parseCallback = vi.fn()
const consumeAuthState = vi.fn()
const isLocalPath = vi.fn()
const createSession = vi.fn()
const setAccessToken = vi.fn()
const applyMe = vi.fn<(ctx: ApiContext) => Promise<void>>()

vi.mock('@mythrun/client-core', async (orig) => {
  const actual = await orig<typeof import('@mythrun/client-core')>()
  return {
    ...actual,
    parseCallback: (...a: unknown[]) => parseCallback(...a),
    consumeAuthState: (...a: unknown[]) => consumeAuthState(...a),
    isLocalPath: (...a: unknown[]) => isLocalPath(...a),
    createSession: (...a: unknown[]) => createSession(...a),
    // `applyMe` is the one typed mock (`vi.fn<(ctx) => Promise<void>>`), so forward
    // its single fixed arg — an `unknown[]` rest-spread can't satisfy that signature.
    applyMe: (ctx: ApiContext) => applyMe(ctx),
    setAccessToken: (...a: unknown[]) => setAccessToken(...a),
  }
})

// Imported AFTER the mock (the route binds the mocked members).
const { CallbackRoute } = await import('./callback.tsx')

const ctx: ApiContext = { baseUrl: 'http://api.test', getAuthHeaders: () => Promise.resolve({}) }

function renderCallback(search: string): void {
  const router = createMemoryRouter(
    [
      { path: '/auth/callback', element: <CallbackRoute /> },
      { path: '/home', element: <div data-testid="at-home" /> },
      { path: '/auth/onboard', element: <div data-testid="at-onboard" /> },
      { path: '/join/:code', element: <div data-testid="at-join" /> },
    ],
    { initialEntries: [`/auth/callback${search}`] },
  )
  render(
    <ApiClientProvider value={ctx}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </ApiClientProvider>,
  )
}

// NOTE: the route's single-use `code` guard is a MODULE-LEVEL Set (it survives a
// real remount, by design), so it persists ACROSS the cases in this file — give
// every case a DISTINCT `code` (OAuth authorization codes are unique anyway), or
// a later case dedups against an earlier one before its assertion can run.
beforeEach(() => {
  useSessionStore.setState({ status: 'initializing', sub: null, suspended: false })
  for (const m of [parseCallback, consumeAuthState, isLocalPath, createSession, setAccessToken, applyMe]) m.mockReset()
  isLocalPath.mockReturnValue(true)
  createSession.mockResolvedValue({ accessToken: 'at', expiresIn: 3600, name: 'Aria' })
})
// This suite has no global testing-library auto-cleanup (web's vitest config sets
// no `globals`), and cases 3 + 4 both assert the SAME `callback-error` testid —
// so `cleanup()` must UNMOUNT the prior render or the next case trips over a
// phantom second match. Mirrors `app/require-auth.test.tsx`.
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('CallbackRoute', () => {
  it('exchanges the code and navigates to the return-to when ready', async () => {
    parseCallback.mockReturnValue({ code: 'auth-code', state: 'st' })
    consumeAuthState.mockReturnValue({ provider: 'google', returnTo: '/join/abc', verifier: 'v' })
    applyMe.mockImplementation((c: ApiContext) => {
      void c
      act(() => { useSessionStore.getState().setReady('sub-1') })
      return Promise.resolve()
    })

    renderCallback('?code=auth-code&state=st')

    await waitFor(() => { expect(screen.getByTestId('at-join')).toBeDefined() })
    expect(createSession).toHaveBeenCalledWith({ code: 'auth-code', codeVerifier: 'v' }, ctx)
    expect(setAccessToken).toHaveBeenCalledWith('at', 3600)
  })

  it('navigates to onboard (carrying name + returnTo) when onboarding-required', async () => {
    parseCallback.mockReturnValue({ code: 'c', state: 'st' })
    consumeAuthState.mockReturnValue({ provider: 'discord', returnTo: '/home', verifier: 'v' })
    applyMe.mockImplementation(() => {
      act(() => { useSessionStore.getState().setOnboardingRequired('sub-2') })
      return Promise.resolve()
    })
    renderCallback('?code=c&state=st')
    await waitFor(() => { expect(screen.getByTestId('at-onboard')).toBeDefined() })
  })

  it('shows the error state when the state does not match (consumeAuthState null)', async () => {
    parseCallback.mockReturnValue({ code: 'forged-code', state: 'forged' })
    consumeAuthState.mockReturnValue(null)
    renderCallback('?code=forged-code&state=forged')
    await waitFor(() => { expect(screen.getByTestId('callback-error')).toBeDefined() })
    expect(createSession).not.toHaveBeenCalled()
  })

  it('shows the error state when parseCallback reports an error (provider denial)', async () => {
    parseCallback.mockReturnValue({ error: 'access_denied' })
    renderCallback('?error=access_denied')
    await waitFor(() => { expect(screen.getByTestId('callback-error')).toBeDefined() })
    expect(consumeAuthState).not.toHaveBeenCalled()
  })

  it('runs the exchange exactly once under StrictMode double-mount', async () => {
    parseCallback.mockReturnValue({ code: 'once', state: 'st' })
    consumeAuthState.mockReturnValue({ provider: 'google', returnTo: '/home', verifier: 'v' })
    applyMe.mockImplementation(() => {
      act(() => { useSessionStore.getState().setReady('sub-1') })
      return Promise.resolve()
    })
    renderCallback('?code=once&state=st')
    await waitFor(() => { expect(screen.getByTestId('at-home')).toBeDefined() })
    expect(createSession).toHaveBeenCalledTimes(1)
  })
})
