import { forwardRef } from 'react'
import type { SessionStartBeatProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { BeatFigure } from '../BeatFigure/BeatFigure.tsx'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'

// SessionStartBeat (MYT-92 live play) — the beat that holds the screen between pressing Start
// and the first DM token. The SHIPPED 1-bit loading register, rebuilt on the BeatFigure
// quantized-dither meter: a FULL-WIDTH ink meter under a two-row itinerary. Pure/presentational
// — it renders from `phase` + `reducedMotion` and owns no timing; the play route advances the
// phase and the meter follows.
//
// ONE BEAT, TWO LABELED PHASES (spec §2): `prep` — the SSE-driven atmospheric "the DM is
// preparing tonight's session…" 1–2 minute wait — and `connecting`, the short socket-connect
// boundary. The two phases render as a two-row itinerary; the current `phase` drives each row's
// derived state:
//   prep       → prep = active,  connecting = pending
//   connecting → prep = done,    connecting = active
// and drives the meter LEVEL: prep sits well underway (the long atmospheric wait), connecting
// lands at completion. There is no numeric progress on the wire; the phase IS the progress. The
// phase change drives a decelerating QUANTIZED advance of the meter's dither front (easing in
// time, not a tweened bar); while a phase holds, only the front band shimmers (liveness, never
// fake progress). `reducedMotion` lands the front instantly at its phase level — no churn.
//
// THE FIGURE: the shared BeatFigure (mode="fill") — a full-width band of hard binary Bayer
// cells, solid ink behind the front, a soft dithered front, paper ahead. Frozen-paper tone by
// default (theme-invariant 1-bit relic), framed by the theme-aware card around it. Decoration →
// aria-hidden (the BeatFigure sets it).
//
// THE ROWS: the two phases as a mono column. `done` reads solid ink, `active` is emphasised in
// ember, `pending` is the SOLID tertiary-ink token — NOT a sub-AA `opacity` dim (the contrast
// lesson: progress rows carry meaning, so they meet the 4.5:1 floor). A mono eyebrow (the
// resolved `heading` prop) names the beat.
//
// a11y: the whole surface is `aria-busy` while mounted (the parent unmounts it when play
// begins); the figure + rows are decoration, so an SR-only polite live region announces the
// ACTIVE phase's label as the single AT source of truth (motion is never the sole signal).

// The meter level per phase: `prep` is well underway (the long atmospheric wait), `connecting`
// lands at completion. The prep→connecting rise is the beat "accelerating toward completion".
const FILL_LEVEL: Record<SessionStartBeatProps['phase'], number> = {
  prep: 0.58,
  connecting: 1,
}

// The loadwrap: a theme-aware paper card, a column holding the itinerary over the full-width
// meter. min-w-0 so the rows wrap rather than spilling at ~375px.
const WRAP_CLASS = cn(
  'flex min-w-0 flex-col gap-[var(--space-4)] rounded-none border border-border bg-surface',
  'p-[var(--space-4)]',
)

// The text column — the eyebrow + the two phase rows.
const TEXT_CLASS = 'flex min-w-0 flex-col gap-[var(--space-2)]'
const HEADING_CLASS = 'font-ui text-xs uppercase tracking-wide text-accent-fg'
const ROWS_CLASS = 'flex flex-col gap-[var(--space-1)]'
const ROW_CLASS = 'font-ui text-sm leading-[1.4]'

// A phase row is `done` (already crossed), `active` (the current phase), or `pending` (still
// ahead). Per-state treatment: done = solid ink, active = emphasised ember, pending = the
// muted-but-SOLID tertiary-ink token (~5.7:1 on paper — the state stays distinct via token +
// weight, never a sub-AA opacity dim).
type RowState = 'done' | 'active' | 'pending'
const ROW_STATE_CLASS: Record<RowState, string> = {
  done: 'text-ink',
  active: 'font-medium text-accent-fg',
  pending: 'text-ink-tertiary',
}

/** The two phase rows in itinerary order, each with its state derived from the active `phase` —
 *  prep resolves as the beat advances to connecting. */
function phaseRows(
  phase: SessionStartBeatProps['phase'],
  prepLabel: string,
  connectingLabel: string,
): { phase: SessionStartBeatProps['phase']; label: string; state: RowState }[] {
  return [
    { phase: 'prep', label: prepLabel, state: phase === 'prep' ? 'active' : 'done' },
    { phase: 'connecting', label: connectingLabel, state: phase === 'connecting' ? 'active' : 'pending' },
  ]
}

export const SessionStartBeat = forwardRef<HTMLDivElement, SessionStartBeatProps>(
  function SessionStartBeat({ phase, reducedMotion, heading, prepLabel, connectingLabel }, ref) {
    // The active phase's label is the single AT source of truth.
    const activeLabel = phase === 'prep' ? prepLabel : connectingLabel
    const rows = phaseRows(phase, prepLabel, connectingLabel)

    return (
      <div
        ref={ref}
        data-testid="session-start-beat"
        data-phase={phase}
        data-reduced-motion={reducedMotion}
        aria-busy={true}
        className={WRAP_CLASS}
      >
        {/* The single AT source of truth: the figure + rows are decoration, so a polite live
            region carries the active phase's label. */}
        <VisuallyHidden>
          <span role="status" aria-live="polite" data-testid="session-start-beat-live">
            {activeLabel}
          </span>
        </VisuallyHidden>

        {/* The two phase rows. */}
        <div className={TEXT_CLASS}>
          <p aria-hidden="true" className={HEADING_CLASS}>
            {heading}
          </p>
          <ul className={ROWS_CLASS} aria-hidden="true">
            {rows.map((row) => (
              <li
                key={row.phase}
                data-testid="session-start-beat-row"
                data-phase={row.phase}
                data-state={row.state}
                className={cn(ROW_CLASS, ROW_STATE_CLASS[row.state])}
              >
                {row.label}
              </li>
            ))}
          </ul>
        </div>

        {/* The full-width quantized meter — the phase change drives its decelerating advance. */}
        <BeatFigure
          mode="fill"
          level={FILL_LEVEL[phase]}
          reducedMotion={reducedMotion}
          data-testid="session-start-beat-figure"
        />
      </div>
    )
  },
)
