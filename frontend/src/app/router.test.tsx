import { render, screen, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { useSessionStore } from '@mythrun/client-core'
import { afterEach, describe, expect, it } from 'vitest'
import { routes } from './router.tsx'
import { i18n } from '../i18n/config.ts'

// The shell's routing contract, proven through `createMemoryRouter` over the
// SAME `routes` array the app ships (so the test exercises the real tree, not a
// parallel one). Each case drives the three-state `<RequireAuth>` gate by
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

function renderAt(initialPath: string): void {
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] })
  render(
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  )
}

describe('app router', () => {
  it('redirects a protected route to the sign-in stub when unauthenticated', () => {
    // Default state is `unauthenticated`; <RequireAuth> must bounce /home → /auth/signin.
    renderAt('/home')
    expect(screen.getByTestId('route-signin')).toBeDefined()
    // The authed frame must NOT have rendered.
    expect(screen.queryByTestId('app-frame')).toBeNull()
  })

  it('renders the authed frame for a protected route when ready', () => {
    act(() => {
      useSessionStore.getState().setReady('dev-user-1')
    })
    renderAt('/home')
    // The quiet brand frame's header is present, wrapping the home stub.
    expect(screen.getByTestId('app-frame')).toBeDefined()
    expect(screen.getByTestId('route-home')).toBeDefined()
  })

  it('renders the dithered 404 for an unknown path', () => {
    renderAt('/no/such/route')
    // The Dither component paints an SVG carrying `data-dither-texture`; its
    // presence proves the full-bleed dithered 404 rendered.
    const dither = document.querySelector('[data-dither-texture]')
    expect(dither).not.toBeNull()
  })
})
