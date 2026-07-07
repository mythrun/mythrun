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
  /** The per-second countdown line (already-resolved i18n string, e.g.
   *  "~4:37 left") — the consumer owns the 1s tick + the `~M:SS` formatting
   *  (from `remainingWaitMs`) and re-supplies this each second. Omitted →
   *  no countdown (cold-start / no timings history). Rendered `aria-hidden`:
   *  a line that changes every second would be live-region noise — the
   *  Spinner's `role="status"` + label carry the busy meaning to AT. */
  countdownLabel?: string
  /** i18n key: the Spinner's screen-reader label (the busy announcement — the
   *  flavor line is decorative; this carries the meaning to AT). */
  spinnerLabel?: string
  /** Entities have started streaming → show the watch button. Default false
   *  (the pure prep act). */
  watchReady?: boolean
  /** i18n key: the watch button's label (e.g. "watch your world be born"). */
  watchLabel?: string
  /** Pressed the watch button — the consumer swaps to the graph view. */
  onWatch?: () => void
}
