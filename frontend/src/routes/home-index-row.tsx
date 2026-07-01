import { Stack, Heading, Text, CoverDither, Link } from '@mythrun/ui'
import type { CampaignSummary } from '@mythrun/client-core'
import { useCardPhaseLine } from './card-phase-line.ts'

// The campaign-hub mobile INDEX ROW (MYT-87 — the "table of contents"). On a
// narrow viewport the hub collapses the cover-card grid into a compact index: one
// quiet row per campaign, composed from @mythrun/ui primitives only (no-ad-hoc-ui).
// A small self-sized world-dither swatch + the title + world + the SAME mono state
// line the card shows (shared via `useCardPhaseLine`), the WHOLE row a link to the
// campaign. Flat paper register — square, no badges / dots / status chips; state is
// conveyed only by the mono line. The rows are hairline-divided by the container
// (see `home-hub.tsx`), so the row itself carries no rule.
//
// NOTE (T16 visual audit, shared with the card): @mythrun/ui's `Link` tints its
// whole subtree with the accent foreground, so the row text renders in the link
// accent rather than ink. This composes the one sanctioned navigable primitive
// without hand-rolling raw CSS; the bare/un-tinted card-link treatment is the
// primitive-level call for the T16 audit / brand sign-off — the same fix the cover
// card needs.

/** One campaign as a compact index row; the whole row links to its detail. */
export function CampaignIndexRow({ campaign }: { campaign: CampaignSummary }): React.JSX.Element {
  const { id, name, worldName, worldColors } = campaign
  const stateLine = useCardPhaseLine(campaign)

  return (
    <Link href={`/campaigns/${id}`} data-testid={`campaign-index-row-${id}`}>
      <Stack direction="row" align="center" gap={3}>
        {worldColors !== null ? (
          <CoverDither size="swatch" from={worldColors.from} to={worldColors.to} data-testid="row-cover" />
        ) : (
          // GHOST swatch — a still-generating world has no colours yet. A muted
          // paper→paper dither (NOT a chromatic default pair) holds the swatch's
          // square + the paper register while reading as "unwritten".
          <CoverDither size="swatch" from="paper-100" to="paper-200" data-testid="row-cover-ghost" />
        )}
        <Stack gap={1} grow>
          <Heading level={2}>{name}</Heading>
          <Text role="prose-body" data-testid="row-world">
            {worldName}
          </Text>
          {/* Mono ledger line — the record/state, as plain text (no dot/badge/chip). */}
          <Text role="data" data-testid="row-state">
            {stateLine}
          </Text>
        </Stack>
      </Stack>
    </Link>
  )
}
