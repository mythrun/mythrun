import { describe, expect, it } from 'vitest'
import type { GraphNode } from '@mythrun/client-core/contract'
import {
  arrivalOutline,
  hashFrac,
  NODE_TRACE_MS,
  nodeArriveProgress,
  PC_RING_PAD,
  recordNodeAppearances,
  SEED_APPEAR_MS,
  STACK_HEAD_RATIO,
  strokePartialOutline,
} from '../arrival-draw.ts'
import { drawNodes, EDGE_SNAP_MS, EDGE_WEAVE_MS, type Point } from '../canvas-draw.ts'
import { recorder } from './recording-ctx.ts'

// The MYT-89 audit-v2 node ARRIVAL treatment: "trace, then stamp." An arriving
// node must NOT pop in — its silhouette traces itself in as a penstroke (the same
// hand as the C6 edge draw-in), and the solid ink + name label land together at
// completion. These tests pin the pure parts: the progress clock (seeded /
// reduced-motion / finalize-re-key semantics), the per-kind silhouette geometry,
// the partial-perimeter stroke walk, and the drawNodes gating (no fill, no label,
// no selection frame until the stamp).

const LABEL_FONT_STUB = '14px "Source Serif 4", ui-serif, Georgia, serif'
const REF_DIMS = { width: 900, height: 470 }

const gnode = (synthKey: string, kind: string, name: string): GraphNode => ({
  synthKey,
  kind,
  name,
  displayId: synthKey,
  state: 'live',
  lastEventIndex: 0,
})

describe('NODE_TRACE_MS — the trace timing sits between the edge reference points', () => {
  it('is slower than a snap edge, faster than a weave edge (brief and deliberate)', () => {
    expect(NODE_TRACE_MS).toBeGreaterThan(EDGE_SNAP_MS)
    expect(NODE_TRACE_MS).toBeLessThan(EDGE_WEAVE_MS)
  })
})

describe('nodeArriveProgress — the arrival clock', () => {
  it('lerps 0→1 over NODE_TRACE_MS from the first-seen clock', () => {
    expect(nodeArriveProgress(100, 100, false)).toBe(0)
    expect(nodeArriveProgress(100, 100 + NODE_TRACE_MS / 2, false)).toBeCloseTo(0.5, 6)
    expect(nodeArriveProgress(100, 100 + NODE_TRACE_MS, false)).toBe(1)
  })

  it('clamps past the duration (a long-arrived node stays at exactly 1)', () => {
    expect(nodeArriveProgress(0, NODE_TRACE_MS * 50, false)).toBe(1)
  })

  it('reduced motion forces 1 — instant final state, never a stranded partial', () => {
    expect(nodeArriveProgress(100, 100, true)).toBe(1)
    expect(nodeArriveProgress(undefined, 0, true)).toBe(1)
  })

  it('a node not yet clocked (undefined appear-time) is 0 — about to start', () => {
    expect(nodeArriveProgress(undefined, 5000, false)).toBe(0)
  })

  it('SEED-stamped nodes (present before the first motion frame) render full at any clock', () => {
    expect(nodeArriveProgress(SEED_APPEAR_MS, 0, false)).toBe(1)
    expect(nodeArriveProgress(SEED_APPEAR_MS, 1e9, false)).toBe(1)
  })
})

describe('recordNodeAppearances — first-seen stamps, keyed on synthKey', () => {
  it('stamps each unseen synthKey at the given clock', () => {
    const appear = new Map<string, number>()
    recordNodeAppearances([gnode('s1/a', 'npc', 'A'), gnode('s1/b', 'item', 'B')], appear, 250)
    expect(appear.get('s1/a')).toBe(250)
    expect(appear.get('s1/b')).toBe(250)
  })

  it('never restamps a seen key — a later frame cannot restart the trace', () => {
    const appear = new Map<string, number>()
    recordNodeAppearances([gnode('s1/a', 'npc', 'A')], appear, 5)
    recordNodeAppearances([gnode('s1/a', 'npc', 'A')], appear, 900)
    expect(appear.get('s1/a')).toBe(5)
  })

  it('a finalize re-key (displayId synthKey→UUID) cannot replay the arrival', () => {
    // The fold swaps displayId on `finalized` but synthKey is stable — the stamp
    // map keys on synthKey, so the finalized node keeps its original appear-time.
    const appear = new Map<string, number>()
    recordNodeAppearances([gnode('s1/a', 'npc', 'A')], appear, 5)
    const finalized: GraphNode = {
      ...gnode('s1/a', 'npc', 'A'),
      displayId: '018f7b21-aaaa-7000-8000-000000000001',
      state: 'finalized',
    }
    recordNodeAppearances([finalized], appear, 3000)
    expect(appear.size).toBe(1)
    expect(appear.get('s1/a')).toBe(5)
  })
})

describe('hashFrac — deterministic per-node start point (no Math.random in the render path)', () => {
  it('is pure: the same key always hashes to the same fraction', () => {
    expect(hashFrac('world_and_factions/factions/0')).toBe(hashFrac('world_and_factions/factions/0'))
  })

  it('lands in [0, 1)', () => {
    for (const key of ['a', 'b', 's1/world', 'coherence_pass/npcs/3', '']) {
      const h = hashFrac(key)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(1)
    }
  })

  it('spreads distinct keys to distinct fractions (arrival bursts desync)', () => {
    expect(hashFrac('s1/a')).not.toBe(hashFrac('s1/b'))
    expect(hashFrac('s2/ward')).not.toBe(hashFrac('s3/guild'))
  })
})

describe('arrivalOutline — each kind traces its own silhouette', () => {
  const half = 6

  it('location (default) traces the glyph square at ±half', () => {
    expect(arrivalOutline('location', half)).toEqual([
      { x: -half, y: -half },
      { x: half, y: -half },
      { x: half, y: half },
      { x: -half, y: half },
    ])
  })

  it('world/campaign trace the outer frame ring (the inner square stamps at completion)', () => {
    expect(arrivalOutline('world', half)).toEqual(arrivalOutline('location', half))
    expect(arrivalOutline('campaign', half)).toEqual(arrivalOutline('location', half))
  })

  it('faction traces the diamond', () => {
    expect(arrivalOutline('faction', half)).toEqual([
      { x: 0, y: -half },
      { x: half, y: 0 },
      { x: 0, y: half },
      { x: -half, y: 0 },
    ])
  })

  it('item traces the small square at ±half/2', () => {
    expect(arrivalOutline('item', half)).toEqual(arrivalOutline('location', half / 2))
  })

  it('pc traces its outline ring at ±(half + PC_RING_PAD) — the stack stamps at completion', () => {
    expect(arrivalOutline('pc', half)).toEqual(arrivalOutline('location', half + PC_RING_PAD))
  })

  it('npc traces the head+body union silhouette (matches the drawn stack geometry)', () => {
    const head = half * STACK_HEAD_RATIO
    const bodyTop = -head + 1
    const bodyBottom = half + 1
    expect(arrivalOutline('npc', half)).toEqual([
      { x: -head, y: -half - head },
      { x: head, y: -half - head },
      { x: head, y: bodyTop },
      { x: half, y: bodyTop },
      { x: half, y: bodyBottom },
      { x: -half, y: bodyBottom },
      { x: -half, y: bodyTop },
      { x: -head, y: bodyTop },
    ])
  })
})

describe('strokePartialOutline — the pen walks the perimeter', () => {
  /** A unit square (side 2, perimeter 8) — hand-checkable arc arithmetic. */
  const square: Point[] = [
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
  ]

  it('draws nothing at progress 0 (about to start)', () => {
    const r = recorder()
    strokePartialOutline(r.ctx, square, 0, 0)
    expect(r.strokes).toBe(0)
    expect(r.moves).toEqual([])
  })

  it('at progress 0.25 strokes exactly the first quarter of the perimeter', () => {
    const r = recorder()
    strokePartialOutline(r.ctx, square, 0, 0.25)
    expect(r.strokes).toBe(1)
    expect(r.moves).toEqual([{ x: -1, y: -1 }])
    expect(r.lines).toEqual([{ x: 1, y: -1 }]) // 2 of 8 units: the whole top side
  })

  it('crosses vertices mid-stroke (0.375 = top side + half the right side)', () => {
    const r = recorder()
    strokePartialOutline(r.ctx, square, 0, 0.375)
    expect(r.moves).toEqual([{ x: -1, y: -1 }])
    expect(r.lines).toEqual([
      { x: 1, y: -1 },
      { x: 1, y: 0 },
    ])
  })

  it('starts mid-segment when the hash start-fraction says so', () => {
    // startFrac 1/16 of the perimeter = 0.5 units into the top side.
    const r = recorder()
    strokePartialOutline(r.ctx, square, 1 / 16, 0.125)
    expect(r.moves).toEqual([{ x: -0.5, y: -1 }])
    expect(r.lines).toEqual([{ x: 0.5, y: -1 }])
  })

  it('wraps around the loop closure as two subpaths of ONE stroke', () => {
    // Start 7 units in (midway up the left side), draw 2 units: 1 unit to the
    // start corner, wrap, 1 unit along the top side.
    const r = recorder()
    strokePartialOutline(r.ctx, square, 7 / 8, 0.25)
    expect(r.strokes).toBe(1)
    expect(r.moves).toEqual([
      { x: -1, y: 0 },
      { x: -1, y: -1 },
    ])
    expect(r.lines).toEqual([
      { x: -1, y: -1 },
      { x: 0, y: -1 },
    ])
  })

  it('at progress 1 covers the full perimeter (every vertex visited)', () => {
    const r = recorder()
    strokePartialOutline(r.ctx, square, 0, 1)
    const visited = [...r.moves, ...r.lines]
    for (const corner of square) {
      expect(visited).toContainEqual(corner)
    }
  })

  it('is a no-op on degenerate inputs (fewer than 2 points / zero perimeter)', () => {
    const r = recorder()
    strokePartialOutline(r.ctx, [{ x: 0, y: 0 }], 0, 0.5)
    strokePartialOutline(r.ctx, [{ x: 2, y: 3 }, { x: 2, y: 3 }], 0, 0.5)
    expect(r.strokes).toBe(0)
  })
})

// ── drawNodes integration: the trace phase gates the ink ──────────────────────────────
// Mid-arrival (progress < 1) a node is ONLY its partial silhouette stroke: no glyph
// fill, no label, no selection frame. At completion everything lands in one beat.

describe('drawNodes — arrival gating (trace, then stamp)', () => {
  const arriving = gnode('s2/ward', 'location', 'The Drowned Ward')
  const positions = new Map<string, Point>([[arriving.displayId, { x: 10, y: -20 }]])
  const deco = (): Parameters<typeof drawNodes>[3] => ({
    selectedKey: undefined,
    hoverKey: null,
    focusKey: null,
    t: null,
    showLabels: true,
    labeled: undefined,
    labelFont: LABEL_FONT_STUB,
    paper: '',
    virtual: REF_DIMS,
  })

  it('mid-trace draws the partial outline only — no fill, no label', () => {
    const r = recorder()
    drawNodes(r.ctx, [arriving], positions, deco(), () => 0.5)
    expect(r.strokes).toBe(1) // the partial silhouette penstroke…
    expect(r.moves.length).toBeGreaterThan(0)
    expect(r.rects).toEqual([]) // …but the location square's fillRect has NOT landed
    expect(r.texts).toEqual([]) // …and neither has the name
  })

  it('mid-trace suppresses the selection frame too (the stamp is one beat)', () => {
    const r = recorder()
    drawNodes(r.ctx, [arriving], positions, { ...deco(), selectedKey: arriving.displayId }, () => 0.5)
    expect(r.strokes).toBe(1) // only the trace stroke — no strokeRect frame
  })

  it('at completion the glyph, the label, and the frame land together', () => {
    const r = recorder()
    drawNodes(r.ctx, [arriving], positions, deco(), () => 1)
    expect(r.rects.length).toBe(1) // the location square is filled
    expect(r.texts).toEqual([arriving.name]) // the name lands on the same beat
  })

  it('omitting the progress source draws every node FULL (the pre-treatment default)', () => {
    const withProgress = recorder()
    drawNodes(withProgress.ctx, [arriving], positions, deco(), () => 1)
    const without = recorder()
    drawNodes(without.ctx, [arriving], positions, deco())
    expect(without.rects).toEqual(withProgress.rects)
    expect(without.texts).toEqual(withProgress.texts)
  })

  it('the trace is deterministic per node and desynced across nodes', () => {
    const a = gnode('s1/a', 'location', 'A')
    const b = gnode('s1/b', 'location', 'B')
    const pos = new Map<string, Point>([
      ['s1/a', { x: 0, y: 0 }],
      ['s1/b', { x: 0, y: 0 }],
    ])
    const run = (node: GraphNode): Point[] => {
      const r = recorder()
      drawNodes(r.ctx, [node], pos, deco(), () => 0.3)
      return r.moves
    }
    expect(run(a)).toEqual(run(a)) // pure — same node, same frame, same stroke
    expect(run(a)).not.toEqual(run(b)) // hashed start — a burst doesn't move in lockstep
  })
})
