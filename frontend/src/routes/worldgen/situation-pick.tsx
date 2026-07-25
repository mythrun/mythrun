import { useEffect, useState } from 'react'
import { Stack, Heading, Text, GhostHookList, Button, Icon } from '@mythrun/ui'
import type { GhostHookItem } from '@mythrun/ui'
import {
  getStartingSituations,
  chooseStartingSituation,
  getMyCampaigns,
  isHttpError,
  useApiContext,
  type ApiContext,
  type CampaignSummary,
  type StartingSituationsResponse,
} from '@mythrun/client-core'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'

// The STARTING-SITUATION PICK (MYT-90 character creation, D1) — the FIRST
// character-creation beat after the world reveal, and OWNER-ONLY. The owner
// (`CampaignSummary.creator === null` — the viewer made this world) picks one of
// three opening HOOKS (title + locationName + prose, all DATA from the API); each
// hook also carries an `invitation` whisper (kept in the response, consumed later
// by character creation — not surfaced here). A member (a joined world, a non-null
// creator) — or an unresolved / failed role probe — sees a calm WAITING HOLD
// instead of the picker; the pick is the owner's to make. Selecting → POST the
// index → the LEVEL-PICK beat (`/campaigns/:id/level`, built by D2). A 409
// `situation_locked` (the pick is already locked in) is idempotent-success — hand
// off to level-pick anyway. Load/empty/error are calm placeholders. A quiet screen
// (eyebrow + prompt over the three hooks as borderless GhostHookList items — flat
// 1-bit paper register, square, rule-split, no cards/radios). All UI composes
// @mythrun/ui.

/** The situations source — defaults to the real endpoint; tests substitute it. */
type FetchSituations = (ctx: ApiContext, campaignId: string) => Promise<StartingSituationsResponse>
/** The pick sink — defaults to the real endpoint; tests substitute it. */
type ChooseSituation = (ctx: ApiContext, campaignId: string, index: number) => Promise<unknown>
/** The campaigns source (the role probe) — defaults to `/api/campaigns/mine`; tests
 *  substitute it. Same shape + wiring the campaign page uses to read a world's identity. */
type FetchCampaigns = (ctx: ApiContext) => Promise<readonly CampaignSummary[]>

const defaultFetchCampaigns: FetchCampaigns = (ctx) =>
  getMyCampaigns(undefined, ctx).then((r) => r.campaigns)

/** The three lifecycle states of the hook fetch. `ready` carries the situations
 *  (possibly empty — the defensive empty branch); `error` a calm failed fetch. */
type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly response: StartingSituationsResponse }
  | { readonly status: 'error' }

/** The viewer's role for this campaign. `owner` sees the picker; `member` (and the
 *  unresolved `loading` state) sees the calm hold — the gate fails CLOSED so the
 *  owner-only picker never flashes for a non-owner. `worldName` rides the same
 *  probe (the hub summary carries it) and anchors the screen's eyebrow
 *  (ux-run2 myth-8ozsw); `null` when the campaign/probe didn't resolve. */
interface CampaignRole {
  readonly role: 'loading' | 'owner' | 'member'
  readonly worldName: string | null
}

/** Resolve the viewer's role from the hub payload: `creator === null` means the
 *  viewer made this world (owner); any other case — a non-null creator, a campaign
 *  we can't see, or a failed probe — resolves to `member` (the safe, gated default). */
function useCampaignRole(
  campaignId: string,
  ctx: ApiContext,
  fetchCampaigns: FetchCampaigns,
): CampaignRole {
  const [state, setState] = useState<CampaignRole>({ role: 'loading', worldName: null })
  useEffect(() => {
    let active = true
    setState({ role: 'loading', worldName: null })
    void fetchCampaigns(ctx)
      .then((list) => {
        if (!active) return
        const campaign = list.find((c) => c.id === campaignId) ?? null
        setState({
          role: campaign !== null && campaign.creator === null ? 'owner' : 'member',
          worldName: campaign?.worldName ?? null,
        })
      })
      .catch(() => {
        // A failed role probe fails CLOSED — the member hold, never the owner picker.
        if (active) setState({ role: 'member', worldName: null })
      })
    return () => {
      active = false
    }
  }, [campaignId, ctx, fetchCampaigns])
  return state
}

/** Fetch the three opening hooks once. A failed/transient fetch settles to a calm
 *  error state (never throws into the route); `active` drops a late resolve after
 *  unmount. */
function useSituations(
  campaignId: string,
  ctx: ApiContext,
  fetchSituations: FetchSituations,
): LoadState {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  useEffect(() => {
    let active = true
    setState({ status: 'loading' })
    void fetchSituations(ctx, campaignId)
      .then((response) => {
        if (active) setState({ status: 'ready', response })
      })
      .catch(() => {
        if (active) setState({ status: 'error' })
      })
    return () => {
      active = false
    }
  }, [campaignId, ctx, fetchSituations])
  return state
}

interface SituationBodyProps {
  load: LoadState
  submitFailed: boolean
  onSelect: (index: number) => void
}

/** The body: a calm i18n line while loading / on error / when empty, else the
 *  three hooks as GhostHookList items (title + place + prose). A failed pick shows
 *  the same calm retryable note beneath the list (which stays, so re-picking works). */
function SituationBody({ load, submitFailed, onSelect }: SituationBodyProps): React.JSX.Element {
  const { t } = useTranslation()
  if (load.status === 'loading') {
    return (
      <Text role="ui-caption" as="p">
        {t('startingSituation.loading')}
      </Text>
    )
  }
  if (load.status === 'error') {
    return (
      <Text role="ui-caption" as="p">
        {t('startingSituation.error')}
      </Text>
    )
  }
  if (load.response.situations.length === 0) {
    return (
      <Text role="ui-caption" as="p">
        {t('startingSituation.empty')}
      </Text>
    )
  }
  const items: GhostHookItem[] = load.response.situations.map((s) => ({
    id: String(s.index),
    title: s.title,
    place: s.locationName,
    prose: s.prose,
    onSelect: () => {
      onSelect(s.index)
    },
  }))
  return (
    <Stack gap={3}>
      <GhostHookList items={items} data-testid="situation-hooks" />
      {submitFailed && (
        <Text role="ui-caption" as="p">
          {t('startingSituation.error')}
        </Text>
      )}
    </Stack>
  )
}

/** The world-anchored eyebrow (ux-run2 myth-8ozsw): "{worldName} · Where it
 *  starts" once the role probe delivered the name; the plain fallback until
 *  then (and for a failed probe). Shared by the picker and the member hold. */
function SituationEyebrow({ worldName }: { worldName: string | null }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Text role="ui-caption" as="p" data-testid="situation-eyebrow">
      {worldName !== null
        ? t('startingSituation.eyebrowNamed', { worldName })
        : t('startingSituation.eyebrow')}
    </Text>
  )
}

/** The quiet Back to the campaign surface the picker came from (the reveal /
 *  campaign page) — the screen's one named exit (ux-run2 myth-80an1). */
function SituationBack({ campaignId }: { campaignId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <Stack align="start">
      <Button
        variant="ghost"
        size="sm"
        icon={<Icon name="arrow-left" decorative />}
        onPress={() => void navigate(`/campaigns/${campaignId}`)}
        data-testid="situation-back"
      >
        {t('back')}
      </Button>
    </Stack>
  )
}

/** The member (non-owner) WAITING HOLD — a calm eyebrow + heading + line; the owner
 *  makes the opening pick, so a member just holds until the table is set. Never
 *  renders the owner-only picker (no `situation-hooks`). */
function MemberHold({
  campaignId,
  worldName,
}: {
  campaignId: string
  worldName: string | null
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} maxWidth="content" data-testid="situation-pick-hold">
      <SituationBack campaignId={campaignId} />
      <Stack gap={1}>
        <SituationEyebrow worldName={worldName} />
        <Heading level={1} role="headline">
          {t('startingSituation.holdTitle')}
        </Heading>
      </Stack>
      <Text role="ui-caption" as="p">
        {t('startingSituation.hold')}
      </Text>
    </Stack>
  )
}

export interface SituationPickRouteProps {
  /** The situations source — defaults to the real endpoint; tests substitute it. */
  fetchSituations?: FetchSituations
  /** The pick sink — defaults to the real endpoint; tests substitute it. */
  chooseSituation?: ChooseSituation
  /** The role probe — defaults to the real `/api/campaigns/mine` endpoint; tests
   *  substitute it to render the owner picker vs. the member hold. */
  fetchCampaigns?: FetchCampaigns
}

export function SituationPickRoute({
  fetchSituations = getStartingSituations,
  chooseSituation = chooseStartingSituation,
  fetchCampaigns = defaultFetchCampaigns,
}: SituationPickRouteProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  const navigate = useNavigate()
  // The route only matches with an `:id`; `?? ''` keeps the hook calls unconditional.
  const { id = '' } = useParams<{ id: string }>()
  const { role, worldName } = useCampaignRole(id, ctx, fetchCampaigns)
  const load = useSituations(id, ctx, fetchSituations)
  const [submitFailed, setSubmitFailed] = useState(false)

  const handleSelect = (index: number): void => {
    setSubmitFailed(false)
    void chooseSituation(ctx, id, index)
      .then(() => void navigate(`/campaigns/${id}/level`))
      .catch((err: unknown) => {
        // A locked pick is done — hand off to the level-pick beat idempotently. Any
        // OTHER failure surfaces a calm retryable note; the list stays for a retry.
        if (isHttpError(err) && err.status === 409 && err.code === 'situation_locked') {
          void navigate(`/campaigns/${id}/level`)
          return
        }
        setSubmitFailed(true)
      })
  }

  // Non-owners never see the owner-only picker. While the role probe is in flight we
  // hold on a neutral loading line (no owner framing leaks); a member gets the hold.
  if (role === 'loading') {
    return (
      <Stack gap={4} maxWidth="content" data-testid="situation-pick-loading">
        <Text role="ui-caption" as="p">
          {t('startingSituation.loading')}
        </Text>
      </Stack>
    )
  }
  if (role === 'member') {
    return <MemberHold campaignId={id} worldName={worldName} />
  }

  return (
    // The centred ~720px content column (ux-run2 myth-ma8yv, critique 021): the
    // hook cards wrap their prose (already capped at its own reading measure)
    // instead of running full-bleed with the enter arrow stranded across ~600px
    // of empty card. Width only — the third card's fold-peek scroll cue stays.
    <Stack gap={4} maxWidth="content" data-testid="situation-pick">
      <SituationBack campaignId={id} />
      <Stack gap={2}>
        <Stack gap={1}>
          <SituationEyebrow worldName={worldName} />
          {/* The page question earns the headline step (ux-run2 myth-aynpf) —
              clearly above the 18px hook-card titles it governs. */}
          <Heading level={1} role="headline">
            {t('startingSituation.prompt')}
          </Heading>
        </Stack>
        {/* The contract line (ux-run2 myth-wq6ln): the option COUNT + what
            picking commits the player to, in one quiet chrome line. */}
        <Text role="ui-caption" as="p" data-testid="situation-contract">
          {t('startingSituation.contract')}
        </Text>
      </Stack>
      <SituationBody load={load} submitFailed={submitFailed} onSelect={handleSelect} />
    </Stack>
  )
}
