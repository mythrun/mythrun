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
 * It reads the stream's `stages[]` (the B4 `StageProgress[]` from the first-frame
 * snapshot) + optional cumulative `costUsd`. This is a DOM overlay (§3.3), NOT a
 * canvas surface — it composes over the C3 fog + C4 graph canvases.
 *
 * Platform-neutral (§9): `stages`/`costUsd` are plain data; every label is an i18n
 * KEY the consumer resolves (the DS owns no copy). No className/style/DOM events. The
 * card positions itself `absolute` inside its host pane, so drop it into the graph
 * pane's `relative` container and it pins top-left.
 */
export interface WorldGenStatusCardProps extends Omit<BaseProps, 'children'> {
  /** Per-stage progress from the stream's first-frame snapshot (B4). The percent is
   *  `completed / total` over this array; the running entry is the "current" stage. */
  stages: readonly StageProgress[]
  /** Cumulative generation spend (the stream's `costUsd`). Rendered subtly (a
   *  dev/observability readout) when a number; `null`/omitted hides it. */
  costUsd?: number | null
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
