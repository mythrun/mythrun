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
export function CampaignCard({
  campaign,
  lowOnSessionCredits = false,
  premier = false,
}: {
  campaign: CampaignSummary
  /** Owner-only quiet low-credit line (MYT-95 T13, controller-applied post-91-merge).
   *  The `creator === null` guard enforces owner-only in the render — a member
   *  never sees the owner's billing state (no member-visible owner-balance read
   *  exists, by design). */
  lowOnSessionCredits?: boolean
  /** This card holds the grid's premier (top-left) slot — the most-recent-activity
   *  campaign (myth-z9eiq). When it also has a play record, it carries the LOUD
   *  "Continue session →" cta plus the promoted card treatment (myth-7jc1h);
   *  dormant played cards carry their own quiet "Resume →" regardless. Exactly
   *  one card per grid is premier (the hub passes it to index 0). */
  premier?: boolean
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { id, name, worldName, worldColors, creator, party } = campaign

  // The foot imprint reflects the party ASSEMBLING: members with a character are
  // pigment Avatar seals; members still building are muted placeholder seals. Built
  // lead so a ready party reads first; the `MAX_SEALS` cap (+N overflow) spans the
  // combined cluster, dropping still-building members before built ones.
  const builtMembers = party.filter((member) => member.hasCharacter)
  const buildingMembers = party.filter((member) => !member.hasCharacter)

  // The mono ledger line (shared with the mobile index row — see card-phase-line).
  const stateLine = cardPhaseLine(campaign, t, i18n.language)

  // The card's ONE accent cta line, tiered by weight (myth-rhvkt / myth-z9eiq →
  // myth-7jc1h): EVERY played campaign is continuable — the premier slot's
  // played card carries the LOUD "Continue session →" (plus the promoted card
  // treatment), a dormant played card the QUIET "Resume →" (live-vs-dormant in
  // the words + weight, never in cta presence/absence), and a stalled
  // needs-character card keeps its accent "Author your character →" at the
  // WHISPER tier — visible when scanning, but a cold start never out-shouts an
  // invested campaign. CLICK SEMANTICS (decided, run 3): the whole card is the
  // ONE target — the cta line names the card's action, it is never a nested
  // control (no two overlapping affordances).
  const cta =
    campaign.cardPhase === 'needs-character'
      ? ({ label: stateLine, tone: 'whisper' } as const)
      : campaign.cardPhase === 'played'
        ? premier
          ? ({ label: t('home.card.continueSession'), tone: 'loud' } as const)
          : ({ label: t('home.card.resume'), tone: 'quiet' } as const)
        : undefined
  // The premier slot earns the promoted treatment only WITH a play record — an
  // unplayed premier card has no "jump back in" story to spotlight.
  const promoted = premier && campaign.cardPhase === 'played'

  return (
    <Link href={`/campaigns/${id}`} unstyled data-testid={`campaign-card-${id}`}>
      <CoverCard
        width={CARD_WIDTH}
        promoted={promoted}
        {...(cta !== undefined ? { cta: cta.label, ctaTone: cta.tone } : {})}
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
          // Foot imprint — party seals over the mono record/state line. (MYT-95
          // layers its low-credit line onto this same foot at merge — keep the
          // Stack composable; do not collapse it into a single child.)
          <Stack gap={2}>
            {party.length > 0 ? (
              // Built (pigment) seals first, still-building (muted `placeholder`
              // hatch) seals after — one AvatarGroup so the ring, overlap, and +N
              // overflow span the combined party and the MAX_SEALS cap truncates
              // building members first.
              <AvatarGroup size="sm" surface="surface" max={MAX_SEALS}>
                {builtMembers.map((member) => (
                  <Avatar key={member.userId} name={member.displayName} size="sm" />
                ))}
                {buildingMembers.map((member) => (
                  <Avatar
                    key={member.userId}
                    name={member.displayName}
                    size="sm"
                    placeholder
                    data-testid="card-building-seal"
                  />
                ))}
              </AvatarGroup>
            ) : null}
            {/* Mono ledger line — the record/state, carried as plain text (the
                register forbids a dot/badge/chip). A needs-character card's line
                IS the cta zone's whisper line — its ledger slot stays RESERVED
                as a blank line (myth-7jc1h: the 4-zone card holds every zone at
                a fixed offset, so seals never sit at three heights per grid). */}
            <Text role="meta" data-testid="card-state">
              {campaign.cardPhase !== 'needs-character' ? stateLine : '\u00A0'}
            </Text>

            {creator === null && lowOnSessionCredits ? (
              <Text role="meta" data-testid="card-low-credits">
                {t('home.card.lowCredits')}
              </Text>
            ) : null}
          </Stack>
        }
      >
        <Stack gap={1}>
          {/* The title zone holds a fixed 2-line band (`lines={2}`: clamp +
              lh reserve — myth-7jc1h) so 1- and 2-line titles keep the sub-line
              at one offset across the grid; the promoted premier reads one
              size up (`heading` vs `title`) — the weight signal. */}
          <Heading level={2} role={promoted ? 'heading' : 'title'} lines={2}>
            {name}
          </Heading>
          {/* World · creator — italic, muted narrative sub-line, truncated to a
              single line (the zone's fixed height). The creator credit shows
              ONLY on a joined (not-own) world. Suppressed entirely when it
              would only echo the title: campaign names default to the world name,
              so an identical sub-line is pure noise (MYT-102 audit) — it returns
              the moment a rename or a creator credit gives it something to say. */}
          {worldName !== name || creator !== null ? (
            <Text role="subtitle" truncate data-testid="card-world">
              {worldName !== name ? worldName : null}
              {creator !== null ? t('home.card.byCreator', { creator }) : null}
            </Text>
          ) : null}
        </Stack>
      </CoverCard>
    </Link>
  )
}
