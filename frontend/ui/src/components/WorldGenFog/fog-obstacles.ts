import {
  ENTITY_SIZE,
  LABEL_CAP_Y_OFFSET,
  LABEL_CLEAR_PAD,
  type FogObstacle,
  type NodeBox,
} from '@mythrun/client-core/worldgen'

// Pure obstacle GEOMETRY for the world-gen fog shell (MYT-89 C3). Turns an entity's
// virtual-space anchor + its measured label width into the single `FogObstacle` box
// FogSim streams around. Kept DOM-free (the `measureText` that yields `textWidth`
// lives in the shell) so the box math is unit-testable in isolation.
//
// A FogObstacle box couples TWO things the reference kept a hair apart: the doublet
// LINE (the fog-avoidance capsule the fog routes around, along the box MIDLINE) and
// the density CLEAR window (the box top→bottom, so fog never covers the text). In the
// reference the capsule sits at `y = anchorY - 3` while the clear window is
// `[anchorY - 16, anchorY + 9]` — whose centre is `anchorY - 3.5`, a HALF-PIXEL below
// the capsule. One box can't honour both exactly, so we anchor the box on the CAPSULE
// (the doublet midline lands exactly on it — that drives the visible fog routing) and
// let the clear window land within 0.5px of `[-16, +9]` around the baseline. Both the
// 0.5px midline shift and the 0.5px window shift are sub-cell (< CELL_PX) and
// imperceptible; the brief's "MIDLINE lands on the capsule, top/bottom encode the
// ~[-16,+9] window" pins exactly this reconciliation.

/** The reference marker size (px) for an entity kind: FACTION / NPC each get a bespoke
 *  size, everything else (LOCATION / ITEM / PC / unknown) the default. */
export function markerSize(kind: string): number {
  if (kind === 'FACTION') return ENTITY_SIZE.FACTION
  if (kind === 'NPC') return ENTITY_SIZE.NPC
  return ENTITY_SIZE.DEFAULT
}

/** The full vertical extent (px) of the clear box = the top pad + the bottom pad of the
 *  reference `[-16, +9]` window (16 + 9 = 25). */
const CLEAR_HEIGHT = LABEL_CLEAR_PAD.yTop + LABEL_CLEAR_PAD.yBottom

/**
 * The icon+label box for one entity kind + measured text width, as SIGNED extents RELATIVE
 * to the marker anchor (the icon centre) — the box the fog reserves AND the box the graph's
 * force-sim collides on (`NodeBox`). ONE definition, so collision + fog are consistent (a
 * label can never overlap a neighbour's icon or text — MYT-89 re-audit). The box is OFFSET
 * from the anchor: it spans the reference capsule horizontally (`-sz/2` → `sz + textWidth`,
 * so it extends much further RIGHT — the label sits to the right of the icon) and is centred
 * on the capsule midline `-LABEL_CAP_Y_OFFSET` (slightly ABOVE the anchor), its top/bottom
 * encoding the ~`[-16, +9]` clear window. Pure — no anchor, no motion — so both consumers
 * translate it by their own position.
 */
export function labelBoxExtents(kind: string, textWidth: number): NodeBox {
  const sz = markerSize(kind)
  const midY = -LABEL_CAP_Y_OFFSET
  return {
    left: -sz / 2,
    right: sz + textWidth,
    top: midY - CLEAR_HEIGHT / 2,
    bottom: midY + CLEAR_HEIGHT / 2,
  }
}

/**
 * Build the `FogObstacle` box for one entity — the shared `labelBoxExtents` translated to
 * the marker anchor (virtual space), plus the box's PER-SUB-STEP motion (`vx`/`vy`, for the
 * wake-drag when a label moves). Output is bit-identical to the pre-refactor box: `x`/`y`
 * is the box top-left, `w`/`h` its size. The box midline lands on the reference capsule and
 * its top/bottom encode the ~`[-16, +9]` clear window (see module note).
 */
export function entityObstacle(
  entity: { x: number; y: number; kind: string },
  textWidth: number,
  vx: number,
  vy: number,
): FogObstacle {
  const b = labelBoxExtents(entity.kind, textWidth)
  return {
    x: entity.x + b.left,
    y: entity.y + b.top,
    w: b.right - b.left,
    h: b.bottom - b.top,
    vx,
    vy,
  }
}
