import type { BaseProps } from './index.ts'
import type { StageProgress } from '@mythrun/contract/events'

// Re-export B4's per-stage progress shape off the same contract surface a consumer
// reads the props from (the wire type lives in `@mythrun/contract`; this render
// contract re-exposes it so a consumer imports `StageProgress` + the props from one
// place). This does NOT redefine it — it is the same `StageProgress` the stream
// (`useWorldGenStream`) already exposes.
export type { StageProgress } from '@mythrun/contract/events'

/**
 * The world-gen STATUS card (MYT-89 Phase C, C4 + the two-act cut) — a small DOM
 * overlay pinned to the top-left of the graph pane during the ENTITY-GENERATION act.
 * The pre-entity prep stretch (concept_intake → world_color → vocabulary_intake, the
 * first ~2 minutes) is NOT this card's job anymore — the two-act flow shows the
 * WorldGenLoading screen for it. This card turns the graph act into legible progress:
 * the current (running) stage's friendly label, a completed/total percent, and a
 * PAPER-REGISTER working indicator — a segmented SQUARE bar whose running cell pulses
 * (an opacity fade, the brand's only sanctioned motion). Hard brand rule: no circles,
 * no spinner, no dots. The indicator stops at 100%.
 *
 * It reads the stream's `stages[]` (the B4 `StageProgress[]`), advancing the fill of
 * a FIXED bar indicator seeded from the canonical `WATCHED_ENTITY_STAGES` slice of
 * the `WORLD_GEN_STAGES` taxonomy (MYT-89 audit ③ + reveal timing — all bars known
 * from frame one, not grown one per stage). The card renders ONLY the visible wait:
 * the graph-act stages through the wiki-reveal boundary (world_introduction, myth-zaqxh), so
 * the bars hit 100% exactly at the moment the reveal fires. Prep-stage entries match
 * no bar (the two-act loading screen owns that stretch) and SILENT TAIL entries
 * (entity_consolidation → embed_world) match no bar either — they run behind the
 * reveal and are nobody's wait. This is a DOM overlay (§3.3), NOT a canvas surface —
 * it composes over the C3 fog + C4 graph canvases.
 *
 * Platform-neutral (§9): `stages` is plain data; every label is an i18n KEY the
 * consumer resolves (the DS owns no copy). No className/style/DOM events. The card
 * positions itself `absolute` inside its host pane, so drop it into the graph pane's
 * `relative` container and it pins top-left. Cost is NOT rendered here (audit ⑥ — the
 * player never sees API spend; the dev ticker owns cost).
 */
export interface WorldGenStatusCardProps extends Omit<BaseProps, 'children'> {
  /** Layout variant (MYT-89 audit v2 — the mobile full-bleed fix). `overlay`
   *  (default) is the shipped desktop card: `absolute`, pinned top-left of the
   *  graph pane. `footer` is the narrow-viewport treatment: a compact full-width
   *  in-flow bar the graph places BELOW the pane (the pane goes full-bleed; the
   *  status never hovers over the world). Same substance either way — the
   *  running-stage label, the percent, the fixed segmented bars, the countdown —
   *  but the footer drops the framing caption (compactness is the point).
   *  WorldGenGraph sets this itself from its viewport regime; consumers normally
   *  omit it. */
  variant?: 'overlay' | 'footer'
  /** Per-stage progress from the stream (B4). Advances the FIXED bar indicator's
   *  fill: a canonical `WATCHED_ENTITY_STAGES` bar matches its stream entry's
   *  status, or is `pending` until it appears (prep-stage and silent-tail entries
   *  match no bar). The percent is `completedCount / watched-entity-count` (fixed
   *  denominator); the running entry marks the "current" stage. */
  stages: readonly StageProgress[]
  /** The COUNTDOWN line (already resolved, e.g. "Ready in about 4 min") — the
   *  consumer owns the tick, the AGGREGATE derivation (`remainingWaitMs` over
   *  the stage-timings history — the whole visible wait, not this act's slice),
   *  the coarse bucket wording, and the MONOTONIC clamp (`clampEtaMonotonic`:
   *  the shown number may hold, never climb — ux-run2 myth-uz1bn). Omitted →
   *  no countdown (cold-start / no history, or the estimate exhausted and
   *  `stalledLabel` stands in). Rendered `aria-hidden`: a churning line would
   *  be live-region noise — the determinate progressbar carries the progress
   *  semantics to AT. */
  countdownLabel?: string
  /** The degrade-in-language stand-in for an EXHAUSTED estimate (ux-run2
   *  myth-uz1bn: a frozen number never sits — "Still working…" replaces it).
   *  Shown in the countdown slot only when `countdownLabel` is absent; real
   *  content (a one-time state change), so NOT aria-hidden. */
  stalledLabel?: string
  /** The quiet return-to-the-calm-wait text link (ux-run2 myth-t11az — the live
   *  map must not be a one-way door). Rendered only when BOTH `returnLabel` and
   *  `onReturn` are supplied; the card is pointer-transparent chrome, so the
   *  link re-enables its own pointer events. */
  returnLabel?: string
  /** Pressed the return link — the consumer swaps back to the calm loading
   *  view. */
  onReturn?: () => void
  /** Map from raw stage id (`vocabulary_intake`) → an i18n'd FRIENDLY label the
   *  consumer resolves. An unmapped stage falls back to the card's `titleLabel` (its
   *  generic running caption) — with the full stage map supplied, that fallback is
   *  defensive only (the DS owns no copy, so it never invents a placeholder). */
  stageLabels?: Readonly<Record<string, string>>
  /** The resolved framing caption (e.g. "Weaving your world"); also the defensive
   *  fallback label for an unmapped stage id. */
  titleLabel: string
  /** The resolved label shown on the main line once every stage has completed (the
   *  100% "done" state). */
  doneLabel: string
  /** The resolved accessible name for the determinate progressbar. */
  progressLabel: string
}
