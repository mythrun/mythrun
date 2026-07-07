import type { BaseProps } from './index.ts'
import type { GraphEdge, GraphNode } from '../worldgen/graph-reducers.ts'
import type { ForceParams } from '../worldgen/force-sim.ts'
import type { DensityParams } from '../worldgen/label-tiers.ts'
import type { WorldGenStatusCardProps } from './world-gen-status.ts'

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
 * `displayId` callback (never a DOM event), `reducedMotion` is a plain boolean. No
 * className/style/raw DOM events. The Canvas itself is a raw leaf (Tailwind can't
 * reach it), so it is `aria-hidden` and the entity list carries all meaning.
 *
 * SELECTION ID-SPACE is `displayId` (BUG 2.1): node render-identity === edge
 * endpoint-space === `displayId` (the synthKey pre-finalize, the real entity UUID
 * after). Post-gen a `displayId` IS the entity id, so a consumer can share it
 * directly with an entity-keyed surface (e.g. the reveal wiki) with no bridge.
 *
 * TWO PHASES (§3.4). The DEFAULT is the GENERATION graph: a decorative fog layer
 * behind the mono-ink shape glyphs, a top-left status card, and NO entity list / NO
 * selection (that experience belongs to the reveal). The REVEAL opts in with
 * `interactive` — which turns on the accessible entity list + selection (Canvas tap
 * and list activation) and the on-glyph name labels.
 */
export interface WorldGenGraphProps extends Omit<BaseProps, 'children'> {
  /** The current node set (the folded entities, in chronological arrival order). */
  nodes: GraphNode[]
  /** The current edge set (the folded, resolved relationships). */
  edges: GraphEdge[]
  /** The `displayId` of the currently-selected entity, if any — reflected on the
   *  matching entity-list item (`aria-current`) and emphasised in the Canvas. */
  selectedKey?: string
  /** Fired when an entity is chosen (an entity-list item, or a fine-pointer Canvas
   *  tap). Neutral — carries the entity's `displayId`, never a DOM event. Only fires
   *  when `interactive` (the reveal); the generation graph is inert. */
  onSelect: (displayId: string) => void
  /** Honour the user's reduced-motion preference: no requestAnimationFrame churn
   *  loop, no buoy bob — the physics ticks to convergence once per `nodes`/`edges`
   *  change and the graph (and its fog) are drawn static (still accurate). */
  reducedMotion?: boolean
  /** GATE (§3.4). `false` (default) = the GENERATION graph: no entity list, no
   *  selection (Canvas taps are inert), no on-glyph labels. `true` = the REVEAL:
   *  renders the accessible entity list, wires selection (list + fine-pointer Canvas
   *  tap), and draws the name labels. Preserves the `displayId` selection contract —
   *  it is only GATED OFF during generation, never changed. */
  interactive?: boolean
  /** Draw the entity NAME beside each glyph. Default `true` — names show DURING
   *  generation too (MYT-89 audit #3), decoupled from `interactive`: the fog reserves a
   *  label-sized keep-out per node, so drawing the name closes that mismatch. Type stays
   *  conveyed by the glyph SHAPE (no type tag). Pass `false` for a bare mono-ink field. */
  showLabels?: boolean
  /** The world-gen status card (C4) shown top-left of the graph pane during
   *  generation. When provided, rendered as a DOM overlay over the fog + graph
   *  canvases; omit it (e.g. the reveal) to hide it. */
  status?: WorldGenStatusCardProps
  /** Drain NUMERATOR for the fog (how many entities have arrived). Defaults to
   *  `nodes.length` — the fog DRAINS as the graph fills (MYT-89 spawn-drain: fewer
   *  particles spawn in; the wind carries the rest off the pane). */
  shownEntities?: number
  /** Drain DENOMINATOR for the fog — the entity count at which the fog is fully
   *  gone (production: `MIN_EXPECTED_ENTITIES`, the DB-derived floor). At
   *  `shownEntities ≥ totalEntities` nothing respawns and the field empties;
   *  omitted / `0` disables the drain (the fog holds its base density). */
  totalEntities?: number
  /** Accessible label for the entity list — an i18n key the consumer resolves.
   *  Only used when `interactive`; the DS owns no copy (§ components-live-in-the-
   *  design-system), so the consuming app supplies the i18n'd value. */
  listLabel?: string
  /** Empty-state note shown in the list before any entity has streamed in — an
   *  i18n key the consumer resolves (the DS owns no copy). Only used when
   *  `interactive`. */
  emptyLabel?: string
  /** OVERRIDE the force-sim params (the spread knobs — charge, distanceMax, centre,
   *  boundary, collide, seed jitter, margin — plus the link CLUSTERING knobs, MYT-89
   *  untangle: link pull + rest length), merged over the locked `FORCE_PARAMS`
   *  defaults. The Storybook spread-tuning harness (MYT-89 audit #4) passes the live
   *  slider values so Miklos dials the exact feel; changing them RE-SEEDS the layout
   *  (fresh spread, not a merge). Production omits this — the locked defaults fill
   *  the space and group connected entities. */
  forceParams?: Partial<ForceParams>
  /** OVERRIDE the density knobs (MYT-89 density redesign — label tiering + virtual-
   *  space growth), merged over the locked `DENSITY_PARAMS`. The Storybook density-
   *  tuning harness passes live slider values (the SpreadTuning pattern); production
   *  omits this — the locked defaults keep a real ~46-entity generation readable. */
  densityParams?: Partial<DensityParams>
}
