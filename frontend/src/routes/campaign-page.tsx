import { useEffect, useState } from 'react'
import { Stack, Heading, Text, Card, CardBody, CoverDither } from '@mythrun/ui'
import {
  getMyCampaigns,
  useApiContext,
  type ApiContext,
  type CampaignSummary,
} from '@mythrun/client-core'
import { useTranslation } from 'react-i18next'

// The CAMPAIGN PAGE (MYT-89 Phase D, D5) — where the owner lands at `/campaigns/:id`
// once world-gen is settled AND a starting situation is chosen (the state the
// situation-pick's POST navigates back to; see campaign-detail.tsx for the routing
// + the seam note). This is the EXPLICIT MYT-89 BOUNDARY: it shows the world
// IDENTITY (the per-world dither cover + world name, reusing the home-hub card's
// treatment) plus TWO clearly-marked STUB SEAMS wired to the shape of the real
// next tickets but NOT built out — invite players (MYT-91) and everyone makes a
// character (MYT-90). Each seam is a dashed "not-yet-written" Card (Card's own
// empty-state frame) carrying a `[ph: …]` note, so it is VISIBLY the next ticket,
// never a fake-working control. Flat 1-bit paper register; all UI composes
// @mythrun/ui; the identity comes from the same `getMyCampaigns` payload the hub
// renders (worldName + worldColors), found by id.

/** The two MYT-89 boundary seam testids, hoisted to module consts so they ride as
 *  JSX EXPRESSIONS (not attribute string literals — the i18next no-literal rail
 *  excludes `data-testid` but flags a bare `testId="…"` on a custom component). */
const INVITE_SEAM_TESTID = 'seam-invite'
const CHARACTER_SEAM_TESTID = 'seam-character'

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
          {loading ? t('campaign.settling') : t('worldReveal.empty')}
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

/** A clearly-marked stub seam — a dashed "not-yet-written" Card with a heading +
 *  a `[ph: …]` note. Shared by the two MYT-89 boundary regions (invite / character)
 *  so both read identically as "the next ticket," never a working control. */
function StubSeam({
  testId,
  title,
  body,
}: {
  testId: string
  title: string
  body: string
}): React.JSX.Element {
  return (
    <Card frame="dashed" data-testid={testId}>
      <CardBody>
        <Stack gap={2}>
          <Heading level={2}>{title}</Heading>
          <Text role="ui-caption" as="p">
            {body}
          </Text>
        </Stack>
      </CardBody>
    </Card>
  )
}

export interface CampaignPageProps {
  /** The campaign whose world identity + setup seams are shown. */
  campaignId: string
  /** The campaigns source — defaults to the real endpoint; tests substitute it. */
  fetchCampaigns?: FetchCampaigns
}

export function CampaignPage({
  campaignId,
  fetchCampaigns = defaultFetchCampaigns,
}: CampaignPageProps): React.JSX.Element {
  const { t } = useTranslation()
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
      <StubSeam
        testId={INVITE_SEAM_TESTID}
        title={t('campaign.invite.title')}
        body={t('campaign.invite.body')}
      />
      <StubSeam
        testId={CHARACTER_SEAM_TESTID}
        title={t('campaign.character.title')}
        body={t('campaign.character.body')}
      />
    </Stack>
  )
}
