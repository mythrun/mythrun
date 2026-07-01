import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { CampaignSummary } from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'
import { CampaignIndexRow } from './home-index-row.tsx'

// Unit test for the mobile campaign-hub INDEX ROW (MYT-87 T15). The compact
// "table of contents" entry the hub shows below the grid breakpoint: a small
// world-dither swatch + the title + world + the SAME mono state line as the
// card, the whole row a link to the campaign. Rendered under the real i18n
// instance (the state line is the only i18n-bearing text).

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
    worldColors: { from: 'ember', to: 'lapis' },
    creator: null,
    party: [{ userId: 'u-1', displayName: 'Ada', hasCharacter: true }],
    sessionCount: 0,
    lastPlayedAt: null,
    cardPhase: 'not-played',
    ...overrides,
  }
}

function renderRow(campaign: CampaignSummary): void {
  render(
    <I18nextProvider i18n={i18n}>
      <CampaignIndexRow campaign={campaign} />
    </I18nextProvider>,
  )
}

afterEach(cleanup)

describe('CampaignIndexRow', () => {
  it('renders the world-dither swatch when worldColors is set', () => {
    renderRow(makeCampaign({ worldColors: { from: 'sienna', to: 'paper-100' } }))
    expect(screen.getByTestId('row-cover')).toBeDefined()
    expect(screen.queryByTestId('row-cover-ghost')).toBeNull()
  })

  it('renders the paper ghost swatch (NOT a chromatic default) when worldColors is null', () => {
    renderRow(makeCampaign({ worldColors: null, cardPhase: 'generating' }))
    expect(screen.getByTestId('row-cover-ghost')).toBeDefined()
    expect(screen.queryByTestId('row-cover')).toBeNull()
  })

  it('shows the title and world name', () => {
    renderRow(makeCampaign({ name: 'The Sunken Coast', worldName: 'Aerth' }))
    expect(screen.getByText('The Sunken Coast')).toBeDefined()
    expect(screen.getByText('Aerth')).toBeDefined()
  })

  it('renders the same mono state line as the card', () => {
    renderRow(makeCampaign({ cardPhase: 'needs-character' }))
    expect(screen.getByTestId('row-state').textContent).toBe(i18n.t('home.card.needsCharacter'))
  })

  it('makes the whole row a link to the campaign detail', () => {
    renderRow(makeCampaign({ id: 'c-42' }))
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('/campaigns/c-42')
    // The swatch + the texts live INSIDE the one link (the whole row is the target).
    expect(within(link).getByTestId('row-state')).toBeDefined()
  })
})
