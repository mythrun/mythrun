import type { BaseProps } from './index.ts'

/**
 * The world-gen LOADING screen (MYT-89 two-act generating flow, act one) — the
 * generic pre-entity surface shown while the prep stages (`PREP_STAGES` in
 * `@mythrun/contract/events`: concept_intake → world_color → vocabulary_intake)
 * run, BEFORE any entity exists to draw. No graph, no fog — the DS Spinner (the
 * brand's diagonal dither wave) over a single flavor line that CYCLES through
 * short playful loading messages every few seconds (Claude-Code-"thinking"
 * style), so the ~2-minute prep stretch reads as alive, not hung. The cycle is
 * RANDOM (MYT-89 waiting-feedback): a shuffled permutation walked to
 * exhaustion, re-shuffled with no immediate repeat across the boundary — never
 * the listed order. Below the flavor line, an optional per-second COUNTDOWN
 * (`countdownLabel`, the consumer-ticked `~M:SS` to the wiki reveal) keeps the
 * player holding an expectation of how much longer, at all times.
 *
 * When entities start streaming (the consumer detects the first entity stage /
 * the first node), `watchReady` flips true and the screen grows a WATCH
 * button ("watch your world be born") — a deliberate beat: generation keeps
 * running regardless; pressing it just tells the consumer to swap to the graph
 * view (`onWatch`). The screen never transitions on its own. (Formerly the
 * "reveal" button — renamed for MYT-89 reveal timing: "reveal" now names the
 * wiki-reveal moment at the connection-weaving boundary, not this graph-entry
 * beat.)
 *
 * Reduced motion: the Spinner already degrades to its static dither; the flavor
 * CYCLER also respects `prefers-reduced-motion` — when reduced, the label holds
 * the first flavor line (no timed swapping).
 *
 * Platform-neutral (§9): every string is an i18n key the consumer resolves (the
 * DS owns no copy). No className/style/DOM events.
 */
export interface WorldGenLoadingProps extends Omit<BaseProps, 'children'> {
  /** The cycling flavor lines (already-resolved i18n strings). The label walks
   *  a RANDOM permutation of them every `intervalMs` (re-shuffled when
   *  exhausted; no immediate repeat across the boundary). Empty → no flavor
   *  line (the Spinner still renders). Under reduced motion the opening line
   *  holds (no timed swapping). */
  flavorLabels: readonly string[]
  /** Milliseconds between flavor rotations. Default 3000 (the "every few
   *  seconds" beat). */
  intervalMs?: number
  /** The shuffle's RNG — default `Math.random`. Injectable so tests pin a
   *  deterministic cycle (the FogSim pattern). UI jitter, not game mechanics:
   *  the ZFC/no-random rule governs dice, not flavor order. */
  random?: () => number
  /** The REAL-EVENT accretion level (0..1) driving the dither mark's quantized
   *  fill (ux-run2 myth-i2pdo — `worldGenAccretion`: completed stages + arrived
   *  entities over the expected total, so structural resolution means work
   *  happened and stillness means stillness). At 0 (or omitted) the mark runs
   *  the faint IDLE shimmer instead (ux-run3 myth-c96rf) — nearly blank but
   *  alive, everywhere emptier than any accretion state, so the first real
   *  event reads as a beginning, never a reset. */
  accretion?: number
  /** The permission-to-leave line (already-resolved i18n, e.g. "Safe to leave.
   *  The world keeps forming." — ux-run2 myth-i2pdo), quietly closing the
   *  screen. Real content (not aria-hidden); backed by real product behavior
   *  (re-entry lands back on this wait with progress intact). Omitted → no
   *  line. */
  leaveLabel?: string
  /** The concrete hold promise paired directly under the leave line (ux-run3
   *  myth-b965d — permission without a resumption promise left the loop open),
   *  e.g. "We'll hold it right here for you." Same quiet mono register; real
   *  content. Omitted → no line. */
  holdLabel?: string
  /** The countdown line (already-resolved i18n string, e.g. "Ready in about
   *  4 min") — the consumer owns the tick, the AGGREGATE derivation (the whole
   *  visible wait — the same budget the act-two status card shows), the coarse
   *  bucket wording, and the MONOTONIC clamp (ux-run2 myth-uz1bn: the number
   *  may hold, never climb). Omitted → no countdown (cold-start / no timings
   *  history, or `stalledLabel` stands in). Rendered `aria-hidden`: a churning
   *  line would be live-region noise — the Spinner's `role="status"` + label
   *  carry the busy meaning to AT. */
  countdownLabel?: string
  /** The degrade-in-language stand-in for an EXHAUSTED estimate (ux-run2
   *  myth-uz1bn: a frozen number never sits — "Still working…" replaces it).
   *  Shown in the countdown slot only when `countdownLabel` is absent; real
   *  content (a one-time state change), so NOT aria-hidden. */
  stalledLabel?: string
  /** i18n key: the accreting mark's screen-reader label (the busy announcement
   *  — the flavor line is decorative; this carries the meaning to AT). Named
   *  for the Spinner it once labelled; the mark is now the accretion-driven
   *  dither square (ux-run2 myth-i2pdo). */
  spinnerLabel?: string
  /** Entities have started streaming → show the watch button. Default false
   *  (the pure prep act). */
  watchReady?: boolean
  /** The watch button's label (a resolved i18n string, e.g. "Watch it take
   *  shape") — the consumer passes it (MYT-100 made it required; the DS owns no
   *  copy). Rendered only when `watchReady`. */
  watchLabel: string
  /** Pressed the watch button — the consumer swaps to the graph view. */
  onWatch?: () => void
}
