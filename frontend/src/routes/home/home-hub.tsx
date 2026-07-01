import { Fragment } from 'react'
import { Show, Grid, Stack, Divider } from '@mythrun/ui'
import type { CampaignSummary } from '@mythrun/client-core'
import { CampaignCard } from './home-card.tsx'
import { CampaignIndexRow } from './home-index-row.tsx'

// The responsive campaign-hub BODY (MYT-87 T15). The card and the index row are
// visually DISTINCT layouts (a cover card vs a table-of-contents line), so this is
// a breakpoint SWITCH, not a reflow: at/above `sm` a GRID of cover cards; below
// `sm` a compact INDEX list of hairline-divided rows. The `Show` primitive owns
// the breakpoint visibility (the only `@mythrun/ui` zone where a raw breakpoint
// class is legal), so this screen stays ad-hoc-UI-free.
//
// Takes the already-resolved campaigns; T16 drops this into `home.tsx` behind the
// suspense/empty-state and adds the page header.

const GRID_BREAKPOINT = 'sm'

/** The responsive grid ⊕ index body for a non-empty campaign list. */
export function CampaignHubBody({
  campaigns,
}: {
  campaigns: readonly CampaignSummary[]
}): React.JSX.Element {
  return (
    <>
      {/* Desktop — a grid of cover cards. Fixed column count for now; T16's visual
          audit tunes the count (and `Grid` auto-fit's --space-token min-width can't
          yet express a card-width track, so a fluid card grid is a Grid follow-up). */}
      <Show above={GRID_BREAKPOINT} data-testid="hub-grid">
        <Grid columns={2} gap={4}>
          {campaigns.map((campaign) => (
            <CampaignCard key={campaign.id} campaign={campaign} />
          ))}
        </Grid>
      </Show>
      {/* Mobile — a compact index, the rows hairline-divided (a Divider BETWEEN
          rows, not before the first). */}
      <Show below={GRID_BREAKPOINT} data-testid="hub-index">
        <Stack gap={3}>
          {campaigns.map((campaign, i) => (
            <Fragment key={campaign.id}>
              {i > 0 ? <Divider /> : null}
              <CampaignIndexRow campaign={campaign} />
            </Fragment>
          ))}
        </Stack>
      </Show>
    </>
  )
}
