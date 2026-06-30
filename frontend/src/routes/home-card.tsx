import {
  Card,
  CardBody,
  Stack,
  Heading,
  Text,
  Divider,
  CoverDither,
  Avatar,
  AvatarGroup,
  Link,
} from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { CampaignSummary } from '@mythrun/client-core'

// The campaign-hub cover card (MYT-87 — "The Cover"). Each campaign is a quiet
// paperback cover composed from @mythrun/ui primitives only (no-ad-hoc-ui): a
// full-bleed cover-dither band carrying the world's two-colour identity, over a
// serif narrative zone (title, world · creator) and a mono ledger zone (party
// seals, the record/state line). Flat 1-bit register — square corners, square
// avatar seals, NO circles / dots / badges / chips. State is conveyed ONLY by the
// mono state line + the implicit party seals, never a discrete status element.
//
// The WHOLE card is the click target → the campaign detail. The detail surface
// (a modal/sheet) is owned by a later ticket; the card links to the canonical
// `/campaigns/:id` URL (an interim target — no dead click). NOTE for the T16
// visual audit: @mythrun/ui's Link styles its descendants as link text
// (text-accent-fg + hover underline; the type roles set no colour, so they
// inherit). The quiet-cover treatment (a bare/un-tinted card-link variant, or a
// stretched-link pattern) is a primitive-level decision for the visual audit —
// this composes the sanctioned navigable primitive without hand-rolling raw CSS.

const MAX_SEALS = 5
const DAY_MS = 86_400_000

// The five phases whose state line is a single static label. `played` is special
// (a record string built from sessionCount + a relative lastPlayedAt), so it is
// excluded here and handled below. A static literal map (the spirit of the
// retired STATUS_LABEL_KEY) keeps every key a first-class string the typed-keys
// guard + the i18n:todo scan can see — a computed `home.card.${phase}` template
// would be invisible to both.
const PHASE_LABEL_KEY = {
  generating: 'home.card.generating',
  failed: 'home.card.failed',
  'needs-character': 'home.card.needsCharacter',
  'waiting-for-players': 'home.card.waiting',
  'not-played': 'home.card.notPlayed',
} as const satisfies Record<Exclude<CampaignSummary['cardPhase'], 'played'>, string>

/**
 * A terse, locale-aware "when" for the played record line — the only place the
 * card formats a relative time. Mechanical date math (no LLM, ZFC-exempt) through
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

/** One campaign as a flat cover card; the whole card links to its detail. */
export function CampaignCard({ campaign }: { campaign: CampaignSummary }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { id, name, worldName, worldColors, creator, party, cardPhase, sessionCount, lastPlayedAt } =
    campaign

  // The played card reads "N sessions · <relative>"; lastPlayedAt is non-null for
  // a played card by construction, but the wire type allows null — fall back to a
  // terse "recently" so the line never renders a dangling separator.
  const stateLine =
    cardPhase === 'played'
      ? t('home.card.record', {
          sessions: sessionCount,
          when:
            lastPlayedAt !== null
              ? formatRelative(lastPlayedAt, Date.now(), i18n.language)
              : t('home.card.recently'),
        })
      : t(PHASE_LABEL_KEY[cardPhase])

  return (
    <Link href={`/campaigns/${id}`} data-testid={`campaign-card-${id}`}>
      <Card>
        {worldColors !== null ? (
          <CoverDither size="band" from={worldColors.from} to={worldColors.to} data-testid="card-cover" />
        ) : (
          // GHOST band — a still-generating world has no colours yet. A muted
          // paper→paper dither (NOT a default chromatic pair — an uncoloured world
          // must not borrow a fake identity) holds the band's geometry + the paper
          // register while reading as "unwritten".
          <CoverDither size="band" from="paper-100" to="paper-200" data-testid="card-cover-ghost" />
        )}
        <Divider />
        <CardBody>
          <Stack gap={3}>
            <Heading level={2}>{name}</Heading>
            {/* World · creator — serif narrative sub-line. The creator credit shows
                ONLY on a joined (not-own) world; an own world (creator null) is just
                the world name. */}
            <Text role="prose-body" data-testid="card-world">
              {worldName}
              {creator !== null ? t('home.card.byCreator', { creator }) : null}
            </Text>
            {party.length > 0 ? (
              <AvatarGroup surface="surface" max={MAX_SEALS}>
                {party.map((member) => (
                  <Avatar key={member.userId} name={member.displayName} />
                ))}
              </AvatarGroup>
            ) : null}
            {/* Mono ledger line — the record/state, carried as plain text (the
                register forbids a dot/badge/chip). */}
            <Text role="data" data-testid="card-state">
              {stateLine}
            </Text>
          </Stack>
        </CardBody>
      </Card>
    </Link>
  )
}
