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

// The grid leads with a `Link`-wrapped create tile (an `<a href>`), so the unit
// render needs a router context — a bare <MemoryRouter> is enough.
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

  it('trails the grid with the create tile as the LAST cell, linking to campaign-new (myth-z9eiq)', () => {
    renderHub([makeCampaign({ id: 'a' }), makeCampaign({ id: 'b' })])
    const grid = screen.getByTestId('hub-grid')
    const createCard = within(grid).getByTestId('hub-create-card')
    // The create tile is a link to the campaign-new route…
    expect(createCard.getAttribute('href')).toBe('/campaigns/new')
    // …and it TERMINATES the grid (the Figma/Drive convention): the premier
    // top-left cell belongs to the player's most-recent campaign, the ghost
    // tile trails as a natural "+ one more". Create-primacy stays with the
    // page header's filled button.
    const gridChildren = Array.from(grid.querySelectorAll('[data-testid^="campaign-card-"], [data-testid="hub-create-card"]'))
    expect(gridChildren[gridChildren.length - 1]).toBe(createCard)
    expect(gridChildren[0]?.getAttribute('data-testid')).toBe('campaign-card-a')
  })

  it('gives the premier card the loud continue cue and every dormant played card a quiet resume (myth-7jc1h)', () => {
    // b was played more recently than a → hub-sort puts b in the premier slot.
    // Run 3 (P1): the dormant played card is no longer inert — it carries the
    // quieter "Resume →" so a returning player's invested campaigns all read as
    // continuable, ranked by weight rather than by cta presence/absence.
    renderHub([
      makeCampaign({ id: 'a', cardPhase: 'played', sessionCount: 2, lastPlayedAt: '2026-06-01T10:00:00.000Z' }),
      makeCampaign({ id: 'b', cardPhase: 'played', sessionCount: 7, lastPlayedAt: '2026-06-20T10:00:00.000Z' }),
    ])
    const grid = screen.getByTestId('hub-grid')
    const premier = within(grid).getByTestId('campaign-card-b')
    expect(within(premier).getByTestId('cover-card-cta').textContent).toBe(
      i18n.t('home.card.continueSession'),
    )
    const other = within(grid).getByTestId('campaign-card-a')
    expect(within(other).getByTestId('cover-card-cta').textContent).toBe(i18n.t('home.card.resume'))
  })

  it('shows no continue-session cue when the premier campaign has not been played', () => {
    renderHub([makeCampaign({ id: 'a', cardPhase: 'not-played' })])
    const grid = screen.getByTestId('hub-grid')
    expect(within(grid).queryByTestId('cover-card-cta')).toBeNull()
  })
})
