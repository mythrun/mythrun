import type { GraphNode } from './graph-reducers.ts'
import type { VirtualDims, VirtualGrowth } from './virtual-space.ts'

// Label tiering (MYT-89 density redesign): WHICH nodes wear their name at the current
// graph density. A real generation lands ~46 entities (measured across the dev worlds:
// ~22 locations / ~15 npcs / ~9 factions, ~63–81 relationships) and a full icon+label
// box is ~134×25 virtual px — at full load the boxes alone claim ~half the desktop
// virtual space and ~80% of a phone's, so "label everything" is GEOMETRICALLY unable
// to read. Instead the label set is tiered:
//
//   - ANCHORS (world / campaign / faction / pc) are ALWAYS labeled — the skeleton the
//     player orients by (~10 of a real gen's 46).
//   - Everything else (npc / location / item) is labeled by RECENCY within an
//     area-derived BUDGET: the newest arrivals wear names (the streaming beat — you
//     watch each new piece of your world get named), and older ones quietly retire to
//     glyph-only as the world outgrows the space. The reveal's entity list (and
//     tap/click-to-focus) carries the full enumeration.
//   - PINNED keys (the selection, the tap/click focus) are always labeled.
//
// An UNLABELED node keeps its glyph but drops to an icon-sized collision box and an
// icon-sized fog hole — that shrinkage is what returns the screen real estate. The
// box-collision guarantee is unchanged for every label that IS shown: a shown label's
// full box stays in the keep-out force, so shown text never overlaps other text/icons.
//
// Everything here is DETERMINISTIC GEOMETRY (a budget from an area, a stable ordering)
// — mechanical computation, no semantic judgment, so it lives in deterministic code
// under ZFC. Pure + DOM-free: unit-testable, shared by any render surface.

/** The density knobs (the SpreadTuning-harness pattern — NEW dials, the locked
 *  `FORCE_PARAMS` untouched): how many labels the space affords + how the virtual
 *  space GROWS with the node count. Threaded as a `Partial` override merged over
 *  `DENSITY_PARAMS`; production omits it (→ the locked defaults). */
export interface DensityParams {
  /** Virtual px² of graph space one shown label needs to breathe. The label budget is
   *  `floor(virtualArea / areaPerLabel)` — bigger = fewer, airier labels. */
  areaPerLabel: number
  /** The label budget never drops below this many (a tiny pane still names a few). */
  minLabels: number
  /** Node count at which the virtual space starts GROWING (density-aware growth):
   *  below it, `virtualDims` behaves exactly as shipped (the eye-approved desktop
   *  zoom); above it each node relaxes the wide-pane upscale toward 1:1. */
  growthStartCount: number
  /** Virtual px of reference-width growth per node past `growthStartCount`. The
   *  upscale never drops below 1:1 (the CSS-px legibility floor caps the growth). */
  growthPerNode: number
}

/** The LOCKED density defaults — tuned by eye against the realistic max-density
 *  fixture (46 nodes / 72 edges) at 1440 / 768 / 375. */
export const DENSITY_PARAMS: DensityParams = {
  areaPerLabel: 15000,
  minLabels: 6,
  growthStartCount: 16,
  growthPerNode: 40,
}

/** Slider envelopes for the density-tuning harness (mirrors `FORCE_PARAM_RANGES`). */
export const DENSITY_PARAM_RANGES = {
  areaPerLabel: { min: 3000, max: 30000, step: 500 },
  minLabels: { min: 0, max: 20, step: 1 },
  growthStartCount: { min: 4, max: 46, step: 1 },
  growthPerNode: { min: 0, max: 100, step: 5 },
} as const

/** The kinds that are ALWAYS labeled — the world's skeleton: the root container, the
 *  factions (the political map), and the players themselves. */
export const ANCHOR_KINDS: ReadonlySet<string> = new Set(['world', 'campaign', 'faction', 'pc'])

/** The density-aware growth input for `virtualDims`, derived from the CURRENT node
 *  count + the (possibly overridden) density knobs. ONE derivation both layers (graph
 *  + fog) call with the same count, so the C5 shared-space invariant holds while the
 *  space grows. */
export function growthFrom(
  nodeCount: number,
  params?: Partial<DensityParams>,
): VirtualGrowth {
  const p = { ...DENSITY_PARAMS, ...params }
  return { nodeCount, startCount: p.growthStartCount, perNode: p.growthPerNode }
}

/** How many labels the current virtual space affords: `(area − reservedArea) /
 *  areaPerLabel`, floored, never below `minLabels`. `reservedArea` is space no label
 *  can use — the status-card overlay's keep-out footprint. */
export function labelBudget(
  virtual: VirtualDims,
  params: DensityParams,
  reservedArea = 0,
): number {
  const usable = Math.max(0, virtual.width * virtual.height - reservedArea)
  return Math.max(params.minLabels, Math.floor(usable / params.areaPerLabel))
}

export interface LabelTierOptions {
  /** Keys (displayIds) that are labeled UNCONDITIONALLY — the selection and the
   *  tap/click focus. `undefined` entries are ignored (the no-selection idiom). */
  pinned?: readonly (string | undefined)[]
  /** Density-knob overrides, merged over `DENSITY_PARAMS` (the tuning harness). */
  params?: Partial<DensityParams>
  /** Virtual px² reserved by overlays labels can't use (the status card's keep-out) —
   *  subtracted from the budget's area so a phone whose card covers ~a quarter of the
   *  pane doesn't over-issue labels into the remaining space. */
  reservedArea?: number
}

/** Anchor priority within the budget: the root container first, then the players,
 *  then factions — the order labels survive a tight pane in. */
function anchorRank(kind: string): number {
  if (kind === 'world' || kind === 'campaign') return 0
  if (kind === 'pc') return 1
  return 2 // faction
}

/** The set of `displayId`s that wear a label at the current density. Pinned keys
 *  (selection / tap focus) are always labeled; the rest fill an area-derived BUDGET
 *  in priority order — anchors first (world/campaign, then pc, then factions), then
 *  every other kind by RECENCY (`lastEventIndex`, the fold's authoritative touch
 *  order; ties keep array order — `Array.prototype.sort` is stable). On a roomy pane
 *  the budget covers everything; on a phone it trims to the skeleton + the freshest
 *  arrivals. Deterministic: same nodes + same space + same pins → the same set. */
export function labeledDisplayIds(
  nodes: readonly GraphNode[],
  virtual: VirtualDims,
  options?: LabelTierOptions,
): ReadonlySet<string> {
  const params = { ...DENSITY_PARAMS, ...options?.params }
  const labeled = new Set<string>()
  for (const key of options?.pinned ?? []) {
    if (key !== undefined) labeled.add(key)
  }
  const anchors: GraphNode[] = []
  const others: GraphNode[] = []
  for (const node of nodes) {
    if (labeled.has(node.displayId)) continue
    if (ANCHOR_KINDS.has(node.kind)) anchors.push(node)
    else others.push(node)
  }
  anchors.sort(
    (a, b) => anchorRank(a.kind) - anchorRank(b.kind) || b.lastEventIndex - a.lastEventIndex,
  )
  others.sort((a, b) => b.lastEventIndex - a.lastEventIndex)
  const budget = labelBudget(virtual, params, options?.reservedArea ?? 0)
  for (const node of [...anchors, ...others].slice(0, Math.max(0, budget - labeled.size))) {
    labeled.add(node.displayId)
  }
  return labeled
}
