import { forwardRef } from 'react'
import type { WorldGenLoadingProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { useReducedMotionPref, useWhisperCycle } from '../../lib/use-whisper-cycle.ts'
import { BeatFigure } from '../BeatFigure/BeatFigure.tsx'
import { Button } from '../Button/Button.tsx'
import { WhisperLedger } from '../WhisperLedger/WhisperLedger.tsx'

// WorldGenLoading (MYT-89 two-act generating flow, act ONE; ux-run2 myth-i2pdo
// + myth-xe38q) — the calm pre-graph loading screen. While the world generates
// there is nothing the player must do — so this surface holds the beat: the
// ACCRETING DITHER MARK over a whisper line that cycles playful flavor copy,
// the past whispers settling beneath it as a faint ledger, a coarse overall
// countdown, and one quiet line of permission to leave.
//
// THE MARK (myth-i2pdo — provable liveness): a ~96px 1-bit dither square (the
// praised session-prep wait-square idiom) whose quantized fill is driven by
// `accretion` — REAL pipeline events (completed stages + arrived entities), so
// structural resolution means work happened and stillness means stillness; a
// time-driven animation can't tell "working" from "hung". At zero accretion it
// runs the ambient BREATHE field instead (alive from frame one — never an
// empty frame, the myth-zyk6o rule). Replaces the old time-driven Spinner.
//
// THE WHISPERS: the flavor line order is a SHUFFLED permutation (Fisher-Yates
// over the injectable `random` — the FogSim pattern; UI jitter, not game
// mechanics), walked to exhaustion and re-shuffled with no immediate repeat
// across the boundary (useWhisperCycle). Each advance settles the shown line
// into the LEDGER (myth-i2pdo — "the growing list IS the progress indicator"):
// newest first, oldest most faded. The current line carries a headline's job —
// it is the only content on the screen — at ~20px (myth-xe38q).
//
// THE WAIT LINE: the coarse aggregate `countdownLabel` ("Ready in about
// 8 min" — the consumer owns the tick, the aggregate derivation, and the
// monotonic clamp) or its `stalledLabel` stand-in, pushed a full beat below the
// whisper block (myth-xe38q — the whisper stands alone before the logistics
// speak).
//
// PERMISSION TO LEAVE (myth-i2pdo): one mono line (`leaveLabel`, e.g. "Safe to
// leave. The world keeps forming.") closing the screen — backed by real product
// behavior (the campaign re-entry lands back on this wait with progress
// intact).
//
// THE WATCH BEAT: when entities start streaming, the consumer flips
// `watchReady` and the screen grows the "watch your world be born" button.
// Generation keeps running regardless — pressing it only fires `onWatch`. The
// screen never transitions on its own.
//
// REDUCED MOTION: the whisper cycle holds its opening line (no interval — the
// ledger stays empty) and the mark stills to a legible frame; accretion still
// repaints on real events (a state change, not an animation). The countdown is
// NOT gated on it — the number is CONTENT.
//
// a11y: the mark's wrapper carries `role="status"` + `spinnerLabel` (the busy
// meaning); whispers + ledger are decorative prose (aria-hidden inside
// WhisperLedger); the countdown is aria-hidden churn; the stalled + leave lines
// are real content; the watch button is a real DS Button. The vertical
// footprint matches the graph pane's (`clamp(18rem,62dvh,46rem)`) so the
// act-one → act-two swap doesn't jump.

// ~10s dwell per line (Miklos, 2026-07-23 staging audit): the catalog is 20
// lines over a ~10-minute wait, so a slower cycle reads as writing, not blinking.
const DEFAULT_INTERVAL_MS = 10_000

const SCREEN_CLASS = cn(
  'flex min-h-[clamp(18rem,62dvh,46rem)] w-full min-w-0 flex-col items-center justify-center',
  'gap-[var(--space-5)] p-[var(--space-6)] text-center',
)
// The mark: a fixed 96px square (16 rows · 6px) — grown from the old ~48px
// spinner (myth-i2pdo) so the screen's anchor holds the composition.
const MARK_BOX_CLASS = 'w-[96px]'
const MARK_ROWS = 16
// The countdown: quiet mono/tabular, paper register — mirrors the status card's
// countdown line so the two waiting surfaces read as one voice. The extra top
// margin (on the shared wait-line slot) lets the whisper stand alone for a beat
// before the logistics speak (myth-xe38q: whisper→estimate ≈ 64px).
const WAIT_SLOT_CLASS = 'mt-[var(--space-7)] flex min-w-0 flex-col items-center gap-[var(--space-3)]'
const COUNTDOWN_CLASS = 'font-ui text-xs tabular-nums text-ink-tertiary leading-none'
// The stalled stand-in — real reassurance content (not churn): a calm
// secondary-ink line, a touch more present than the countdown, never loud.
const STALLED_CLASS = 'font-body text-sm text-ink-secondary leading-[1.4]'
// Permission to leave — the quiet mono record register, closing the screen.
const LEAVE_CLASS = 'mt-[var(--space-5)] font-ui text-xs text-ink-tertiary leading-[1.5] break-words'

export const WorldGenLoading = forwardRef<HTMLDivElement, WorldGenLoadingProps>(
  function WorldGenLoading(
    {
      flavorLabels,
      intervalMs = DEFAULT_INTERVAL_MS,
      random = Math.random,
      accretion = 0,
      countdownLabel,
      stalledLabel,
      spinnerLabel,
      leaveLabel,
      watchReady = false,
      watchLabel,
      onWatch,
      'data-testid': dataTestId,
    },
    ref,
  ) {
    const { current, history } = useWhisperCycle(flavorLabels, intervalMs, random)
    const reducedMotion = useReducedMotionPref()

    return (
      <div
        ref={ref}
        {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
        className={SCREEN_CLASS}
      >
        {/* The accreting mark — the busy signal AT hears; the dither itself is
            decoration (BeatFigure sets aria-hidden). Breathe until the first
            real event lands (never an empty fill frame). */}
        <div
          role="status"
          {...(spinnerLabel !== undefined ? { 'aria-label': spinnerLabel } : {})}
          className={MARK_BOX_CLASS}
        >
          {accretion > 0 ? (
            <BeatFigure
              mode="fill"
              level={accretion}
              rows={MARK_ROWS}
              reducedMotion={reducedMotion}
              data-testid="worldgen-loading-mark"
            />
          ) : (
            <BeatFigure
              mode="breathe"
              rows={MARK_ROWS}
              reducedMotion={reducedMotion}
              data-testid="worldgen-loading-mark"
            />
          )}
        </div>

        {/* The whisper + its settled ledger (decorative prose — aria-hidden
            inside the ledger). */}
        {current !== undefined && (
          <WhisperLedger data-testid="worldgen-loading-whispers" current={current} history={history} />
        )}

        {/* The wait line — the coarse aggregate countdown, or the stalled
            reassurance in its place; a beat of air above so the whisper stands
            alone (myth-xe38q). */}
        {(countdownLabel !== undefined || stalledLabel !== undefined || watchReady) && (
          <div className={WAIT_SLOT_CLASS}>
            {countdownLabel !== undefined ? (
              <p aria-hidden="true" data-testid="worldgen-loading-countdown" className={COUNTDOWN_CLASS}>
                {countdownLabel}
              </p>
            ) : (
              stalledLabel !== undefined && (
                <p data-testid="worldgen-loading-stalled" className={STALLED_CLASS}>
                  {stalledLabel}
                </p>
              )
            )}
            {watchReady && (
              <Button
                data-testid="worldgen-loading-watch"
                {...(onWatch !== undefined ? { onPress: onWatch } : {})}
              >
                {watchLabel}
              </Button>
            )}
          </div>
        )}

        {/* Permission to leave — real content, quietly closing the screen. */}
        {leaveLabel !== undefined && (
          <p data-testid="worldgen-loading-leave" className={LEAVE_CLASS}>
            {leaveLabel}
          </p>
        )}
      </div>
    )
  },
)
