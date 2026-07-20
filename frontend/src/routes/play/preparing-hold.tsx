import { useEffect, useState } from 'react'
import { useSessionPrep, type ApiContext, type SessionPrepStream } from '@mythrun/client-core'
import { SessionPreparing } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { CenteredHold, PrepFailedNotice } from './notices.tsx'

// The between-sessions preparing hold (MYT-92 T16; storm fix myth-ep74g). The
// start flow's `waiting` arm lands here — a prior session ended and the next one
// isn't startable yet (prep_not_ready / reconcile_pending / session_ending). It
// renders a calm <SessionPreparing> beat while the start-flow HOOK backoff-polls
// `/start` in the background.
//
// WHAT CHANGED (myth-ep74g): the old prep beat re-attempted `start()` the instant
// its SSE reported `ready` — a stale/flapping `ready` (a prior prep row still marked
// ready during the between-sessions window) re-fired `start()` with zero backoff, a
// tight loop that hit the `/start` 10/min rate limit and 429'd the player. That
// SSE-driven re-`start()` is GONE. The hook owns the poll cadence now; this hold no
// longer drives retry at all — when prep completes, the next backoff poll returns
// 200 and the hook transitions to `ready` on its own.
//
// The prep-status SSE (`useSessionPrep`) is kept for ONE job: latching a TERMINAL
// prep FAILURE into the calm dead-end (a fast, definitive "this didn't come
// together" instead of polling forever behind the atmospheric beat). During
// reconcile_pending / session_ending the prep bit is `ready` (prep isn't the
// blocker), so the latch never false-fires there. The parent unmounts this hold on
// the start-flow transition, so the latch lives exactly as long as the wait.

/** The `useSessionPrep` seam — injected for tests; defaults to the real hook. */
type UsePrep = (ctx: ApiContext, campaignId: string) => SessionPrepStream

export interface PreparingHoldProps {
  readonly ctx: ApiContext
  readonly campaignId: string
  readonly reducedMotion: boolean
  /** Re-attempt start (= the flow's `retry`) — used ONLY by the prep-failed dead-end's
   *  retry affordance. The atmospheric wait itself never calls this (the hook polls). */
  readonly onRetry: () => void
  /** Injected prep hook (tests); defaults to `useSessionPrep`. */
  readonly usePrep?: UsePrep
}

export function PreparingHold({
  ctx,
  campaignId,
  reducedMotion,
  onRetry,
  usePrep = useSessionPrep,
}: PreparingHoldProps): React.JSX.Element {
  const { t } = useTranslation()
  const prep = usePrep(ctx, campaignId)

  // Latch a TERMINAL prep failure → the calm dead-end. Once seen it never reverts to
  // the beat (a post-failure reconnect re-snapshots `generating`, which must NOT
  // re-arm the wait).
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (prep.status === 'failed') setFailed(true)
  }, [prep.status])

  if (failed) return <PrepFailedNotice onRetry={onRetry} />

  return (
    <CenteredHold data-testid="play-preparing">
      <SessionPreparing
        label={t('play.preparing.label')}
        detail={t('play.preparing.detail')}
        reducedMotion={reducedMotion}
      />
    </CenteredHold>
  )
}
