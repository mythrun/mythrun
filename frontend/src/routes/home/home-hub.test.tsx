import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import type { CampaignSummary } from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { CampaignHubBody } from './home-hub.tsx'

// Unit test for the responsive campaign-hub BODY (MYT-87 T15). The hub renders
// BOTH layouts and lets the `Show` primitive's breakpoint classes decide which
// is visible: a desktop GRID of cover cards (shown ≥ sm) ⊕ a mobile INDEX list
// of compact rows (shown < sm). jsdom has no layout, so both subtrees are in the
// DOM; we assert the wrapper breakpoint classes + that each layout carries its
// per-campaign element. (T16 drops this into `home.tsx` with the header + empty
// state.)

function makeCampaign(overrides: Partial<CampaignSummary> = {}): CampaignSummary {
  return {
    id: 'c-1',
    worldId: 'w-1',
    name: 'The Sunken Coast',
    status: 'active',
    language: 'en',
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
    worldName: 'Aerth',
    worldColors: { from: 'ember-200', to: 'lapis-800' },
    creator: null,
    party: [{ userId: 'u-1', displayName: 'Ada', hasCharacter: true }],
    sessionCount: 0,
    lastPlayedAt: null,
    cardPhase: 'not-played',
    ...overrides,
  }
}

// The body now carries a `useNavigate`-backed "new campaign" CTA (the populated-hub
// counterpart to the empty shelf's create CTA), so the unit render needs a router
// context — a bare <MemoryRouter> is enough (the CTA only calls navigate on press).
function renderHub(campaigns: CampaignSummary[]): void {
  render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <CampaignHubBody campaigns={campaigns} />
      </I18nextProvider>
    </MemoryRouter>,
  )
}

afterEach(cleanup)

describe('CampaignHubBody', () => {
  it('renders a desktop grid (shown ≥ sm) carrying a cover card per campaign', () => {
    renderHub([makeCampaign({ id: 'a' }), makeCampaign({ id: 'b' })])
    const grid = screen.getByTestId('hub-grid')
    expect(grid.classList.contains('hidden')).toBe(true)
    expect(grid.classList.contains('sm:block')).toBe(true)
    expect(within(grid).getByTestId('campaign-card-a')).toBeDefined()
    expect(within(grid).getByTestId('campaign-card-b')).toBeDefined()
  })

  it('renders a mobile index (shown < sm) carrying a compact row per campaign', () => {
    renderHub([makeCampaign({ id: 'a' }), makeCampaign({ id: 'b' })])
    const index = screen.getByTestId('hub-index')
    expect(index.classList.contains('block')).toBe(true)
    expect(index.classList.contains('sm:hidden')).toBe(true)
    expect(within(index).getByTestId('campaign-index-row-a')).toBeDefined()
    expect(within(index).getByTestId('campaign-index-row-b')).toBeDefined()
  })

  it('hairline-divides the index rows (a divider between, not before, the first)', () => {
    renderHub([makeCampaign({ id: 'a' }), makeCampaign({ id: 'b' }), makeCampaign({ id: 'c' })])
    const index = screen.getByTestId('hub-index')
    // Three rows → two separators between them.
    expect(within(index).getAllByRole('separator')).toHaveLength(2)
  })

  it('renders a quiet "new campaign" CTA below the shelf (the populated-hub counterpart to the empty CTA)', () => {
    renderHub([makeCampaign({ id: 'a' })])
    // A single trailing affordance for starting another campaign — MYT-87 shipped
    // the CTA only on the EMPTY hub, so a player who already owns campaigns had no
    // way to start a new one from the populated grid.
    expect(screen.getByTestId('new-campaign')).toBeDefined()
  })
})
