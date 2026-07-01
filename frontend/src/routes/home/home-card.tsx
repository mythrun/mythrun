import { CoverCard, CoverDither, Stack, Heading, Text, Avatar, AvatarGroup, Link } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { CampaignSummary } from '@mythrun/client-core'
import { cardPhaseLine } from './card-phase-line.ts'

// The campaign-hub cover card (MYT-87 — "The Cover"). Each campaign is a quiet
// portrait BOOK COVER, composed entirely from @mythrun/ui primitives (no ad-hoc
// UI): a `CoverCard` carrying the world's two-colour identity as its full-bleed
// `CoverDither` cover, a serif title + italic `subtitle` world · creator line up
// top, and a mono ledger imprint (party seals over the record/state line) pinned
// to the foot. Flat 1-bit register — square corners, hairline borders, square
// avatar seals, NO circles / dots / badges / chips. State is conveyed ONLY by the
// mono state line + the implicit party seals, never a discrete status element. The
// CoverCard owns the portrait geometry (fixed 3:2, ~40% cover, ink seam, foot-pin)
// and re-inks in dark mode via CSS, so the card needs no per-card layout or theme
// logic. (The three earlier ad-hoc escape hatches are now first-class DS
// capabilities: the CoverCard layout, the `subtitle`/`meta` Text roles, and the
// Divider `tone="ink"` seam CoverCard renders internally.)
//
// The WHOLE card is the click target → the campaign detail. The detail surface
// (a modal/sheet) is owned by a later ticket; the card links to the canonical
// `/campaigns/:id` URL (an interim target — no dead click). The link is `unstyled`
// (MYT-87 T16): @mythrun/ui's default Link tints its whole subtree with the accent
// foreground, so a plain Link renders the cover's title/world/state in link-accent
// instead of ink. `unstyled` drops the accent paint (keeping the a11y focus ring), so
// the cover reads in the quiet paper-ink register while still composing the one
// sanctioned navigable primitive.

const MAX_SEALS = 5
const CARD_WIDTH = 230

/** One campaign as a flat portrait cover card; the whole card links to its detail. */
export function CampaignCard({ campaign }: { campaign: CampaignSummary }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { id, name, worldName, worldColors, creator, party } = campaign

  // The mono ledger line (shared with the mobile index row — see card-phase-line).
  const stateLine = cardPhaseLine(campaign, t, i18n.language)

  return (
    <Link href={`/campaigns/${id}`} unstyled data-testid={`campaign-card-${id}`}>
      <CoverCard
        width={CARD_WIDTH}
        cover={
          worldColors !== null ? (
            <CoverDither
              size="band"
              from={worldColors.from}
              to={worldColors.to}
              data-testid="card-cover"
            />
          ) : (
            // GHOST band — a still-generating world has no colours yet. Omitting
            // both ends renders CoverDither's muted paper→paper placeholder (it
            // must not borrow a fake chromatic identity).
            <CoverDither size="band" data-testid="card-cover-ghost" />
          )
        }
        foot={
          // Foot imprint — party seals over the mono record/state line.
          <Stack gap={2}>
            {party.length > 0 ? (
              <AvatarGroup size="sm" surface="surface" max={MAX_SEALS}>
                {party.map((member) => (
                  <Avatar key={member.userId} name={member.displayName} size="sm" />
                ))}
              </AvatarGroup>
            ) : null}
            {/* Mono ledger line — the record/state, carried as plain text (the
                register forbids a dot/badge/chip). */}
            <Text role="meta" data-testid="card-state">
              {stateLine}
            </Text>
          </Stack>
        }
      >
        <Stack gap={1}>
          <Heading level={2} role="title">
            {name}
          </Heading>
          {/* World · creator — italic, muted narrative sub-line. The creator credit
              shows ONLY on a joined (not-own) world. */}
          <Text role="subtitle" data-testid="card-world">
            {worldName}
            {creator !== null ? t('home.card.byCreator', { creator }) : null}
          </Text>
        </Stack>
      </CoverCard>
    </Link>
  )
}
