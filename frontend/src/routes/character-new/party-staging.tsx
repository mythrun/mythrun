import { useEffect, useState } from 'react'
import { Stack, Heading, Text, Button, PartyRoster } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  getCharacterCreationProgress as getProgressApi,
  finalizeCharacterCreation as finalizeApi,
  getCharacter as getCharacterApi,
  getMyCampaigns,
  createSseStatusClient,
  useApiContext,
  useLiveRoster,
  type ApiContext,
  type CampaignSummary,
  type CharacterCreationProgress,
  type CharacterFull,
  type ProgressState,
  type SseStatusClient,
} from '@mythrun/client-core'
import { partyRosterViewModel } from '@mythrun/client-core/character'
import type { PartyRosterLabels, RosterMember } from '@mythrun/client-core/contract'
import { useForegroundRefetch } from '../../platform/web/use-foreground-refetch.ts'
import { CampaignInvitePanel, type InvitePanelDeps } from '../campaign-invite-panel.tsx'

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
//   • Invite → a no-op placeholder seam here (the live invite-link flow / InvitePanel
//     is a separate MYT-91 surface); the roster's `empty` slot fires it.
//   • LIVE roster updates (MYT-91): `useLiveRoster` folds the campaign status SSE
//     (`character_creation_complete` + each reconnect) so a teammate finishing their
//     character surfaces without a reload; `useForegroundRefetch` adds the web
//     focus + visible-tab slow-poll fallback the SSE can't provide.
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
/** The status-SSE transport factory — defaults to the real client; tests substitute a hand-driven one. */
type CreateClient = (ctx: ApiContext) => SseStatusClient
/** One PC's full read (the character NAME for the roster row) — defaults to the
 *  real endpoint; tests substitute it. */
type GetCharacter = (ctx: ApiContext, campaignId: string, charId: string) => Promise<CharacterFull>

/** The injectable endpoint + transport seam. Every field is optional and defaults to
 *  the real endpoint/transport; D8 mounts the surface with `deps` unset, tests +
 *  stories substitute hand-driven ones. */
export interface PartyStagingDeps {
  getProgress?: GetProgress
  finalize?: Finalize
  getCampaigns?: GetCampaigns
  /** The status-SSE transport the live roster subscribes to (default: the real client). */
  createClient?: CreateClient
  /** The character read backing the roster's character-name rows (myth-wfgfi). */
  getCharacter?: GetCharacter
}

export interface PartyStagingSurfaceProps {
  /** The campaign whose party this stages. */
  campaignId: string
  /** The viewer whose row is marked "you" + whose owner role gates the Begin. */
  viewerUserId: string
  /** Called after a successful finalize — D8 re-routes to the weave/opening scene. */
  onFinalized: () => void
  /** Injected endpoint + transport seams (default to the real ones); tests + stories substitute. */
  deps?: PartyStagingDeps
  /** Injected invite endpoints + web ports for the owner's inline invite disclosure
   *  (MYT-99g03) — the SINGLE invite entry point on staging, opened from the dashed
   *  party slot. Defaults to the real client-core fns + web port. */
  inviteDeps?: InvitePanelDeps
}

const defaultGetCampaigns: GetCampaigns = (ctx) =>
  getMyCampaigns(undefined, ctx).then((r) => r.campaigns)

// The synthetic invite affordance — a single dashed "empty" slot the surface
// appends in the solo case (PartyRoster renders an `empty` row as the invite CTA).
const INVITE_SLOT: RosterMember = {
  userId: '__invite__',
  displayName: '',
  status: 'empty',
  isViewer: false,
}

/** Append the invite affordance in the SOLO OWNER case only — one real member, no
 *  pending joiners, and the viewer owns the campaign (invites are owner-only). A
 *  party (2+ real members), a roster that already carries an `empty` seat from
 *  `missing[]`, or a non-owner keeps its own rows with no extra invite slot. */
function withInviteSlot(members: readonly RosterMember[], isOwner: boolean): RosterMember[] {
  const realCount = members.filter((m) => m.status !== 'empty').length
  const hasEmpty = members.some((m) => m.status === 'empty')
  return isOwner && realCount <= 1 && !hasEmpty ? [...members, INVITE_SLOT] : [...members]
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

/** Fetch + cache each made character's NAME by its characterId (ux-run2
 *  myth-wfgfi: the lobby leads with the CHARACTER, and the progress wire carries
 *  only ids). Each id is fetched once; a failed read calm-degrades (that row
 *  keeps its account-led rendering). */
function useCharacterNames(
  campaignId: string,
  progress: ProgressState,
  ctx: ApiContext,
  getCharacter: GetCharacter,
): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map())
  useEffect(() => {
    if (progress.status !== 'ready') return
    const missing = progress.progress.concepts
      .map((c) => c.characterId)
      .filter((id): id is string => typeof id === 'string' && !names.has(id))
    if (missing.length === 0) return
    let active = true
    void Promise.all(
      missing.map((charId) =>
        getCharacter(ctx, campaignId, charId)
          .then((full) => [charId, full.character.name] as const)
          .catch(() => null),
      ),
    ).then((pairs) => {
      if (!active) return
      const resolved = pairs.filter((pair): pair is readonly [string, string] => pair !== null)
      if (resolved.length > 0) setNames((prev) => new Map([...prev, ...resolved]))
    })
    return () => {
      active = false
    }
  }, [progress, ctx, campaignId, getCharacter, names])
  return names
}

/** Attach each member's character name (userId → characterId → fetched name).
 *  Absent names (still creating / fetch failed) leave the row untouched. */
function withCharacterNames(
  members: readonly RosterMember[],
  concepts: CharacterCreationProgress['concepts'],
  names: ReadonlyMap<string, string>,
): RosterMember[] {
  const charIdByUser = new Map(
    concepts
      .filter((c): c is typeof c & { characterId: string } => typeof c.characterId === 'string')
      .map((c) => [c.userId, c.characterId]),
  )
  return members.map((member) => {
    const charId = charIdByUser.get(member.userId)
    const characterName = charId !== undefined ? names.get(charId) : undefined
    return characterName !== undefined ? { ...member, characterName } : member
  })
}

/** The roster's resolved labels — the partial-begin strings arrive count-resolved
 *  here (the DS stays interpolation-free). */
function rosterLabels(t: TFunction, readyCount: number, realCount: number): PartyRosterLabels {
  return {
    partyHeading: t('characterCreate.staging.partyHeading'),
    inviteSub: t('characterCreate.staging.inviteSub'),
    creating: t('characterCreate.staging.creating'),
    gathering: t('characterCreate.staging.gathering'),
    waiting: t('characterCreate.staging.waiting'),
    beginSolo: t('characterCreate.staging.beginSolo'),
    beginParty: t('characterCreate.staging.beginParty'),
    beginPartial: t('characterCreate.staging.beginPartial', { ready: readyCount, total: realCount }),
    beginConfirmPrompt: t('characterCreate.staging.beginConfirm', { count: realCount - readyCount }),
    beginConfirmYes: t('characterCreate.staging.beginConfirmYes'),
    beginConfirmNo: t('characterCreate.staging.beginConfirmNo'),
  }
}

/** The calm loading line while the fetches are in flight. */
function StagingLoading({ t }: { t: TFunction }): React.JSX.Element {
  return (
    <Stack gap={4} maxWidth="content" data-testid="party-staging-loading">
      <Text role="ui-caption" as="p">
        {t('characterCreate.staging.loading')}
      </Text>
    </Stack>
  )
}

/** The calm retryable error screen for a failed roster fetch. */
function StagingError({ t, onRetry }: { t: TFunction; onRetry: () => void }): React.JSX.Element {
  return (
    <Stack gap={3} maxWidth="content" data-testid="party-staging-error">
      <Text role="ui-caption" as="p">
        {t('characterCreate.staging.loadError')}
      </Text>
      <Button variant="secondary" onPress={onRetry}>
        {t('characterCreate.staging.retry')}
      </Button>
    </Stack>
  )
}

export function PartyStagingSurface({
  campaignId,
  viewerUserId,
  onFinalized,
  deps,
  inviteDeps,
}: PartyStagingSurfaceProps): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  const {
    getProgress = getProgressApi,
    finalize = finalizeApi,
    getCampaigns = defaultGetCampaigns,
    createClient = createSseStatusClient,
    getCharacter = getCharacterApi,
  } = deps ?? {}

  const role = useOwnerRole(campaignId, viewerUserId, ctx, getCampaigns)
  const { state: progress, reload } = useLiveRoster(campaignId, ctx, { getProgress, createClient })
  useForegroundRefetch(reload)
  const names = useCharacterNames(campaignId, progress, ctx, getCharacter)
  const [beginFailed, setBeginFailed] = useState(false)
  // The partial-begin confirm (ux-run2 myth-wfgfi) — the DS roster is fully
  // controlled, so this surface owns the armed/dismissed state.
  const [beginConfirming, setBeginConfirming] = useState(false)
  // The inline invite disclosure (MYT-99g03) — opened from the dashed party slot, the
  // SINGLE invite entry point on staging (no standalone invite block above the party).
  const [inviteOpen, setInviteOpen] = useState(false)

  const handleBegin = (): void => {
    setBeginConfirming(false)
    setBeginFailed(false)
    void finalize(ctx, campaignId)
      .then(() => {
        onFinalized()
      })
      .catch(() => {
        setBeginFailed(true)
      })
  }

  // The dashed slot toggles the inline invite disclosure below it (progressive
  // disclosure) — the live invite-link flow now lives INSIDE the roster on staging.
  const handleInvite = (): void => {
    setInviteOpen((open) => !open)
  }

  if (progress.status === 'loading' || role.status === 'loading') {
    return <StagingLoading t={t} />
  }
  if (progress.status === 'error') {
    return <StagingError t={t} onRetry={reload} />
  }

  const members = withCharacterNames(
    withInviteSlot(
      partyRosterViewModel(progress.progress, viewerUserId, role.ownerUserId),
      role.viewerIsOwner,
    ),
    progress.progress.concepts,
    names,
  )
  // The owner may begin once their OWN concept is ready (a laggard party member
  // does not gate it — the owner begins now or waits, past an honest confirm). The
  // view-model leads with the owner's row, so read readiness off the owner's id.
  const canBegin = members.some((m) => m.userId === role.ownerUserId && m.status === 'ready')
  const realCount = members.filter((m) => m.status !== 'empty').length
  const readyCount = members.filter((m) => m.status === 'ready').length

  // The owner's inline invite disclosure — the wired quiet panel rendered inside the
  // roster (below the party, above Begin) when the dashed slot is open. `undefined`
  // (member, or slot closed) leaves the slot collapsed.
  const inviteExpansion =
    role.viewerIsOwner && inviteOpen ? (
      <CampaignInvitePanel
        campaignId={campaignId}
        prominence="quiet"
        {...(inviteDeps !== undefined && { deps: inviteDeps })}
      />
    ) : undefined

  return (
    // The centred ~720px lobby column (ux-run2 myth-ma8yv): five rows never earn full bleed.
    <Stack gap={5} maxWidth="content" data-testid="party-staging">
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
        beginConfirming={beginConfirming}
        onRequestBegin={() => {
          setBeginConfirming(true)
        }}
        onCancelBegin={() => {
          setBeginConfirming(false)
        }}
        onBegin={handleBegin}
        onInvite={handleInvite}
        {...(inviteExpansion !== undefined && { inviteExpansion })}
        labels={rosterLabels(t, readyCount, realCount)}
      />
      {beginFailed && (
        <Text role="ui-caption" as="p" data-testid="party-staging-begin-error">
          {t('characterCreate.staging.beginError')}
        </Text>
      )}
    </Stack>
  )
}
