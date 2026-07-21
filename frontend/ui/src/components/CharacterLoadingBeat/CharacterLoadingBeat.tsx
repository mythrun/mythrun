import { forwardRef } from 'react'
import type { CharacterLoadingBeatProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { BeatFigure } from '../BeatFigure/BeatFigure.tsx'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'

// CharacterLoadingBeat (MYT-90 character creation) — the "coming into being" beat that holds
// the screen while the pipeline generates the sheet. The SHIPPED world-gen loading register,
// rebuilt on the BeatFigure quantized-dither meter: a FULL-WIDTH ink meter under a column of
// surfacing beat rows. Pure/presentational — it renders from `beats` + `reducedMotion` and owns
// no timing; the client-core view-model advances each beat pending → active → done and the
// meter/rows follow.
//
// THE FIGURE: the shared BeatFigure (mode="fill"). The meter LEVEL is the honest (# beats done)
// / (# beats total) — each beat completion lands as a decelerating QUANTIZED advance of the
// dither front (easing in time, never a tweened bar); the fill never regresses. Between
// completions the front band SHIMMERS in place — that liveness is the active beat's presence,
// not fake progress. Frozen-paper tone (theme-invariant 1-bit relic), framed by the theme-aware
// card. Decoration → aria-hidden (the BeatFigure sets it).
//
// THE ROWS (the mockup's `.rows`): the beats as a mono column. `done` rows read solid ink,
// `active` is emphasised in ember, `pending` is the SOLID tertiary-ink token — they surface one
// at a time as the parent advances their state. A fixed mono eyebrow names the beat.
//
// REDUCED MOTION: `reducedMotion` (a prop) drops the quantized advance + shimmer — the front
// lands instantly at its proportion and holds still; the rows swap state with no fade. a11y: the
// whole surface is `aria-busy` while any beat is unfinished, and an SR-only polite live region
// announces the ACTIVE beat's label (figure + rows are aria-hidden decoration).

// Fixed interim chrome — the beat's eyebrow. Not carried by the contract, so it is a `[ph:]`
// placeholder (the deliberate pre-copy-pass convention), not real copy.
const LOADING_HEADING = '[ph: bringing them to life…]'

// The loadwrap: a theme-aware paper card, a column holding the surfacing rows over the
// full-width meter. min-w-0 so the rows wrap rather than spilling at ~375px.
const WRAP_CLASS = cn(
  'flex min-w-0 flex-col gap-[var(--space-4)] rounded-none border border-border bg-surface',
  'p-[var(--space-4)]',
)

// The text column — the eyebrow + the surfacing beat rows + the countdown.
const TEXT_CLASS = 'flex min-w-0 flex-col gap-[var(--space-2)]'
// The ticking `~M:SS` wait (MYT-102) — the WorldGenLoading countdown register: quiet tertiary
// ink, tabular digits so the per-second tick never jitters the column. aria-hidden like the
// rows — the SR live region stays the single AT source of truth (a per-second churn must never
// spam a live region). NOT gated on reducedMotion: the changing number is CONTENT (the remaining
// wait), not decoration. `break-words` keeps an over-long label wrapping inside the narrow text
// column instead of spilling at 375px.
const COUNTDOWN_CLASS = 'font-ui text-xs tabular-nums text-ink-tertiary break-words'
const HEADING_CLASS = 'font-ui text-xs uppercase tracking-wide text-accent-fg'
const ROWS_CLASS = 'flex flex-col gap-[var(--space-1)]'
const ROW_CLASS = 'font-ui text-sm leading-[1.4]'
// Per-state row treatment: done = solid ink, active = emphasised ember, pending = the muted
// tertiary ink token. `--ink-tertiary` (paper-600) is a SOLID AA color on paper (~5.7:1); the
// state stays distinct via token + weight, NOT a sub-AA opacity dim.
const ROW_STATE_CLASS: Record<CharacterLoadingBeatProps['beats'][number]['state'], string> = {
  done: 'text-ink',
  active: 'font-medium text-accent-fg',
  pending: 'text-ink-tertiary',
}

export const CharacterLoadingBeat = forwardRef<HTMLDivElement, CharacterLoadingBeatProps>(
  function CharacterLoadingBeat({ beats, reducedMotion, countdownLabel }, ref) {
    const total = beats.length
    const doneCount = beats.filter((beat) => beat.state === 'done').length
    // Fill level as the mechanical done/total ratio (0 beats → 0). Drives the meter + the
    // test/inspection hook.
    const fillLevel = total > 0 ? doneCount / total : 0
    // Busy until every beat is done; the active beat (if any) is what AT hears.
    const busy = beats.some((beat) => beat.state !== 'done')
    const activeLabel = beats.find((beat) => beat.state === 'active')?.label ?? ''

    return (
      <div
        ref={ref}
        data-testid="character-loading-beat"
        data-reduced-motion={reducedMotion}
        aria-busy={busy}
        className={WRAP_CLASS}
      >
        {/* The single AT source of truth: the figure + rows are decoration, so a polite live
            region carries the active beat's label. */}
        <VisuallyHidden>
          <span role="status" aria-live="polite" data-testid="character-loading-beat-live">
            {activeLabel}
          </span>
        </VisuallyHidden>

        {/* The surfacing beat rows. */}
        <div className={TEXT_CLASS}>
          <p aria-hidden="true" className={HEADING_CLASS}>
            {LOADING_HEADING}
          </p>
          <ul className={ROWS_CLASS} aria-hidden="true">
            {beats.map((beat) => (
              <li
                key={beat.id}
                data-testid="character-loading-beat-row"
                data-beat-id={beat.id}
                data-state={beat.state}
                className={cn(ROW_CLASS, ROW_STATE_CLASS[beat.state])}
              >
                {beat.label}
              </li>
            ))}
          </ul>
          {/* The remaining-wait countdown — present only with a usable estimate (the contract
              OMITS the prop on cold-start; no fake numbers). */}
          {countdownLabel !== undefined && (
            <p aria-hidden="true" data-testid="character-loading-beat-countdown" className={COUNTDOWN_CLASS}>
              {countdownLabel}
            </p>
          )}
        </div>

        {/* The full-width quantized meter — each beat completion lands a decelerating advance. */}
        <BeatFigure
          mode="fill"
          level={fillLevel}
          reducedMotion={reducedMotion}
          data-testid="character-loading-beat-figure"
        />
      </div>
    )
  },
)
