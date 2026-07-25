import { Fragment } from 'react'
import { Show, Grid, Stack, Divider, Link, CoverCardAdd } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { CampaignSummary } from '@mythrun/client-core'
import { CampaignCard } from './home-card.tsx'
import { CampaignIndexRow } from './home-index-row.tsx'
import { sortCampaignsForHub } from './hub-sort.ts'

// The responsive campaign-hub BODY (MYT-87 T15). The card and the index row are
// visually DISTINCT layouts (a cover card vs a table-of-contents line), so this is
// a breakpoint SWITCH, not a reflow: at/above `sm` a GRID of cover cards; below
// `sm` a compact INDEX list of hairline-divided rows. The `Show` primitive owns
// the breakpoint visibility (the only `@mythrun/ui` zone where a raw breakpoint
// class is legal), so this screen stays ad-hoc-UI-free.
//
// Create-campaign affordance (MYT-3jb55, re-balanced myth-z9eiq): the dashed
// `CoverCardAdd` tile TRAILS the grid (the Figma/Drive convention) — run 2 found
// the ghost tile in slot 1 spent "the highest-value real estate on 'make another
// one'" while the player's actual campaigns got pushed right and down. Keeping
// BOTH create affordances is validated (PatternFly deliberately runs ghost card
// + toolbar button): the page header's filled "New campaign" button (home.tsx)
// owns intentional create + primacy; the trailing tile is in-grid discovery and
// terminates the grid as a natural "+ one more". Scroll-reachability: the header
// button covers the top, the trailing tile the bottom — one of the two is always
// near. (On the mobile index the header button is the create path; the list
// stays a clean table of contents.)
//
// The PREMIER slot (top-left, the eye's landing point) now belongs to the
// most-recent-activity campaign (hub-sort), and — when it has a play record —
// that card carries the accent "Continue session" cta: the returning player's
// actual job, resume, gets the hero cell.
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

// The campaign-creation route (mirrors `home.tsx`'s EmptyShelf CTA + the page
// header's primary button — the SAME target). Hoisted to a module const so the
// path isn't a JSX-attribute string literal (the i18n rule).
const CAMPAIGN_NEW_PATH = '/campaigns/new'

/** The responsive grid ⊕ index body for a non-empty campaign list, led by the create tile. */
export function CampaignHubBody({
  campaigns,
  lowOnSessionCredits = false,
}: {
  campaigns: readonly CampaignSummary[]
  /** MYT-95 T13: owner-only low-credit nudge, read fail-open by the ROUTE
   *  (this body stays pure-presentational; the card's creator===null guard
   *  enforces owner-only). */
  lowOnSessionCredits?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const ordered = sortCampaignsForHub(campaigns)
  return (
    <Stack gap={4}>
      {/* Desktop — a fluid shelf of cover cards. `auto-fill` at the ~230px cover
          width packs as many covers per row as fit, then wraps (no fixed column
          count — the shelf grows with the viewport). */}
      <Show above={GRID_BREAKPOINT} data-testid="hub-grid">
        <Grid columns="auto-fill" minColumnPx={COVER_MIN_PX} gap={4}>
          {/* Premier slot first: the most-recent-activity card (index 0) carries
              the continue-session cue when it has a play record. */}
          {ordered.map((campaign, i) => (
            <CampaignCard
              key={campaign.id}
              campaign={campaign}
              lowOnSessionCredits={lowOnSessionCredits}
              premier={i === 0}
            />
          ))}
          {/* The create tile trails the grid — a peer-sized dashed affordance wrapped
              in the sanctioned navigable Link (mirroring CampaignCard's Link > cover),
              so it reads in the quiet paper-ink register with the label as its name. */}
          <Link href={CAMPAIGN_NEW_PATH} unstyled data-testid="hub-create-card">
            <CoverCardAdd width={COVER_MIN_PX} label={t('home.newCampaign')} />
          </Link>
        </Grid>
      </Show>
      {/* Mobile — a compact index, the rows hairline-divided (a Divider BETWEEN
          rows, not before the first). The page header's "New campaign" button is the
          create path here, so the list stays a pure table of contents. */}
      <Show below={GRID_BREAKPOINT} data-testid="hub-index">
        <Stack gap={3}>
          {ordered.map((campaign, i) => (
            <Fragment key={campaign.id}>
              {i > 0 ? <Divider /> : null}
              <CampaignIndexRow campaign={campaign} />
            </Fragment>
          ))}
        </Stack>
      </Show>
    </Stack>
  )
}
