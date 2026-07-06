import { describe, expect, it } from 'vitest'
import {
  LABEL_CAP_Y_OFFSET,
  VIRTUAL_HEIGHT,
  VIRTUAL_WIDTH,
} from '@mythrun/client-core/worldgen'
import type { GraphEdge, GraphNode } from '@mythrun/client-core/contract'
import {
  bobOffset,
  centredToVirtual,
  drawEdges,
  drawNodes,
  edgeDrawDurationMs,
  edgeDrawProgress,
  EDGE_SNAP_MS,
  EDGE_WEAVE_MS,
  fogEntitiesFrom,
  type Point,
} from '../canvas-draw.ts'
import { entityObstacle } from '../../WorldGenFog/fog-obstacles.ts'

// BUG 2.1 render-layer proof. The sim/render/edge id-space is `displayId`: node
// positions are keyed by `displayId`, and edge endpoints are entity UUIDs (= the
// endpoints' `displayId`). A live-won node keeps a `${stage}/…` synthKey but a
// UUID displayId; a seed-only node's synthKey IS its UUID. These tests prove the
// draw helpers reconcile the two — an edge between a live-won node and a seed-only
// node RENDERS — and that a synthKey-keyed positions map (the old bug) would drop
// it. Only the draw path is unit-tested here; jsdom has no real 2D context, so the
// context is a call recorder.

interface Recorder {
  ctx: CanvasRenderingContext2D
  strokes: number
  moves: Point[]
  quads: { cx: number; cy: number; x: number; y: number }[]
  translates: Point[]
  /** Every `fillText(text, …)` call's text — the node-label draws (drawGlyph never
   *  fillTexts, only fill/stroke rects), so this is exactly the rendered names. */
  texts: string[]
}

/** A recording 2D context: draw methods append to logs, everything else is a
 *  no-op, and property writes are absorbed. Enough to assert what got drawn. */
function recorder(): Recorder {
  const r: Recorder = {
    strokes: 0,
    moves: [],
    quads: [],
    translates: [],
    texts: [],
    ctx: undefined as unknown as CanvasRenderingContext2D,
  }
  const impl: Record<string, (...args: never[]) => void> = {
    stroke: () => {
      r.strokes += 1
    },
    moveTo: (x: number, y: number) => {
      r.moves.push({ x, y })
    },
    quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => {
      r.quads.push({ cx, cy, x, y })
    },
    translate: (x: number, y: number) => {
      r.translates.push({ x, y })
    },
    fillText: (text: string) => {
      r.texts.push(text)
    },
  }
  r.ctx = new Proxy(
    {},
    {
      get: (_t, prop: string) => impl[prop] ?? ((): void => undefined),
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D
  return r
}

const uuidA = '018f7b21-aaaa-7000-8000-000000000001'
const uuidB = '018f7b21-bbbb-7000-8000-000000000002'

/** A live-won faction: `synthKey` ≠ `displayId` (the post-finalize reality). */
const liveWon: GraphNode = {
  synthKey: 'world_and_factions/factions/0',
  kind: 'faction',
  name: 'The Tallow Guild',
  displayId: uuidA,
  state: 'finalized',
  lastEventIndex: 0,
}
/** A seed-only node: its `synthKey` IS its UUID (never got a `${stage}/…` key). */
const seedOnly: GraphNode = {
  synthKey: uuidB,
  kind: 'npc',
  name: 'Maeris Vale',
  displayId: uuidB,
  state: 'finalized',
  lastEventIndex: 1,
}
const edge: GraphEdge = {
  synthKey: 'e-ab',
  from: uuidA,
  to: uuidB,
  relationship: 'leads',
  arrivalIndex: 0,
  sourceStage: 'weave',
}

/** Positions keyed by `displayId` — the reconciled render id-space. */
const displayIdPositions = new Map<string, Point>([
  [uuidA, { x: -30, y: 0 }],
  [uuidB, { x: 30, y: 0 }],
])

describe('drawEdges — displayId ↔ UUID reconciliation (BUG 2.1)', () => {
  it('renders an edge between a live-won node and a seed-only node', () => {
    const r = recorder()
    drawEdges(r.ctx, [edge], displayIdPositions)
    // The single edge is stroked, from A's position to B's position.
    expect(r.strokes).toBe(1)
    expect(r.moves).toEqual([{ x: -30, y: 0 }])
    expect(r.quads).toHaveLength(1)
    expect(r.quads[0]).toMatchObject({ x: 30, y: 0 })
  })

  it('drops the edge when positions are keyed by synthKey (the old bug)', () => {
    // The regression: keying node positions by synthKey means the UUID endpoints
    // miss the lookup, so no edge is drawn. This is exactly BUG 2.1.
    const synthKeyPositions = new Map<string, Point>([
      [liveWon.synthKey, { x: -30, y: 0 }],
      [seedOnly.synthKey, { x: 30, y: 0 }],
    ])
    const r = recorder()
    drawEdges(r.ctx, [edge], synthKeyPositions)
    expect(r.strokes).toBe(0)
  })
})

// ── C6: the Act-2 penstroke edge draw-in ──────────────────────────────────────────────
// Edges must NOT pop in — each is DRAWN from source→target (a penstroke) on first
// appearance. `drawEdges` reveals a PARTIAL line: the stroked endpoint is lerp(source,
// target, progress); at progress 1 it's the full line to the target (B1 parity). Progress
// itself is a pure fn of the edge's first-seen clock, keyed on `sourceStage` — `weave`
// (relationship/consolidation) draws SLOWLY, `snap` (coherence_pass) draws FAST.

const seedEdge: GraphEdge = { ...edge, synthKey: 'seed', arrivalIndex: -1, sourceStage: 'snap' }
const snapEdge: GraphEdge = { ...edge, synthKey: 'e-snap', arrivalIndex: 3, sourceStage: 'snap' }

describe('drawEdges — partial-line penstroke reveal (C6)', () => {
  it('at progress 0.5 strokes a partial line to lerp(source, target, 0.5)', () => {
    const r = recorder()
    drawEdges(r.ctx, [edge], displayIdPositions, () => 0.5)
    // The pen starts at the source and has reached the MIDPOINT (half the length).
    expect(r.strokes).toBe(1)
    expect(r.moves).toEqual([{ x: -30, y: 0 }])
    expect(r.quads).toHaveLength(1)
    expect(r.quads[0]).toMatchObject({ x: 0, y: 0 }) // lerp({-30,0},{30,0},0.5)
  })

  it('at progress 1.0 strokes the full line to the target (B1 parity)', () => {
    const r = recorder()
    drawEdges(r.ctx, [edge], displayIdPositions, () => 1)
    expect(r.moves).toEqual([{ x: -30, y: 0 }])
    expect(r.quads[0]).toMatchObject({ x: 30, y: 0 })
  })

  it('omitting the progress source renders every edge FULL (default 1)', () => {
    const r = recorder()
    drawEdges(r.ctx, [edge], displayIdPositions)
    expect(r.quads[0]).toMatchObject({ x: 30, y: 0 })
  })
})

describe('edgeDrawDurationMs / edgeDrawProgress — weave vs snap timing (C6)', () => {
  it('weave and snap resolve DIFFERENT durations (weave is the slow penstroke)', () => {
    expect(edgeDrawDurationMs('weave')).toBe(EDGE_WEAVE_MS)
    expect(edgeDrawDurationMs('snap')).toBe(EDGE_SNAP_MS)
    expect(edgeDrawDurationMs('weave')).not.toBe(edgeDrawDurationMs('snap'))
    expect(EDGE_WEAVE_MS).toBeGreaterThan(EDGE_SNAP_MS)
  })

  it('lerps progress over the stage duration from the first-seen clock', () => {
    // half a weave duration in → half drawn.
    expect(edgeDrawProgress(edge, 100, 100 + EDGE_WEAVE_MS / 2, false)).toBeCloseTo(0.5, 6)
    // past the full duration → clamped to 1.
    expect(edgeDrawProgress(edge, 0, EDGE_WEAVE_MS * 3, false)).toBe(1)
  })

  it('snap reaches full FASTER than weave at the same elapsed time', () => {
    const elapsed = EDGE_SNAP_MS // exactly one snap duration
    expect(edgeDrawProgress(snapEdge, 0, elapsed, false)).toBe(1) // snap done
    expect(edgeDrawProgress(edge, 0, elapsed, false)).toBeLessThan(1) // weave still drawing
  })

  it('seed edges (arrivalIndex -1) render FULL immediately — never animate', () => {
    expect(edgeDrawProgress(seedEdge, undefined, 0, false)).toBe(1)
  })

  it('reduced motion forces progress to 1 (instant full edges, no draw-in)', () => {
    expect(edgeDrawProgress(edge, 0, 0, true)).toBe(1)
  })

  it('an edge not yet clocked (undefined appear-time) is progress 0 (about to start)', () => {
    expect(edgeDrawProgress(edge, undefined, 500, false)).toBe(0)
  })
})

describe('drawNodes — displayId lookup', () => {
  it('draws a live-won node via its displayId (not its synthKey)', () => {
    const r = recorder()
    drawNodes(r.ctx, [liveWon, seedOnly], displayIdPositions, {
      selectedKey: undefined,
      hoverKey: null,
      t: null, // no bob → the draw translate is the raw physics position
      showLabels: false,
    })
    // Both nodes resolve their position by displayId and are drawn there.
    expect(r.translates).toEqual([
      { x: -30, y: 0 },
      { x: 30, y: 0 },
    ])
  })

  it('skips a node absent from the displayId-keyed positions', () => {
    const r = recorder()
    drawNodes(r.ctx, [liveWon], new Map(), {
      selectedKey: undefined,
      hoverKey: null,
      t: null,
      showLabels: false,
    })
    expect(r.translates).toEqual([])
  })
})

// ── MYT-89 audit #3: name labels (decoupled from `interactive`) ────────────────────────
// The regression: labels were gated on `interactive` (false during generation) so the
// glyphs streamed in nameless while the fog parted around a text-sized keep-out —
// "fog-parts-around-nothing." drawNodes draws the entity NAME iff `showLabels`, and the
// gen path now passes `showLabels` true (see WorldGenGraph.test.tsx). The kind is NOT
// rendered as text — it stays conveyed by the glyph SHAPE.

describe('drawNodes — name labels (MYT-89 audit #3)', () => {
  const deco = (showLabels: boolean): Parameters<typeof drawNodes>[3] => ({
    selectedKey: undefined,
    hoverKey: null,
    t: null,
    showLabels,
  })

  it('draws each node NAME when showLabels is true', () => {
    const r = recorder()
    drawNodes(r.ctx, [liveWon, seedOnly], displayIdPositions, deco(true))
    expect(r.texts).toEqual(['The Tallow Guild', 'Maeris Vale'])
  })

  it('draws NO text when showLabels is false (the pre-fix generation behaviour)', () => {
    const r = recorder()
    drawNodes(r.ctx, [liveWon, seedOnly], displayIdPositions, deco(false))
    expect(r.texts).toEqual([])
  })

  it('renders the NAME only — never the kind as a text tag (shape conveys type)', () => {
    const r = recorder()
    drawNodes(r.ctx, [liveWon], displayIdPositions, deco(true))
    expect(r.texts).toEqual([liveWon.name])
    expect(r.texts).not.toContain(liveWon.kind) // 'faction' is never drawn as text
  })
})

// ── C5: the shared graph↔fog virtual space + render-only buoy bob ─────────────────────
// The C5 crux in unit form: the graph and the fog share ONE 900×470 virtual space, so a
// node's glyph and its fog-hole land on the identical coordinate. `fogEntitiesFrom` is
// the single source the fog obstacles derive from, and it maps a centred sim point the
// SAME way the draw translates it — (VW/2, VH/2). The buoy bob is a RENDER offset only.

const cnode = (displayId: string, kind: string, name: string): GraphNode => ({
  synthKey: displayId,
  kind,
  name,
  displayId,
  state: 'finalized',
  lastEventIndex: 0,
})

describe('centredToVirtual — the shared graph↔fog translation', () => {
  it('recentres a centred sim point into the fog top-left virtual space', () => {
    expect(centredToVirtual({ x: 0, y: 0 })).toEqual({ x: VIRTUAL_WIDTH / 2, y: VIRTUAL_HEIGHT / 2 })
    expect(centredToVirtual({ x: 100, y: -50 })).toEqual({
      x: VIRTUAL_WIDTH / 2 + 100,
      y: VIRTUAL_HEIGHT / 2 - 50,
    })
  })
})

describe('fogEntitiesFrom — fog obstacles from live node positions (C5 decision 3)', () => {
  const nodeA = cnode('a', 'location', 'Ashfen Reach')
  const nodeB = cnode('b', 'npc', 'Maeris Vale')
  const nodes = [nodeA, nodeB]
  const positions = new Map<string, Point>([
    ['a', { x: 120, y: -30 }],
    ['b', { x: -80, y: 60 }],
  ])

  it('maps each node to the SAME virtual coordinate the glyph is drawn at (no bob)', () => {
    // drawNodes above proves the glyph translate is the centred position; the host then
    // translates the context by (VW/2, VH/2). fogEntitiesFrom applies that same offset —
    // so obstacle position === glyph draw position, in one virtual space.
    const entities = fogEntitiesFrom(nodes, positions, null)
    expect(entities[0]).toEqual({
      x: VIRTUAL_WIDTH / 2 + 120,
      y: VIRTUAL_HEIGHT / 2 - 30,
      kind: 'location',
      name: 'Ashfen Reach',
    })
    expect(entities[1]?.x).toBe(VIRTUAL_WIDTH / 2 - 80)
    expect(entities[1]?.y).toBe(VIRTUAL_HEIGHT / 2 + 60)
  })

  it('a node at virtual (x,y) yields a FogObstacle whose capsule midline sits on it', () => {
    const entity = fogEntitiesFrom([nodeA], positions, null)[0]
    if (entity === undefined) throw new Error('expected a fog entity for the node')
    const obstacle = entityObstacle(entity, 40, 0, 0)
    // The reference anchors the capsule LABEL_CAP_Y_OFFSET above the marker; the box
    // midline (y + h/2) lands there — on the node's virtual anchor's capsule.
    expect(obstacle.y + obstacle.h / 2).toBeCloseTo(entity.y - LABEL_CAP_Y_OFFSET, 6)
  })

  it('skips nodes that have no position yet', () => {
    const partial = new Map<string, Point>([['a', { x: 10, y: 20 }]])
    expect(fogEntitiesFrom(nodes, partial, null)).toHaveLength(1)
  })
})

describe('bobOffset / fogEntitiesFrom — buoy bob is a RENDER offset only (C5 decision 4)', () => {
  it('is deterministic per (position, clock) and animates with the clock', () => {
    const a = bobOffset(300, 200, 1.5)
    expect(bobOffset(300, 200, 1.5)).toEqual(a) // pure
    expect(bobOffset(300, 200, 2.5)).not.toEqual(a) // moves with time
  })

  it('adds the bob to the drawn/derived position WITHOUT mutating the physics positions', () => {
    const nodes = [cnode('a', 'location', 'Ashfen Reach')]
    const positions = new Map<string, Point>([['a', { x: 40, y: -10 }]])
    const base = fogEntitiesFrom(nodes, positions, null)[0] // no bob
    const bobbed = fogEntitiesFrom(nodes, positions, 3)[0] // same frame, with bob
    if (base === undefined || bobbed === undefined) throw new Error('expected fog entities')

    const v = centredToVirtual({ x: 40, y: -10 })
    const bob = bobOffset(v.x, v.y, 3)
    // The derived (drawn) position differs from the physics position by exactly the bob…
    expect(bobbed.x).toBeCloseTo(base.x + bob.x, 6)
    expect(bobbed.y).toBeCloseTo(base.y + bob.y, 6)
    expect(bob.y).not.toBe(0) // the y bob is real, not a no-op
    // …while the source positions map is untouched — bob never writes back to physics.
    expect(positions.get('a')).toEqual({ x: 40, y: -10 })
  })
})
