import type { ForceSim } from '@mythrun/client-core/worldgen'
import type { GraphEdge, GraphNode } from '@mythrun/client-core/contract'
import { nodeBoxExtents, type LabelSide } from '../WorldGenFog/fog-obstacles.ts'

// Graph STABILITY (ux-run2 myth-uis1p) — the "fixed world being revealed" layer.
// Two independent squirm sources, one module:
//
//   1. IDENTITY-ONLY re-syncs. The parent folds nodes/edges per SSE event, but it
//      ALSO re-renders on unrelated state (a wiki-pane expansion, a selection),
//      handing the hook fresh array identities with identical content. The sync
//      effect used to re-sync the sim on every such render — and every sync
//      injects reheat alpha, so the settled constellation visibly jittered
//      whenever the RIGHT pane changed ("nodes jitter when the unrelated right
//      pane re-renders"). `graphSyncKey` fingerprints the CONTENT so the effect
//      can skip a re-sync whose graph hasn't actually changed.
//
//   2. LAYOUT MIGRATION under later passes. The force layout keeps annealing as
//      arrivals/edges reheat it, so a place the player had already seen NAMED
//      could wander to a new position minutes later — "for a feature sold as
//      'watch your world take shape,' a place that wanders is poison."
//      `pinSettledLabels` freezes each LABELED node at its current position
//      once the field has genuinely cooled (never mid-flight — a node pinned at
//      its seed position would freeze the layout unformed). New arrivals still
//      settle freely around the pinned constellation: the world may GROW; what
//      the player has seen placed does not move. The deliberate trade: pinned
//      nodes no longer migrate toward their communities on later edge reheats —
//      positional stability outranks crossing minimisation once a name is worn.
//      A pinned node stays pinned even if its label later retires (the tier
//      budget breathes; the place must not). Drag stays live: dragging
//      overwrites the pin while held; the reveal's release-reheat unpins, lets
//      the node fly home, and the cooled field re-pins it where it lands.

/** The sim alpha below which the field counts as SETTLED — labels are pinned
 *  only under this. Cooling from the hottest reheat (0.8) takes ~2s of ticks
 *  to get here, so a pin always captures a rested position. */
export const PIN_SETTLE_ALPHA = 0.05

/** A content fingerprint of the folded graph — same graph, same key, whatever
 *  the array identities. Every field the sync path consumes participates (a
 *  finalize's displayId swap or a fold's lastEventIndex touch must re-sync). */
export function graphSyncKey(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string {
  const n = nodes
    .map((x) => `${x.synthKey}|${x.displayId}|${x.kind}|${x.name}|${x.state}|${String(x.lastEventIndex)}`)
    .join('¶')
  const e = edges
    .map((x) => `${x.synthKey}|${x.from}|${x.to}|${x.relationship}|${x.sourceStage}|${String(x.arrivalIndex)}`)
    .join('¶')
  return `${n}#${e}`
}

/** Pin every labeled-but-unpinned node at its CURRENT position, iff the field
 *  has cooled below `PIN_SETTLE_ALPHA`. Idempotent per node (`pinned` is the
 *  caller-owned memory); a hot field is a no-op, so calling this every frame is
 *  one `alpha()` read while the layout is still forming. Returns how many nodes
 *  were NEWLY pinned this call — a non-zero return is the caller's cue to pick
 *  label sides + re-push collision boxes for the fresh pins. */
export function pinSettledLabels(
  sim: Pick<ForceSim, 'alpha' | 'positions' | 'pin'>,
  labeled: ReadonlySet<string>,
  pinned: Set<string>,
): number {
  if (sim.alpha() >= PIN_SETTLE_ALPHA) return 0
  const positions = sim.positions()
  let fresh = 0
  for (const id of labeled) {
    if (pinned.has(id)) continue
    const p = positions.get(id)
    if (p === undefined) continue
    sim.pin(id, p.x, p.y)
    pinned.add(id)
    fresh += 1
  }
  return fresh
}

// ── Candidate label SIDES (myth-uis1p) ────────────────────────────────────────────
// While the field is hot, label collisions are the COLLISION FORCE's problem — it
// resolves them by moving nodes, which is always better than flipping text around.
// Once a node is PINNED its position can no longer give way, so a label revealed
// or promoted on a pinned field (a tap focus, a selection, a tier re-issue) can
// find its east slot occupied by an immovable neighbour. For exactly those labels
// the side is CHOSEN: east if the east box is free, else west if west is free,
// else east (the reference fallback). A chosen side is STICKY while the label is
// worn (no flapping); a retired label forgets its side and chooses fresh if it is
// ever promoted again.

interface AbsBox {
  left: number
  right: number
  top: number
  bottom: number
}

function overlaps(a: AbsBox, b: AbsBox): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

export interface SideChoiceInputs {
  nodes: readonly GraphNode[]
  /** displayId → current position (the sim's `positions()`). */
  positions: ReadonlyMap<string, { x: number; y: number }>
  labeled: ReadonlySet<string>
  /** The pin memory — only PINNED labels get a chosen side (an unpinned label's
   *  collisions are still the force's to resolve). */
  pinned: ReadonlySet<string>
  /** Measured label text width at the DS label font (the caller's memoized measure). */
  widthOf: (name: string) => number
  /** The sticky side memory — MUTATED in place (pruned + extended). */
  sides: Map<string, LabelSide>
}

/** Prune retired sides, then choose a side for every labeled+pinned node that
 *  lacks one — first collision-free slot, east preferred, tested against the
 *  live box field (every other node's box at its current label state/side). */
export function chooseLabelSides(inputs: SideChoiceInputs): void {
  const { nodes, positions, labeled, pinned, widthOf, sides } = inputs
  for (const id of [...sides.keys()]) {
    if (!labeled.has(id)) sides.delete(id)
  }
  const boxAt = (node: GraphNode, side: LabelSide): AbsBox | undefined => {
    const p = positions.get(node.displayId)
    if (p === undefined) return undefined
    const wears = labeled.has(node.displayId)
    const b = nodeBoxExtents(node.kind, wears ? widthOf(node.name) : 0, wears, side)
    return { left: p.x + b.left, right: p.x + b.right, top: p.y + b.top, bottom: p.y + b.bottom }
  }
  // The current field: every OTHER node's box at its committed state.
  const field = new Map<string, AbsBox>()
  for (const node of nodes) {
    const box = boxAt(node, sides.get(node.displayId) ?? 'e')
    if (box !== undefined) field.set(node.displayId, box)
  }
  const collides = (selfId: string, box: AbsBox): boolean => {
    for (const [id, other] of field) {
      if (id !== selfId && overlaps(box, other)) return true
    }
    return false
  }
  for (const node of nodes) {
    const id = node.displayId
    if (!labeled.has(id) || !pinned.has(id) || sides.has(id)) continue
    const east = boxAt(node, 'e')
    if (east === undefined) continue
    if (!collides(id, east)) {
      sides.set(id, 'e')
      field.set(id, east)
      continue
    }
    const west = boxAt(node, 'w')
    const side: LabelSide = west !== undefined && !collides(id, west) ? 'w' : 'e'
    sides.set(id, side)
    field.set(id, (side === 'w' ? west : east) ?? east)
  }
}
