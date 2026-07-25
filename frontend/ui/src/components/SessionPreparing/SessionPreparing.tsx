import { forwardRef } from 'react'
import type { SessionPreparingProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'
import { useWhisperCycle } from '../../lib/use-whisper-cycle.ts'
import { BeatFigure } from '../BeatFigure/BeatFigure.tsx'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'
import { WhisperLedger } from '../WhisperLedger/WhisperLedger.tsx'

// SessionPreparing (myth-ep74g; MYT-102 timer revamp; ux-run2 myth-i2pdo) — the
// calm BETWEEN-SESSIONS hold. When a session has just ended and the next one
// isn't startable yet (the server answers prep_not_ready / reconcile_pending /
// session_ending), the play route sits here while the start-flow hook
// backoff-polls in the background.
//
// THE FIGURE (MYT-102 fix). Miklos liked the breathing dither wave but the old
// treatment was a FULL-WIDTH band — a wide rectangle that reads as a progress
// BAR yet only breathes (no fill), the "shaped like a bar, acts like a spinner"
// confusion. The animation is unchanged; the SHAPE is an AMBIENT SQUARE, so the
// dither reads as texture / a "thinking" glyph rather than an unfilled meter.
// Still `mode="breathe"` (a diagonal density wave, ~3s, asymmetric, re-seeded
// each cycle — NO opacity fade, NO progress); `reducedMotion` freezes it to a
// legible still frame; decoration → aria-hidden (the BeatFigure sets it).
// Session prep exposes NO per-stage client events (the prep channel is a coarse
// generating→ready lifecycle — and prep CONTENT is spoiler surface), so the
// constant low-rate shimmer is the honest liveness here; there is no real-event
// accretion to drive a fill (unlike the world-gen mark).
//
// THE WHISPERS (ux-run2 myth-i2pdo). Under the title, an optional rotating
// whisper (`whisperLabels`, ~25s cadence via the shared useWhisperCycle) with
// past lines settling into a faint LEDGER — the multi-minute wait accrues
// visible history instead of sitting on one frozen sentence. Public-tier
// table-setting flavor only (the consumer owns the copy; prep facts never
// reach this surface).
//
// THE SUB-LINE (MYT-102 fix for "how long / has it broken?"). One line, chosen
// by precedence: the coarse `countdownLabel` ("Ready in about 2 min") while a
// usable estimate holds; the indeterminate `stalledLabel` ("still working…")
// once it exhausts — so a long wait always reassures rather than looking hung;
// else the calm `detail` fallback (cold-start, no estimate yet).
//
// PERMISSION TO LEAVE (ux-run2 myth-i2pdo): one quiet mono line (`leaveLabel`)
// closing the hold — backed by real product behavior (the start flow re-polls
// on return; the campaign page shows prep in progress).
//
// a11y: `aria-busy` while mounted (the route unmounts it when play begins); the
// figure + whispers are decoration, so an SR-only polite live region carries
// the `label` as the single AT source of truth (motion is never the sole
// signal). The coarse countdown is aria-hidden (a per-minute change is churn
// the live region shouldn't carry); the stalled / detail / leave lines are
// meaningful content.

// The whisper cadence — the critique's "rotating stage line every 20-30s".
const DEFAULT_WHISPER_INTERVAL_MS = 25_000

// The centred hold — a quiet column: the breathing figure over the atmospheric
// line(s). min-w-0 so the text wraps rather than spilling at ~375px.
const WRAP_CLASS = 'flex min-w-0 flex-col items-center gap-[var(--space-4)] text-center'

// The ambient figure's square frame: a fixed 144px box (24 cells · 6px = 144),
// so the BeatFigure (w-full + rows-driven height) paints a SQUARE — the shape
// that reads as ambient texture, not a progress bar.
const FIGURE_BOX_CLASS = 'w-[144px]'
const FIGURE_ROWS = 24

// The atmospheric line + the single sub-line.
const TEXT_CLASS = 'flex min-w-0 flex-col gap-[var(--space-1)]'
// The label reads as unhurried narrative (serif title), not a machine status line.
const LABEL_CLASS = cn(TYPE_ROLE_CLASS.title, 'text-ink')
// The stalled / detail sub-line — the quiet meta register.
const DETAIL_CLASS = cn(TYPE_ROLE_CLASS.meta, 'break-words')
// The coarse countdown — quiet tabular so a minute flip never jitters the column.
const COUNTDOWN_CLASS = 'font-ui text-xs tabular-nums text-ink-tertiary break-words'
// Permission to leave — the quiet mono record register, closing the hold with a
// beat of air above it.
const LEAVE_CLASS = 'mt-[var(--space-3)] font-ui text-xs text-ink-tertiary leading-[1.5] break-words'

export const SessionPreparing = forwardRef<HTMLDivElement, SessionPreparingProps>(function SessionPreparing(
  {
    label,
    detail,
    countdownLabel,
    stalledLabel,
    whisperLabels = [],
    whisperIntervalMs = DEFAULT_WHISPER_INTERVAL_MS,
    whisperRandom = Math.random,
    leaveLabel,
    reducedMotion,
  },
  ref,
) {
  const { current, history } = useWhisperCycle(whisperLabels, whisperIntervalMs, whisperRandom)

  return (
    <div ref={ref} data-testid="session-preparing" data-reduced-motion={reducedMotion} aria-busy={true} className={WRAP_CLASS}>
      {/* The single AT source of truth: the figure is decoration, so a polite live
          region carries the atmospheric label. */}
      <VisuallyHidden>
        <span role="status" aria-live="polite" data-testid="session-preparing-live">
          {label}
        </span>
      </VisuallyHidden>

      {/* The ambient breathing SQUARE — decorative; still under reduced motion. */}
      <div className={FIGURE_BOX_CLASS}>
        <BeatFigure
          mode="breathe"
          rows={FIGURE_ROWS}
          reducedMotion={reducedMotion}
          data-testid="session-preparing-figure"
        />
      </div>

      <div className={TEXT_CLASS}>
        <p aria-hidden="true" className={LABEL_CLASS}>
          {label}
        </p>
        {/* One sub-line, by precedence: the coarse estimate while it holds, else
            the stalled reassurance, else the calm detail fallback. */}
        {countdownLabel !== undefined ? (
          <p aria-hidden="true" data-testid="session-preparing-countdown" className={COUNTDOWN_CLASS}>
            {countdownLabel}
          </p>
        ) : stalledLabel !== undefined ? (
          <p data-testid="session-preparing-stalled" className={DETAIL_CLASS}>
            {stalledLabel}
          </p>
        ) : detail !== undefined ? (
          <p data-testid="session-preparing-detail" aria-hidden="true" className={DETAIL_CLASS}>
            {detail}
          </p>
        ) : null}
      </div>

      {/* The rotating whisper + its settled ledger (decorative — aria-hidden
          inside the ledger; myth-i2pdo). */}
      {current !== undefined && (
        <WhisperLedger data-testid="session-preparing-whispers" size="sub" current={current} history={history} />
      )}

      {/* Permission to leave — real content, quietly closing the hold. */}
      {leaveLabel !== undefined && (
        <p data-testid="session-preparing-leave" className={LEAVE_CLASS}>
          {leaveLabel}
        </p>
      )}
    </div>
  )
})
