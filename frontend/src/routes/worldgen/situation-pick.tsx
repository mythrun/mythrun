import { useEffect, useState } from 'react'
import { Stack, Heading, Text, GhostHookList } from '@mythrun/ui'
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
 *  owner-only picker never flashes for a non-owner. */
type RoleState = 'loading' | 'owner' | 'member'

/** Resolve the viewer's role from the hub payload: `creator === null` means the
 *  viewer made this world (owner); any other case — a non-null creator, a campaign
 *  we can't see, or a failed probe — resolves to `member` (the safe, gated default). */
function useOwnerRole(
  campaignId: string,
  ctx: ApiContext,
  fetchCampaigns: FetchCampaigns,
): RoleState {
  const [role, setRole] = useState<RoleState>('loading')
  useEffect(() => {
    let active = true
    setRole('loading')
    void fetchCampaigns(ctx)
      .then((list) => {
        if (!active) return
        const campaign = list.find((c) => c.id === campaignId) ?? null
        setRole(campaign !== null && campaign.creator === null ? 'owner' : 'member')
      })
      .catch(() => {
        // A failed role probe fails CLOSED — the member hold, never the owner picker.
        if (active) setRole('member')
      })
    return () => {
      active = false
    }
  }, [campaignId, ctx, fetchCampaigns])
  return role
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

/** The body: a calm `[ph: …]` line while loading / on error / when empty, else the
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

/** The member (non-owner) WAITING HOLD — a calm eyebrow + heading + line; the owner
 *  makes the opening pick, so a member just holds until the table is set. Never
 *  renders the owner-only picker (no `situation-hooks`). */
function MemberHold(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="situation-pick-hold">
      <Stack gap={1}>
        <Text role="ui-caption" as="p">
          {t('startingSituation.eyebrow')}
        </Text>
        <Heading level={1} role="title">
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
  const role = useOwnerRole(id, ctx, fetchCampaigns)
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
      <Stack gap={4} data-testid="situation-pick-loading">
        <Text role="ui-caption" as="p">
          {t('startingSituation.loading')}
        </Text>
      </Stack>
    )
  }
  if (role === 'member') {
    return <MemberHold />
  }

  return (
    <Stack gap={4} data-testid="situation-pick">
      <Stack gap={1}>
        <Text role="ui-caption" as="p">
          {t('startingSituation.eyebrow')}
        </Text>
        <Heading level={1} role="title">
          {t('startingSituation.prompt')}
        </Heading>
      </Stack>
      <SituationBody load={load} submitFailed={submitFailed} onSelect={handleSelect} />
    </Stack>
  )
}
