// SessionPreparing (myth-ep74g) — the calm between-sessions hold shown while the
// start-flow hook backoff-polls a not-yet-startable session (prep_not_ready /
// reconcile_pending / session_ending). Presentational: it renders an atmospheric
// figure + line and owns no timing (the hook owns the poll). Platform-neutral (§9):
// pure data, no DOM types.

/** Props for the between-sessions preparing hold. */
export interface SessionPreparingProps {
  /** The atmospheric line — a resolved key ("the DM is preparing the next
   *  session…"). Also the single AT source of truth (a polite live region). */
  label: string
  /** An optional quiet sub-line — a resolved key. Omitted ⇒ label only. */
  detail?: string
  /** Honour reduced motion — the figure's breathing pulse is dropped when true. */
  reducedMotion: boolean
}
