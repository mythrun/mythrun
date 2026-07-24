import { useEffect, useState } from 'react'
import { Stack, Heading, Text, CoverDither } from '@mythrun/ui'
import {
  getMyCampaigns,
  useApiContext,
  type ApiContext,
  type CampaignSummary,
} from '@mythrun/client-core'
import { useTranslation } from 'react-i18next'
import { CharacterSurface, type CharacterSurfaceDeps } from './character-new/character-surface.tsx'
import type { InvitePanelDeps } from './campaign-invite-panel.tsx'

// The CAMPAIGN PAGE (MYT-89 Phase D, D5 → MYT-90 D8 → MYT-91) — where a player
// lands at `/campaigns/:id` once world-gen is settled AND a starting situation is
// chosen (see campaign-detail.tsx for the routing). It shows the world IDENTITY
// (the per-world dither cover + world name, reusing the home-hub card's treatment)
// plus two setup regions: the OWNER INVITE PANEL (MYT-91 — the real share-link
// surface, mounted only when `creator === null`) and — since MYT-90 D8 — the real
// CHARACTER SURFACE, which reads the viewer's creation state and mounts the right
// beat (situation/level redirect, member hold, loading beat, reveal, party staging,
// character-context failure+retry, or a play entry) per the spec §3.3 routing
// table. Flat 1-bit paper register; all UI composes @mythrun/ui; the identity comes
// from the same `getMyCampaigns` payload the hub renders (worldName + worldColors +
// status + creator), found by id — and that same `campaign` is handed to the
// surface (and its `creator` gates the invite panel) so nothing re-fetches the
// role/status.

/** The campaigns source — defaults to the real `/api/campaigns/mine` endpoint (the
 *  hub's payload, carrying each world's identity); tests substitute it. */
type FetchCampaigns = (ctx: ApiContext) => Promise<readonly CampaignSummary[]>

const defaultFetchCampaigns: FetchCampaigns = (ctx) =>
  getMyCampaigns(undefined, ctx).then((r) => r.campaigns)

// The header cover chip — a COMPACT version of the home-hub card's dithered `band`
// cover (myth-ij1gq). The tiny `swatch` size renders a real world-colour pair as a
// coarse ~50%-density checkerboard that reads as a broken/missing image (only 12
// gradient rows, so the mid-density band dominates the tile); the `band` grid (45×27)
// sweeps a clean light→dark cover even at chip scale, so it reads as intentional
// cover art. Fixed 64px width (`--space-9`, `shrink-0` so it holds beside the title);
// the band stands its own 5:3 height. A colour-less world keeps the muted ghost.
const COVER_CHIP_CLASS = 'w-[var(--space-9)] shrink-0'

function CoverChip({ colors }: { colors: CampaignSummary['worldColors'] }): React.JSX.Element {
  return (
    // A fixed-width host for the full-bleed `band` CoverDither — the DS models a full
    // CoverCard (portrait card + body) but not a bare compact cover chip, so this is a
    // true one-off layout wrapper.
    // eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- fixed-width host for a full-bleed band cover; DS has no bare cover-chip primitive
    <div className={COVER_CHIP_CLASS}>
      {colors !== null ? (
        <CoverDither size="band" bordered from={colors.from} to={colors.to} data-testid="campaign-cover" />
      ) : (
        <CoverDither size="band" bordered data-testid="campaign-cover-ghost" />
      )}
    </div>
  )
}

/** The world identity block: the dither cover + world name + campaign name. A
 *  still-loading / not-found campaign renders the muted ghost cover beside a calm
 *  i18n line (never a fake identity). */
function WorldIdentity({
  campaign,
  loading,
}: {
  campaign: CampaignSummary | null
  loading: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  if (campaign === null) {
    return (
      <Stack direction="row" align="center" gap={3}>
        <CoverChip colors={null} />
        <Text role="ui-caption" as="p">
          {loading ? t('campaign.settling') : t('campaign.notFound')}
        </Text>
      </Stack>
    )
  }
  const { name, worldName, worldColors } = campaign
  return (
    <Stack direction="row" align="center" gap={3}>
      <CoverChip colors={worldColors} />
      <Stack gap={1} grow>
        <Text role="ui-caption" as="p">
          {t('campaign.eyebrow')}
        </Text>
        <Heading level={1} role="title" data-testid="campaign-world-name">
          {worldName}
        </Heading>
        {/* Campaign names default to the world name — the subtitle renders only
            when a rename gives it something to add (MYT-102 audit, the hub rule). */}
        {name !== worldName ? <Text role="subtitle">{name}</Text> : null}
      </Stack>
    </Stack>
  )
}

export interface CampaignPageProps {
  /** The campaign whose world identity + setup seams are shown. */
  campaignId: string
  /** The campaigns source — defaults to the real endpoint; tests substitute it. */
  fetchCampaigns?: FetchCampaigns
  /** Injected character-surface seams (endpoints + child-surface deps) — defaults to
   *  the real endpoints; tests + stories substitute them so the mounted surface
   *  routes without a live SSE/endpoint. */
  characterDeps?: CharacterSurfaceDeps
  /** Injected invite endpoints + web share/clipboard ports for the owner panel —
   *  defaults to the real client-core fns + web port; tests substitute them. */
  inviteDeps?: InvitePanelDeps
}

export function CampaignPage({
  campaignId,
  fetchCampaigns = defaultFetchCampaigns,
  characterDeps,
  inviteDeps,
}: CampaignPageProps): React.JSX.Element {
  const ctx = useApiContext()
  const [campaign, setCampaign] = useState<CampaignSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    void fetchCampaigns(ctx)
      .then((list) => {
        if (!active) return
        setCampaign(list.find((c) => c.id === campaignId) ?? null)
        setLoading(false)
      })
      .catch(() => {
        // A transient/failed fetch settles to a calm identity placeholder (the
        // seams still render — the page is the setup hub, not the identity alone).
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [ctx, campaignId, fetchCampaigns])

  return (
    <Stack gap={5} data-testid="route-campaign-detail">
      <WorldIdentity campaign={campaign} loading={loading} />
      {/* The owner's invite now travels WITH the character beat (MYT-99g03): a quiet
          collapsed line below the reveal / setup beats, and the inline party-slot
          disclosure on staging — never a standalone block above the character. The
          surface gates it owner-only (`creator === null`) per beat. */}
      <CharacterSurface
        campaign={campaign}
        campaignId={campaignId}
        {...(characterDeps !== undefined && { deps: characterDeps })}
        {...(inviteDeps !== undefined && { inviteDeps })}
      />
    </Stack>
  )
}
