// SessionPreparing (myth-ep74g; MYT-102 timer revamp) — the calm between-sessions
// hold shown while the start-flow hook backoff-polls a not-yet-startable session
// (prep_not_ready / reconcile_pending / session_ending). Presentational: an
// ambient breathing figure + line, plus an optional coarse wait estimate / stalled
// line (the consumer owns the timing). Platform-neutral (§9): pure data, no DOM.
//
// MYT-102: the figure is an AMBIENT square (not the old full-width band, which
// read as a progress bar it never filled), and the sub-line answers "how long /
// has it broken?" — a coarse "{{time}} remaining" while a baseline estimate holds,
// the "still working" line once it exhausts, else the calm detail fallback.

/** Props for the between-sessions preparing hold. */
export interface SessionPreparingProps {
  /** The atmospheric line — a resolved key ("the DM is preparing the next
   *  session…"). Also the single AT source of truth (a polite live region). */
  label: string
  /** An optional quiet sub-line — a resolved key. The FALLBACK sub-line, shown
   *  only when neither a countdown nor a stalled line is present (cold-start, no
   *  usable estimate yet). Omitted ⇒ no fallback line. */
  detail?: string
  /** The COARSE remaining-wait estimate (MYT-102), already resolved (e.g. "2 min
   *  remaining"). Shown as the sub-line while a usable estimate holds; OMITTED on
   *  cold-start or once the estimate exhausts (then `stalledLabel` / `detail`
   *  take over). Mutually exclusive with `stalledLabel`. */
  countdownLabel?: string
  /** The indeterminate "still working" line (MYT-102) shown in place of the
   *  countdown once the estimate exhausts / the wait runs long — so the hold
   *  answers "has it broken?" and never implies a stuck bar. Already-resolved
   *  i18n; mutually exclusive with `countdownLabel`. */
  stalledLabel?: string
  /** Honour reduced motion — the figure's breathing pulse is dropped when true. */
  reducedMotion: boolean
}
