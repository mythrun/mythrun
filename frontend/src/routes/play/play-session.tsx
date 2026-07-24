import { useEffect, useRef } from 'react'
import {
  useSessionStart,
  type ApiContext,
  type SessionPrepStream,
  type SessionView,
  type StartFlow,
  type SessionParams,
} from '@mythrun/client-core'
import { SessionStartBeat } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { PlayViewer } from './play-viewer.ts'
import { PreparingHold } from './preparing-hold.tsx'
import { SessionShell } from './session-shell.tsx'
import { PurchaseSeam } from './purchase-seam.tsx'
import { CenteredHold, RetryNotice } from './notices.tsx'

// The in-session character-name fallback: MYT-94 owns the live sheet read, so 92
// passes an empty name (an expression, not a literal attribute — the character name
// is DATA, never an i18n key). The optimistic own-message still labels by displayName.
const NO_CHARACTER_NAME = ''

// The started-session driver (MYT-92 T16; storm fix myth-ep74g). Mounted once the
// viewer identity has resolved (so `viewerIsOwner` is known), it owns the start flow:
// on mount it calls `start()`, then renders by `state.phase`:
//   starting / idle  → the connecting beat (the short pre-session boundary)
//   waiting          → <PreparingHold> (the calm between-sessions beat; the HOOK
//                      backoff-polls /start — no SSE-driven re-start storm)
//   ready            → <SessionShell> (the live transcript)
//   purchase         → <PurchaseSeam> (the MYT-95 seam; owner buy / member hold)
//   blocked / error  → a calm retry notice (retry = start again)
//
// The injected hooks (usePrep / useLiveSession) thread through to the child that owns
// each — the play route stays a thin composition, and tests substitute the whole
// hooks to drive any phase deterministically.

type UseStart = (
  ctx: ApiContext,
  input: { campaignId: string; viewerIsOwner: boolean; viewerUserId: string },
) => StartFlow
type UsePrep = (ctx: ApiContext, campaignId: string) => SessionPrepStream
type UseLiveSession = (ctx: ApiContext, params: SessionParams) => SessionView

export interface PlaySessionProps {
  readonly ctx: ApiContext
  readonly campaignId: string
  readonly viewer: PlayViewer
  readonly reducedMotion: boolean
  /** Route back to the campaign setup page (`/campaigns/:id`). Used ONLY by the
   *  `campaign_failed` terminal arm — a failed integration is retried from the
   *  campaign page's failure surface, not by re-POSTing `/start` in place. The route
   *  wires the real navigate; omitted in tests (the arm falls back to `retry`). */
  readonly onExitToCampaign?: () => void
  readonly useStart?: UseStart
  readonly usePrep?: UsePrep
  readonly useLiveSession?: UseLiveSession
}

export function PlaySession({
  ctx,
  campaignId,
  viewer,
  reducedMotion,
  onExitToCampaign,
  useStart = useSessionStart,
  usePrep,
  useLiveSession,
}: PlaySessionProps): React.JSX.Element {
  const { t } = useTranslation()
  const flow = useStart(ctx, { campaignId, viewerIsOwner: viewer.isOwner, viewerUserId: viewer.userId })
  const { start, retry } = flow

  // Kick off the start attempt once on mount (the phase switch drives everything after).
  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    start()
  }, [start])

  return renderPhase(flow, {
    ctx,
    campaignId,
    viewer,
    reducedMotion,
    retry,
    connectingLabels: {
      heading: t('play.start.heading'),
      prep: t('play.start.prep'),
      connecting: t('play.start.connecting'),
    },
    blocked: {
      body:
        flow.state.phase === 'blocked' && flow.state.memberNames !== undefined
          ? t('play.blocked.membersBody', { names: flow.state.memberNames.join(', ') })
          : t('play.blocked.body'),
      retry: t('play.blocked.retry'),
    },
    // The reason-aware wait line: `campaign_not_active` is the whole party being woven
    // into the world; `members_without_characters` (viewer only) is the viewer's OWN
    // character settling in; the rest (prep/reconcile/ending) is the DM preparing the
    // session. Same calm beat, apter words.
    preparing: {
      label: t('play.preparing.label'),
      integratingLabel: t('play.preparing.integratingLabel'),
      settlingLabel: t('play.preparing.settlingLabel'),
    },
    // The `campaign_failed` terminal arm reuses the campaign page's authored
    // integration-failure copy (one voice for "the party didn't make it in"); its
    // action returns to setup, where the retry lives.
    integrationFailed: {
      title: t('campaign.character.failure.integration.title'),
      body: t('campaign.character.failure.integration.body'),
      action: t('play.blocked.integrationFailedAction'),
    },
    startError: { body: t('play.startError.body'), retry: t('play.startError.retry') },
    ...(onExitToCampaign !== undefined && { onExitToCampaign }),
    ...(usePrep !== undefined && { usePrep }),
    ...(useLiveSession !== undefined && { useLiveSession }),
  })
}

interface RenderArgs {
  readonly ctx: ApiContext
  readonly campaignId: string
  readonly viewer: PlayViewer
  readonly reducedMotion: boolean
  readonly retry: () => void
  readonly connectingLabels: { heading: string; prep: string; connecting: string }
  readonly blocked: { body: string; retry: string }
  readonly preparing: { label: string; integratingLabel: string; settlingLabel: string }
  readonly integrationFailed: { title: string; body: string; action: string }
  readonly startError: { body: string; retry: string }
  readonly onExitToCampaign?: () => void
  readonly usePrep?: UsePrep
  readonly useLiveSession?: UseLiveSession
}

/** Map the start-flow phase to its screen. Split out of the component so the switch
 *  stays a pure render dispatch (the hooks + the start effect live in PlaySession). */
function renderPhase(flow: StartFlow, args: RenderArgs): React.JSX.Element {
  const { state } = flow
  switch (state.phase) {
    case 'idle':
    case 'starting':
      return <ConnectingBeat reducedMotion={args.reducedMotion} labels={args.connectingLabels} />
    case 'waiting':
      return (
        <PreparingHold
          ctx={args.ctx}
          campaignId={args.campaignId}
          reducedMotion={args.reducedMotion}
          onRetry={args.retry}
          label={preparingLabelFor(state.code, args.preparing, args.viewer.party.size <= 1)}
          {...(args.usePrep !== undefined && { usePrep: args.usePrep })}
        />
      )
    case 'ready':
      return (
        <SessionShell
          ctx={args.ctx}
          campaignId={args.campaignId}
          sessionId={state.sessionId}
          viewerUserId={args.viewer.userId}
          displayName={args.viewer.displayName}
          characterName={NO_CHARACTER_NAME}
          party={args.viewer.party}
          reducedMotion={args.reducedMotion}
          {...(args.useLiveSession !== undefined && { useLiveSession: args.useLiveSession })}
        />
      )
    case 'purchase':
      return <PurchaseSeam moment={state.moment} />
    case 'blocked':
      // A terminal integration failure routes back to setup (the failure surface
      // owns the retry) rather than re-POSTing /start in place, which would just
      // re-answer campaign_failed. Falls back to `retry` when no navigate is wired
      // (tests). Every other blocked code keeps the calm in-place retry notice —
      // members_without_characters keeps its named body (args.blocked.body).
      if (state.code === 'campaign_failed') {
        return (
          <RetryNotice
            data-testid="play-integration-failed"
            title={args.integrationFailed.title}
            body={args.integrationFailed.body}
            retryLabel={args.integrationFailed.action}
            onRetry={args.onExitToCampaign ?? args.retry}
          />
        )
      }
      return retryHold('play-blocked', args.blocked, args.retry)
    case 'error':
      return retryHold('play-error', args.startError, args.retry)
  }
}

/** Pick the wait line for the triggering code: the world being woven together
 *  (`campaign_not_active`, the setup→active integration window), the viewer's OWN
 *  character settling in (`members_without_characters` — the classifier only routes
 *  the viewer-only case to `waiting`), or the DM preparing the session
 *  (prep/reconcile/ending). `campaign_not_active` reads by party size: a SOLO owner
 *  (the common first-play case) is just their own character being woven in, so it
 *  borrows the settling line rather than claiming a "party" they don't have. */
function preparingLabelFor(
  code: string,
  labels: { label: string; integratingLabel: string; settlingLabel: string },
  isSolo: boolean,
): string {
  if (code === 'campaign_not_active') return isSolo ? labels.settlingLabel : labels.integratingLabel
  if (code === 'members_without_characters') return labels.settlingLabel
  return labels.label
}

/** The idle/starting connecting beat — the short pre-session boundary. */
function ConnectingBeat({
  reducedMotion,
  labels,
}: {
  reducedMotion: boolean
  labels: { heading: string; prep: string; connecting: string }
}): React.JSX.Element {
  return (
    <CenteredHold data-testid="play-connecting">
      <SessionStartBeat
        phase="connecting"
        reducedMotion={reducedMotion}
        heading={labels.heading}
        prepLabel={labels.prep}
        connectingLabel={labels.connecting}
      />
    </CenteredHold>
  )
}

/** The shared blocked/error calm retry notice. */
function retryHold(
  testId: string,
  copy: { body: string; retry: string },
  onRetry: () => void,
): React.JSX.Element {
  return (
    <RetryNotice data-testid={testId} body={copy.body} retryLabel={copy.retry} onRetry={onRetry} />
  )
}
