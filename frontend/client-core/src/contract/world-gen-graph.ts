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
 * without ever resetting its layout.
 *
 * The parent (the world-gen screen / `useWorldGenStream`, C5) folds the SSE
 * `PipelineEvent` stream into `nodes`/`edges` and passes them as props — the fold
 * NEVER runs in the render loop. A `nodes`/`edges` change re-syncs the physics
 * (survivors keep their settled position; new entities fly in near centre).
 *
 * Platform-neutral (§9): `nodes`/`edges` are plain data, `onSelect` is a neutral
 * `displayId` callback (never a DOM event), `reducedMotion` is a plain boolean. No
 * className/style/raw DOM events. The Canvas itself is a raw leaf (Tailwind can't
 * reach it) and is `aria-hidden` — decorative on every surface (the reveal's
 * accessible browse surface is the WIKI; the audit-v3 cut removed the graph-side
 * entity list, and the deeper graph-a11y story belongs to Phase E).
 *
 * SELECTION ID-SPACE is `displayId` (BUG 2.1): node render-identity === edge
 * endpoint-space === `displayId` (the synthKey pre-finalize, the real entity UUID
 * after). Post-gen a `displayId` IS the entity id, so a consumer can share it
 * directly with an entity-keyed surface (e.g. the reveal wiki) with no bridge.
 *
 * TWO PHASES (§3.4). The DEFAULT is the GENERATION graph: a decorative fog layer
 * behind the mono-ink shape glyphs, a top-left status card, and NO selection
 * (that experience belongs to the reveal). The REVEAL opts in with `interactive`
 * — which wires selection (a fine-pointer Canvas tap / a coarse-pointer tap).
 */
export interface WorldGenGraphProps extends Omit<BaseProps, 'children'> {
  /** The current node set (the folded entities, in chronological arrival order). */
  nodes: GraphNode[]
  /** The current edge set (the folded, resolved relationships). */
  edges: GraphEdge[]
  /** The `displayId` of the currently-selected entity, if any — emphasised in
   *  the Canvas (raised glyph, pinned label). */
  selectedKey?: string
  /** Fired when an entity is chosen (a Canvas tap). Neutral — carries the
   *  entity's `displayId`, never a DOM event. Only fires when `interactive`
   *  (the reveal); the generation graph is inert. */
  onSelect: (displayId: string) => void
  /** Honour the user's reduced-motion preference: no requestAnimationFrame churn
   *  loop, no buoy bob — the physics ticks to convergence once per `nodes`/`edges`
   *  change and the graph (and its fog) are drawn static (still accurate). */
  reducedMotion?: boolean
  /** GATE (§3.4). `false` (default) = the GENERATION graph: no selection (Canvas
   *  taps are inert). `true` = the REVEAL: wires selection (a Canvas tap).
   *  Preserves the `displayId` selection contract — it is only GATED OFF during
   *  generation, never changed. */
  interactive?: boolean
  /** Whether the T1b pannable CAMERA may engage when the world outgrows the pane
   *  (MYT-89 audit v3). Default `true` — the shipped geometric behavior (phones
   *  at real density pan). The DESKTOP REVEAL passes `false`: its pane is a true
   *  half of the screen and must FILL, never pan — the seat derivation is zeroed,
   *  so world === view at every density and labels tier down by budget instead.
   *  A LAYOUT-CONTEXT gate at the prop seam (the camera math itself is locked):
   *  the consumer states the regime; the sim never sniffs viewports. */
  pannable?: boolean
  /** Fill the HOST-provided height instead of the graph's own viewport-clamp
   *  height (MYT-89 audit v3). Default `false` — the shipped
   *  `clamp(18rem,62dvh,46rem)` pane. The REVEAL passes `true` on BOTH
   *  breakpoints (audit v4): desktop, the RevealPanes row owns the vertical
   *  space and the pane flexes to fill its half; narrow, the FullBleedStage
   *  owns the viewport below the header and the pane must reach the fold (the
   *  v3 `!narrow` gate left the mobile reveal on the 62dvh clamp — the pane
   *  stopped two-thirds down the screen). The host MUST provide a definite
   *  height. */
  fillHost?: boolean
  /** The FORCEFUL settle regime (MYT-89 audit v4 — the reveal's detangle).
   *  Default `false`: the generating act's ambient physics, byte-identical
   *  (parity-pinned). `true` (the REVEAL, both breakpoints): the sim runs the
   *  `REVEAL_FORCE_PARAMS` profile — a stiffer link equilibrium that converges
   *  the cold one-shot settle to fewer crossings and visibly holds its shape —
   *  and a node DRAG releases back to the simulation on drop (never left
   *  pinned): the release injects a hot reheat so the layout re-asserts and the
   *  dragged node snaps back into its community. A LAYOUT-CONTEXT gate at the
   *  prop seam (the locked params and the camera/drag math are untouched): the
   *  consumer states the regime. Explicit `forceParams` still win over the
   *  profile (the tuning harness dials the regime live). */
  forcefulSettle?: boolean
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
  /** SR-ONLY accessible model for the GENERATION graph (MYT-89 Phase E, E1). The
   *  node/edge canvases are `aria-hidden` decoration, so a screen-reader user is
   *  otherwise cut off from the whole generation act. When provided (the
   *  generation route passes it; the reveal omits it), the graph renders a
   *  `VisuallyHidden` `aria-live="polite"` region announcing progress plus a
   *  hidden list of the entities discovered so far. All strings arrive RESOLVED
   *  (the DS owns no copy). Presence — not `interactive` — gates the announcer,
   *  so it never renders on the reveal. */
  generationA11y?: GenerationA11y
  /** SR-ONLY aria-label for the REVEAL graph's roving hidden node list (E2) — the
   *  keyboard path that selects a graph node when the canvas itself is
   *  `aria-hidden`. Provided (resolved) on the interactive reveal; omitted during
   *  generation. The list is rendered only when `interactive` AND this label is
   *  supplied. */
  nodeListLabel?: string
  /** RESOLVED kind → label copy for the graph's GLYPH LEGEND (myth-466cy). The graph
   *  encodes an entity's kind in its glyph SHAPE; when this map is supplied a quiet
   *  key renders beneath the pane documenting the shapes for the kinds actually
   *  present (the same i18n labels the wiki's group headings speak — one map, no
   *  drift). Omit it (the generation graph) and no legend renders. The DS owns no
   *  copy: a kind absent from the map is left out of the key. */
  legend?: GraphLegendLabels
}

/** A resolved kind → display-label map for the graph legend (myth-466cy). Keyed by
 *  entity kind (`faction`/`location`/`npc`/`item`, plus `pc`/`world` when a world
 *  carries them); values are i18n'd strings the consumer supplies (the DS owns no
 *  copy). A kind with no entry is omitted from the key. */
export type GraphLegendLabels = Partial<Record<string, string>>

/**
 * The GENERATION graph's screen-reader model (MYT-89 Phase E, E1). Every field is
 * a RESOLVED string (the DS owns no copy). The consumer composes `phaseLabel` from
 * the running stage and `entitiesLabel` from the arrived count; the graph decides
 * WHEN each is announced (a stage change flushes immediately; an entity burst is
 * coalesced) so a 20-entity flurry never machine-guns the reader.
 */
export interface GenerationA11y {
  /** aria-label for the SR-only list of entities discovered so far. */
  entityListLabel: string
  /** The current generation-phase label — a CHANGE flushes the live region at
   *  once, so a stage transition is never delayed behind the entity-count
   *  coalescer. */
  phaseLabel: string
  /** The running entity tally (count interpolated) — CHANGES here are coalesced
   *  (trailing-debounced) so an entity burst announces once, not once per
   *  arrival. */
  entitiesLabel: string
}
