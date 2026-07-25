import { forwardRef } from 'react'
import type { CharacterLoadingBeatProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { BeatFigure } from '../BeatFigure/BeatFigure.tsx'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'

// CharacterLoadingBeat (MYT-90; MYT-102 timer revamp; ux-run2 myth-8ddt4 +
// myth-zyk6o) — the "coming into being" beat that holds the screen while the
// pipeline generates the sheet. A TYPOGRAPHIC LADDER of the four phases over the
// brand's quantized-dither figure, capped at a readable panel width.
//
// THE LADDER (the run-2 rework, myth-8ddt4). The previous treatment boxed each
// phase in a full-width bordered rung — but in this square-cornered register a
// full-width bordered rectangle IS the button affordance, so four of them read
// as disabled buttons ("button cosplay"), and with only two visual states the
// single most interesting fact on the screen — which phase is happening RIGHT
// NOW — went un-encoded. The ladder is now a plain typographic list with three
// unmistakable states:
//   `done`    — a small leading FILLED square + the label settled into quiet
//               accent: a checklist mark accreting down the page;
//   `active`  — the emphasized ink line (font-medium) closing with an ELLIPSIS
//               ("A calling takes shape…"): the one thing happening now, loudest
//               by weight not decoration (motion-free, so reduced-motion users
//               read the same state);
//   `pending` — tertiary ink, marker slot empty: visibly not-yet.
// The stage copy itself is praise-ledger ("A name surfaces." — do not rewrite);
// the ellipsis is appended presentation, skipped when a label already ends
// with one.
//
// THE KICKER ROW: the eyebrow and the coarse estimate share one label·value
// line ("BRINGING THEM TO LIFE…   ·   Ready in about 2 min"), so the estimate is
// anchored to the panel's voice instead of floating attached to nothing.
//
// THE FIGURE (myth-zyk6o — never an empty frame). The shared BeatFigure under
// the ladder is the brand's "materializing" texture — but a fill meter at zero
// progress painted NOTHING: an empty black-bordered rectangle a mid-generation
// user cannot distinguish from a rendering failure. Two fixes: (1) before the
// first completed beat the figure runs the ambient BREATHE field (alive dither
// from frame one — the praised session-prep square); the determinate fill takes
// over once (# beats done)/(# beats total) is a true, non-zero level. (2) The
// frame wears the `muted` tone (panel-weight border-border) so the figure's
// stroke never out-weighs its containing panel.
//
// THE WAIT LINE (MYT-102 timer revamp). At most ONE of:
//   - `countdownLabel` — the COARSE remaining estimate ("Ready in about 2 min"),
//     minute-granular, NOT a ticking `0:24`; aria-hidden (churn the SR live
//     region shouldn't carry), quiet tabular tertiary ink, seated on the kicker
//     row.
//   - `stalledLabel` — the indeterminate "still working" line shown as the text
//     column's closing line the instant the estimate exhausts, so the wait NEVER
//     sits at a dead 0:00. Meaningful content (a one-time state change), so NOT
//     aria-hidden; a calm secondary-ink line.
// The consumer passes at most one; cold-start shows neither.
//
// REDUCED MOTION: `reducedMotion` stills the figure (breathe freezes to a
// legible field; fill lands instantly); rung state swaps with no fade. a11y: the
// surface is `aria-busy` while any beat is unfinished, and an SR-only polite
// live region announces the ACTIVE beat's label (figure + rungs are aria-hidden
// decoration; the ellipsis is visual pacing, so the region reads the plain
// label).

// The loadwrap: a theme-aware paper card holding the ladder over the figure.
// min-w-0 so rows wrap rather than spilling at ~375px; max-w caps the panel near
// 600px (ux-run2 myth-8ddt4 — a readout, not an admin table that lost its data).
const WRAP_CLASS = cn(
  'flex min-w-0 max-w-[38rem] flex-col gap-[var(--space-4)] rounded-none border border-border bg-surface',
  'p-[var(--space-4)]',
)

// The text column — the kicker row + the ladder + the stalled line.
const TEXT_CLASS = 'flex min-w-0 flex-col gap-[var(--space-3)]'
// The kicker row: the eyebrow leading, the coarse estimate trailing (label·value).
// flex-wrap so the pair stacks rather than colliding at ~375px.
const HEADER_CLASS = 'flex min-w-0 flex-wrap items-baseline justify-between gap-x-[var(--space-3)] gap-y-[var(--space-1)]'
// The eyebrow — a quiet kicker; the screen H1 is the primary voice and the
// active rung is the panel's only emphasis.
const HEADING_CLASS = 'font-ui text-xs uppercase tracking-wide text-ink-secondary'
// The ladder: a semantic list, tight vertical rhythm, NO row boxes.
const LADDER_CLASS = 'flex list-none flex-col gap-[var(--space-2)] p-0'
// One row of the typographic list: marker + label on a baseline.
const ROW_CLASS = 'flex min-w-0 items-baseline gap-[var(--space-2)]'
// The leading marker slot — a fixed 8px square (paper register: squares only),
// FILLED quiet accent when the stage is done, empty otherwise. self-center on
// the cross axis reads better than baseline for a solid square.
const MARKER_BASE = 'size-[8px] shrink-0 self-center rounded-none'
const MARKER_STATE_CLASS: Record<CharacterLoadingBeatProps['beats'][number]['state'], string> = {
  done: 'bg-accent',
  active: 'bg-transparent',
  pending: 'bg-transparent',
}
// Per-state label treatment — three channels (marker fill, ink weight/color, the
// active ellipsis), never text color alone.
const ROW_STATE_CLASS: Record<CharacterLoadingBeatProps['beats'][number]['state'], string> = {
  done: 'text-accent-fg',
  active: 'font-medium text-ink',
  pending: 'text-ink-tertiary',
}
// The phase prose — readable body; the row's state class colors it. break-words
// so a long phase label wraps inside the narrow column at ~375px.
const RUNG_LABEL_CLASS = 'font-body text-sm leading-[1.4] break-words'
// The coarse remaining-wait value on the kicker row — quiet tertiary ink,
// tabular so a minute flip never jitters the line. aria-hidden (the SR live
// region is the single AT source of truth).
const COUNTDOWN_CLASS = 'font-ui text-xs tabular-nums text-ink-tertiary break-words'
// The indeterminate "still working" line — a calm secondary-ink body line, a
// touch more present than the countdown (it is real reassurance content, not
// churn), but never loud.
const STALLED_CLASS = 'font-body text-sm text-ink-secondary leading-[1.4] break-words'

/** The active row's motion-free "in progress" cue. Presentation only — the
 *  praise-ledger stage copy is never rewritten, so a label that already closes
 *  with an ellipsis keeps exactly one. */
function withWorkingEllipsis(label: string): string {
  return label.endsWith('…') ? label : `${label}…`
}

export const CharacterLoadingBeat = forwardRef<HTMLDivElement, CharacterLoadingBeatProps>(
  function CharacterLoadingBeat({ heading, beats, reducedMotion, countdownLabel, stalledLabel }, ref) {
    const total = beats.length
    const doneCount = beats.filter((beat) => beat.state === 'done').length
    // Fill level as the mechanical done/total ratio. Drives the meter + the
    // test/inspection hook — but only once it is non-zero: at zero the figure
    // breathes instead (never an empty fill frame, myth-zyk6o).
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

        <div className={TEXT_CLASS}>
          {/* The kicker row — eyebrow · coarse estimate. */}
          <div aria-hidden="true" data-testid="character-loading-beat-header" className={HEADER_CLASS}>
            <p className={HEADING_CLASS}>{heading}</p>
            {stalledLabel === undefined && countdownLabel !== undefined && (
              <p aria-hidden="true" data-testid="character-loading-beat-countdown" className={COUNTDOWN_CLASS}>
                {countdownLabel}
              </p>
            )}
          </div>

          {/* The typographic ladder. */}
          <ul className={LADDER_CLASS} aria-hidden="true">
            {beats.map((beat) => (
              <li
                key={beat.id}
                data-testid="character-loading-beat-row"
                data-beat-id={beat.id}
                data-state={beat.state}
                className={cn(ROW_CLASS, ROW_STATE_CLASS[beat.state])}
              >
                <span
                  data-testid="character-loading-beat-marker"
                  className={cn(MARKER_BASE, MARKER_STATE_CLASS[beat.state])}
                />
                <span className={RUNG_LABEL_CLASS}>
                  {beat.state === 'active' ? withWorkingEllipsis(beat.label) : beat.label}
                </span>
              </li>
            ))}
          </ul>

          {/* The stalled reassurance takes the countdown's place as the column's
              closing line once the estimate exhausts (never both). */}
          {stalledLabel !== undefined && (
            <p data-testid="character-loading-beat-stalled" className={STALLED_CLASS}>
              {stalledLabel}
            </p>
          )}
        </div>

        {/* The quantized figure — ambient breathe until the first beat lands,
            then the honest fill; panel-weight frame (muted tone). */}
        {doneCount > 0 ? (
          <BeatFigure
            mode="fill"
            level={fillLevel}
            tone="muted"
            reducedMotion={reducedMotion}
            data-testid="character-loading-beat-figure"
          />
        ) : (
          <BeatFigure
            mode="breathe"
            tone="muted"
            reducedMotion={reducedMotion}
            data-testid="character-loading-beat-figure"
          />
        )}
      </div>
    )
  },
)
