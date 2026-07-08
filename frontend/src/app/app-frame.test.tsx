import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import { AppFrame } from './app-frame.tsx'
import { i18n } from '../i18n/config.ts'

// AppFrame chrome pins. The one load-bearing assertion: the content Box's inset
// token. The generating route's <FullBleedStage inset={6}> (MYT-89 audit v2)
// cancels EXACTLY this padding to render the world-gen graph edge-to-edge on
// phones — if the frame's content padding moves off step 6, the stage stops
// being full-bleed (or over-bleeds past the frame edge) and the pair must be
// changed TOGETHER. This test is the frame-side tripwire; the route-side twin
// (generating.test.tsx › "act two rides the FullBleedStage") pins the stage's
// bleed to the same token.

function renderFrame(): void {
  const router = createMemoryRouter([
    { element: <AppFrame />, children: [{ index: true, element: <p data-testid="outlet-probe" /> }] },
  ])
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
  it('pads the content box with --space-6 — the step the generating stage bleeds', () => {
    renderFrame()
    expect(screen.getByTestId('app-frame-content').className).toContain('p-[var(--space-6)]')
  })

  it('renders the routed outlet inside the content box', () => {
    renderFrame()
    const content = screen.getByTestId('app-frame-content')
    expect(content.querySelector('[data-testid="outlet-probe"]')).not.toBeNull()
  })
})
