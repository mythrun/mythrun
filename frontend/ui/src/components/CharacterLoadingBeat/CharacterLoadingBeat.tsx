import { forwardRef } from 'react'
import type { CharacterLoadingBeatProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { BeatFigure } from '../BeatFigure/BeatFigure.tsx'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'

// CharacterLoadingBeat (MYT-90; MYT-102 legibility+timer revamp) — the "coming
// into being" beat that holds the screen while the pipeline generates the sheet.
// A RUNG LADDER of the four phases over the brand's quantized-dither meter.
//
// THE LADDER (the legibility fix — MYT-102). The old flat text rows read state
// through TEXT COLOR alone (done=ink vs pending=ink-tertiary), which is
// ambiguous at a squint. The phases now wear the GuidedRail rung idiom — the
// DS's established done/now/todo state language — so each phase's state is
// unmistakable: `done` = a SOLID ink edge over a settled (secondary-ink) label;
// `active` = an EMBER edge + ember label (the one loud element — the phase
// happening now); `pending` = a faint muted edge + tertiary label. Edge + text
// are two channels, so done vs pending never collapses to "two greys". The
// eyebrow is demoted to a quiet kicker (the screen H1 is the primary voice, and
// the active rung owns the only ember), establishing hierarchy over the old flat
// wall of same-weight lines.
//
// THE FIGURE. The shared BeatFigure (mode="fill") under the ladder — the brand's
// "materializing" texture, kept as ambient feel (not a second progress read):
// the meter LEVEL is the honest (# beats done)/(# beats total), each completion a
// decelerating QUANTIZED advance of the dither front, shimmering in place
// between. Frozen-paper ink framed by the theme-aware card; aria-hidden.
//
// THE WAIT LINE (MYT-102 timer revamp). Under the ladder, at most ONE of:
//   - `countdownLabel` — the COARSE remaining estimate (e.g. "2 min remaining"),
//     minute-granular, NOT a ticking `0:24`; a per-second count reads as false
//     precision. aria-hidden (a per-minute change is still churn the SR live
//     region shouldn't carry), quiet tabular tertiary ink.
//   - `stalledLabel` — the indeterminate "still working" line shown IN PLACE OF
//     the countdown the instant the estimate exhausts, so the wait NEVER sits at
//     a dead 0:00. Meaningful content (a one-time state change), so NOT
//     aria-hidden; a calm secondary-ink line.
// The consumer passes at most one; cold-start shows neither.
//
// REDUCED MOTION: `reducedMotion` drops the meter's quantized advance + shimmer
// (front lands instantly, holds still); rung state swaps with no fade. a11y: the
// surface is `aria-busy` while any beat is unfinished, and an SR-only polite live
// region announces the ACTIVE beat's label (figure + rungs are aria-hidden
// decoration; the ladder's meaning reaches AT through that one region).

// The loadwrap: a theme-aware paper card holding the ladder over the full-width
// meter. min-w-0 so the rungs wrap rather than spilling at ~375px.
const WRAP_CLASS = cn(
  'flex min-w-0 flex-col gap-[var(--space-4)] rounded-none border border-border bg-surface',
  'p-[var(--space-4)]',
)

// The text column — the eyebrow + the rung ladder + the wait line.
const TEXT_CLASS = 'flex min-w-0 flex-col gap-[var(--space-3)]'
// The eyebrow — DEMOTED to a quiet kicker (was ember): the screen H1 is the
// primary voice and the active rung owns the only ember, so this steps back.
const HEADING_CLASS = 'font-ui text-xs uppercase tracking-wide text-ink-secondary'
// The ladder: a semantic list of full-width rungs, tight vertical rhythm.
const LADDER_CLASS = 'flex list-none flex-col gap-[var(--space-1)] p-0'
// One rung — a flat square (rounded-none) bordered box, the GuidedRail idiom.
const RUNG_BASE = cn(
  'flex min-w-0 items-center rounded-none border',
  'px-[var(--space-3)] py-[var(--space-2)]',
)
// Per-state rung treatment — VERBATIM the GuidedRail done/now/todo token trio
// (mapped done→done, active→now, pending→todo). Edge + text carry the state
// through the same ember/ink/muted language the rest of the guided journey uses:
// `done` = solid ink edge over a settled label; `active` = ember edge + text;
// `pending` = faint muted edge + tertiary label. The ink-tertiary/-secondary
// tokens are SOLID AA colors on paper (not sub-AA opacity dims), so the state
// stays legible in both themes.
const RUNG_STATE_CLASS: Record<CharacterLoadingBeatProps['beats'][number]['state'], string> = {
  done: 'border-ink bg-surface text-ink-secondary',
  active: 'border-accent bg-surface font-medium text-accent-fg',
  pending: 'border-border bg-bg text-ink-tertiary',
}
// The phase prose inside a rung — readable body; the rung's state class colors it.
// break-words so a long phase label wraps inside the rung at ~375px.
const RUNG_LABEL_CLASS = 'font-body text-sm leading-[1.4] break-words'
// The coarse remaining-wait line — quiet tertiary ink, tabular so a minute flip
// never jitters the column. aria-hidden (the SR live region is the single AT
// source of truth). break-words keeps a long label inside the narrow column at
// 375px.
const COUNTDOWN_CLASS = 'font-ui text-xs tabular-nums text-ink-tertiary break-words'
// The indeterminate "still working" line — a calm secondary-ink body line, a
// touch more present than the countdown (it is real reassurance content, not
// per-second churn), but never loud.
const STALLED_CLASS = 'font-body text-sm text-ink-secondary leading-[1.4] break-words'

export const CharacterLoadingBeat = forwardRef<HTMLDivElement, CharacterLoadingBeatProps>(
  function CharacterLoadingBeat({ heading, beats, reducedMotion, countdownLabel, stalledLabel }, ref) {
    const total = beats.length
    const doneCount = beats.filter((beat) => beat.state === 'done').length
    // Fill level as the mechanical done/total ratio (0 beats → 0). Drives the
    // meter + the test/inspection hook.
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
        {/* The single AT source of truth: the figure + rungs are decoration, so a
            polite live region carries the active beat's label. */}
        <VisuallyHidden>
          <span role="status" aria-live="polite" data-testid="character-loading-beat-live">
            {activeLabel}
          </span>
        </VisuallyHidden>

        {/* The rung ladder. */}
        <div className={TEXT_CLASS}>
          <p aria-hidden="true" className={HEADING_CLASS}>
            {heading}
          </p>
          <ul className={LADDER_CLASS} aria-hidden="true">
            {beats.map((beat) => (
              <li
                key={beat.id}
                data-testid="character-loading-beat-row"
                data-beat-id={beat.id}
                data-state={beat.state}
                className={cn(RUNG_BASE, RUNG_STATE_CLASS[beat.state])}
              >
                <span className={RUNG_LABEL_CLASS}>{beat.label}</span>
              </li>
            ))}
          </ul>
          {/* The wait line — the coarse estimate, or the stalled line in its
              place once the estimate exhausts. At most one is present; cold-start
              shows neither (no fake numbers). */}
          {stalledLabel !== undefined ? (
            <p data-testid="character-loading-beat-stalled" className={STALLED_CLASS}>
              {stalledLabel}
            </p>
          ) : (
            countdownLabel !== undefined && (
              <p aria-hidden="true" data-testid="character-loading-beat-countdown" className={COUNTDOWN_CLASS}>
                {countdownLabel}
              </p>
            )
          )}
        </div>

        {/* The full-width quantized meter — the brand "materializing" texture. */}
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
