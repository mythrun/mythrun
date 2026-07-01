import { Stack, Text, CoverDither, Link } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { CampaignSummary } from '@mythrun/client-core'
import { cardPhaseLine } from './card-phase-line.ts'

// The campaign-hub mobile INDEX ROW (MYT-87 — the "table of contents"). Below the
// grid breakpoint the hub collapses the cover-card shelf into a compact index: one
// quiet, UNIFORM-HEIGHT row per campaign, so the list reads as a table of contents
// rather than a column of variable cards. Composed from @mythrun/ui primitives only
// (no ad-hoc UI): a small self-sized world-dither `swatch` + a serif title + the
// italic `world · creator` sub-line + the SAME mono state line the cover card shows
// (shared via `cardPhaseLine`), the WHOLE row a link to the campaign.
//
// Uniform height comes from TRUNCATION, not a hard-coded px height: every text line
// is `truncate` (single-line ellipsis), so a long title / world / placeholder can't
// wrap and stretch the row — each row is exactly its three one-line texts beside the
// fixed 48px swatch. Flat paper register — square swatch, no badges / dots / status
// chips; state is conveyed only by the mono line.
//
// The row link is `unstyled` (the same fix the cover card takes): @mythrun/ui's
// default `Link` tints its whole subtree with the accent foreground, so a plain Link
// would render the row's title/world/state in link-accent rather than ink. `unstyled`
// drops the accent paint (keeping the a11y focus ring) so the row reads in the quiet
// paper-ink register, still composing the one sanctioned navigable primitive.

/** One campaign as a compact, uniform-height index row; the whole row links to its detail. */
export function CampaignIndexRow({ campaign }: { campaign: CampaignSummary }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { id, name, worldName, worldColors, creator } = campaign
  const stateLine = cardPhaseLine(campaign, t, i18n.language)

  return (
    <Link href={`/campaigns/${id}`} unstyled data-testid={`campaign-index-row-${id}`}>
      <Stack direction="row" align="center" gap={3}>
        {worldColors !== null ? (
          <CoverDither size="swatch" bordered from={worldColors.from} to={worldColors.to} data-testid="row-cover" />
        ) : (
          // GHOST swatch — a still-generating world has no colours yet. Omitting both
          // ends renders CoverDither's muted paper→paper ghost (it must not borrow a
          // fake chromatic identity), holding the square + the paper register.
          <CoverDither size="swatch" bordered data-testid="row-cover-ghost" />
        )}
        <Stack gap={1} grow>
          {/* Serif title — the narrative line; truncated so it holds a single row. */}
          <Text role="prose-body" truncate data-testid="row-title">
            {name}
          </Text>
          {/* World · creator — the italic muted sub-line. The creator credit shows
              ONLY on a joined (not-own) world, mirroring the cover card. */}
          <Text role="subtitle" truncate data-testid="row-world">
            {worldName}
            {creator !== null ? t('home.card.byCreator', { creator }) : null}
          </Text>
          {/* Mono ledger line — the record/state, carried as plain text (the register
              forbids a dot/badge/chip); truncated to keep every row the same height. */}
          <Text role="meta" truncate data-testid="row-state">
            {stateLine}
          </Text>
        </Stack>
      </Stack>
    </Link>
  )
}
