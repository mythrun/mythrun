import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { CampaignSummary } from '@mythrun/client-core'

// The campaign-hub state line (MYT-87). One campaign's `cardPhase` → its terse
// mono line — "shaping your world", "your turn — make your character", or, once
// played, the "N sessions · <relative>" record. The COVER CARD and the mobile
// INDEX ROW both render this exact string, so the logic lives here once (DRY'd
// out of `home-card.tsx`) rather than duplicated per layout.

const DAY_MS = 86_400_000

// The five phases whose state line is a single static label. `played` is special
// (a record string built from sessionCount + a relative lastPlayedAt), so it is
// excluded here and handled below. A static literal map keeps every key a
// first-class string the typed-keys guard + the i18n:todo scan can see — a
// computed `home.card.${phase}` template would be invisible to both.
const PHASE_LABEL_KEY = {
  generating: 'home.card.generating',
  failed: 'home.card.failed',
  'needs-character': 'home.card.needsCharacter',
  'waiting-for-players': 'home.card.waiting',
  'not-played': 'home.card.notPlayed',
} as const satisfies Record<Exclude<CampaignSummary['cardPhase'], 'played'>, string>

/**
 * A terse, locale-aware "when" for the played record line — the only place the
 * hub formats a relative time. Mechanical date math (no LLM, ZFC-exempt) through
 * the platform's `Intl.RelativeTimeFormat` (`numeric: 'auto'` → "today" /
 * "yesterday" / "2 days ago" / "last week"), stepped day → week → month → year by
 * magnitude. The locale is the active i18n language so the phrase matches the
 * catalog's locale.
 */
function formatRelative(iso: string, nowMs: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const days = Math.round((new Date(iso).getTime() - nowMs) / DAY_MS)
  const magnitude = Math.abs(days)
  if (magnitude < 7) return rtf.format(days, 'day')
  if (magnitude < 30) return rtf.format(Math.round(days / 7), 'week')
  if (magnitude < 365) return rtf.format(Math.round(days / 30), 'month')
  return rtf.format(Math.round(days / 365), 'year')
}

/**
 * The mono state line for one campaign. Pure (takes `t` + `locale` + an injected
 * `nowMs` clock) so it is deterministic to unit-test and reusable from either
 * layout. The played card reads "N sessions · <relative>"; `lastPlayedAt` is
 * non-null for a played card by construction, but the wire type allows null — so
 * it falls back to a terse "recently" rather than render a dangling separator.
 */
export function cardPhaseLine(
  campaign: CampaignSummary,
  t: TFunction,
  locale: string,
  nowMs: number = Date.now(),
): string {
  const { cardPhase, sessionCount, lastPlayedAt } = campaign
  if (cardPhase === 'played') {
    return t('home.card.record', {
      sessions: sessionCount,
      when: lastPlayedAt !== null ? formatRelative(lastPlayedAt, nowMs, locale) : t('home.card.recently'),
    })
  }
  return t(PHASE_LABEL_KEY[cardPhase])
}

/** The {@link cardPhaseLine} bound to the active i18n language + the wall clock —
 *  the hook form a component renders directly. */
export function useCardPhaseLine(campaign: CampaignSummary): string {
  const { t, i18n } = useTranslation()
  return cardPhaseLine(campaign, t, i18n.language)
}
