import { useEffect, useMemo, useRef, useState } from 'react'
import { CharacterLoadingBeat, Heading, Stack, Text } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  getStageTimings,
  useApiContext,
  waitDisplay,
  type ApiContext,
  type StageTiming,
} from '@mythrun/client-core'
import {
  remainingCreationWaitMs,
  useCharacterCreationStream,
  useCreationProgressPoll,
  type CharacterCreationStreamDeps,
} from '@mythrun/client-core/character'
import { usePrefersReducedMotion } from '../../platform/web/use-prefers-reduced-motion.ts'
import { coarseWaitTime } from '../wait-format.ts'

// The CHARACTER-LOADING SURFACE (MYT-90 D5 + the MYT-102 waiting upgrade) — the
// "coming into being" screen the D8 routing table mounts while the viewer's
// character concept is `processing`. It composes the DS <CharacterLoadingBeat>
// (the 1-bit figure filling in beside the surfacing beat rows) over the
// client-core useCharacterCreationStream (the per-user SSE fold — snapshot-
// seeded, so a mid-creation refresh shows the truth at once), under a screen
// headline that matches the other create beats.
//
// The SWAP: the instant the viewer's completion arrives (`done` — the live
// event OR the hook's reload-stable progress probe) it calls `onDone` EXACTLY
// ONCE — D8 re-evaluates routing and lands the player on the reveal. A latch
// ref keeps it one-shot even if the surface re-renders while `done` holds.
//
// The WAIT (MYT-102 timer revamp): one `getStageTimings` fetch (the un-filtered
// historical aggregate — it already carries the character stages) + a real
// 1-second tick turn the hook's folded viewer `stages` into the adaptive
// remaining-ms estimate (`remainingCreationWaitMs`, re-derived each tick from
// live stage completions). The shared `waitDisplay` brain then decides what the
// beat shows: a COARSE estimate ("2 min remaining", minute-granular — never a
// ticking `0:24`) while usable; the AUTHORED "still working" line the INSTANT
// the estimate exhausts (the running stage overran) or the wait wedges — so the
// beat NEVER sits at a dead 0:00 — and nothing at all on cold-start (no fake
// numbers). No retry affordance here (resume is Track A's surface; the stalled
// line composes above whatever lands there).

/** The wall-clock stall backstop: a wedged pending stage keeps the estimate
 *  positive forever, so stall once elapsed reaches 3× the FIRST usable estimate.
 *  With NO history to estimate from, stall after this flat window instead —
 *  clearly beyond a healthy ~1-minute creation, so the reassurance never fires
 *  on a normal run. */
const STALL_ETA_MULTIPLIER = 3
const NO_HISTORY_STALL_MS = 2 * 60_000

/** The 1-second tick behind the countdown + stall clock (the generating.tsx
 *  idiom): the current epoch ms, refreshed by a REAL 1s interval while
 *  `active`. Each tick re-derives the remaining wait from scratch, so a stage
 *  event landing between ticks recalibrates on the next render. NOT gated on
 *  reduced motion — the ticking number is CONTENT (the remaining wait), not
 *  decoration; freezing it would show a wrong number. */
function useNowMs(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNowMs(Date.now())
    // Bare timer globals (not window.*) — universal across web + native (R1).
    const id = setInterval(() => {
      setNowMs(Date.now())
    }, 1000)
    return () => {
      clearInterval(id)
    }
  }, [active])
  return nowMs
}

/** Resolve one beat's display copy from its stable id (the client-core stream
 *  emits IDs only — the copy lives here, in the screen). A `switch` keeps each
 *  `t()` key a literal the typed catalog can check, without a cast; an unknown id
 *  falls back to empty (defensive — the fixed beat set is exhaustive). */
function beatLabel(id: string, t: TFunction): string {
  switch (id) {
    case 'name':
      return t('characterCreate.loading.beat.name')
    case 'class':
      return t('characterCreate.loading.beat.class')
    case 'scores':
      return t('characterCreate.loading.beat.scores')
    case 'kit':
      return t('characterCreate.loading.beat.kit')
    default:
      return ''
  }
}

export interface CharacterLoadingSurfaceProps {
  /** The campaign whose status stream carries the per-player creation events. */
  campaignId: string
  /** The viewer whose stage progress this surface folds + waits on. */
  userId: string
  /** Called once when the viewer's creation completes — D8 re-routes to the reveal. */
  onDone: () => void
  /** Injected stream transport + progress probe — defaults to the real ones;
   *  tests + stories substitute hand-driven ones (forwarded to
   *  useCharacterCreationStream). */
  deps?: CharacterCreationStreamDeps
  /** The stage-timings history source (the countdown's input) — defaults to the
   *  real endpoint; tests + stories substitute it. A failed fetch degrades to no
   *  countdown, never an error surface. */
  fetchTimings?: (ctx: ApiContext) => Promise<readonly StageTiming[]>
}

export function CharacterLoadingSurface({
  campaignId,
  userId,
  onDone,
  deps,
  fetchTimings = getStageTimings,
}: CharacterLoadingSurfaceProps): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  const { beats, done, stages } = useCharacterCreationStream(campaignId, userId, deps)
  // The stream emits stable beat IDs; resolve each to its display copy here (the
  // client-core layer owns no copy). The DS beat renders these labels + the eyebrow.
  const labeledBeats = useMemo(() => beats.map((b) => ({ ...b, label: beatLabel(b.id, t) })), [beats, t])
  // myth-qkjdq: the RELIABLE, SSE-independent advance. The SSE-driven stream above
  // animates the beats, but its `done` depends on a live event / snapshot recheck
  // that a CloudFront-buffered SSE may never deliver. This durable poll flips on
  // the viewer's own terminal concept status regardless — and surfaces `failed`,
  // which the stream hook never did — so the screen advances (to the reveal on
  // success, to the concept-failure surface on failure) even with a dead stream.
  // It reuses the injected progress fetch so a test that stubs one stubs both.
  const poll = useCreationProgressPoll(
    campaignId,
    userId,
    deps?.fetchProgress !== undefined ? { fetchProgress: deps.fetchProgress } : {},
  )
  const reducedMotion = usePrefersReducedMotion()

  // The viewer's creation has reached a TERMINAL state — completed OR failed —
  // from EITHER path (the live stream or the durable poll). `onDone` is the
  // "re-evaluate routing" signal: D8 re-reads the concept row and lands the
  // player on the reveal (completed) or the concept-failure surface (failed).
  const resolved = done || poll.done || poll.failed

  // Fire the swap exactly once: each terminal signal latches true and never goes
  // back, so a ref guard collapses any repeat renders-while-resolved to one call.
  const swappedRef = useRef(false)
  useEffect(() => {
    if (resolved && !swappedRef.current) {
      swappedRef.current = true
      onDone()
    }
  }, [resolved, onDone])

  // The one-time timings fetch. `null` until it resolves (or forever, on a
  // failed fetch / cold-start) → no countdown, and the stall clock falls back
  // to the no-history threshold.
  const [timings, setTimings] = useState<readonly StageTiming[] | null>(null)
  useEffect(() => {
    let active = true
    fetchTimings(ctx)
      .then((rows) => {
        if (active) setTimings(rows)
      })
      .catch(() => {
        // Calm: the beat simply shows no countdown.
      })
    return () => {
      active = false
    }
  }, [ctx, fetchTimings])

  // The tick runs for the whole wait (it also drives the stall clock, which
  // needs no history) and stops once resolved — the surface swaps away right after.
  const nowMs = useNowMs(!resolved)
  const remainingMs = useMemo(
    () => remainingCreationWaitMs(timings, stages, nowMs),
    [timings, stages, nowMs],
  )

  // Capture the FIRST usable estimate (the expected whole wait as this screen
  // first saw it — later recalibrations must not let the wall-clock backstop
  // creep) + the mount time; both feed the shared stall decision.
  const mountedAtRef = useRef(Date.now())
  const initialEtaRef = useRef<number | null>(null)
  useEffect(() => {
    if (initialEtaRef.current === null && remainingMs !== null) initialEtaRef.current = remainingMs
  }, [remainingMs])

  // The shared waiting-display decision (MYT-102): a coarse estimate while
  // usable, the "still working" line the instant it exhausts (never a dead
  // 0:00), nothing on cold-start. `resolved` short-circuits to 'hidden' — the
  // surface swaps away the same tick, so neither line should flash.
  const display = useMemo(
    () =>
      resolved
        ? ({ kind: 'hidden' } as const)
        : waitDisplay({
            remainingMs,
            elapsedMs: nowMs - mountedAtRef.current,
            noHistoryStallMs: NO_HISTORY_STALL_MS,
            initialEstimateMs: initialEtaRef.current,
            stallMultiplier: STALL_ETA_MULTIPLIER,
          }),
    [resolved, remainingMs, nowMs],
  )
  const countdownLabel =
    display.kind === 'estimate'
      ? t('characterCreate.loading.countdown', { time: coarseWaitTime(display.bucket, t) })
      : undefined
  const stalledLabel = display.kind === 'stalled' ? t('characterCreate.loading.stalled') : undefined

  return (
    <Stack gap={5} data-testid="character-loading">
      <Heading level={1} role="title">
        {t('characterCreate.loading.title')}
      </Heading>
      <CharacterLoadingBeat
        beats={labeledBeats}
        heading={t('characterCreate.loading.heading')}
        reducedMotion={reducedMotion}
        // At most one of the two wait lines (exactOptionalPropertyTypes; the
        // honesty contract — no usable estimate means neither line, never an
        // empty or a dead one). The beat renders the stalled line in place of
        // the countdown.
        {...(countdownLabel !== undefined ? { countdownLabel } : {})}
        {...(stalledLabel !== undefined ? { stalledLabel } : {})}
      />
      {/* One line of setup for the invite affordance the surface shell renders
          directly below (ux-run2 myth-3bl24) — bare, that link reads as
          utility-nav that wandered in from a footer; this makes it an
          invitation. Quiet body prose, not chrome. */}
      <Text role="subtitle" as="p" data-testid="character-loading-table-room">
        {t('characterCreate.loading.tableRoom')}
      </Text>
    </Stack>
  )
}
