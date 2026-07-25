import { useEffect, useState } from 'react'
import { Stack, Heading, Text, CoverDither, Link } from '@mythrun/ui'
import {
  getMyCampaigns,
  getSessionRecap,
  useApiContext,
  type ApiContext,
  type CampaignSummary,
  type SessionRecap,
  type SessionRecapResponse,
} from '@mythrun/client-core'
import { useTranslation } from 'react-i18next'
import { CharacterSurface, type CharacterSurfaceDeps } from './character-new/character-surface.tsx'
import { ThreadIndexList } from './recap.tsx'
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

/** The last-session recap source (ux-run2 myth-8x3uh) — the same SECRET-FREE
 *  endpoint the recap page polls; fetched once here (no polling: the hub block
 *  is an enhancement, absent while the analysis is pending). Tests substitute it. */
type FetchRecap = (campaignId: string, ctx: ApiContext) => Promise<SessionRecapResponse>

const defaultFetchRecap: FetchRecap = (campaignId, ctx) => getSessionRecap({ campaignId }, ctx)

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

/** The re-entry block for a played campaign (ux-run2 myth-8x3uh): the last
 *  session's open threads — the recap's referable numbered index, shared
 *  verbatim — plus a quiet link to the full recap, so the hub says "continue
 *  where you left off" instead of reading as a generic setup page. Absent
 *  unless a ready recap with threads exists (never a fake or empty block).
 *  Labelled with the recap's own "Threads left open" (ux-run3 myth-y3jbw —
 *  the content is forward-looking, so "Last session" over-claimed). */
function LastSessionThreads({
  campaignId,
  recap,
}: {
  campaignId: string
  recap: SessionRecap
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const threads = recap.emergingThreads ?? []
  if (recap.status !== 'ready' || threads.length === 0) return null
  return (
    <Stack gap={2} data-testid="campaign-last-session">
      <Text role="ui-label">{t('recap.threadsHeading')}</Text>
      <ThreadIndexList threads={threads} />
      <Stack direction="row">
        <Link href={`/campaigns/${campaignId}/recap`} data-testid="campaign-read-recap">
          {t('campaign.readRecap')}
        </Link>
      </Stack>
    </Stack>
  )
}

export interface CampaignPageProps {
  /** The campaign whose world identity + setup seams are shown. */
  campaignId: string
  /** The campaigns source — defaults to the real endpoint; tests substitute it. */
  fetchCampaigns?: FetchCampaigns
  /** The last-session recap source — defaults to the real endpoint; tests substitute it. */
  fetchRecap?: FetchRecap
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
  fetchRecap = defaultFetchRecap,
  characterDeps,
  inviteDeps,
}: CampaignPageProps): React.JSX.Element {
  const ctx = useApiContext()
  const [campaign, setCampaign] = useState<CampaignSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [recap, setRecap] = useState<SessionRecap | null>(null)

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

  // The last-session read fires only once a PLAYED campaign is identified
  // (lastPlayedAt set) — an unplayed hub never asks. Any failure settles to no
  // block; the recap page, not the hub, owns the pending/polling story.
  const played = campaign !== null && campaign.lastPlayedAt !== null
  useEffect(() => {
    if (!played) return
    let active = true
    fetchRecap(campaignId, ctx)
      .then((r) => {
        if (active) setRecap(r.recap)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [played, campaignId, ctx, fetchRecap])

  return (
    // ONE centred content column for the whole page (ux-run3 myth-kn9th /
    // myth-y3jbw): the campaign header used to sit content-sized on the chrome
    // margin while the working column centred (~720px) and the threads ran
    // full-bleed (~130ch) — two grids, a dead left rail, unreadable measure.
    // The `content` cap is the lobby column's deliberate run-2 width
    // (myth-ma8yv), so header → question → content → CTA travel one left edge.
    <Stack gap={5} maxWidth="content" data-testid="route-campaign-detail">
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
      {recap !== null && <LastSessionThreads campaignId={campaignId} recap={recap} />}
    </Stack>
  )
}
