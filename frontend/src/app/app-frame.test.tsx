import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ApiClientProvider,
  type ApiContext,
  type BalanceResponse,
  type MeResponse,
} from '@mythrun/client-core'
import { AppFrame } from './app-frame.tsx'
import { i18n } from '../i18n/config.ts'
import { IntersectionObserverStub } from '../../test/intersection-observer-stub.ts'

// AppFrame chrome pins (navbar redesign 2026-07-30). The load-bearing groups:
//
//  1. The DEFAULT content Box's inset token. The generating route's
//     <FullBleedStage inset={6}> (MYT-89 audit v2) cancels EXACTLY this padding to
//     render the world-gen graph edge-to-edge on phones — if the frame's content
//     padding moves off step 6, the stage stops being full-bleed (or over-bleeds
//     past the frame edge) and the pair must be changed TOGETHER. This test is the
//     frame-side tripwire; the route-side twin (generating.test.tsx › "act two
//     rides the FullBleedStage") pins the stage's bleed to the same token.
//  2. The FULL-BLEED content variant (MYT-92 T15). A route that declares
//     `handle: { fullBleed: true }` escapes the padded Box and gets a viewport-fill
//     flex column instead (min-h-0 flex-1) — the live-play stage owns the screen
//     below the header, scrolling internally rather than scrolling the page.
//  3. The redesigned banner: StickyBar carries the bar (its <header> landmark, the
//     border-swap hairline — NO standalone Divider), the lockup is fluid in the
//     brand slot, and the right side is two arrangement clusters (desktop:
//     credits · Add credits · name-menu; mobile: credits · hamburger) that Show
//     CSS-switches at `sm`. The gear is DEAD — billing lives in the menu.
//  4. Elevation WIRING only: driving the stubbed IntersectionObserver flips the
//     bar's border class (the state transitions themselves are pinned by the
//     use-scroll-elevation hook tests; StickyBar's own tests pin the paint).
//
// Both header caches are pre-seeded (the screen-harness pattern, staleTime
// Infinity) so the suspense credits slot and the display name render
// deterministically with no live fetch in jsdom.

const TEST_CTX: ApiContext = {
  baseUrl: 'http://api.test',
  getAuthHeaders: () => Promise.resolve({}),
}

const SEED_BALANCE: BalanceResponse = { session: 1250, world_gen: 0, active_subscription: null }

const SEED_ME: MeResponse = {
  user: {
    id: 'dev-user-1',
    username: 'idrisa',
    displayName: 'Idrisa the Bold',
    freeTrialUsed: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
}

function renderFrame(
  options: { fullBleed?: boolean; forceElevated?: boolean } = {},
): ReturnType<typeof createMemoryRouter> {
  const child: RouteObject = {
    path: '*',
    element: <p data-testid="outlet-probe" />,
    ...(options.fullBleed === true ? { handle: { fullBleed: true } } : {}),
  }
  const frame =
    options.forceElevated === undefined ? (
      <AppFrame />
    ) : (
      <AppFrame forceElevated={options.forceElevated} />
    )
  const router = createMemoryRouter([{ element: frame, children: [child] }], {
    initialEntries: ['/home'],
  })
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(['billing', 'balance'], SEED_BALANCE)
  queryClient.setQueryData(['me'], SEED_ME)
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider value={TEST_CTX}>
          <RouterProvider router={router} />
        </ApiClientProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  )
  return router
}

/** Drive the sentinel's stubbed IntersectionObserver: `intersecting: false`
 *  models the sentinel scrolled out (elevate), `true` the return to top. */
function driveSentinel(intersecting: boolean): void {
  const observer = IntersectionObserverStub.instances.at(-1)
  if (observer === undefined) throw new Error('no IntersectionObserver instance recorded')
  act(() => {
    observer.callback([{ isIntersecting: intersecting } as IntersectionObserverEntry], observer)
  })
}

afterEach(cleanup)

describe('AppFrame — the content inset ↔ FullBleedStage coupling (MYT-89 audit v2)', () => {
  it('the frame floors at the viewport on EVERY route — short content never exposes the page background (MYT-102 audit)', () => {
    renderFrame()
    expect(screen.getByTestId('app-frame').className).toContain('min-h-dvh')
  })

  it('pads the content box with --space-6 — the step the generating stage bleeds', () => {
    renderFrame()
    expect(screen.getByTestId('app-frame-content').className).toContain('p-[var(--space-6)]')
  })

  it('renders the routed outlet inside the content box', () => {
    renderFrame()
    const content = screen.getByTestId('app-frame-content')
    expect(content.querySelector('[data-testid="outlet-probe"]')).not.toBeNull()
  })

  it('uses the padded content box (not the bleed container) for a default route', () => {
    renderFrame()
    expect(screen.getByTestId('app-frame-content')).toBeDefined()
    expect(screen.queryByTestId('app-frame-content-bleed')).toBeNull()
  })
})

describe('AppFrame — the banner chrome (navbar redesign)', () => {
  it('renders the bar as a <header> banner landmark (StickyBar)', () => {
    renderFrame()
    expect(screen.getByTestId('app-frame-header').tagName).toBe('HEADER')
  })

  it('renders no gear and no standalone divider (the hairline is the bar border)', () => {
    renderFrame()
    expect(screen.queryByTestId('frame-settings')).toBeNull()
    expect(screen.queryByTestId('app-frame-divider')).toBeNull()
  })

  it('mounts the elevation sentinel out of flow at the top of the frame, before the bar', () => {
    renderFrame()
    const sentinel = screen.getByTestId('frame-sentinel')
    expect(sentinel.getAttribute('aria-hidden')).toBe('true')
    expect(sentinel.className).toContain('absolute')
    // The sentinel precedes the StickyBar in document order (top of the frame root).
    const header = screen.getByTestId('app-frame-header')
    expect(sentinel.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('the lockup is fluid inside the bar brand slot (no fixed width attribute)', () => {
    renderFrame()
    const svg = screen.getByTestId('frame-logo')
    expect(svg.hasAttribute('width')).toBe(false)
    // Still wrapped in the universal home link.
    expect(screen.getByTestId('frame-logo-link').getAttribute('href')).toBe('/home')
  })

  it('mounts BOTH arrangement clusters (Show CSS-switches them at sm): credits twice, one menu per arm', () => {
    renderFrame()
    expect(screen.getByTestId('frame-credits-desktop')).toBeDefined()
    expect(screen.getByTestId('frame-credits-mobile')).toBeDefined()
    expect(screen.getAllByTestId('frame-menu-trigger')).toHaveLength(2)
  })

  it('the desktop menu trigger carries the resolved display name (identity lives IN the menu now)', () => {
    renderFrame()
    expect(screen.getByRole('button', { name: 'Idrisa the Bold' })).toBeDefined()
  })

  it('Add credits navigates to /billing#buy', () => {
    const router = renderFrame()
    fireEvent.click(screen.getByTestId('frame-buy-credits'))
    const { pathname, hash } = router.state.location
    expect(pathname + hash).toBe('/billing#buy')
  })

  it('reserves the + glyph for campaign creation — Add credits carries no leading plus (myth-rhvkt)', () => {
    // Run 2: three plus-prefixed controls diluted the glyph ("+ Add credits",
    // "+ New campaign", "+ NEW CAMPAIGN"). A top-up is not "creating an object";
    // the buy action keeps its label but drops the icon, so + consistently
    // means create-campaign across the page.
    renderFrame()
    const buy = screen.getByTestId('frame-buy-credits')
    expect(buy.querySelector('svg')).toBeNull()
  })
})

describe('AppFrame — elevation wiring (the hook tests own the state machine)', () => {
  it('starts at rest (transparent border) and elevates when the sentinel leaves the viewport', () => {
    renderFrame()
    const header = screen.getByTestId('app-frame-header')
    expect(header.className).toContain('border-transparent')
    driveSentinel(false)
    expect(header.className).toContain('border-border')
    expect(header.className).not.toContain('border-transparent')
    driveSentinel(true)
    expect(header.className).toContain('border-transparent')
  })

  it('forceElevated pins the elevated paint (the stories/tests-only plumb)', () => {
    renderFrame({ forceElevated: true })
    expect(screen.getByTestId('app-frame-header').className).toContain('border-border')
  })
})

describe('AppFrame — the full-bleed content variant (MYT-92 T15)', () => {
  it('drops the padded box for a route that declares handle.fullBleed', () => {
    renderFrame({ fullBleed: true })
    expect(screen.getByTestId('app-frame-content-bleed')).toBeDefined()
    // The padded content Box is gone — the play route owns the full viewport.
    expect(screen.queryByTestId('app-frame-content')).toBeNull()
  })

  it('renders the routed outlet inside the full-bleed container', () => {
    renderFrame({ fullBleed: true })
    const bleed = screen.getByTestId('app-frame-content-bleed')
    expect(bleed.querySelector('[data-testid="outlet-probe"]')).not.toBeNull()
  })

  it('gives the bleed container the flex-scroll unblocker (min-h-0 flex-1 column)', () => {
    renderFrame({ fullBleed: true })
    const { className } = screen.getByTestId('app-frame-content-bleed')
    // min-h-0 is the load-bearing class: without it a tall transcript scrolls the
    // PAGE instead of scrolling inside this region (spec §2 "one viewport").
    expect(className).toContain('min-h-0')
    expect(className).toContain('flex-1')
  })

  it('keeps the header row present in full-bleed mode (only the content region swaps)', () => {
    renderFrame({ fullBleed: true })
    expect(screen.getByTestId('app-frame-header')).toBeDefined()
  })
})

describe('AppFrame — commerce chrome quiets on the immersive stage (myth-u5qro)', () => {
  it('stands the buy affordance down on a full-bleed route; the menu does NOT stand down', () => {
    // Run 2: "'+ Add credits' glowing in the corner while the curtain is
    // lowered is the usher hawking concessions during the overture." On the
    // immersive stage the balance readout stays; the purchase action retreats
    // into the menu (Add credits is a mobile-menu item on every route).
    renderFrame({ fullBleed: true })
    expect(screen.queryByTestId('frame-buy-credits')).toBeNull()
    expect(screen.getAllByTestId('frame-menu-trigger')).toHaveLength(2)
  })

  it('never elevates on a full-bleed route, even when the sentinel scrolls out', () => {
    renderFrame({ fullBleed: true })
    driveSentinel(false)
    expect(screen.getByTestId('app-frame-header').className).toContain('border-transparent')
  })

  it('keeps the buy affordance on ordinary framed routes', () => {
    renderFrame()
    expect(screen.getByTestId('frame-buy-credits')).toBeDefined()
  })
})
