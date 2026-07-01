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
import { cardPhaseLine } from './card-phase-line.ts'

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

/** One campaign as a flat cover card; the whole card links to its detail. */
export function CampaignCard({ campaign }: { campaign: CampaignSummary }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { id, name, worldName, worldColors, creator, party } = campaign

  // The mono ledger line (shared with the mobile index row — see card-phase-line).
  const stateLine = cardPhaseLine(campaign, t, i18n.language)

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
