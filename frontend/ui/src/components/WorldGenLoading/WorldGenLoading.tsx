import { forwardRef } from 'react'
import type { WorldGenLoadingProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { useReducedMotionPref, useWhisperCycle } from '../../lib/use-whisper-cycle.ts'
import { BeatFigure } from '../BeatFigure/BeatFigure.tsx'
import { WhisperLedger } from '../WhisperLedger/WhisperLedger.tsx'

// WorldGenLoading (MYT-89 two-act generating flow, act ONE; ux-run2 myth-i2pdo
// + myth-xe38q) — the calm pre-graph loading screen. While the world generates
// there is nothing the player must do — so this surface holds the beat: the
// ACCRETING DITHER MARK over a whisper line that cycles playful flavor copy,
// the past whispers settling beneath it as a faint ledger, a coarse overall
// countdown, and one quiet line of permission to leave.
//
// THE MARK (myth-i2pdo — provable liveness; ux-run3 myth-c96rf — the filling
// glyph): a 120px 1-bit dither square whose quantized fill is driven by
// `accretion` — REAL pipeline events (completed stages + arrived entities), so
// structural resolution means work happened and stillness means stillness; a
// time-driven animation can't tell "working" from "hung". Grown from ~96px so
// filling proportionally over the wait makes it the honest ambient progress
// signal, the composition anchor, and the returning-user "not stuck" proof. At
// zero accretion it runs the faint IDLE shimmer (nearly blank, poised at the
// fill's origin — run 3's blocker was a breathe field DENSER than early
// accretion, which made the handoff read as a reset; ink now only ever
// accrues).
//
// THE WHISPERS: the flavor line order is a SHUFFLED permutation (Fisher-Yates
// over the injectable `random` — the FogSim pattern; UI jitter, not game
// mechanics), walked to exhaustion and re-shuffled with no immediate repeat
// across the boundary (useWhisperCycle). Each advance settles the shown line
// into the LEDGER (myth-i2pdo — "the growing list IS the progress indicator"):
// newest first, oldest most faded. The current line carries a headline's job —
// it is the only content on the screen — at ~20px (myth-xe38q).
//
// THE WAIT LINE (reworked for ux-run3 myth-b965d): the coarse aggregate
// `countdownLabel` ("Ready in about 8 min" — the consumer owns the tick, the
// aggregate derivation, the monotonic clamp, and the once-per-whisper damping)
// or its `stalledLabel` stand-in, seated DIRECTLY UNDER THE MARK — the glyph
// and the estimate are one "how it's going" vitals unit, and the ETA carries
// raised (secondary-ink) presence: run 3 found the most trust-relevant datum
// on the screen sitting ~5th-heaviest. The whisper still stands alone, below
// the vitals (the myth-xe38q intent, re-seated). The slot is RESERVED from
// first paint so a late-arriving estimate displaces nothing (myth-5ekb5).
//
// PERMISSION TO LEAVE (myth-i2pdo; loop closed in ux-run3 myth-b965d): the
// mono `leaveLabel` ("Safe to leave. The world keeps forming." — verbatim,
// praise-ledger) closing the screen, now paired with the concrete `holdLabel`
// resumption promise — permission plus the reason to trust it. Backed by real
// product behavior (the campaign re-entry lands back on this wait with
// progress intact).
//
// THE WATCH BEAT (reworked for ux-run3 myth-5ekb5): when entities start
// streaming, the consumer flips `watchReady` and the watch affordance appears
// — inside a slot RESERVED from first paint (run 3: its arrival shoved the
// composition ~75px down; absent-then-present is fine, displacement is not),
// and in the QUIET underlined text-link register matching the live map's "Wait
// quietly instead" return link (a solid stay-CTA argued with "Safe to leave."
// right below it). Generation keeps running regardless — pressing it only
// fires `onWatch`. The screen never transitions on its own.
//
// OPTICAL SEAT (myth-5ekb5): the stack sat ~70px above the header-adjusted
// optical center, leaving the lower band blank — a clamped top pad nudges the
// composition down (padding, never transform: the brand motion rail bans
// translate, and a static seat is layout, not motion).
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
  // The optical-center nudge (myth-5ekb5): extra top padding shifts the seated
  // stack down toward the header-adjusted optical center; clamped away on
  // short viewports so ~375px phones lose nothing.
  'pt-[clamp(var(--space-6),8dvh,4.5rem)]',
)
// The mark: a fixed 120px square (20 rows · 6px) — grown again for ux-run3
// myth-c96rf (the filling-glyph prescription) so the screen's anchor holds the
// composition and the proportional fill reads at a glance.
const MARK_BOX_CLASS = 'w-[120px]'
const MARK_ROWS = 20
// The vitals unit (ux-run3 myth-b965d): the mark and its wait line as ONE
// cluster — the glyph answers "is it working", the line right under it answers
// "how much longer".
const VITALS_CLASS = 'flex min-w-0 flex-col items-center gap-[var(--space-3)]'
// The wait-line slot — RESERVED from first paint (one line of min-height) so a
// late-arriving estimate/stall never displaces the composition (myth-5ekb5).
const WAIT_SLOT_CLASS = 'flex min-h-[1.25rem] min-w-0 flex-col items-center justify-center'
// The countdown at raised presence (myth-b965d): secondary ink, small-not-tiny,
// still mono/tabular — present, never loud. The status card keeps the quieter
// register (an overlay next to its own bars carries less of the trust load).
const COUNTDOWN_CLASS = 'font-ui text-sm tabular-nums text-ink-secondary leading-none'
// The stalled stand-in — real reassurance content (not churn): a calm
// secondary-ink line, a touch more present than the countdown, never loud.
const STALLED_CLASS = 'font-body text-sm text-ink-secondary leading-[1.4]'
// The watch slot — RESERVED from first paint (myth-5ekb5): the affordance
// appears inside it without shoving the leave lines below.
const WATCH_SLOT_CLASS = 'flex min-h-[1.5rem] min-w-0 items-center justify-center'
// The watch affordance in the quiet underlined text-link register — the live
// map's "Wait quietly instead" voice (WorldGenStatusCard RETURN_CLASS), never
// a loud stay-CTA next to "Safe to leave." (myth-5ekb5).
const WATCH_LINK_CLASS = cn(
  'cursor-pointer appearance-none rounded-none border-0 bg-transparent p-0',
  'font-ui text-xs text-ink-secondary underline underline-offset-2',
)
// Permission to leave + the hold promise — one tight block in the quiet mono
// record register, closing the screen with an extra beat of air above.
const LEAVE_BLOCK_CLASS = 'mt-[var(--space-5)] flex min-w-0 flex-col items-center gap-[var(--space-1)]'
const LEAVE_CLASS = 'font-ui text-xs text-ink-tertiary leading-[1.5] break-words'

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
      holdLabel,
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
        {/* The vitals unit (ux-run3 myth-b965d): the accreting mark — the busy
            signal AT hears; the dither itself is decoration (BeatFigure sets
            aria-hidden); the faint IDLE shimmer until the first real event
            lands (myth-c96rf) — with the wait line seated directly under it. */}
        <div data-testid="worldgen-loading-vitals" className={VITALS_CLASS}>
          <div
            role="status"
            {...(spinnerLabel !== undefined ? { 'aria-label': spinnerLabel } : {})}
            className={MARK_BOX_CLASS}
          >
            <BeatFigure
              {...(accretion > 0 ? { mode: 'fill' as const, level: accretion } : { mode: 'idle' as const })}
              rows={MARK_ROWS}
              reducedMotion={reducedMotion}
              data-testid="worldgen-loading-mark"
            />
          </div>

          {/* The wait line — countdown or its stalled stand-in, in a slot
              reserved from first paint (myth-5ekb5). */}
          <div data-testid="worldgen-loading-wait-slot" className={WAIT_SLOT_CLASS}>
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
          </div>
        </div>

        {/* The whisper + its settled ledger (decorative prose — aria-hidden
            inside the ledger), standing alone below the vitals (myth-xe38q). */}
        {current !== undefined && (
          <WhisperLedger data-testid="worldgen-loading-whispers" current={current} history={history} />
        )}

        {/* The watch beat — its slot reserved from first paint; the quiet
            text-link appears inside it (myth-5ekb5). Generation keeps running
            regardless. */}
        <div data-testid="worldgen-loading-watch-slot" className={WATCH_SLOT_CLASS}>
          {watchReady && (
            <button
              type="button"
              data-testid="worldgen-loading-watch"
              className={WATCH_LINK_CLASS}
              {...(onWatch !== undefined ? { onClick: onWatch } : {})}
            >
              {watchLabel}
            </button>
          )}
        </div>

        {/* Permission to leave + the hold promise — real content, quietly
            closing the screen (myth-i2pdo; loop closed in myth-b965d). */}
        {(leaveLabel !== undefined || holdLabel !== undefined) && (
          <div className={LEAVE_BLOCK_CLASS}>
            {leaveLabel !== undefined && (
              <p data-testid="worldgen-loading-leave" className={LEAVE_CLASS}>
                {leaveLabel}
              </p>
            )}
            {holdLabel !== undefined && (
              <p data-testid="worldgen-loading-hold" className={LEAVE_CLASS}>
                {holdLabel}
              </p>
            )}
          </div>
        )}
      </div>
    )
  },
)
