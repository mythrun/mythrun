import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { CampaignSummary } from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { CampaignCard } from './home-card.tsx'

// Unit test for the campaign-hub cover card (MYT-87 rework — book cover). The
// component is rendered directly under the real i18n instance — the @mythrun/ui
// Link is a plain <a> (no router needed) and none of the composed primitives read
// the theme context, so the harness is just <I18nextProvider>. Each case proves one
// arm of the design: the cardPhase → mono state-line map, the played record string,
// the colored-vs-ghost cover band AND that the band receives the world's colour
// pair, the world · creator line's creator-conditional, the +N party overflow, and
// the whole-card click target.

const DAY_MS = 86_400_000

// A complete hub-card fixture (the widened MYT-87 shape, now with stepped
// `{ramp}-{step}` WorldColor tokens); each test overrides only the fields it
// exercises.
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

function renderCard(
  campaign: CampaignSummary,
  extra: { lowOnSessionCredits?: boolean } = {},
): void {
  render(
    <I18nextProvider i18n={i18n}>
      <CampaignCard campaign={campaign} {...extra} />
    </I18nextProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('CampaignCard — book-cover structure', () => {
  it('renders the cover band, the serif title, and the mono state line', () => {
    renderCard(makeCampaign())
    expect(screen.getByTestId('card-cover')).toBeDefined()
    // The title is a real heading carrying the campaign name.
    expect(screen.getByRole('heading', { name: 'The Sunken Coast' })).toBeDefined()
    expect(screen.getByTestId('card-state')).toBeDefined()
  })
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
  it('renders the colored CoverDither, passing the world colour pair to it', () => {
    // step-ordered ground (lower step) → accent (higher step), independent of
    // argument order: verdigris-200 is the sparse ground, moss-800 the dense accent.
    renderCard(makeCampaign({ worldColors: { from: 'verdigris-200', to: 'moss-800' } }))
    const cover = screen.getByTestId('card-cover')
    expect(screen.queryByTestId('card-cover-ghost')).toBeNull()
    // The pair reaches the cover as its light-mode ground/accent custom properties.
    expect(cover.style.getPropertyValue('--cover-ground-lt')).toBe('var(--color-verdigris-200)')
    expect(cover.style.getPropertyValue('--cover-accent-lt')).toBe('var(--color-moss-800)')
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

  it('suppresses the sub-line entirely when it would only echo the title (MYT-102 audit)', () => {
    renderCard(makeCampaign({ name: 'Aerth', worldName: 'Aerth', creator: null }))
    expect(screen.queryByTestId('card-world')).toBeNull()
  })

  it('keeps the creator credit even when the names match (renamed-free joined world)', () => {
    renderCard(makeCampaign({ name: 'Aerth', worldName: 'Aerth', creator: 'Brennan' }))
    const world = screen.getByTestId('card-world').textContent
    expect(world).toContain('Brennan')
    expect(world.startsWith('Aerth')).toBe(false)
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

describe('CampaignCard — assembling party (built vs building seals)', () => {
  // The hub foot reflects the party FILLING: a member who has made a character
  // (`hasCharacter:true`) is a pigment Avatar seal; a member who has joined but is
  // still building (`hasCharacter:false`) is a distinct muted 1-bit placeholder
  // seal (the roster's hatch treatment) — NOT a chip/dot (register rule) — so an
  // owner watching the hub sees the party assemble.
  it('renders built members as pigment seals and a distinct placeholder seal for each still-building member', () => {
    const party = [
      { userId: 'u-1', displayName: 'Ada', hasCharacter: true },
      { userId: 'u-2', displayName: 'Bram', hasCharacter: true },
      { userId: 'u-3', displayName: 'Cyra', hasCharacter: false },
    ]
    renderCard(makeCampaign({ party }))
    // Built members are pigment Avatar seals (role="img", named).
    expect(screen.getByRole('img', { name: 'Ada' })).toBeDefined()
    expect(screen.getByRole('img', { name: 'Bram' })).toBeDefined()
    // The still-building member renders a distinct placeholder seal (by testid, not
    // a chip) that still names the member — a11y parity with the pigment seals.
    const building = screen.getAllByTestId('card-building-seal')
    expect(building).toHaveLength(1)
    expect(building[0]?.getAttribute('aria-label')).toBe('Cyra')
  })

  it('renders a solo built owner as a single seal with no placeholder', () => {
    renderCard(makeCampaign({ party: [{ userId: 'u-1', displayName: 'Ada', hasCharacter: true }] }))
    expect(screen.getByRole('img', { name: 'Ada' })).toBeDefined()
    expect(screen.queryByTestId('card-building-seal')).toBeNull()
  })

  it('caps the combined party at 5 seals (built first, then building) with a +N overflow', () => {
    // 3 built + 4 building = 7 total → the first 5 (3 built + 2 building) render as
    // seals and the remaining 2 collapse into a single +2 overflow.
    const party = [
      ...Array.from({ length: 3 }, (_, i) => ({
        userId: `b-${String(i)}`,
        displayName: `Built ${String(i)}`,
        hasCharacter: true,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        userId: `g-${String(i)}`,
        displayName: `Gathering ${String(i)}`,
        hasCharacter: false,
      })),
    ]
    renderCard(makeCampaign({ party }))
    // Both a pigment Avatar and a placeholder seal are role="img"; 5 seals show.
    expect(screen.getAllByRole('img')).toHaveLength(5)
    expect(screen.getByText('+2')).toBeDefined()
  })
})

// ── MYT-95 T13 (controller patch): owner-only low-credit line ───────────────
describe('low-credit line', () => {
  it('renders for the OWNER (creator null) when low', () => {
    renderCard(makeCampaign({ creator: null }), { lowOnSessionCredits: true })
    expect(screen.getByTestId('card-low-credits')).toBeDefined()
  })

  it('never renders for a joined member, even when low', () => {
    renderCard(makeCampaign({ creator: 'Ana' }), { lowOnSessionCredits: true })
    expect(screen.queryByTestId('card-low-credits')).toBeNull()
  })

  it('does not render for the owner when not low', () => {
    renderCard(makeCampaign({ creator: null }), { lowOnSessionCredits: false })
    expect(screen.queryByTestId('card-low-credits')).toBeNull()
  })
})
