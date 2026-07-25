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

// ── Label SLOTS (myth-uis1p; the declutter hardened in ux-run3 myth-k0sja) ─────────
// While the field is hot, label collisions are the COLLISION FORCE's problem — it
// resolves them by moving nodes, which is always better than flipping text around.
// Once a node is PINNED its position can no longer give way, so a label revealed
// or promoted on a pinned field (a tap focus, a selection, a tier re-issue) can
// find its east slot occupied by an immovable neighbour. For exactly those labels a
// SLOT is resolved: east if the east box is free, else west if west is free.
//
// Run 3 found the third branch was wrong. When neither side was free the old code
// fell back to east ANYWAY, printing one name straight through another: "The Well of
// Names" / "The Ward Refectory" landed in the same slot as an illegible smear, with
// two more pairs fused or touching, and — the tell — not one west-slotted label in
// either captured frame, because in a dense cluster the mirrored box usually lands on
// something else and the fallback swallowed it. Overprinting is the one outcome a
// declutter must never produce: two names in one slot is strictly worse than one name
// and one anonymous mark, because the second is still legible and still findable (the
// mark stays on the map and the name stays in the wiki index — the state the reveal's
// legend now documents).
//
// So the fallback is gone. A pinned label that fits neither slot is SUPPRESSED: it
// retires to a hollow mark and waits for a later reveal. Three further properties
// make the outcome trustworthy:
//   - AT MOST ONE LABEL PER SLOT, by construction: every committed label is written
//     into the field before the next candidate is tested, so no second name can be
//     granted a box that overlaps it.
//   - MINIMUM CLEARANCE: label-vs-label tests inflate the boxes vertically by
//     `LABEL_CLEARANCE_PAD`, so a pair that merely grazes (run 3's "Pigment Street" /
//     "The Sahara Ward", at the touching threshold) is separated too, not just a pair
//     that strictly intersects.
//   - DETERMINISM: candidates are resolved in a stable priority order (arrival first,
//     `synthKey` to break ties) rather than in array order, so the same world lays out
//     the same way every time — which is what makes the persisted layout (myth-aftau)
//     worth persisting.
//
// A resolved slot (or suppression) is STICKY while the label is worn: pinned nodes do
// not move, so re-deciding could only produce flicker. A retired label forgets both
// and is resolved fresh if it is ever promoted again.

/** Extra vertical clearance (px) enforced BETWEEN two labels — on top of the 25px
 *  clear box each already carries. Roughly half a line at the DS label size, which is
 *  what turns "these two boxes technically don't intersect" into "these two names read
 *  as separate lines". Applied only label-to-label: a label may still sit as close to
 *  an unlabeled glyph as the boxes allow. */
export const LABEL_CLEARANCE_PAD = 7

interface AbsBox {
  left: number
  right: number
  top: number
  bottom: number
}

function overlaps(a: AbsBox, b: AbsBox): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/** `box` inflated vertically by the minimum label-to-label clearance. */
function withClearance(box: AbsBox): AbsBox {
  return { ...box, top: box.top - LABEL_CLEARANCE_PAD, bottom: box.bottom + LABEL_CLEARANCE_PAD }
}

export interface SideChoiceInputs {
  nodes: readonly GraphNode[]
  /** displayId → current position (the sim's `positions()`). */
  positions: ReadonlyMap<string, { x: number; y: number }>
  labeled: ReadonlySet<string>
  /** The pin memory — only PINNED labels get a resolved slot (an unpinned label's
   *  collisions are still the force's to resolve). */
  pinned: ReadonlySet<string>
  /** Measured label text width at the DS label font (the caller's memoized measure). */
  widthOf: (name: string) => number
  /** The sticky side memory — MUTATED in place (pruned + extended). */
  sides: Map<string, LabelSide>
  /** The sticky SUPPRESSION memory (ux-run3) — MUTATED in place. displayIds whose
   *  label fits neither slot and must not be drawn; the caller subtracts these from
   *  the drawn label set, demoting the node to a hollow mark. */
  suppressed: Set<string>
}

/** Stable resolution order (ux-run3): oldest arrival first, `synthKey` breaking ties.
 *  Seniority is the fair priority — a place the player has already read keeps its
 *  slot, and a late arrival is the one that goes anonymous — and it is a pure function
 *  of the world, so the declutter is reproducible. */
function byPriority(nodes: readonly GraphNode[]): GraphNode[] {
  return [...nodes].sort(
    (a, b) => a.lastEventIndex - b.lastEventIndex || (a.synthKey < b.synthKey ? -1 : a.synthKey > b.synthKey ? 1 : 0),
  )
}

/** Prune retired slots, then resolve a slot for every labeled+pinned node that lacks
 *  one: east if free, else west if free, else SUPPRESSED (never an overprint). Tested
 *  against the live box field — every other node's box at its committed label
 *  state/side — with label-to-label tests inflated by `LABEL_CLEARANCE_PAD`. */
export function chooseLabelSides(inputs: SideChoiceInputs): void {
  const { nodes, positions, labeled, pinned, widthOf, sides, suppressed } = inputs
  for (const id of [...sides.keys()]) {
    if (!labeled.has(id)) sides.delete(id)
  }
  for (const id of [...suppressed]) {
    if (!labeled.has(id)) suppressed.delete(id)
  }
  const boxAt = (node: GraphNode, side: LabelSide, wears: boolean): AbsBox | undefined => {
    const p = positions.get(node.displayId)
    if (p === undefined) return undefined
    const b = nodeBoxExtents(node.kind, wears ? widthOf(node.name) : 0, wears, side)
    return { left: p.x + b.left, right: p.x + b.right, top: p.y + b.top, bottom: p.y + b.bottom }
  }
  // The field a candidate is tested against. A label box is RESERVED when it is
  // granted, never assumed: an unresolved candidate contributes only its glyph, so a
  // cluster of contenders doesn't lock every one of them out of the slot they are all
  // still competing for. Each entry also records whether it is a label (which earns
  // the clearance pad) and whether it can still GIVE WAY — an unpinned node is a
  // moving obstacle, and a moving obstacle must never force a permanent suppression.
  interface Occupant {
    box: AbsBox
    labeled: boolean
    movable: boolean
  }
  const field = new Map<string, Occupant>()
  for (const node of nodes) {
    const id = node.displayId
    const committed = sides.get(id)
    // Drawn label, box reserved: a resolved side, or a labeled node the force still
    // owns (unpinned — it will draw at the reference east while it settles).
    const wears = labeled.has(id) && !suppressed.has(id) && (committed !== undefined || !pinned.has(id))
    const box = boxAt(node, committed ?? 'e', wears)
    if (box !== undefined) field.set(id, { box, labeled: wears, movable: !pinned.has(id) })
  }
  /** Which occupants would a LABEL box here hit? Label-vs-label gets the
   *  minimum-clearance inflation; label-vs-glyph is the plain box test. */
  const blockers = (selfId: string, box: AbsBox): Occupant[] => {
    const padded = withClearance(box)
    const hits: Occupant[] = []
    for (const [id, other] of field) {
      if (id === selfId) continue
      if (overlaps(other.labeled ? padded : box, other.box)) hits.push(other)
    }
    return hits
  }
  for (const node of byPriority(nodes)) {
    const id = node.displayId
    if (!labeled.has(id) || !pinned.has(id) || sides.has(id) || suppressed.has(id)) continue
    const east = boxAt(node, 'e', true)
    if (east === undefined) continue
    const eastHits = blockers(id, east)
    if (eastHits.length === 0) {
      sides.set(id, 'e')
      field.set(id, { box: east, labeled: true, movable: false })
      continue
    }
    const west = boxAt(node, 'w', true)
    const westHits = west === undefined ? [{ movable: false } as Occupant] : blockers(id, west)
    if (west !== undefined && westHits.length === 0) {
      sides.set(id, 'w')
      field.set(id, { box: west, labeled: true, movable: false })
      continue
    }
    // Neither slot is free. If EVERY blocker can still move, the field is simply hot
    // here — leave the label unresolved (it draws at the reference east this frame and
    // is decided again once the neighbours settle), because a suppression is sticky and
    // must not be spent on a collision that is about to resolve itself.
    if ([...eastHits, ...westHits].every((hit) => hit.movable)) continue
    // Blocked by something immovable: the name retires to the wiki index and the mark
    // goes hollow — never a second name printed through the first.
    suppressed.add(id)
    const glyph = boxAt(node, 'e', false)
    if (glyph !== undefined) field.set(id, { box: glyph, labeled: false, movable: false })
  }
}
