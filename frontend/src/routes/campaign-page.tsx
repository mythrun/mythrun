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
import { CampaignInvitePanel, type InvitePanelDeps } from './campaign-invite-panel.tsx'

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

/** The world identity block: the dither cover + world name + campaign name. A
 *  still-loading / not-found campaign renders the muted ghost swatch beside a calm
 *  `[ph: …]` line (never a fake identity). */
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
        <CoverDither size="swatch" bordered data-testid="campaign-cover-ghost" />
        <Text role="ui-caption" as="p">
          {loading ? t('campaign.settling') : t('campaign.notFound')}
        </Text>
      </Stack>
    )
  }
  const { name, worldName, worldColors } = campaign
  return (
    <Stack direction="row" align="center" gap={3}>
      {worldColors !== null ? (
        <CoverDither
          size="swatch"
          bordered
          from={worldColors.from}
          to={worldColors.to}
          data-testid="campaign-cover"
        />
      ) : (
        <CoverDither size="swatch" bordered data-testid="campaign-cover-ghost" />
      )}
      <Stack gap={1} grow>
        <Text role="ui-caption" as="p">
          {t('campaign.eyebrow')}
        </Text>
        <Heading level={1} role="title" data-testid="campaign-world-name">
          {worldName}
        </Heading>
        <Text role="subtitle">{name}</Text>
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
      {/* The invite region is OWNER-ONLY (`creator === null`); a member — or a
          still-resolving / not-found campaign — sees nothing here. */}
      {campaign?.creator === null ? (
        <CampaignInvitePanel
          campaignId={campaignId}
          {...(inviteDeps !== undefined && { deps: inviteDeps })}
        />
      ) : null}
      <CharacterSurface
        campaign={campaign}
        campaignId={campaignId}
        {...(characterDeps !== undefined && { deps: characterDeps })}
      />
    </Stack>
  )
}
