import type { BaseProps } from './index.ts'

/**
 * The world-gen LOADING screen (MYT-89 two-act generating flow, act one) — the
 * generic pre-entity surface shown while the prep stages (`PREP_STAGES` in
 * `@mythrun/contract/events`: concept_intake → world_color → vocabulary_intake)
 * run, BEFORE any entity exists to draw. No graph, no fog — the DS Spinner (the
 * brand's diagonal dither wave) over a single flavor line that CYCLES through
 * short playful loading messages every few seconds (Claude-Code-"thinking"
 * style), so the ~2-minute prep stretch reads as alive, not hung.
 *
 * When entities start streaming (the consumer detects the first entity stage /
 * the first node), `revealReady` flips true and the screen grows a REVEAL
 * button ("watch your world be born") — a deliberate beat: generation keeps
 * running regardless; pressing it just tells the consumer to swap to the graph
 * view (`onReveal`). The screen never transitions on its own.
 *
 * Reduced motion: the Spinner already degrades to its static dither; the flavor
 * CYCLER also respects `prefers-reduced-motion` — when reduced, the label holds
 * the first flavor line (no timed swapping).
 *
 * Platform-neutral (§9): every string is an i18n key the consumer resolves (the
 * DS owns no copy). No className/style/DOM events.
 */
export interface WorldGenLoadingProps extends Omit<BaseProps, 'children'> {
  /** The cycling flavor lines (already-resolved i18n strings). The label rotates
   *  through them in order (wrapping) every `intervalMs`. Empty → no flavor line
   *  (the Spinner still renders). Under reduced motion the first line holds. */
  flavorLabels: readonly string[]
  /** Milliseconds between flavor rotations. Default 3000 (the "every few
   *  seconds" beat). */
  intervalMs?: number
  /** i18n key: the Spinner's screen-reader label (the busy announcement — the
   *  flavor line is decorative; this carries the meaning to AT). */
  spinnerLabel?: string
  /** Entities have started streaming → show the reveal button. Default false
   *  (the pure prep act). */
  revealReady?: boolean
  /** i18n key: the reveal button's label (e.g. "watch your world be born"). */
  revealLabel?: string
  /** Pressed the reveal button — the consumer swaps to the graph view. */
  onReveal?: () => void
}
