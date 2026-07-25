import {
  ENTITY_SIZE,
  LABEL_CAP_Y_OFFSET,
  LABEL_CLEAR_PAD,
  LABEL_TEXT_OFFSET_X,
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

/** Which side of its marker a label sits on (ux-run2 myth-uis1p): `e` (east —
 *  the reference default, text to the RIGHT of the icon) or `w` (west — the
 *  collision-relief mirror, text to the LEFT, right-aligned toward the icon).
 *  The side threads through EVERY consumer of the shared box geometry (the
 *  draw, the force-sim collision, the fog keep-out), so the three can never
 *  disagree about where a label lives. */
export type LabelSide = 'e' | 'w'

/**
 * The icon+label box for one entity kind + measured text width, as SIGNED extents RELATIVE
 * to the marker anchor (the icon centre) — the box the fog reserves AND the box the graph's
 * force-sim collides on (`NodeBox`). ONE definition, so collision + fog are consistent (a
 * label can never overlap a neighbour's icon or text — MYT-89 re-audit). The box is OFFSET
 * from the anchor: horizontally it spans the icon on the LEFT (`-sz/2`) to the label's drawn
 * RIGHT edge (`LABEL_TEXT_OFFSET_X + textWidth` — the SHARED constant `canvas-draw` draws the
 * label at, so the reserved box bounds the label exactly where it lands; the old `sz +
 * textWidth` modelled the reference's `+sz` start and under-reserved the ~7px to the real
 * `+18` draw offset). A WEST label (myth-uis1p) mirrors the horizontal extents about the
 * anchor — the icon edge on the RIGHT, the text extending LEFT — matching the mirrored draw
 * exactly. It is centred on the capsule midline `-LABEL_CAP_Y_OFFSET` (slightly
 * ABOVE the anchor), its top/bottom encoding the ~`[-16, +9]` clear window — a 25px band that
 * comfortably contains the design-system label (`--text-sm` ≈ 14px, middle-baselined). Pure —
 * no anchor, no motion — so both consumers translate it by their own position.
 */
export function labelBoxExtents(kind: string, textWidth: number, side: LabelSide = 'e'): NodeBox {
  const sz = markerSize(kind)
  const midY = -LABEL_CAP_Y_OFFSET
  const iconEdge = -sz / 2
  const textEdge = LABEL_TEXT_OFFSET_X + textWidth
  return {
    left: side === 'e' ? iconEdge : -textEdge,
    right: side === 'e' ? textEdge : -iconEdge,
    top: midY - CLEAR_HEIGHT / 2,
    bottom: midY + CLEAR_HEIGHT / 2,
  }
}

/** Half-extent (px) of the ICON-ONLY box (MYT-89 density redesign — label tiering).
 *  Sized to contain the TALLEST drawn glyph — the npc stack's head rises ~10px above
 *  the anchor and the pc frame extends ±8 — plus a hair of air, so a shown label's
 *  box can never overlap an unlabeled glyph's ink (the no-overlap guarantee covers
 *  ICONS too, not just text). */
export const ICON_BOX_HALF = 12

/** The keep-out box for a node that does NOT wear its label (label tiering): just the
 *  glyph, symmetric about the anchor. Both consumers (the force-sim's collision and
 *  the fog's obstacle) use THIS for unlabeled nodes — one geometry, two surfaces, the
 *  same C5 consistency `labelBoxExtents` gives labeled ones. The shrink from the full
 *  icon+label box (~134×25 at a realistic name) is what returns the screen real estate
 *  at real density (~46 entities). */
export function iconBoxExtents(): NodeBox {
  return {
    left: -ICON_BOX_HALF,
    right: ICON_BOX_HALF,
    top: -ICON_BOX_HALF,
    bottom: ICON_BOX_HALF,
  }
}

/** The keep-out box for one node at its CURRENT label state: the full icon+label box
 *  (on its worn side — myth-uis1p) when the name is worn, the icon-only box when it
 *  isn't. The single fork both the collision measure and the fog obstacle go through. */
export function nodeBoxExtents(
  kind: string,
  textWidth: number,
  labeled: boolean,
  side: LabelSide = 'e',
): NodeBox {
  return labeled ? labelBoxExtents(kind, textWidth, side) : iconBoxExtents()
}

/**
 * Build the `FogObstacle` box for one entity — the shared `nodeBoxExtents` translated to
 * the marker anchor (virtual space), plus the box's PER-SUB-STEP motion (`vx`/`vy`, for the
 * wake-drag when a label moves). Output is bit-identical to the pre-refactor box: `x`/`y`
 * is the box top-left, `w`/`h` its size. For a LABELED entity the box midline lands on the
 * reference capsule and its top/bottom encode the ~`[-16, +9]` clear window (see module
 * note), mirrored west when the label wears that side (myth-uis1p); an UNLABELED entity
 * (label tiering — `labeled: false`) reserves only the icon-only box, so fog may roll
 * where its unworn name would sit.
 */
export function entityObstacle(
  entity: { x: number; y: number; kind: string; labeled?: boolean; side?: LabelSide },
  textWidth: number,
  vx: number,
  vy: number,
): FogObstacle {
  const b = nodeBoxExtents(entity.kind, textWidth, entity.labeled !== false, entity.side ?? 'e')
  return {
    x: entity.x + b.left,
    y: entity.y + b.top,
    w: b.right - b.left,
    h: b.bottom - b.top,
    vx,
    vy,
  }
}
