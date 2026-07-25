import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getStageTimings,
  remainingSessionPrepWaitMs,
  useSessionPrep,
  waitDisplay,
  type ApiContext,
  type SessionPrepStream,
  type StageTiming,
} from '@mythrun/client-core'
import { SessionPreparing } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { CenteredHold, PrepFailedNotice } from './notices.tsx'
import { coarseWaitTime } from '../wait-format.ts'

// The between-sessions preparing hold (MYT-92 T16; storm fix myth-ep74g; MYT-102
// timer revamp). The start flow's `waiting` arm lands here — a prior session ended
// and the next one isn't startable yet (prep_not_ready / reconcile_pending /
// session_ending). It renders a calm <SessionPreparing> beat while the start-flow
// HOOK backoff-polls `/start` in the background.
//
// MYT-102 — "how long / has it broken?" Session prep is a SINGLE pipeline stage
// with no per-stage client signals (useSessionPrep only carries a coarse
// generating→ready/failed lifecycle), so the beat can't fill a determinate meter.
// The honest fallback (research "path b"): a coarse estimate from the HISTORICAL
// prep-duration baseline (a one-time getStageTimings fetch → `remainingSession
// PrepWaitMs`) fed to the SAME shared `waitDisplay` brain the other waiting
// surfaces use — a coarse "{{time}} remaining" while the baseline holds, and the
// "still working…" line the instant it exhausts, so the wait never looks hung and
// never sits at a dead 0:00. No history → no number, and after a flat window the
// stalled line still answers "has it broken?". The figure itself is reshaped in
// the DS component (an ambient square, not the old bar-shaped band).
//
// WHAT CHANGED (myth-ep74g): the old prep beat re-attempted `start()` on its SSE
// `ready` — a stale/flapping ready re-fired `start()` with zero backoff and 429'd
// the player. That SSE-driven re-`start()` is GONE; the hook owns the poll cadence.
// The prep-status SSE (`useSessionPrep`) is kept for ONE job: latching a TERMINAL
// prep FAILURE into the calm dead-end. The parent unmounts this hold on the
// start-flow transition, so the wait clock lives exactly as long as the wait.

/** The `useSessionPrep` seam — injected for tests; defaults to the real hook. */
type UsePrep = (ctx: ApiContext, campaignId: string) => SessionPrepStream

/** With no prep-duration baseline to estimate from, the wait reads as stalled
 *  after this flat window — clearly beyond a healthy Opus prep, so the "taking
 *  longer than usual" reassurance never fires on a normal run. (With a baseline,
 *  the stall fires at 1× it — exhaustion — instead, per `waitDisplay`.) */
const NO_HISTORY_STALL_MS = 3 * 60_000

/** The 1-second tick behind the coarse estimate + stall clock (the generating.tsx
 *  idiom): the current epoch ms, refreshed by a real 1s interval while `active`.
 *  NOT gated on reduced motion — the number is content (the remaining wait), not
 *  decoration. */
function useNowMs(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNowMs(Date.now())
    const id = setInterval(() => {
      setNowMs(Date.now())
    }, 1000)
    return () => {
      clearInterval(id)
    }
  }, [active])
  return nowMs
}

export interface PreparingHoldProps {
  readonly ctx: ApiContext
  readonly campaignId: string
  readonly reducedMotion: boolean
  /** Re-attempt start (= the flow's `retry`) — used ONLY by the prep-failed dead-end's
   *  retry affordance. The atmospheric wait itself never calls this (the hook polls). */
  readonly onRetry: () => void
  /** The resolved atmospheric line. The caller picks it from the triggering wait code
   *  (the integration window reads differently from the between-sessions prep wait);
   *  omitted ⇒ the between-sessions default. */
  readonly label?: string
  /** Injected prep hook (tests); defaults to `useSessionPrep`. */
  readonly usePrep?: UsePrep
  /** The stage-timings history source (the estimate's input) — defaults to the real
   *  endpoint; tests + stories substitute it. A failed fetch degrades to no estimate
   *  (the calm detail line), never an error surface. */
  readonly fetchTimings?: (ctx: ApiContext) => Promise<readonly StageTiming[]>
}

export function PreparingHold({
  ctx,
  campaignId,
  reducedMotion,
  onRetry,
  label,
  usePrep = useSessionPrep,
  fetchTimings = getStageTimings,
}: PreparingHoldProps): React.JSX.Element {
  const { t } = useTranslation()
  const prep = usePrep(ctx, campaignId)

  // The rotating whispers (ux-run2 myth-i2pdo) — six public-tier table-setting
  // lines, cycled by the DS beat every ~25s with past lines settling into the
  // faint ledger. Literal keys for the typed catalog.
  const whisperLabels = useMemo<readonly string[]>(
    () => [
      t('play.preparing.flavor1'),
      t('play.preparing.flavor2'),
      t('play.preparing.flavor3'),
      t('play.preparing.flavor4'),
      t('play.preparing.flavor5'),
      t('play.preparing.flavor6'),
    ],
    [t],
  )

  // Latch a TERMINAL prep failure → the calm dead-end. Once seen it never reverts to
  // the beat (a post-failure reconnect re-snapshots `generating`, which must NOT
  // re-arm the wait).
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (prep.status === 'failed') setFailed(true)
  }, [prep.status])

  // The one-time prep-duration baseline fetch. `null` until it resolves (or forever,
  // on a failed fetch / cold-start) → no estimate; the beat shows the detail line
  // until the no-history window elapses, then the stalled line.
  const [timings, setTimings] = useState<readonly StageTiming[] | null>(null)
  useEffect(() => {
    let active = true
    fetchTimings(ctx)
      .then((rows) => {
        if (active) setTimings(rows)
      })
      .catch(() => {
        // Calm: the beat simply shows no estimate.
      })
    return () => {
      active = false
    }
  }, [ctx, fetchTimings])

  // The wait clock: mount is the surface's best origin for "prep began" (no
  // prep-started timestamp reaches the client; the estimate errs long — safe).
  const mountedAtRef = useRef(Date.now())
  const nowMs = useNowMs(!failed)
  const remainingMs = useMemo(
    () => remainingSessionPrepWaitMs(timings, mountedAtRef.current, nowMs),
    [timings, nowMs],
  )
  const display = useMemo(
    () =>
      failed
        ? ({ kind: 'hidden' } as const)
        : waitDisplay({
            remainingMs,
            elapsedMs: nowMs - mountedAtRef.current,
            noHistoryStallMs: NO_HISTORY_STALL_MS,
          }),
    [failed, remainingMs, nowMs],
  )
  const countdownLabel =
    display.kind === 'estimate'
      ? t('play.preparing.countdown', { time: coarseWaitTime(display.bucket, t) })
      : undefined
  const stalledLabel = display.kind === 'stalled' ? t('shared.wait.stalled') : undefined

  if (failed) return <PrepFailedNotice onRetry={onRetry} />

  return (
    <CenteredHold data-testid="play-preparing">
      <SessionPreparing
        label={label ?? t('play.preparing.label')}
        detail={t('play.preparing.detail')}
        // The rotating table-setting whispers + their ledger (ux-run2
        // myth-i2pdo) — PUBLIC-TIER flavor only; prep content never reaches
        // this surface (enforced ignorance).
        whisperLabels={whisperLabels}
        // Permission to leave — the start-flow hook re-polls on return, so
        // stepping away costs nothing.
        leaveLabel={t('play.preparing.safeToLeave')}
        reducedMotion={reducedMotion}
        // At most one wait line (exactOptionalPropertyTypes; the beat renders the
        // estimate, else the stalled line, else the calm detail fallback).
        {...(countdownLabel !== undefined ? { countdownLabel } : {})}
        {...(stalledLabel !== undefined ? { stalledLabel } : {})}
      />
    </CenteredHold>
  )
}
