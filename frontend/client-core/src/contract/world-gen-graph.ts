import type { BaseProps } from './index.ts'
import type { GraphEdge, GraphNode } from '../worldgen/graph-reducers.ts'

// Re-export the graph model types so a consumer reads the node/edge shape off the
// same contract surface it reads the props from (the graph model lives in the
// DOM-free brain, `../worldgen`, but the render contract lives here).
export type { GraphNode, GraphEdge, GraphNodeState } from '../worldgen/graph-reducers.ts'

/**
 * The live streaming graph shown during world generation (MYT-89 Phase C, C4) —
 * the world-gen loading experience. Named entities stream in over ~10 minutes as
 * the prep pipeline runs; this renders them as a force-directed graph that grows
 * without ever resetting its layout, plus an ACCESSIBLE entity list (the a11y +
 * keyboard + touch-selection surface) beside the decorative Canvas.
 *
 * The parent (the world-gen screen / `useWorldGenStream`, C5) folds the SSE
 * `PipelineEvent` stream into `nodes`/`edges` and passes them as props — the fold
 * NEVER runs in the render loop. A `nodes`/`edges` change re-syncs the physics
 * (survivors keep their settled position; new entities fly in near centre).
 *
 * Platform-neutral (§9): `nodes`/`edges` are plain data, `onSelect` is a neutral
 * `synthKey` callback (never a DOM event), `reducedMotion` is a plain boolean. No
 * className/style/raw DOM events. The Canvas itself is a raw leaf (Tailwind can't
 * reach it), so it is `aria-hidden` and the entity list carries all meaning.
 */
export interface WorldGenGraphProps extends Omit<BaseProps, 'children'> {
  /** The current node set (the folded entities, in chronological arrival order). */
  nodes: GraphNode[]
  /** The current edge set (the folded, resolved relationships). */
  edges: GraphEdge[]
  /** The `synthKey` of the currently-selected entity, if any — reflected on the
   *  matching entity-list item (`aria-current`) and emphasised in the Canvas. */
  selectedKey?: string
  /** Fired when an entity is chosen (an entity-list item, or a fine-pointer Canvas
   *  tap). Neutral — carries the entity's `synthKey`, never a DOM event. */
  onSelect: (synthKey: string) => void
  /** Honour the user's reduced-motion preference: no requestAnimationFrame churn
   *  loop, no ambient ghost blooms — the physics ticks to convergence once per
   *  `nodes`/`edges` change and the graph is drawn static (still accurate). */
  reducedMotion?: boolean
  /** Accessible label for the entity list — an i18n key the consumer resolves.
   *  The Canvas is `aria-hidden`, so this list is the graph's whole accessible
   *  name. The DS owns no copy (§ components-live-in-the-design-system); the
   *  consuming app supplies the i18n'd value. */
  listLabel: string
  /** Empty-state note shown in the list before any entity has streamed in — an
   *  i18n key the consumer resolves (the DS owns no copy). */
  emptyLabel: string
}
