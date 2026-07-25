// SessionPreparing (myth-ep74g; MYT-102 timer revamp; ux-run2 myth-i2pdo) — the
// calm between-sessions hold shown while the start-flow hook backoff-polls a
// not-yet-startable session (prep_not_ready / reconcile_pending /
// session_ending). Presentational: an ambient breathing figure + line, an
// optional rotating WHISPER with its settled ledger, an optional coarse wait
// estimate / stalled line, and a permission-to-leave line (the consumer owns
// all timing + copy). Platform-neutral (§9): pure data, no DOM.
//
// MYT-102: the figure is an AMBIENT square (not the old full-width band, which
// read as a progress bar it never filled), and the sub-line answers "how long /
// has it broken?" — a coarse estimate while a baseline holds, the "still
// working" line once it exhausts, else the calm detail fallback.
//
// ux-run2 myth-i2pdo: the multi-minute wait gains texture — `whisperLabels`
// rotate every ~25s beneath the title (public-tier flavor only; prep content is
// spoiler surface), past lines settling into a faint ledger so the wait has
// visible history; `leaveLabel` grants explicit permission to step away.

/** Props for the between-sessions preparing hold. */
export interface SessionPreparingProps {
  /** The atmospheric line — a resolved key ("the DM is preparing the next
   *  session…"). Also the single AT source of truth (a polite live region). */
  label: string
  /** An optional quiet sub-line — a resolved key. The FALLBACK sub-line, shown
   *  only when neither a countdown nor a stalled line is present (cold-start, no
   *  usable estimate yet). Omitted ⇒ no fallback line. */
  detail?: string
  /** The COARSE remaining-wait estimate (MYT-102), already resolved (e.g.
   *  "Ready in about 2 min"). Shown as the sub-line while a usable estimate
   *  holds; OMITTED on cold-start or once the estimate exhausts (then
   *  `stalledLabel` / `detail` take over). Mutually exclusive with
   *  `stalledLabel`. */
  countdownLabel?: string
  /** The indeterminate "still working" line (MYT-102) shown in place of the
   *  countdown once the estimate exhausts / the wait runs long — so the hold
   *  answers "has it broken?" and never implies a stuck bar. Already-resolved
   *  i18n; mutually exclusive with `countdownLabel`. */
  stalledLabel?: string
  /** The rotating whisper lines (already-resolved i18n; ux-run2 myth-i2pdo) —
   *  PUBLIC-TIER table-setting flavor only, cycled ~25s in shuffled order, past
   *  lines settling into a faint ledger. Omitted/empty → no whisper column
   *  (the pre-run-2 anatomy). Under reduced motion the opening line holds. */
  whisperLabels?: readonly string[]
  /** Milliseconds between whisper rotations. Default 25000 (the "every
   *  20-30s" critique cadence). */
  whisperIntervalMs?: number
  /** The whisper shuffle's RNG — default `Math.random`; injectable so tests
   *  pin a deterministic cycle (the FogSim pattern; UI jitter, not game
   *  mechanics). */
  whisperRandom?: () => number
  /** The permission-to-leave line (already-resolved i18n, e.g. "Safe to leave.
   *  The table will be set when you return." — ux-run2 myth-i2pdo), quietly
   *  closing the hold. Real content (not aria-hidden); backed by the start
   *  flow's re-poll-on-return behavior. Omitted → no line. */
  leaveLabel?: string
  /** Honour reduced motion — the figure's breathing pulse is dropped when true. */
  reducedMotion: boolean
}
