import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import { AppFrame } from './app-frame.tsx'
import { i18n } from '../i18n/config.ts'

// AppFrame chrome pins. Two load-bearing content-layout assertions:
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
//     below the header, scrolling internally rather than scrolling the page. The
//     `min-h-0` flex-scroll unblocker is the load-bearing class here.

function renderFrame(childHandle?: { readonly fullBleed: true }): void {
  const child: RouteObject = {
    index: true,
    element: <p data-testid="outlet-probe" />,
    handle: childHandle,
  }
  const router = createMemoryRouter([{ element: <AppFrame />, children: [child] }])
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>,
  )
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

  it('keeps the header row present in full-bleed mode (92 swaps only the content region; 95 owns the header)', () => {
    renderFrame({ fullBleed: true })
    expect(screen.getByTestId('app-frame-header')).toBeDefined()
  })
})
