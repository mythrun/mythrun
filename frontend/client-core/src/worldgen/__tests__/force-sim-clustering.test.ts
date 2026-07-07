import { describe, it, expect } from 'vitest'
import { create } from '../force-sim.ts'
import type { NodeBox } from '../force-sim.ts'
import type { GraphNode, GraphEdge } from '../graph-reducers.ts'

// Link clustering (MYT-89 untangle). The tangle: the link force ran on d3
// DEFAULTS — rest length 30 (far inside the icon+label box footprint) at
// strength ~1 (`1/min(degree)`, full strength for any edge touching a leaf) —
// which overpowers the locked −120 charge at any range, so the whole connected
// graph contracted into ONE arrival-ordered contact mass and edges crossed
// chaotically. Two fixes, proved here against the real d3 wrapper:
//   1. the tuned link force — `linkDistance` (a box-scale rest length) +
//      `linkStrength` (a multiplier over d3's degree-normalised default, scaled
//      DOWN) — so dense intra-community subgraphs condense while the locked
//      charge holds distinct communities apart: force-directed clustering, the
//      standard live-graph approximation of (NP-hard) crossing minimisation;
//   2. the EDGE-arrival reheat — a new edge changes TOPOLOGY, and at the gentle
//      0.3 node-arrival reheat the packed layout measurably freezes in whatever
//      arrival order it settled into (crossings barely drop on unlucky seeds);
//      the hotter edge reheat gives the Act-2 penstroke the migration energy to
//      re-organise into clusters as connections form.
// The locked spread params (charge/boundary/collide/jitter/margin) are
// UNTOUCHED — the invariants they guarantee are re-asserted on the clustered
// settle at the end of the headline test.

function node(synthKey: string, name = synthKey): GraphNode {
  return {
    synthKey,
    kind: 'npc',
    name,
    displayId: synthKey,
    state: 'live',
    lastEventIndex: 0,
  }
}

function edge(synthKey: string, from: string, to: string): GraphEdge {
  return { synthKey, from, to, relationship: 'allied', arrivalIndex: 0, sourceStage: 'weave' }
}

interface Pos {
  x: number
  y: number
}

function dist(positions: Map<string, Pos>, a: string, b: string): number {
  const pa = positions.get(a)
  const pb = positions.get(b)
  if (pa === undefined || pb === undefined) throw new Error('missing node')
  return Math.hypot(pa.x - pb.x, pa.y - pb.y)
}

const EPS = 1e-6

/** A representative icon+label collision box (the shape the fog reserves per entity —
 *  see the main force-sim suite for the geometry rationale). */
function box(textWidth: number): NodeBox {
  const sz = 11 // ENTITY_SIZE.DEFAULT
  return { left: -sz / 2, right: sz + textWidth, top: -15.5, bottom: 9.5 }
}

/** Two OFFSET boxes are DISJOINT when they don't overlap on at least one axis. */
function boxesDisjoint(pa: Pos, ba: NodeBox, pb: Pos, bb: NodeBox): boolean {
  const ox =
    Math.min(pa.x + ba.right, pb.x + bb.right) - Math.max(pa.x + ba.left, pb.x + bb.left)
  const oy =
    Math.min(pa.y + ba.bottom, pb.y + bb.bottom) - Math.max(pa.y + ba.top, pb.y + bb.top)
  return ox <= EPS || oy <= EPS
}

/** Deterministic LCG (the same generator the containment/spread suites inline). */
function lcg(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

/** Two dense communities — a hub star + a leaf ring of six nodes each (10 edges
 *  per community) — joined by ONE cross edge between the hubs: dense
 *  intra-cluster, sparse inter-cluster. The canonical clustering fixture. */
function twoCommunities(): {
  nodes: GraphNode[]
  edges: GraphEdge[]
  a: string[]
  b: string[]
} {
  const a = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5']
  const b = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5']
  const community = (ids: string[]): GraphEdge[] => {
    const hub = ids[0]
    if (hub === undefined) throw new Error('empty community')
    const leaves = ids.slice(1)
    return [
      ...leaves.map((id) => edge(`e-${hub}-${id}`, hub, id)),
      ...leaves.map((id, i) => {
        const next = leaves[(i + 1) % leaves.length]
        if (next === undefined) throw new Error('missing leaf')
        return edge(`e-${id}-${next}`, id, next)
      }),
    ]
  }
  return {
    nodes: [...a, ...b].map((id) => node(id)),
    edges: [...community(a), ...community(b), edge('e-cross', 'a0', 'b0')],
    a,
    b,
  }
}

/** Mean pairwise distance WITHIN one id set. */
function meanIntraDist(p: Map<string, Pos>, ids: string[]): number {
  let sum = 0
  let n = 0
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]
      const b = ids[j]
      if (a === undefined || b === undefined) throw new Error('missing id')
      sum += dist(p, a, b)
      n++
    }
  }
  return sum / n
}

/** Mean pairwise distance ACROSS two id sets. */
function meanInterDist(p: Map<string, Pos>, aIds: string[], bIds: string[]): number {
  let sum = 0
  let n = 0
  for (const a of aIds) {
    for (const b of bIds) {
      sum += dist(p, a, b)
      n++
    }
  }
  return sum / n
}

/** Strict segment intersection (interiors cross) via the orientation test —
 *  shared-endpoint and collinear touches don't count. */
function segmentsCross(p1: Pos, p2: Pos, p3: Pos, p4: Pos): boolean {
  const orient = (o: Pos, q: Pos, r: Pos): number =>
    Math.sign((q.x - o.x) * (r.y - o.y) - (q.y - o.y) * (r.x - o.x))
  const d1 = orient(p3, p4, p1)
  const d2 = orient(p3, p4, p2)
  const d3 = orient(p1, p2, p3)
  const d4 = orient(p1, p2, p4)
  return d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0
}

/** Count crossing pairs among the drawn edges at the given positions, skipping
 *  pairs that share an endpoint (they always meet at the shared node). */
function countCrossings(edges: GraphEdge[], p: Map<string, Pos>): number {
  let crossings = 0
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e1 = edges[i]
      const e2 = edges[j]
      if (e1 === undefined || e2 === undefined) throw new Error('missing edge')
      const shared =
        e1.from === e2.from || e1.from === e2.to || e1.to === e2.from || e1.to === e2.to
      if (shared) continue
      const a = p.get(e1.from)
      const b = p.get(e1.to)
      const c = p.get(e2.from)
      const d = p.get(e2.to)
      if (a === undefined || b === undefined || c === undefined || d === undefined) {
        throw new Error('missing position')
      }
      if (segmentsCross(a, b, c, d)) crossings++
    }
  }
  return crossings
}

describe('ForceSim link clustering (MYT-89 untangle)', () => {
  it('relaxes a link to the tuned rest length (linkDistance wiring)', () => {
    // Spring-only isolation (charge/centre/boundary off, no boxes): the linked pair
    // must settle at the REST LENGTH — proof `linkDistance` reaches d3's `.distance`.
    // d3's old default (30) would fail both probes.
    for (const linkDistance of [80, 220]) {
      const sim = create({
        width: 4000,
        height: 4000,
        random: lcg(0x1234567),
        params: {
          chargeStrength: 0,
          boundaryStrength: 0,
          seedJitter: 300,
          margin: 0,
          linkDistance,
          linkStrength: 1,
        },
      })
      sim.sync([node('a'), node('b')], [edge('e-ab', 'a', 'b')])
      for (let i = 0; i < 500; i++) sim.tick()
      expect(Math.abs(dist(sim.positions(), 'a', 'b') - linkDistance)).toBeLessThan(5)
    }
  })

  it('linkStrength dials the pull against the locked charge (0 = topology ignored)', () => {
    // One linked pair under the LOCKED charge (−120), boundary off so the charge-only
    // equilibrium is unambiguous. Stronger springs settle shorter; at 0 the link
    // exerts NO pull and the pair drifts apart on pure repulsion — monotone wiring
    // proof for the multiplier.
    const settled = (linkStrength: number): number => {
      const sim = create({
        width: 4000,
        height: 4000,
        random: lcg(0x7e57ab),
        params: { boundaryStrength: 0, seedJitter: 300, margin: 0, linkStrength },
      })
      sim.sync([node('a'), node('b')], [edge('e-ab', 'a', 'b')])
      for (let i = 0; i < 500; i++) sim.tick()
      return dist(sim.positions(), 'a', 'b')
    }
    const strong = settled(0.6)
    const weak = settled(0.05)
    const off = settled(0)
    expect(strong).toBeLessThan(weak)
    expect(weak).toBeLessThan(off)
    expect(off).toBeGreaterThan(2 * strong)
  })

  it('normalises spring strength by degree (hub links weaker than leaf links)', () => {
    // d3's `1/min(degree)` guard must SURVIVE the multiplier: a hub↔hub bridge (both
    // endpoints degree 3) is a third the strength of a leaf link, so the bridge
    // settles LONGER than the leaf spokes — the differential that lets communities
    // hold apart. All-equal strengths would settle them at the same length.
    const sim = create({
      width: 4000,
      height: 4000,
      random: lcg(0xbadd1e),
      params: { boundaryStrength: 0, seedJitter: 400, margin: 0 },
    })
    const nodes = ['h1', 'h2', 'l1', 'l2', 'l3', 'l4'].map((id) => node(id))
    const edges = [
      edge('e-h1-h2', 'h1', 'h2'), // the hub↔hub bridge: min(degree) = 3
      edge('e-h1-l1', 'h1', 'l1'), // leaf spokes: min(degree) = 1
      edge('e-h1-l2', 'h1', 'l2'),
      edge('e-h2-l3', 'h2', 'l3'),
      edge('e-h2-l4', 'h2', 'l4'),
    ]
    sim.sync(nodes, edges)
    for (let i = 0; i < 600; i++) sim.tick()

    const p = sim.positions()
    const bridge = dist(p, 'h1', 'h2')
    const spokes = [
      dist(p, 'h1', 'l1'),
      dist(p, 'h1', 'l2'),
      dist(p, 'h2', 'l3'),
      dist(p, 'h2', 'l4'),
    ]
    const meanSpoke = spokes.reduce((s, d) => s + d, 0) / spokes.length
    expect(bridge).toBeGreaterThan(meanSpoke)
  })

  it('clusters two communities as edges arrive INCREMENTALLY over a settled spread', () => {
    // The live Act-2 shape: entities stream in FIRST and settle into the spread
    // (no edges — positions are arrival-ordered, topology-blind), then the penstroke
    // streams the edges in batches (each sync = one SSE fold + the edge reheat).
    // Under the DEFAULT params the two dense communities must condense into two
    // spatially-separated groups: mean intra-cluster distance well under the mean
    // inter-cluster distance — while every locked invariant (containment, disjoint
    // label boxes) still holds.
    const { nodes, edges, a, b } = twoCommunities()
    const width = 900
    const height = 470
    const sim = create({ width, height, random: lcg(0x2f6e2b1) })

    // Act 1 — nodes only: the locked spread fills the space, blind to topology.
    sim.sync(nodes, [])
    const nodeBox = box(60)
    sim.setBoxes(new Map<string, NodeBox>(nodes.map((n) => [n.displayId, nodeBox])))
    for (let i = 0; i < 300; i++) sim.tick()

    // Act 2 — the penstroke: edges land in three batches, re-heating each time.
    sim.sync(nodes, edges.slice(0, 7))
    for (let i = 0; i < 150; i++) sim.tick()
    sim.sync(nodes, edges.slice(0, 14))
    for (let i = 0; i < 150; i++) sim.tick()
    sim.sync(nodes, edges)
    for (let i = 0; i < 600; i++) sim.tick()

    const p = sim.positions()

    // CLUSTERING: each community condenses; the two groups hold apart. (Measured
    // ratio at the locked defaults: ~0.42 across seeds; d3's untuned defaults sat
    // at ~0.5–1.0 — interleaved, no visible grouping.)
    const intra = (meanIntraDist(p, a) + meanIntraDist(p, b)) / 2
    const inter = meanInterDist(p, a, b)
    expect(intra).toBeLessThan(0.5 * inter)

    // CONTAINMENT (B2 intact): no node escapes the centred draw space.
    for (const pt of p.values()) {
      expect(Math.abs(pt.x)).toBeLessThanOrEqual(width / 2)
      expect(Math.abs(pt.y)).toBeLessThanOrEqual(height / 2)
    }

    // NO OVERLAP (box collide intact): every pair of label boxes stays disjoint.
    const pts = [...p.values()]
    pts.forEach((pa, i) => {
      pts.slice(i + 1).forEach((pb) => {
        expect(boxesDisjoint(pa, nodeBox, pb, nodeBox)).toBe(true)
      })
    })
  })

  it('re-settling after the edges land REDUCES edge crossings (the tangle drops)', () => {
    // Crossing count as the direct tangle measure: settle the topology-blind spread,
    // land the full edge set at once (many crossings — edges drawn over an arbitrary
    // arrangement), then let the edge-reheated sim re-settle. The clustered layout
    // must cut the crossings sharply. (Measured at the locked defaults: 34 → 8 on
    // this seed; 31–42 → 5–28 across six seeds.)
    const { nodes, edges } = twoCommunities()
    const sim = create({ width: 900, height: 470, random: lcg(0x5eed) })

    sim.sync(nodes, [])
    const nodeBox = box(60)
    sim.setBoxes(new Map<string, NodeBox>(nodes.map((n) => [n.displayId, nodeBox])))
    for (let i = 0; i < 300; i++) sim.tick()

    sim.sync(nodes, edges)
    const before = countCrossings(edges, sim.positions())
    for (let i = 0; i < 800; i++) sim.tick()
    const after = countCrossings(edges, sim.positions())

    // The topology-blind spread tangles (this fixture: a two-digit crossing count);
    // the clustered re-settle must at LEAST halve it.
    expect(before).toBeGreaterThan(4)
    expect(after).toBeLessThan(before / 2)
  })
})
