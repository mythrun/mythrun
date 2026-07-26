import type { SessionProgressBand } from '../../session/session-progress.ts'

// SessionProgressLine (myth-atxhx) — the play surface's session-position readout.
// One quiet line in the mono record register, sitting in the between-turns chrome
// beside the end control.
//
// It is a LINE, not a meter, and that is the whole point. The underlying signal is
// cost-derived (token budget + context fill), so a bar or a percentage would render
// the fiction as a spend gauge — "62% of your money used" — which is both the wrong
// thing to think about mid-scene and out of the brand's paper-y, un-gamified
// register. The consumer bands the fraction (`progressBand`) and passes the already
// resolved WORD; this component never sees the number and cannot render one.
//
// Platform-neutral (§9): pure data, no DOM.

/** Props for the quiet session-position line. */
export interface SessionProgressLineProps {
  /** The already-resolved coarse position line (e.g. "Nearing the end"). The
   *  consumer owns the copy; no numeric variant exists. */
  label: string
  /** Which coarse band the label names. Drives the quiet INK WEIGHT only — the
   *  line lifts from tertiary to full ink as the session closes, so the last
   *  stretch reads without ever becoming an alarm. Never a colour, never a chip. */
  band: SessionProgressBand
  'data-testid'?: string
}
