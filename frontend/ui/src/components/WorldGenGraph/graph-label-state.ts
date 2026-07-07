import {
  labeledDisplayIds,
  type DensityParams,
  type NodeBox,
  type StaticKeepOut,
  type VirtualDims,
} from '@mythrun/client-core/worldgen'
import type { ForceSim } from '@mythrun/client-core/worldgen'
import type { GraphNode } from '@mythrun/client-core/contract'
import { nodeBoxExtents } from '../WorldGenFog/fog-obstacles.ts'
import { cardKeepOut } from './canvas-util.ts'

// Label-tier state for the WorldGenGraph Canvas (MYT-89 density redesign), split from
// use-graph-canvas.ts (the module-size rail). Two pieces:
//
//   1. `refreshLabeled` — recompute WHICH nodes wear their name (the deterministic
//      tier from client-core's `labeledDisplayIds`: anchors + the freshest arrivals
//      within the area budget + the selection/focus pins) into the hook's ref. Called
//      whenever an input moves: a graph change, a virtual-dims change (the budget is
//      area-derived), a selection, a tap/click focus.
//   2. `measureNodeBoxes` — each node's CURRENT keep-out box for the force-sim's
//      rectangular collide: the full icon+label box when the name is worn, the
//      icon-only box when it isn't (`nodeBoxExtents`, the SAME fork the fog obstacle
//      goes through). The shrink of unlabeled boxes is what returns the screen real
//      estate at real density (~46 entities); the no-overlap guarantee for every
//      SHOWN label is unchanged — a worn name's full box stays in the collision set.

/** The refs `refreshLabeled` reads/writes — the hook's useLatest idiom threaded as a
 *  bundle so the recompute can run from effects AND imperative pointer callbacks. */
export interface LabelStateRefs {
  nodesRef: React.RefObject<GraphNode[]>
  virtualRef: React.RefObject<VirtualDims>
  selectedRef: React.RefObject<string | undefined>
  /** The sticky tap/click focus — always labeled while set. */
  focusRef: React.RefObject<string | null>
  densityRef: React.RefObject<Partial<DensityParams>>
  /** The current status-card keep-out (or null) — its area is RESERVED: subtracted
   *  from the label budget's space, so a phone whose card covers ~a quarter of the
   *  pane doesn't over-issue labels into what's left. */
  keepOutRef: React.RefObject<StaticKeepOut | null>
  labeledRef: { current: ReadonlySet<string> }
}

/** The px² a keep-out rect reserves (0 for none). */
function reservedArea(keepOut: StaticKeepOut | null): number {
  if (keepOut === null) return 0
  return Math.max(0, keepOut.right - keepOut.left) * Math.max(0, keepOut.bottom - keepOut.top)
}

/** Recompute the labeled set from the CURRENT nodes/space/pins into `labeledRef`. */
export function refreshLabeled(refs: LabelStateRefs): void {
  refs.labeledRef.current = labeledDisplayIds(refs.nodesRef.current, refs.virtualRef.current, {
    pinned: [refs.selectedRef.current, refs.focusRef.current ?? undefined],
    params: refs.densityRef.current,
    reservedArea: reservedArea(refs.keepOutRef.current),
  })
}

/** Measure each node's keep-out box (keyed by `displayId` for `ForceSim.setBoxes`) at
 *  its CURRENT label state. Labeled → the icon+label box, its text width measured at
 *  the resolved DS label font (the SAME string the fog measures and the label is drawn
 *  in) and memoized by name; unlabeled → the icon-only box (no text measure needed).
 *  Both go through the fog-shared `nodeBoxExtents`, so the graph collides on the EXACT
 *  box the fog reserves. */
export function measureNodeBoxes(
  ctx: CanvasRenderingContext2D,
  nodes: readonly GraphNode[],
  labeled: ReadonlySet<string>,
  widthCache: Map<string, number>,
  labelFont: string,
): Map<string, NodeBox> {
  ctx.font = labelFont
  const out = new Map<string, NodeBox>()
  for (const node of nodes) {
    const wearsLabel = labeled.has(node.displayId)
    let width = 0
    if (wearsLabel) {
      const cached = widthCache.get(node.name)
      width = cached ?? ctx.measureText(node.name).width
      if (cached === undefined) widthCache.set(node.name, width)
    }
    out.set(node.displayId, nodeBoxExtents(node.kind, width, wearsLabel))
  }
  return out
}

/** Everything `syncCardKeepOut` reads — the hook threads its live refs through. */
export interface KeepOutSyncDeps {
  canvas: HTMLCanvasElement | null
  sim: ForceSim | null
  /** The status-card overlay element, or null (no card — e.g. the reveal). */
  card: HTMLElement | null
  virtual: VirtualDims
  labelRefs: LabelStateRefs
  settledRef: { current: boolean }
}

/** Measure the status-card overlay (when present) into a CENTRED-virtual keep-out rect
 *  and hand it to the sim — nodes are shoved out from under the card, so no entity
 *  name spends the generation occluded (MYT-89 density redesign). Sub-pixel-jitter
 *  guarded: `setKeepOuts` reheats, so it only runs when the card's measured box
 *  actually MOVES (tracked in `labelRefs.keepOutRef`, which also feeds the label
 *  budget's reserved area). No card → clears any keep-out. */
export function syncCardKeepOut(deps: KeepOutSyncDeps): void {
  const { canvas, sim, card, virtual, labelRefs, settledRef } = deps
  if (sim === null || canvas === null) return
  const lastRef = labelRefs.keepOutRef
  if (card === null) {
    if (lastRef.current !== null) {
      lastRef.current = null
      sim.setKeepOuts([])
      refreshLabeled(labelRefs) // reserved area freed → the label budget re-grows
      settledRef.current = false
    }
    return
  }
  const canvasRect = canvas.getBoundingClientRect()
  if (canvasRect.width <= 1) return // unmeasured (jsdom) — nothing to map against
  const next = cardKeepOut(canvasRect, card.getBoundingClientRect(), virtual)
  const last = lastRef.current
  const moved =
    last === null ||
    Math.abs(next.left - last.left) > 0.5 ||
    Math.abs(next.top - last.top) > 0.5 ||
    Math.abs(next.right - last.right) > 0.5 ||
    Math.abs(next.bottom - last.bottom) > 0.5
  if (!moved) return
  lastRef.current = next
  sim.setKeepOuts([next])
  refreshLabeled(labelRefs) // the reserved area changes the label budget
  settledRef.current = false // a reduced-motion graph re-settles around the card
}
