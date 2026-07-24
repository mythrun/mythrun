import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Stack, Text, Button } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import {
  getStartingSituations,
  getCharacterCreationProgress,
  resetCharacterConcept as resetConceptApi,
  finalizeCharacterCreation as finalizeApi,
  useApiContext,
  type CampaignSummary,
} from '@mythrun/client-core'
import { deriveCharacterRoute } from './character-route.ts'
import { useViewerSignals, defaultFetchMe } from './viewer-signals.ts'
import { CharacterBeat, type CharacterSurfaceDeps } from './character-beat.tsx'
import { CampaignInvitePanel, type InvitePanelDeps } from '../campaign-invite-panel.tsx'

// Re-exported so consumers keep a single import surface: CampaignPage mounts
// <CharacterSurface> + types its injected `deps` as CharacterSurfaceDeps.
export type { CharacterSurfaceDeps }

// The CHARACTER SURFACE (MYT-90 D8) — the integrator. Mounted by CampaignPage in
// place of the old character stub seam, it reads the THREE viewer-relative signals
// the spec's §3.3 routing model turns on — the campaign status + role (from the
// `campaign` prop CampaignPage already fetched: `creator === null` ⟹ owner), the
// owner's setup progress (`getStartingSituations` → chosenIndex / startingLevel),
// and the CURRENT user's concept row (`getCharacterCreationProgress`, keyed by the
// viewer's own id from `getMe`) — and mounts the right beat:
//
//   • owner pre-situation / pre-level → REDIRECT to the discrete pick routes;
//     a member in that window sees a calm "setting up the table" hold.
//   • no concept row (or a freshly-resubmittable one) → REDIRECT to create.
//   • a `failed` concept → a CHARACTER-CONTEXT failure+retry (reset → create),
//     never the world-gen terminal (that interception lives in campaign-detail).
//   • `processing` → the D5 loading beat; `completed` unconfirmed → the D6 reveal;
//     `completed` + `confirmed_at` → the D7 party staging (reload-stable — the
//     split keys on the durable `confirmedAt`, not in-session state).
//   • `integrated` / campaign `active` → a play entry; campaign `failed`
//     (terminal integration failure) → the same character-context failure surface.
//
// The transitions advance by re-reading the concept row (a `reload` bump): the
// loading beat's `onDone`, the reveal's `onConfirmed`, and the integration retry
// all refetch; the reveal's `onReset` + the create/level/situation redirects hand
// off to the discrete routes. All routing lives here; the child beats stay the
// self-contained committed surfaces.

export interface CharacterSurfaceProps {
  /** The campaign whose creation this routes — carries the status + role (creator).
   *  `null` while CampaignPage's identity fetch is still resolving. */
  campaign: CampaignSummary | null
  /** The campaign id — the route param + every child surface's scope. */
  campaignId: string
  /** Injected endpoint + child-surface seams (default to the real endpoints). */
  deps?: CharacterSurfaceDeps
  /** Injected invite endpoints + web ports for the owner's invite affordance
   *  (MYT-99g03). The invite renders WITH the beat — a quiet collapsed line below
   *  the reveal / other setup beats, and the inline party-slot disclosure on
   *  staging — never as a standalone block above the character. */
  inviteDeps?: InvitePanelDeps
}

// The surface's own calm loading/error chrome (the child beats own theirs).
const SURFACE_LOADING_TESTID = 'character-surface-loading'
const SURFACE_ERROR_TESTID = 'character-surface-error'

// -----------------------------------------------------------------------------
// The surface — fetches the viewer signals, decides the kind, owns the retry
// state, and delegates the screen to <CharacterBeat>.
// -----------------------------------------------------------------------------

export function CharacterSurface({
  campaign,
  campaignId,
  deps,
  inviteDeps,
}: CharacterSurfaceProps): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  const navigate = useNavigate()
  const {
    fetchMe = defaultFetchMe,
    fetchSituations = getStartingSituations,
    fetchProgress = getCharacterCreationProgress,
    resetConcept = resetConceptApi,
    finalize = finalizeApi,
  } = deps ?? {}

  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => {
    setReloadKey((k) => k + 1)
  }, [])
  const [retryFailed, setRetryFailed] = useState(false)

  const state = useViewerSignals(campaignId, ctx, reloadKey, fetchMe, fetchSituations, fetchProgress)

  // A failed concept: reset the caller's own row (clears the sheet), then hand off
  // to create for a fresh submission. A failed retry surfaces a calm note.
  const onConceptRetry = (): void => {
    setRetryFailed(false)
    void resetConcept(ctx, campaignId)
      .then(() => {
        void navigate(`/campaigns/${campaignId}/character/new`)
      })
      .catch(() => {
        setRetryFailed(true)
      })
  }
  // A terminal integration failure: re-attempt the fan-in, then re-read. Recovery is
  // bounded by the backend (a failed campaign can't always be re-finalized — §7
  // follow-up); the calm note covers the un-recoverable case.
  const onIntegrationRetry = (): void => {
    setRetryFailed(false)
    void finalize(ctx, campaignId)
      .then(() => {
        reload()
      })
      .catch(() => {
        setRetryFailed(true)
      })
  }

  if (campaign === null || state.status === 'loading') {
    return (
      <Stack gap={3} data-testid={SURFACE_LOADING_TESTID}>
        <Text role="ui-caption" as="p">
          {t('campaign.character.loading')}
        </Text>
      </Stack>
    )
  }

  if (state.status === 'error') {
    return (
      <Stack gap={3} data-testid={SURFACE_ERROR_TESTID}>
        <Text role="ui-caption" as="p">
          {t('campaign.character.error.body')}
        </Text>
        <Stack direction="row">
          <Button variant="secondary" onPress={reload}>
            {t('campaign.character.error.retry')}
          </Button>
        </Stack>
      </Stack>
    )
  }

  const s = state.signals
  const isOwner = campaign.creator === null
  const kind = deriveCharacterRoute({
    campaignStatus: campaign.status,
    isOwner,
    situationChosen: s.situationChosen,
    levelSet: s.levelSet,
    conceptStatus: s.conceptStatus,
    confirmed: s.confirmed,
  })

  // The owner's invite deps travel to the staging beat (its inline party-slot
  // disclosure is the single invite entry point there); every other non-redirect beat
  // gets the collapsed quiet line below (MYT-99g03 — the invite is demoted below the
  // character, never a block above it). Conditional spread keeps the optional prop
  // absent (not an explicit `undefined`) under exactOptionalPropertyTypes. The beat
  // takes `inviteDeps` (forwards to PartyStagingSurface); the panel takes `deps`.
  const beatInviteProp = inviteDeps !== undefined ? { inviteDeps } : {}
  const panelDepsProp = inviteDeps !== undefined ? { deps: inviteDeps } : {}

  // Redirect kinds navigate away — render the beat bare (no surface chrome).
  if (kind === 'situation' || kind === 'level' || kind === 'create') {
    return <CharacterBeat kind={kind} campaignId={campaignId} signals={s} deps={deps} onReload={reload} onConceptRetry={onConceptRetry} onIntegrationRetry={onIntegrationRetry} />
  }

  const isFailure = kind === 'failure-concept' || kind === 'failure-integration'
  // Staging owns its own inline invite (folded into the party slot); every other beat
  // shows the demoted collapsed invite here, below the beat content, owner-only.
  const showCollapsedInvite = isOwner && kind !== 'staging'
  return (
    <Stack gap={4} data-testid="character-surface">
      <CharacterBeat
        kind={kind}
        campaignId={campaignId}
        signals={s}
        deps={deps}
        onReload={reload}
        onConceptRetry={onConceptRetry}
        onIntegrationRetry={onIntegrationRetry}
        {...beatInviteProp}
      />
      {showCollapsedInvite && (
        <CampaignInvitePanel campaignId={campaignId} collapsible prominence="quiet" {...panelDepsProp} />
      )}
      {isFailure && retryFailed && (
        <Text role="ui-caption" as="p" data-testid="character-failure-retry-error">
          {t('campaign.character.failure.retryError')}
        </Text>
      )}
    </Stack>
  )
}
