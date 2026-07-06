import type { BaseProps } from './index.ts'
import type { StageProgress } from '@mythrun/contract/events'

// Re-export B4's per-stage progress shape off the same contract surface a consumer
// reads the props from (the wire type lives in `@mythrun/contract`; this render
// contract re-exposes it so a consumer imports `StageProgress` + the props from one
// place). This does NOT redefine it — it is the same `StageProgress` the stream
// (`useWorldGenStream`) already exposes.
export type { StageProgress } from '@mythrun/contract/events'

/**
 * The world-gen STATUS card (MYT-89 Phase C, C4) — a small DOM overlay pinned to the
 * top-left of the graph pane during world generation. Named entities don't start
 * arriving for the first ~2 minutes (concept_intake → world_color → vocabulary_intake
 * run first), so without a readout the screen looks HUNG. This card turns that stretch
 * into legible progress: the current (running) stage's friendly label, a completed/
 * total percent, and a PAPER-REGISTER working indicator — a segmented SQUARE bar whose
 * running cell pulses (an opacity fade, the brand's only sanctioned motion). Hard brand
 * rule: no circles, no spinner, no dots. The indicator stops at 100%.
 *
 * It reads the stream's `stages[]` (the B4 `StageProgress[]`), advancing the fill of
 * a FIXED 11-bar loading indicator seeded from the canonical `WORLD_GEN_STAGES`
 * taxonomy (MYT-89 audit ③ — all bars known from frame one, not grown one per stage).
 * This is a DOM overlay (§3.3), NOT a canvas surface — it composes over the C3 fog +
 * C4 graph canvases.
 *
 * Platform-neutral (§9): `stages` is plain data; every label is an i18n KEY the
 * consumer resolves (the DS owns no copy). No className/style/DOM events. The card
 * positions itself `absolute` inside its host pane, so drop it into the graph pane's
 * `relative` container and it pins top-left. Cost is NOT rendered here (audit ⑥ — the
 * player never sees API spend; the dev ticker owns cost).
 */
export interface WorldGenStatusCardProps extends Omit<BaseProps, 'children'> {
  /** Per-stage progress from the stream (B4). Advances the FIXED 11-bar indicator's
   *  fill: a canonical `WORLD_GEN_STAGES` bar matches its stream entry's status, or is
   *  `pending` until it appears. The percent is `completedCount / 11` (fixed
   *  denominator); the running entry marks the "current" stage. */
  stages: readonly StageProgress[]
  /** i18n key (already resolved): a rough data-driven "time left" (e.g. `~3m left`),
   *  computed by the consumer from the stage-timings history. Omitted → no estimate
   *  (cold-start / no history), so the card shows just the bars. */
  etaLabel?: string
  /** Map from raw stage id (`vocabulary_intake`) → an i18n'd FRIENDLY label the
   *  consumer resolves. An unmapped stage falls back to a `[ph: <stage>]` placeholder
   *  (the DS owns no copy). */
  stageLabels?: Readonly<Record<string, string>>
  /** i18n key: the card's small framing caption (e.g. "Weaving your world"). */
  titleLabel?: string
  /** i18n key: the label shown on the main line once every stage has completed (the
   *  100% "done" state). */
  doneLabel?: string
  /** i18n key: the accessible name for the determinate progressbar. */
  progressLabel?: string
}
