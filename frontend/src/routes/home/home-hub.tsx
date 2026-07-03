import { Fragment } from 'react'
import { Show, Grid, Stack, Divider, Button, Icon } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
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
// Below both layouts sits a single quiet "new campaign" CTA (MYT-89 B6). MYT-87
// shipped the create CTA only on the EMPTY shelf, so a player who already owns
// campaigns had no way to start another from the populated hub; this adds it,
// register-consistent (a flat ghost affordance, not a loud fill).
//
// Takes the already-resolved campaigns; T16 drops this into `home.tsx` behind the
// suspense/empty-state and adds the page header.

const GRID_BREAKPOINT = 'sm'

// The fluid shelf's minimum cover width, in px — the ~230px book-cover width the
// card is built at (`CampaignCard`'s `CARD_WIDTH`). `Grid auto-fill` fits as many
// of these as comfortably fit per row, then wraps (card quality over grid math, no
// fixed column count). It's a raw px escape hatch because the `--space` token scale
// caps at 64px and can't express a card-scale track.
const COVER_MIN_PX = 230

// The campaign-creation route (mirrors `home.tsx`'s EmptyShelf CTA — the SAME
// target the empty CTA uses). Hoisted to a module const so the path isn't a
// JSX-attribute string literal (the i18n rule).
const CAMPAIGN_NEW_PATH = '/campaigns/new'

/** The responsive grid ⊕ index body for a non-empty campaign list, plus the "new campaign" CTA. */
export function CampaignHubBody({
  campaigns,
}: {
  campaigns: readonly CampaignSummary[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <Stack gap={4}>
      {/* Desktop — a fluid shelf of cover cards. `auto-fill` at the ~230px cover
          width packs as many covers per row as fit, then wraps (no fixed column
          count — the shelf grows with the viewport). */}
      <Show above={GRID_BREAKPOINT} data-testid="hub-grid">
        <Grid columns="auto-fill" minColumnPx={COVER_MIN_PX} gap={4}>
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
      {/* A quiet trailing "new campaign" action — the populated-hub counterpart to
          the empty shelf's primary CTA. `variant="ghost"` keeps it flat (a rule-like
          affordance, not a loud fill) so it reads as "add another" beneath the shelf.
          Wrapped in a row so it self-sizes at the start rather than stretching to the
          outer column's full width. */}
      <Stack direction="row">
        <Button
          variant="ghost"
          icon={<Icon name="plus" decorative />}
          onPress={() => {
            void navigate(CAMPAIGN_NEW_PATH)
          }}
          data-testid="new-campaign"
        >
          {t('home.createCampaign')}
        </Button>
      </Stack>
    </Stack>
  )
}
