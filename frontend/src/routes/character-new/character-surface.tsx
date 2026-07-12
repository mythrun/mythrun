import { useCallback, useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { Stack, Heading, Text, Button } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import {
  getMe,
  getStartingSituations,
  getCharacterCreationProgress,
  resetCharacterConcept as resetConceptApi,
  finalizeCharacterCreation as finalizeApi,
  useApiContext,
  type ApiContext,
  type CampaignSummary,
  type StartingSituationsResponse,
  type CharacterCreationProgress,
} from '@mythrun/client-core'
import type { CharacterCreationStreamDeps } from '@mythrun/client-core/character'
import { CharacterLoadingSurface } from './character-loading.tsx'
import { CharacterRevealSurface } from './character-reveal.tsx'
import { PartyStagingSurface, type PartyStagingDeps } from './party-staging.tsx'

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

/** The viewer identity read — only `user.id` is needed (to find the caller's own
 *  concept row). Structural so the default `getMe` slots in without importing the
 *  full `MeResponse` type (not on the client-core barrel). */
type FetchMe = (ctx: ApiContext) => Promise<{ readonly user: { readonly id: string } }>
type FetchSituations = (ctx: ApiContext, campaignId: string) => Promise<StartingSituationsResponse>
type FetchProgress = (ctx: ApiContext, campaignId: string) => Promise<CharacterCreationProgress>
/** Self-scoped mutations — the failure retries. */
type CampaignMutation = (ctx: ApiContext, campaignId: string) => Promise<unknown>

const defaultFetchMe: FetchMe = (ctx) => getMe(undefined, ctx)

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

/** The three reveal endpoint seams, pulled off the committed reveal surface's props
 *  so this file forwards them without redeclaring their signatures. */
type CharacterRevealSurfacePassthrough = Pick<
  React.ComponentProps<typeof CharacterRevealSurface>,
  'getCharacter' | 'confirmCharacter' | 'resetCharacterConcept'
>

export interface CharacterSurfaceProps {
  /** The campaign whose creation this routes — carries the status + role (creator).
   *  `null` while CampaignPage's identity fetch is still resolving. */
  campaign: CampaignSummary | null
  /** The campaign id — the route param + every child surface's scope. */
  campaignId: string
  /** Injected endpoint + child-surface seams (default to the real endpoints). */
  deps?: CharacterSurfaceDeps
}

// -----------------------------------------------------------------------------
// The pure routing decision (spec §3.3). Exported for exhaustive unit coverage.
// -----------------------------------------------------------------------------

export type CharacterRouteKind =
  | 'situation'
  | 'level'
  | 'create'
  | 'hold'
  | 'loading'
  | 'reveal'
  | 'staging'
  | 'failure-concept'
  | 'failure-integration'
  | 'play'

export interface CharacterRouteSignals {
  /** `campaigns.status`. */
  readonly campaignStatus: CampaignSummary['status']
  /** `CampaignSummary.creator === null` ⟹ owner. */
  readonly isOwner: boolean
  /** `starting_situation_index` is set. */
  readonly situationChosen: boolean
  /** `starting_level` is set. */
  readonly levelSet: boolean
  /** The viewer's own concept status — `'none'` when they have no row yet. */
  readonly conceptStatus: string
  /** The viewer's own `confirmed_at` is set ("This is me"). */
  readonly confirmed: boolean
}

/** Map the three viewer-relative signals to a screen, per the §3.3 table. Terminal
 *  gates (campaign failed → integration-failure; active/integrated → play) win over
 *  the setup branches; within `setup` the owner's situation→level beats gate the
 *  per-concept states. A `submitted` (freshly resubmittable) row buckets with `none`
 *  → create; every unknown status falls to create too (safe default). */
export function deriveCharacterRoute(s: CharacterRouteSignals): CharacterRouteKind {
  if (s.campaignStatus === 'failed') return 'failure-integration'
  if (s.campaignStatus === 'active' || s.conceptStatus === 'integrated') return 'play'
  // campaign 'setup' (or 'archived' — a fallback that never enters creation).
  if (!s.situationChosen) return s.isOwner ? 'situation' : 'hold'
  if (!s.levelSet) return s.isOwner ? 'level' : 'hold'
  switch (s.conceptStatus) {
    case 'processing':
      return 'loading'
    case 'failed':
      return 'failure-concept'
    case 'completed':
      return s.confirmed ? 'staging' : 'reveal'
    case 'none':
    case 'submitted':
    default:
      return 'create'
  }
}

// -----------------------------------------------------------------------------
// The viewer-signal fetch.
// -----------------------------------------------------------------------------

interface ViewerSignals {
  readonly situationChosen: boolean
  readonly levelSet: boolean
  readonly conceptStatus: string
  readonly confirmed: boolean
  readonly charId: string | null
  readonly viewerUserId: string
}

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly signals: ViewerSignals }

/** Fetch the viewer id + the owner's situation/level progress + the caller's own
 *  concept row, folded into the routing signals. A `reloadKey` bump refetches (the
 *  transition backstop — loading→reveal, confirm→staging, retry). Any failure of
 *  the three settles to `error` (a calm retry); a late resolve after unmount is a
 *  no-op. */
function useViewerSignals(
  campaignId: string,
  ctx: ApiContext,
  reloadKey: number,
  fetchMe: FetchMe,
  fetchSituations: FetchSituations,
  fetchProgress: FetchProgress,
): LoadState {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  useEffect(() => {
    let active = true
    setState({ status: 'loading' })
    void Promise.all([
      fetchMe(ctx),
      fetchSituations(ctx, campaignId),
      fetchProgress(ctx, campaignId),
    ])
      .then(([me, situations, progress]) => {
        if (!active) return
        const viewerUserId = me.user.id
        const mine = progress.concepts.find((c) => c.userId === viewerUserId) ?? null
        setState({
          status: 'ready',
          signals: {
            situationChosen: situations.chosenIndex !== null,
            levelSet: situations.startingLevel !== null,
            conceptStatus: mine?.status ?? 'none',
            confirmed: mine?.confirmedAt != null,
            charId: mine?.characterId ?? null,
            viewerUserId,
          },
        })
      })
      .catch(() => {
        if (active) setState({ status: 'error' })
      })
    return () => {
      active = false
    }
  }, [campaignId, ctx, reloadKey, fetchMe, fetchSituations, fetchProgress])
  return state
}

// -----------------------------------------------------------------------------
// Inline presentational states (member hold / failure / play entry). All copy is
// resolved to `[ph:]` i18n strings by the parent so the t() keys stay static.
// -----------------------------------------------------------------------------

const HOLD_TESTID = 'character-hold'
const FAILURE_TESTID = 'character-failure'
const FAILURE_RETRY_TESTID = 'character-failure-retry'
const PLAY_TESTID = 'character-play'
const PLAY_ENTER_TESTID = 'character-play-enter'
const SURFACE_LOADING_TESTID = 'character-surface-loading'
const SURFACE_ERROR_TESTID = 'character-surface-error'

/** The member "setting up the table" hold — situation/level are the owner's to set. */
function HoldView({ title, body }: { title: string; body: string }): React.JSX.Element {
  return (
    <Stack gap={2} data-testid={HOLD_TESTID}>
      <Heading level={1} role="title">
        {title}
      </Heading>
      <Text role="ui-caption" as="p">
        {body}
      </Text>
    </Stack>
  )
}

/** The character-context failure — a calm, retryable resume (NOT the world-gen
 *  terminal). Used for both a `failed` concept (retry = reset → create) and a
 *  `failed` campaign / terminal integration failure (retry = re-attempt fan-in). */
function FailureView({
  title,
  body,
  retryLabel,
  onRetry,
}: {
  title: string
  body: string
  retryLabel: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <Stack gap={3} data-testid={FAILURE_TESTID}>
      <Heading level={1} role="title">
        {title}
      </Heading>
      <Text as="p">{body}</Text>
      <Stack direction="row">
        <Button onPress={onRetry} data-testid={FAILURE_RETRY_TESTID}>
          {retryLabel}
        </Button>
      </Stack>
    </Stack>
  )
}

/** The play entry — an integrated/active campaign leads into the game. */
function PlayEntry({
  title,
  body,
  enterLabel,
  onEnter,
}: {
  title: string
  body: string
  enterLabel: string
  onEnter: () => void
}): React.JSX.Element {
  return (
    <Stack gap={3} data-testid={PLAY_TESTID}>
      <Heading level={1} role="title">
        {title}
      </Heading>
      <Text as="p">{body}</Text>
      <Stack direction="row">
        <Button onPress={onEnter} data-testid={PLAY_ENTER_TESTID}>
          {enterLabel}
        </Button>
      </Stack>
    </Stack>
  )
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
  readonly onReload: () => void
  readonly onConceptRetry: () => void
  readonly onIntegrationRetry: () => void
}

function CharacterBeat({
  kind,
  campaignId,
  signals: s,
  deps,
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

  // Forward the child-surface seams only when injected (tests/stories) — under
  // `exactOptionalPropertyTypes` an explicit `undefined` isn't assignable to the
  // committed surfaces' optional props, so spread each key conditionally.
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
          enterLabel={t('campaign.character.play.enter')}
          onEnter={() => {
            void navigate(playPath)
          }}
        />
      )
  }
}

// -----------------------------------------------------------------------------
// The surface — fetches the viewer signals, decides the kind, owns the retry
// state, and delegates the screen to <CharacterBeat>.
// -----------------------------------------------------------------------------

export function CharacterSurface({
  campaign,
  campaignId,
  deps,
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
  const kind = deriveCharacterRoute({
    campaignStatus: campaign.status,
    isOwner: campaign.creator === null,
    situationChosen: s.situationChosen,
    levelSet: s.levelSet,
    conceptStatus: s.conceptStatus,
    confirmed: s.confirmed,
  })

  // Redirect kinds navigate away — render the beat bare (no surface chrome).
  if (kind === 'situation' || kind === 'level' || kind === 'create') {
    return <CharacterBeat kind={kind} campaignId={campaignId} signals={s} deps={deps} onReload={reload} onConceptRetry={onConceptRetry} onIntegrationRetry={onIntegrationRetry} />
  }

  const isFailure = kind === 'failure-concept' || kind === 'failure-integration'
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
      />
      {isFailure && retryFailed && (
        <Text role="ui-caption" as="p" data-testid="character-failure-retry-error">
          {t('campaign.character.failure.retryError')}
        </Text>
      )}
    </Stack>
  )
}
