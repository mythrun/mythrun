import { describe, it, expect } from 'vitest'
import type { CampaignSummary } from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { cardPhaseLine } from './card-phase-line.ts'

// Unit test for the shared cardPhase → mono state-line helper (MYT-87 T15). The
// card AND the mobile index row both render the SAME state line; this helper is
// the single source for that string, DRY'd out of `home-card.tsx`. Driven by the
// real i18n instance's `t` + a pinned clock so the relative phrasing is
// deterministic (no system-time flake).

const DAY_MS = 86_400_000
const NOW_MS = new Date('2026-06-30T12:00:00.000Z').getTime()

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

describe('cardPhaseLine', () => {
  it.each([
    ['generating', 'home.card.generating'],
    ['failed', 'home.card.failed'],
    ['needs-character', 'home.card.needsCharacter'],
    ['waiting-for-players', 'home.card.waiting'],
    ['not-played', 'home.card.notPlayed'],
  ] as const)('returns the static %s phase label', (cardPhase, key) => {
    expect(cardPhaseLine(makeCampaign({ cardPhase }), i18n.t, 'en', NOW_MS)).toBe(i18n.t(key))
  })

  it('builds the played record line, pluralizing on the session count', () => {
    const lastPlayedAt = new Date(NOW_MS - 2 * DAY_MS).toISOString()
    // count > 1 selects record_other → "N sessions · last played …".
    const plural = cardPhaseLine(
      makeCampaign({ cardPhase: 'played', sessionCount: 4, lastPlayedAt }),
      i18n.t,
      'en',
      NOW_MS,
    )
    expect(plural).toContain('4 sessions')
    expect(plural).toContain('2 days ago')

    // count === 1 selects record_one → the singular "1 session" (never "1 sessions").
    const singular = cardPhaseLine(
      makeCampaign({ cardPhase: 'played', sessionCount: 1, lastPlayedAt }),
      i18n.t,
      'en',
      NOW_MS,
    )
    expect(singular).toContain('1 session')
    expect(singular).not.toContain('1 sessions')
  })

  it('falls back to the terse "recently" when a played card has a null lastPlayedAt', () => {
    const line = cardPhaseLine(
      makeCampaign({ cardPhase: 'played', sessionCount: 1, lastPlayedAt: null }),
      i18n.t,
      'en',
      NOW_MS,
    )
    expect(line).toContain(i18n.t('home.card.recently'))
  })

  it('steps the relative unit by magnitude (day → week → month → year)', () => {
    const at = (days: number): string => new Date(NOW_MS - days * DAY_MS).toISOString()
    const lineFor = (days: number): string =>
      cardPhaseLine(
        makeCampaign({ cardPhase: 'played', sessionCount: 2, lastPlayedAt: at(days) }),
        i18n.t,
        'en',
        NOW_MS,
      )
    // The unit WORD is what steps; the exact phrasing is `Intl` numeric:'auto'
    // ("2 days ago", "last week", "2 months ago", "last year").
    expect(lineFor(2)).toContain('day')
    expect(lineFor(10)).toContain('week')
    expect(lineFor(60)).toContain('month')
    expect(lineFor(400)).toContain('year')
  })
})
