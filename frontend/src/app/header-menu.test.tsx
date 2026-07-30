import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClientProvider, logout, type ApiContext } from '@mythrun/client-core'
import type { ToastOptions } from '@mythrun/client-core/contract'
import { i18n } from '../i18n/config.ts'
import { HeaderMenu, type HeaderMenuProps } from './header-menu.tsx'

// HeaderMenu — the frame's ONE overflow surface (navbar redesign). Desktop: the
// display name IS the trigger (Label-in-Name: the visible name is the accessible
// name, no aria-label override) listing exactly [Sessions & billing, Log out].
// Mobile: a labeled hamburger trigger with the full list behind an identity
// HEADER row (visible text, never a disabled menuitem). A null identity falls
// back to the icon trigger on BOTH arrangements so Log out is never unreachable
// during a cold /me fetch. Logout is the security-shaped pin: success must HARD
// navigate (module token + QueryClient die with the document); failure must
// toast and stay PUT — navigating with a live refresh cookie would resurrect
// the session via the landing's refresh probe.
//
// Interactions ride fireEvent (the web package's standing pattern — user-event
// and jest-dom are @mythrun/ui devDeps only): Radix's trigger toggles on Enter
// keydown and its items select on click, both verified against the installed
// @radix-ui/react-dropdown-menu / react-menu sources (pointerdown is unusable
// here — jsdom's fireEvent carries no `button`, which Radix gates on). The ui
// package's Menu.test.tsx covers full pointer/keyboard semantics with real
// user-event; these tests pin THIS component's contract.

const logoutMock = vi.mocked(logout)
const hardNavigateMock = vi.fn<(url: string) => void>()
const toastSpy = vi.fn<(options: ToastOptions) => void>()

// Mock the client-core barrel's logout at the import boundary; everything else
// (useApiContext, ApiClientProvider) stays real.
vi.mock('@mythrun/client-core', async (importActual) => {
  const actual = await importActual<typeof import('@mythrun/client-core')>()
  return { ...actual, logout: vi.fn() }
})

// The hard-navigation helper (platform/web carve-out) — mirrors signin.test.tsx.
vi.mock('../platform/web/navigation.ts', () => ({
  redirectTo: (url: string): void => {
    hardNavigateMock(url)
  },
}))

// The app-global toast surface — spy at the @mythrun/ui import boundary.
vi.mock('@mythrun/ui', async (importActual) => {
  const actual = await importActual<typeof import('@mythrun/ui')>()
  return {
    ...actual,
    toast: (options: ToastOptions): string => {
      toastSpy(options)
      return 'toast-id'
    },
  }
})

// jsdom has no matchMedia; no global stub exists (suites stub per-file — the
// use-prefers-reduced-motion pattern). One shared listener set + one `wide`
// cell across every mql the code requests; `dispatchChange()` models a real
// breakpoint crossing: the query RESULT flips, then the change listeners fire.
function installMatchMedia(): { dispatchChange: () => void } {
  const listeners = new Set<() => void>()
  const state = { wide: false }
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() {
        return state.wide
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  })
  return {
    dispatchChange: () => {
      state.wide = !state.wide
      listeners.forEach((cb) => {
        cb()
      })
    },
  }
}

const TEST_CTX: ApiContext = {
  baseUrl: 'http://api.test',
  getAuthHeaders: () => Promise.resolve({}),
}

// Prod-shaped mount (mirrors app-frame.test.tsx's router+query wrapper), plus
// the ApiClientProvider the logout call reads its ctx from.
function renderHeaderMenu(props: HeaderMenuProps): ReturnType<typeof render> {
  const router = createMemoryRouter([{ path: '*', element: <HeaderMenu {...props} /> }], {
    initialEntries: ['/home'],
  })
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ApiClientProvider value={TEST_CTX}>
          <RouterProvider router={router} />
        </ApiClientProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

/** Open the menu: Radix's trigger toggles on Enter keydown. (Pointerdown needs
 *  `event.button === 0`, which jsdom's fireEvent does not model.) */
function openMenu(trigger: HTMLElement): void {
  fireEvent.keyDown(trigger, { key: 'Enter' })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
})

describe('HeaderMenu', () => {
  it('desktop: the display name IS the accessible trigger name; menu lists exactly billing + logout', async () => {
    renderHeaderMenu({ arrangement: 'desktop', displayName: 'Idrisa the Bold' })
    const trigger = screen.getByRole('button', { name: 'Idrisa the Bold' })
    expect(trigger.hasAttribute('aria-label')).toBe(false) // visible name = accessible name
    openMenu(trigger)
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual(['Sessions & billing', 'Log out'])
  })

  it('desktop with NULL identity (loading or failed): falls back to the icon trigger — menu never unreachable', () => {
    renderHeaderMenu({ arrangement: 'desktop', displayName: null })
    expect(screen.getByRole('button', { name: 'Menu' })).toBeDefined()
  })

  it('mobile: full list with identity header row; header is not a menuitem', async () => {
    renderHeaderMenu({ arrangement: 'mobile', displayName: 'Idrisa the Bold' })
    openMenu(screen.getByRole('button', { name: 'Menu' }))
    expect(await screen.findByText('Idrisa the Bold')).toBeDefined()
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Campaigns',
      'Add credits',
      'Sessions & billing',
      'Log out',
    ])
  })

  it('menu structure: separators fence the identity header and the exit action (both arrangements)', async () => {
    // Desktop: [billing │ logout] — one fence before Log out.
    const desktop = renderHeaderMenu({ arrangement: 'desktop', displayName: 'Idrisa the Bold' })
    openMenu(screen.getByRole('button', { name: 'Idrisa the Bold' }))
    await screen.findAllByRole('menuitem')
    expect(screen.getAllByRole('separator')).toHaveLength(1)
    desktop.unmount()
    // Mobile with identity: [header │ nav ×3 │ logout] — two fences.
    renderHeaderMenu({ arrangement: 'mobile', displayName: 'Idrisa the Bold' })
    openMenu(screen.getByRole('button', { name: 'Menu' }))
    await screen.findAllByRole('menuitem')
    expect(screen.getAllByRole('separator')).toHaveLength(2)
  })

  it('mobile with NULL identity: no header row, no leading fence — one separator before Log out', async () => {
    renderHeaderMenu({ arrangement: 'mobile', displayName: null })
    openMenu(screen.getByRole('button', { name: 'Menu' }))
    await screen.findAllByRole('menuitem')
    expect(screen.getAllByRole('separator')).toHaveLength(1)
  })

  it('uses the bar-end placement rule-set (end-aligned to the gutter line, not centered)', async () => {
    renderHeaderMenu({ arrangement: 'desktop', displayName: 'Idrisa the Bold' })
    openMenu(screen.getByRole('button', { name: 'Idrisa the Bold' }))
    const panel = await screen.findByTestId('frame-menu')
    expect(panel.getAttribute('data-align')).toBe('end')
  })

  it('logout success: calls the endpoint then hard-navigates to /', async () => {
    logoutMock.mockResolvedValueOnce(undefined)
    renderHeaderMenu({ arrangement: 'desktop', displayName: 'X' })
    openMenu(screen.getByRole('button', { name: 'X' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Log out' }))
    await waitFor(() => {
      expect(logoutMock).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(hardNavigateMock).toHaveBeenCalledWith('/')
    })
  })

  it('logout FAILURE: toast, NO navigation (a live refresh cookie + navigate would resurrect the session)', async () => {
    logoutMock.mockRejectedValueOnce(new Error('503'))
    renderHeaderMenu({ arrangement: 'desktop', displayName: 'X' })
    openMenu(screen.getByRole('button', { name: 'X' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Log out' }))
    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalled()
    })
    expect(hardNavigateMock).not.toHaveBeenCalled()
  })

  // Arrangement-change close (spec, normative): `Show` hides via display:none,
  // so BOTH HeaderMenu instances stay MOUNTED — an open mobile menu's PORTAL
  // (portalled to body, not display:none'd) would survive a resize across the
  // breakpoint, floating over the desktop arrangement.
  it('an open menu closes when the viewport crosses the arrangement breakpoint', async () => {
    const matchMediaStub = installMatchMedia()
    renderHeaderMenu({ arrangement: 'mobile', displayName: 'X' })
    openMenu(screen.getByRole('button', { name: 'Menu' }))
    expect((await screen.findAllByRole('menuitem')).length).toBeGreaterThan(0)
    act(() => {
      matchMediaStub.dispatchChange() // drive the stubbed matchMedia listener
    })
    await waitFor(() => {
      expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    })
  })
})
