import { Navigate, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { CharacterCreationStreamDeps } from '@mythrun/client-core/character'
import { CharacterLoadingSurface } from './character-loading.tsx'
import { CharacterRevealSurface } from './character-reveal.tsx'
import { PartyStagingSurface, type PartyStagingDeps } from './party-staging.tsx'
import type { InvitePanelDeps } from '../campaign-invite-panel.tsx'
import type { CharacterRouteKind } from './character-route.ts'
import type {
  ViewerSignals,
  FetchMe,
  FetchSituations,
  FetchProgress,
  CampaignMutation,
} from './viewer-signals.ts'
import { HoldView, FailureView, PlayEntry } from './character-inline-views.tsx'

/** The three reveal endpoint seams, pulled off the committed reveal surface's props
 *  so this file forwards them without redeclaring their signatures. */
type CharacterRevealSurfacePassthrough = Pick<
  React.ComponentProps<typeof CharacterRevealSurface>,
  'getCharacter' | 'confirmCharacter' | 'resetCharacterConcept'
>

/** The injectable endpoint + child-surface seams. Every field defaults to the real
 *  endpoint; CampaignPage mounts the surface with `deps` unset, tests + stories
 *  substitute hand-driven ones. `loading` / `reveal` / `staging` forward to the
 *  committed child surfaces so a routing test doesn't hit a live SSE/endpoint. */
export interface CharacterSurfaceDeps {
  fetchMe?: FetchMe
  fetchSituations?: FetchSituations
  fetchProgress?: FetchProgress
  resetConcept?: CampaignMutation
  finalize?: CampaignMutation
  loading?: CharacterCreationStreamDeps
  reveal?: {
    getCharacter?: CharacterRevealSurfacePassthrough['getCharacter']
    confirmCharacter?: CharacterRevealSurfacePassthrough['confirmCharacter']
    resetCharacterConcept?: CharacterRevealSurfacePassthrough['resetCharacterConcept']
  }
  staging?: PartyStagingDeps
}

// -----------------------------------------------------------------------------
// The routed beat — maps a decided `kind` to the child screen (a redirect Navigate
// or a mounted beat). Split out of CharacterSurface so each stays focused; it owns
// `useNavigate` for the discrete-route redirects + the reveal/staging hand-offs.
// -----------------------------------------------------------------------------

interface CharacterBeatProps {
  readonly kind: CharacterRouteKind
  readonly campaignId: string
  readonly signals: ViewerSignals
  readonly deps: CharacterSurfaceDeps | undefined
  /** The owner's invite endpoints/ports — forwarded to the staging beat, whose inline
   *  party-slot disclosure is the single invite entry point there (MYT-99g03). */
  readonly inviteDeps?: InvitePanelDeps
  /** Whether this campaign has a play record (myth-dbu98) — a played campaign's
   *  play entry says "Continue session" (the verb the hub premier card promised);
   *  a first entry keeps the ceremonial "Step into the world". */
  readonly played?: boolean
  readonly onReload: () => void
  readonly onConceptRetry: () => void
  readonly onIntegrationRetry: () => void
}

/** Forward the child-surface seams only when injected (tests/stories) — under
 *  `exactOptionalPropertyTypes` an explicit `undefined` isn't assignable to the
 *  committed surfaces' optional props, so spread each key conditionally. */
function resolveBeatChildProps(deps: CharacterSurfaceDeps | undefined) {
  const loadingProps = deps?.loading !== undefined ? { deps: deps.loading } : {}
  const stagingProps = deps?.staging !== undefined ? { deps: deps.staging } : {}
  const revealProps = {
    ...(deps?.reveal?.getCharacter !== undefined && { getCharacter: deps.reveal.getCharacter }),
    ...(deps?.reveal?.confirmCharacter !== undefined && {
      confirmCharacter: deps.reveal.confirmCharacter,
    }),
    ...(deps?.reveal?.resetCharacterConcept !== undefined && {
      resetCharacterConcept: deps.reveal.resetCharacterConcept,
    }),
  }
  return { loadingProps, stagingProps, revealProps }
}

export function CharacterBeat({
  kind,
  campaignId,
  signals: s,
  deps,
  inviteDeps,
  played = false,
  onReload,
  onConceptRetry,
  onIntegrationRetry,
}: CharacterBeatProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // Template-literal paths (the route segments aren't translatable strings);
  // `navigate` returns a promise under react-router 7 → `void` it.
  const createPath = `/campaigns/${campaignId}/character/new`
  const playPath = `/campaigns/${campaignId}/play`

  const { loadingProps, stagingProps, revealProps } = resolveBeatChildProps(deps)
  const loadingBeat = (
    <CharacterLoadingSurface
      campaignId={campaignId}
      userId={s.viewerUserId}
      onDone={onReload}
      {...loadingProps}
    />
  )

  switch (kind) {
    case 'situation':
      return <Navigate to={`/campaigns/${campaignId}/situation`} replace />
    case 'level':
      return <Navigate to={`/campaigns/${campaignId}/level`} replace />
    case 'create':
      return <Navigate to={createPath} replace />
    case 'hold':
      return (
        <HoldView
          title={t('campaign.character.hold.title')}
          body={t('campaign.character.hold.body')}
        />
      )
    case 'loading':
      return loadingBeat
    case 'reveal':
      // `completed` implies a persisted sheet (the sheet stage writes the character
      // before flipping the status), but guard the null charId defensively → hold on
      // the loading beat until the row links rather than mount the reveal charId-less.
      return s.charId === null ? (
        loadingBeat
      ) : (
        <CharacterRevealSurface
          campaignId={campaignId}
          charId={s.charId}
          onConfirmed={onReload}
          onReset={() => {
            void navigate(createPath)
          }}
          {...revealProps}
        />
      )
    case 'staging':
      return (
        <PartyStagingSurface
          campaignId={campaignId}
          viewerUserId={s.viewerUserId}
          onFinalized={() => {
            void navigate(playPath)
          }}
          {...stagingProps}
          {...(inviteDeps !== undefined && { inviteDeps })}
        />
      )
    case 'failure-concept':
      return (
        <FailureView
          title={t('campaign.character.failure.concept.title')}
          body={t('campaign.character.failure.concept.body')}
          retryLabel={t('campaign.character.failure.concept.retry')}
          onRetry={onConceptRetry}
        />
      )
    case 'failure-integration':
      return (
        <FailureView
          title={t('campaign.character.failure.integration.title')}
          body={t('campaign.character.failure.integration.body')}
          retryLabel={t('campaign.character.failure.integration.retry')}
          onRetry={onIntegrationRetry}
        />
      )
    case 'play':
      return (
        <PlayEntry
          title={t('campaign.character.play.title')}
          body={t('campaign.character.play.body')}
          // Resume-verb continuity (myth-dbu98): a played campaign continues in
          // the hub's words; only the first entry steps into the world.
          enterLabel={played ? t('campaign.character.play.enterContinue') : t('campaign.character.play.enter')}
          onEnter={() => {
            void navigate(playPath)
          }}
        />
      )
  }
}
