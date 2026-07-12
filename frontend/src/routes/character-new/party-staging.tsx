import { useCallback, useEffect, useState } from 'react'
import { Stack, Heading, Text, Button, PartyRoster } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import {
  getCharacterCreationProgress as getProgressApi,
  finalizeCharacterCreation as finalizeApi,
  getMyCampaigns,
  useApiContext,
  type ApiContext,
  type CampaignSummary,
  type CharacterCreationProgress,
} from '@mythrun/client-core'
import { partyRosterViewModel } from '@mythrun/client-core/character'
import type { RosterMember } from '@mythrun/client-core/contract'

// The PARTY-STAGING SURFACE (MYT-90 D7) — the "ready to begin?" screen the D8
// routing table mounts once the viewer's OWN character is confirmed. It is a
// thin, self-contained composition: it FETCHES the roster progress + the viewer's
// owner role, MAPS the progress into roster rows via the committed client-core
// `partyRosterViewModel`, and renders the DS <PartyRoster> under a screen headline.
//
// Owner detection reuses the `getMyCampaigns → creator === null` mechanism the
// other create beats use (situation-pick, level-pick): a null `creator` means the
// viewer made this world (owner); a named creator (or an unresolved/failed probe)
// resolves to a member — the gate fails CLOSED so the owner-only Begin never leaks
// to a non-owner. The owner's userId (needed to order the roster owner-first) is
// the viewer's own id when they own it, else the party member whose displayName
// matches the creator name.
//
// It owns three behaviours:
//   • Begin (owner only, `canBegin` = the owner's own concept ready) →
//     finalizeCharacterCreation → onFinalized (D8 re-routes to the weave/play).
//   • Invite → a MYT-91 boundary. The live join + invite-link flow is MYT-91, so
//     here the affordance is a no-op placeholder seam (NOT the real invite flow).
//   • A modest interval refetch of the roster so late finishers surface — live WS
//     updates are MYT-91; a poll is enough for the MYT-90 shell.
//
// A failed Begin keeps the roster up under a calm, retryable note; a failed initial
// roster fetch shows a calm error with a retry. Non-owners see the waiting line
// (PartyRoster renders that from `viewerIsOwner=false`).

/** The roster-progress read — defaults to the real endpoint; tests substitute it. */
type GetProgress = (ctx: ApiContext, campaignId: string) => Promise<CharacterCreationProgress>
/** The owner-only finalize (fan-in) — defaults to the real endpoint; tests substitute it. */
type Finalize = (ctx: ApiContext, campaignId: string) => Promise<unknown>
/** The role probe (`/api/campaigns/mine`) — defaults to the real endpoint; tests substitute it. */
type GetCampaigns = (ctx: ApiContext) => Promise<readonly CampaignSummary[]>

/** The injectable endpoint + cadence seam. Every field is optional and defaults to
 *  the real endpoint; D8 mounts the surface with `deps` unset, tests + stories
 *  substitute hand-driven ones. */
export interface PartyStagingDeps {
  getProgress?: GetProgress
  finalize?: Finalize
  getCampaigns?: GetCampaigns
  /** Roster poll cadence (ms) — a modest interval refetch until MYT-91 brings live updates. */
  pollMs?: number
}

export interface PartyStagingSurfaceProps {
  /** The campaign whose party this stages. */
  campaignId: string
  /** The viewer whose row is marked "you" + whose owner role gates the Begin. */
  viewerUserId: string
  /** Called after a successful finalize — D8 re-routes to the weave/opening scene. */
  onFinalized: () => void
  /** Injected endpoint + cadence seams (default to the real endpoints); tests + stories substitute. */
  deps?: PartyStagingDeps
}

const defaultGetCampaigns: GetCampaigns = (ctx) =>
  getMyCampaigns(undefined, ctx).then((r) => r.campaigns)

const DEFAULT_POLL_MS = 5000

// The synthetic invite affordance — a single dashed "empty" slot the surface
// appends in the solo case (PartyRoster renders an `empty` row as the invite CTA).
const INVITE_SLOT: RosterMember = {
  userId: '__invite__',
  displayName: '',
  status: 'empty',
  isViewer: false,
}

/** Append the invite affordance in the SOLO case only — one real member and no
 *  pending joiners (the owner is alone, so offer "invite a friend"). A party (2+
 *  real members) — or one that already carries an `empty` seat from `missing[]` —
 *  keeps its own rows; the mockup shows no extra invite slot there. */
function withInviteSlot(members: readonly RosterMember[]): RosterMember[] {
  const realCount = members.filter((m) => m.status !== 'empty').length
  const hasEmpty = members.some((m) => m.status === 'empty')
  return realCount <= 1 && !hasEmpty ? [...members, INVITE_SLOT] : [...members]
}

/** The viewer's resolved role: `viewerIsOwner` gates the Begin control; `ownerUserId`
 *  orders the roster owner-first + backs the `canBegin` readiness read. */
type OwnerRole =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly viewerIsOwner: boolean; readonly ownerUserId: string }

/** Resolve the viewer's role from the hub payload: `creator === null` means the
 *  viewer made this world (owner → their own id leads the roster); a named creator
 *  resolves to a member (find the owner's id by matching the creator name in the
 *  party). A missing campaign or a failed probe fails CLOSED to the member view. */
function useOwnerRole(
  campaignId: string,
  viewerUserId: string,
  ctx: ApiContext,
  getCampaigns: GetCampaigns,
): OwnerRole {
  const [role, setRole] = useState<OwnerRole>({ status: 'loading' })
  useEffect(() => {
    let active = true
    setRole({ status: 'loading' })
    void getCampaigns(ctx)
      .then((list) => {
        if (!active) return
        const campaign = list.find((c) => c.id === campaignId) ?? null
        const viewerIsOwner = campaign !== null && campaign.creator === null
        const ownerUserId = viewerIsOwner
          ? viewerUserId
          : (campaign?.party.find((m) => m.displayName === campaign.creator)?.userId ?? '')
        setRole({ status: 'ready', viewerIsOwner, ownerUserId })
      })
      .catch(() => {
        // A failed role probe fails CLOSED — the member waiting line, never the owner Begin.
        if (active) setRole({ status: 'ready', viewerIsOwner: false, ownerUserId: '' })
      })
    return () => {
      active = false
    }
  }, [campaignId, viewerUserId, ctx, getCampaigns])
  return role
}

/** The roster-fetch lifecycle. `ready` carries the latest progress; the poll folds
 *  fresh progress in place (and self-heals a prior error) without a loading flash. */
type ProgressState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly progress: CharacterCreationProgress }

/** Fetch the roster once (owning the loading/error UI), then refetch it on a modest
 *  interval so members finishing after the owner lands surface without a reload. A
 *  poll failure is swallowed — the last-good roster stays up, the next tick retries. */
function useProgressPolling(
  campaignId: string,
  ctx: ApiContext,
  getProgress: GetProgress,
  pollMs: number,
): { state: ProgressState; reload: () => void } {
  const [state, setState] = useState<ProgressState>({ status: 'loading' })
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let active = true
    setState({ status: 'loading' })
    void getProgress(ctx, campaignId)
      .then((progress) => {
        if (active) setState({ status: 'ready', progress })
      })
      .catch(() => {
        if (active) setState({ status: 'error' })
      })
    return () => {
      active = false
    }
  }, [campaignId, ctx, getProgress, reloadKey])

  useEffect(() => {
    let active = true
    const id = setInterval(() => {
      void getProgress(ctx, campaignId)
        .then((progress) => {
          if (active) setState({ status: 'ready', progress })
        })
        .catch(() => {
          // Keep the last-good roster; the next tick retries.
        })
    }, pollMs)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [campaignId, ctx, getProgress, pollMs])

  const reload = useCallback(() => {
    setReloadKey((k) => k + 1)
  }, [])
  return { state, reload }
}

export function PartyStagingSurface({
  campaignId,
  viewerUserId,
  onFinalized,
  deps,
}: PartyStagingSurfaceProps): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  const {
    getProgress = getProgressApi,
    finalize = finalizeApi,
    getCampaigns = defaultGetCampaigns,
    pollMs = DEFAULT_POLL_MS,
  } = deps ?? {}

  const role = useOwnerRole(campaignId, viewerUserId, ctx, getCampaigns)
  const { state: progress, reload } = useProgressPolling(campaignId, ctx, getProgress, pollMs)
  const [beginFailed, setBeginFailed] = useState(false)

  const handleBegin = (): void => {
    setBeginFailed(false)
    void finalize(ctx, campaignId)
      .then(() => {
        onFinalized()
      })
      .catch(() => {
        setBeginFailed(true)
      })
  }

  // MYT-91: the real invite flow (share a join link + live join). Until then the
  // roster's invite affordance is a no-op placeholder seam — the roster shell +
  // the finalize control are MYT-90; live join + invite links are MYT-91.
  const handleInvite = (): void => {
    // MYT-91 boundary — intentionally a no-op.
  }

  if (progress.status === 'loading' || role.status === 'loading') {
    return (
      <Stack gap={4} data-testid="party-staging-loading">
        <Text role="ui-caption" as="p">
          {t('characterCreate.staging.loading')}
        </Text>
      </Stack>
    )
  }

  if (progress.status === 'error') {
    return (
      <Stack gap={3} data-testid="party-staging-error">
        <Text role="ui-caption" as="p">
          {t('characterCreate.staging.loadError')}
        </Text>
        <Button variant="secondary" onPress={reload}>
          {t('characterCreate.staging.retry')}
        </Button>
      </Stack>
    )
  }

  const members = withInviteSlot(
    partyRosterViewModel(progress.progress, viewerUserId, role.ownerUserId),
  )
  // The owner may begin once their OWN concept is ready (a laggard party member
  // does not gate it — the owner begins now or waits). The view-model leads with
  // the owner's row, so read readiness off the owner's id.
  const canBegin = members.some((m) => m.userId === role.ownerUserId && m.status === 'ready')

  return (
    <Stack gap={5} data-testid="party-staging">
      <Stack gap={1}>
        <Heading level={1} role="title">
          {t('characterCreate.staging.title')}
        </Heading>
        <Text role="ui-caption" as="p">
          {t('characterCreate.staging.lede')}
        </Text>
      </Stack>
      <PartyRoster
        members={members}
        viewerIsOwner={role.viewerIsOwner}
        canBegin={canBegin}
        onBegin={handleBegin}
        onInvite={handleInvite}
      />
      {beginFailed && (
        <Text role="ui-caption" as="p" data-testid="party-staging-begin-error">
          {t('characterCreate.staging.beginError')}
        </Text>
      )}
    </Stack>
  )
}
