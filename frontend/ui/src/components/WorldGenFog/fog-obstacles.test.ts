import { describe, it, expect } from 'vitest'
import {
  ENTITY_SIZE,
  LABEL_CAP_Y_OFFSET,
  LABEL_CLEAR_PAD,
  LABEL_TEXT_OFFSET_X,
} from '@mythrun/client-core/worldgen'
import {
  entityObstacle,
  ICON_BOX_HALF,
  iconBoxExtents,
  labelBoxExtents,
  markerSize,
  nodeBoxExtents,
} from './fog-obstacles.ts'

// The obstacle GEOMETRY (MYT-89 C3) reconciles the reference's separate capsule + clear
// window into the single FogObstacle box FogSim consumes. These pin the reconciliation:
// the doublet midline lands EXACTLY on the capsule, the vertical clear window lands within a
// half-pixel of the reference `[-16, +9]`, and the horizontal span now reaches the DRAWN
// label's right edge (`+LABEL_TEXT_OFFSET_X + textWidth`, the MYT-89 follow-up that closed the
// ~7px right-edge under-reserve — the box was modelling the reference `+sz` label start).

describe('markerSize', () => {
  it('sizes FACTION / NPC bespoke and everything else default', () => {
    expect(markerSize('FACTION')).toBe(ENTITY_SIZE.FACTION)
    expect(markerSize('NPC')).toBe(ENTITY_SIZE.NPC)
    expect(markerSize('LOCATION')).toBe(ENTITY_SIZE.DEFAULT)
    expect(markerSize('ITEM')).toBe(ENTITY_SIZE.DEFAULT)
    expect(markerSize('anything-unknown')).toBe(ENTITY_SIZE.DEFAULT)
  })
})

describe('entityObstacle', () => {
  const entity = { x: 300, y: 140, kind: 'LOCATION' }
  const tw = 62
  const sz = ENTITY_SIZE.DEFAULT

  it('spans the icon on the left to the DRAWN label right: [x - sz/2, x + LABEL_TEXT_OFFSET_X + textWidth]', () => {
    // The right edge anchors on the SHARED `LABEL_TEXT_OFFSET_X` (where `canvas-draw` actually
    // draws the label), NOT the reference `+sz` — so the fog reserves out to the drawn label's
    // real right edge instead of under-reserving the ~7px to the `+18` draw offset.
    const ob = entityObstacle(entity, tw, 0, 0)
    expect(ob.x).toBe(entity.x - sz / 2)
    expect(ob.x + ob.w).toBe(entity.x + LABEL_TEXT_OFFSET_X + tw)
  })

  it('lands the box MIDLINE (the doublet line) EXACTLY on the capsule (y - cap offset)', () => {
    const ob = entityObstacle(entity, tw, 0, 0)
    const midline = ob.y + ob.h / 2
    expect(midline).toBe(entity.y - LABEL_CAP_Y_OFFSET)
  })

  it('encodes the ~[-16, +9] clear window around the baseline (within a half-pixel)', () => {
    const ob = entityObstacle(entity, tw, 0, 0)
    // Reference window is [y - 16, y + 9]; the capsule-anchored box shifts each edge by
    // the 0.5px capsule↔window-centre offset — a sub-cell (< CELL_PX) reconciliation.
    expect(Math.abs(ob.y - (entity.y - LABEL_CLEAR_PAD.yTop))).toBeLessThanOrEqual(0.5)
    expect(Math.abs(ob.y + ob.h - (entity.y + LABEL_CLEAR_PAD.yBottom))).toBeLessThanOrEqual(0.5)
  })

  it('has a fixed clear height = the top + bottom pads (16 + 9)', () => {
    const ob = entityObstacle(entity, tw, 0, 0)
    expect(ob.h).toBe(LABEL_CLEAR_PAD.yTop + LABEL_CLEAR_PAD.yBottom)
  })

  it('passes the per-sub-step velocity straight through (for the wake-drag)', () => {
    const ob = entityObstacle(entity, tw, 1.4, -0.6)
    expect(ob.vx).toBe(1.4)
    expect(ob.vy).toBe(-0.6)
  })

  it('widens the box for a FACTION marker (bigger sz → the icon reaches further left)', () => {
    // The label right edge is now sz-independent (it anchors on the drawn label), so a bigger
    // marker widens the box via its LEFT (icon) edge, `-sz/2` — FACTION still yields a wider box.
    const loc = entityObstacle({ x: 300, y: 140, kind: 'LOCATION' }, tw, 0, 0)
    const fac = entityObstacle({ x: 300, y: 140, kind: 'FACTION' }, tw, 0, 0)
    expect(fac.w).toBeGreaterThan(loc.w)
  })
})

// ── Label tiering (MYT-89 density redesign): the icon-only box ─────────────────────────
// An UNLABELED node (its name isn't drawn at the current density tier) reserves only an
// icon-sized keep-out — for the collision AND the fog hole (one geometry, two surfaces).
// The shrink from the full icon+label box is what returns the screen real estate at a
// real ~46-entity load; every SHOWN label keeps the full box (the no-overlap guarantee).

describe('iconBoxExtents / nodeBoxExtents — the unlabeled keep-out', () => {
  it('is a symmetric icon-sized box that contains every drawn glyph', () => {
    const box = iconBoxExtents()
    expect(box).toEqual({
      left: -ICON_BOX_HALF,
      right: ICON_BOX_HALF,
      top: -ICON_BOX_HALF,
      bottom: ICON_BOX_HALF,
    })
    // The tallest glyphs: the npc stack's head rises ~10px above the anchor and the pc
    // frame reaches ±8 — the icon box must contain both (labels never overlap ICONS).
    expect(ICON_BOX_HALF).toBeGreaterThanOrEqual(11)
  })

  it('nodeBoxExtents forks: labeled → the full icon+label box, unlabeled → icon-only', () => {
    expect(nodeBoxExtents('LOCATION', 62, true)).toEqual(labelBoxExtents('LOCATION', 62))
    expect(nodeBoxExtents('LOCATION', 62, false)).toEqual(iconBoxExtents())
  })

  it('an unlabeled entity yields the SMALL fog obstacle (the fog may roll over its name)', () => {
    const labeled = entityObstacle({ x: 300, y: 140, kind: 'LOCATION', labeled: true }, 62, 0, 0)
    const unlabeled = entityObstacle({ x: 300, y: 140, kind: 'LOCATION', labeled: false }, 62, 0, 0)
    expect(unlabeled.w).toBe(ICON_BOX_HALF * 2)
    expect(unlabeled.h).toBe(ICON_BOX_HALF * 2)
    expect(unlabeled.w).toBeLessThan(labeled.w)
    // Centred on the anchor (the icon), not the capsule offset.
    expect(unlabeled.x + unlabeled.w / 2).toBe(300)
    expect(unlabeled.y + unlabeled.h / 2).toBe(140)
  })

  it('an entity without the flag stays fully labeled (the pre-tiering callers)', () => {
    const implicit = entityObstacle({ x: 300, y: 140, kind: 'LOCATION' }, 62, 0, 0)
    const explicit = entityObstacle({ x: 300, y: 140, kind: 'LOCATION', labeled: true }, 62, 0, 0)
    expect(implicit).toEqual(explicit)
  })
})
