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
  input: { campaignId: string; viewerIsOwner: boolean },
) => StartFlow
type UsePrep = (ctx: ApiContext, campaignId: string) => SessionPrepStream
type UseLiveSession = (ctx: ApiContext, params: SessionParams) => SessionView

export interface PlaySessionProps {
  readonly ctx: ApiContext
  readonly campaignId: string
  readonly viewer: PlayViewer
  readonly reducedMotion: boolean
  readonly useStart?: UseStart
  readonly usePrep?: UsePrep
  readonly useLiveSession?: UseLiveSession
}

export function PlaySession({
  ctx,
  campaignId,
  viewer,
  reducedMotion,
  useStart = useSessionStart,
  usePrep,
  useLiveSession,
}: PlaySessionProps): React.JSX.Element {
  const { t } = useTranslation()
  const flow = useStart(ctx, { campaignId, viewerIsOwner: viewer.isOwner })
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
    startError: { body: t('play.startError.body'), retry: t('play.startError.retry') },
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
  readonly startError: { body: string; retry: string }
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
      return retryHold('play-blocked', args.blocked, args.retry)
    case 'error':
      return retryHold('play-error', args.startError, args.retry)
  }
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
