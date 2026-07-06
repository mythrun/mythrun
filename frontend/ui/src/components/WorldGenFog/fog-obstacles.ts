import {
  ENTITY_SIZE,
  LABEL_CAP_Y_OFFSET,
  LABEL_CLEAR_PAD,
  type FogObstacle,
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
 * Build the `FogObstacle` box for one entity. `x`/`y` is the marker anchor (virtual
 * space); `textWidth` the measured label width; `vx`/`vy` the box's PER-SUB-STEP motion
 * (for the wake-drag when a label moves). The box spans the reference capsule
 * horizontally (`anchorX - sz/2` → `anchorX + sz + textWidth`) and is centred vertically
 * on the capsule midline (`anchorY - LABEL_CAP_Y_OFFSET`), so its midline lands on the
 * capsule and its top/bottom encode the ~`[-16, +9]` clear window (see module note).
 */
export function entityObstacle(
  entity: { x: number; y: number; kind: string },
  textWidth: number,
  vx: number,
  vy: number,
): FogObstacle {
  const sz = markerSize(entity.kind)
  const left = entity.x - sz / 2
  const right = entity.x + sz + textWidth
  const midY = entity.y - LABEL_CAP_Y_OFFSET
  return {
    x: left,
    y: midY - CLEAR_HEIGHT / 2,
    w: right - left,
    h: CLEAR_HEIGHT,
    vx,
    vy,
  }
}
