import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode } from '@mythrun/client-core/contract'
import { drawEdges, drawNodes, type Point } from '../canvas-draw.ts'

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
}

/** A recording 2D context: draw methods append to logs, everything else is a
 *  no-op, and property writes are absorbed. Enough to assert what got drawn. */
function recorder(): Recorder {
  const r: Recorder = {
    strokes: 0,
    moves: [],
    quads: [],
    translates: [],
    ctx: undefined as unknown as CanvasRenderingContext2D,
  }
  const impl: Record<string, (...args: number[]) => void> = {
    stroke: () => {
      r.strokes += 1
    },
    moveTo: (x, y) => {
      r.moves.push({ x, y })
    },
    quadraticCurveTo: (cx, cy, x, y) => {
      r.quads.push({ cx, cy, x, y })
    },
    translate: (x, y) => {
      r.translates.push({ x, y })
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

describe('drawNodes — displayId lookup', () => {
  it('draws a live-won node via its displayId (not its synthKey)', () => {
    const r = recorder()
    const points = drawNodes(r.ctx, [liveWon, seedOnly], displayIdPositions, {
      selectedKey: undefined,
      hoverKey: null,
    })
    // Both nodes resolve their position by displayId and are drawn.
    expect(points).toEqual([
      { x: -30, y: 0 },
      { x: 30, y: 0 },
    ])
    expect(r.translates).toEqual([
      { x: -30, y: 0 },
      { x: 30, y: 0 },
    ])
  })

  it('skips a node absent from the displayId-keyed positions', () => {
    const r = recorder()
    const points = drawNodes(r.ctx, [liveWon], new Map(), {
      selectedKey: undefined,
      hoverKey: null,
    })
    expect(points).toEqual([])
  })
})
