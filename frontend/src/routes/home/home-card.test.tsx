import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { CampaignSummary } from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { CampaignCard } from './home-card.tsx'

// Unit test for the campaign-hub cover card (MYT-87 T14). The component is
// rendered directly under the real i18n instance — the @mythrun/ui Link is a
// plain <a> (no router needed) and none of the composed primitives read the
// theme context, so the harness is just <I18nextProvider>. Each case proves one
// arm of the design: the cardPhase → mono state-line map, the played record
// string, the colored-vs-ghost cover band, the world · creator line's
// creator-conditional, the +N party overflow, and the whole-card click target.

const DAY_MS = 86_400_000

// A complete hub-card fixture (the widened MYT-87 T11 shape); each test overrides
// only the fields it exercises.
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

function renderCard(campaign: CampaignSummary): void {
  render(
    <I18nextProvider i18n={i18n}>
      <CampaignCard campaign={campaign} />
    </I18nextProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('CampaignCard — cardPhase → mono state line', () => {
  it.each([
    ['generating', 'home.card.generating'],
    ['failed', 'home.card.failed'],
    ['needs-character', 'home.card.needsCharacter'],
    ['waiting-for-players', 'home.card.waiting'],
    ['not-played', 'home.card.notPlayed'],
  ] as const)('renders the %s phase line', (cardPhase, key) => {
    renderCard(makeCampaign({ cardPhase }))
    expect(screen.getByTestId('card-state').textContent).toBe(i18n.t(key))
  })

  it('renders the play record for the played phase (N sessions · relative)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-30T12:00:00.000Z'))
    const lastPlayedAt = new Date(Date.now() - 2 * DAY_MS).toISOString()
    renderCard(makeCampaign({ cardPhase: 'played', sessionCount: 4, lastPlayedAt }))
    const line = screen.getByTestId('card-state').textContent
    expect(line).toContain('4 sessions')
    expect(line).toContain('2 days ago')
  })
})

describe('CampaignCard — cover band', () => {
  it('renders the colored CoverDither when worldColors is set', () => {
    renderCard(makeCampaign({ worldColors: { from: 'sienna', to: 'paper-100' } }))
    expect(screen.getByTestId('card-cover')).toBeDefined()
    expect(screen.queryByTestId('card-cover-ghost')).toBeNull()
  })

  it('renders the ghost band (NOT a default-pair CoverDither) when worldColors is null', () => {
    renderCard(makeCampaign({ worldColors: null, cardPhase: 'generating' }))
    expect(screen.getByTestId('card-cover-ghost')).toBeDefined()
    expect(screen.queryByTestId('card-cover')).toBeNull()
  })
})

describe('CampaignCard — world · creator line', () => {
  it('shows · by {creator} when the viewer did not create the world', () => {
    renderCard(makeCampaign({ worldName: 'Aerth', creator: 'Brennan' }))
    const world = screen.getByTestId('card-world').textContent
    expect(world).toContain('Aerth')
    expect(world).toContain('Brennan')
  })

  it("omits the creator on the viewer's own world (creator null)", () => {
    renderCard(makeCampaign({ worldName: 'Aerth', creator: null }))
    expect(screen.getByTestId('card-world').textContent).toBe('Aerth')
  })
})

describe('CampaignCard — party seals + click target', () => {
  it('caps the party at 5 seals and shows a +N overflow', () => {
    const party = Array.from({ length: 7 }, (_, i) => ({
      userId: `u-${String(i)}`,
      displayName: `Player ${String(i)}`,
      hasCharacter: true,
    }))
    renderCard(makeCampaign({ party }))
    // Avatar roots are role="img"; the +N chip is plain text, not an avatar.
    expect(screen.getAllByRole('img')).toHaveLength(5)
    expect(screen.getByText('+2')).toBeDefined()
  })

  it('makes the whole card a link to the campaign detail', () => {
    renderCard(makeCampaign({ id: 'c-42' }))
    expect(screen.getByRole('link').getAttribute('href')).toBe('/campaigns/c-42')
  })
})
