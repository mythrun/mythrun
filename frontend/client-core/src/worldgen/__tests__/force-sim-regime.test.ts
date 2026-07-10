import { describe, it, expect } from 'vitest'
import { create, FORCE_PARAMS, REVEAL_FORCE_PARAMS } from '../force-sim.ts'
import type { NodeBox } from '../force-sim.ts'
import type { GraphNode, GraphEdge } from '../graph-reducers.ts'

// The FORCEFUL settle regime (MYT-89 audit v4). The settled reveal graph must
// INSIST on its untangled shape: a strong link/charge equilibrium, and a node
// DRAG that releases back into the simulation with a hot reheat so the layout
// re-asserts — the dragged node "pretty much just snaps back". The regime is an
// ADDITIVE preset per the force-sim discipline (the untangle arc's precedent):
// three new tunables (`releaseAlpha`, `alphaDecay`, `velocityDecay`) whose
// DEFAULTS reproduce the shipped behaviour bit-for-bit — the generating act's
// eye-tuned look is untouchable — plus the exported `REVEAL_FORCE_PARAMS`
// profile the reveal surface merges on. Proved here in three layers:
//   1. PARITY — a golden trace: the default path replays a recorded pre-change
//      scenario (nodes → boxes → edges → a drag) to the exact double, so the
//      additive knobs provably cost the generating profile nothing;
//   2. WIRING — each knob monotonically reaches its d3 setting;
//   3. THE SNAP-BACK PIN — under `REVEAL_FORCE_PARAMS`, drag displacement →
//      release → the layout re-converges within N ticks to within ε of its
//      pre-drag equilibrium (deterministic: seeded LCG, no wall clock).

function node(synthKey: string): GraphNode {
  return {
    synthKey,
    kind: 'npc',
    name: synthKey,
    displayId: synthKey,
    state: 'live',
    lastEventIndex: 0,
  }
}

function edge(synthKey: string, from: string, to: string): GraphEdge {
  return { synthKey, from, to, relationship: 'allied', arrivalIndex: 0, sourceStage: 'weave' }
}

/** Deterministic LCG (the generator every force-sim suite inlines). */
function lcg(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

/** The representative icon+label collision box (see the main suite). */
function box(textWidth: number): NodeBox {
  const sz = 11 // ENTITY_SIZE.DEFAULT
  return { left: -sz / 2, right: sz + textWidth, top: -15.5, bottom: 9.5 }
}

interface Pos {
  x: number
  y: number
}

/** The two-communities fixture (the clustering suite's canonical shape): two
 *  hub-and-ring clusters joined by one cross edge. */
function twoCommunities(): { nodes: GraphNode[]; edges: GraphEdge[]; a: string[]; b: string[] } {
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

function positionsCopy(p: Map<string, Pos>): Map<string, Pos> {
  return new Map([...p].map(([k, v]) => [k, { ...v }]))
}

function displacement(before: Map<string, Pos>, after: Map<string, Pos>, key: string): number {
  const a = before.get(key)
  const b = after.get(key)
  if (a === undefined || b === undefined) throw new Error(`missing node ${key}`)
  return Math.hypot(b.x - a.x, b.y - a.y)
}

// ── 1. PARITY: the generating profile is bit-identical ─────────────────────
//
// The golden trace was captured from the PRE-CHANGE force-sim (the shipped
// generating profile) running this exact scenario: two communities seeded with
// lcg(0xa11ce) in 900×470, nodes settled 300 ticks, boxes set, edges landed
// (the edge reheat), settled 400 ticks, one node pinned to (380, −180) for 30
// ticks and unpinned (the shipped release: the node STAYS — no snap-back), then
// 200 more ticks. Every position must replay to the exact double: the additive
// regime knobs, at their defaults, change NOTHING about this path. (This also
// pins the shipped release semantics — a3 holds its drop point — which is the
// very behaviour the reveal regime exists to override.)
const GOLDEN_TRACE: readonly (readonly [string, Pos])[] = [
  ['a0', { x: -120.17809740529226, y: -92.45966518525177 }],
  ['a1', { x: -37.67389697672558, y: -99.27580381294652 }],
  ['a2', { x: -128.10253805798504, y: 40.80179405278574 }],
  ['a3', { x: 373.82645702349953, y: -179.94694663069808 }],
  ['a4', { x: -95.32628103409256, y: -23.67844918921278 }],
  ['a5', { x: 11.65176469988946, y: -8.668645367373879 }],
  ['b0', { x: 50.72445041779742, y: -66.8914629100495 }],
  ['b1', { x: 174.24094164723067, y: -74.50784712049845 }],
  ['b2', { x: 141.9423690630151, y: 43.28051547766606 }],
  ['b3', { x: 30.96813434552547, y: 82.05063391282876 }],
  ['b4', { x: -47.58221489987208, y: 23.579156196682863 }],
  ['b5', { x: 102.70234560964961, y: -2.445319709270693 }],
]

describe('ForceSim generating-profile parity (MYT-89 audit v4)', () => {
  it('replays the pre-change golden trace to the exact double at the locked defaults', () => {
    const { nodes, edges } = twoCommunities()
    const sim = create({ width: 900, height: 470, random: lcg(0xa11ce) })

    sim.sync(nodes, [])
    sim.setBoxes(new Map<string, NodeBox>(nodes.map((n) => [n.displayId, box(50)])))
    for (let i = 0; i < 300; i++) sim.tick()

    sim.sync(nodes, edges)
    for (let i = 0; i < 400; i++) sim.tick()

    sim.pin('a3', 380, -180)
    for (let i = 0; i < 30; i++) sim.tick()
    sim.unpin('a3')
    for (let i = 0; i < 200; i++) sim.tick()

    const p = sim.positions()
    for (const [key, golden] of GOLDEN_TRACE) {
      const got = p.get(key)
      if (got === undefined) throw new Error(`missing node ${key}`)
      // toBe — BIT identity, not closeness: the default path must be unchanged.
      expect(got.x, `${key}.x drifted off the generating profile`).toBe(golden.x)
      expect(got.y, `${key}.y drifted off the generating profile`).toBe(golden.y)
    }
  })

  it('locks the shipped defaults for the regime knobs (release inert, d3 decays)', () => {
    // The additive-knob contract: defaults = the shipped behaviour. releaseAlpha
    // 0 (a release injects nothing), alphaDecay/velocityDecay exactly d3's own
    // defaults (the values d3 computes internally when never configured).
    expect(FORCE_PARAMS.releaseAlpha).toBe(0)
    expect(FORCE_PARAMS.alphaDecay).toBe(1 - Math.pow(0.001, 1 / 300))
    expect(FORCE_PARAMS.velocityDecay).toBe(0.4)
  })
})

// ── 2. WIRING: each knob reaches its d3 setting ────────────────────────────

describe('ForceSim regime knob wiring (MYT-89 audit v4)', () => {
  it('releaseAlpha re-energises the layout when a PINNED node is released', () => {
    // Settle to convergence (alpha ~0 — the sim is asleep), then pin+release one
    // node IN PLACE (no displacement, so any subsequent motion is reheat energy,
    // not a collision resolving). With releaseAlpha the whole layout stirs; at
    // the default 0 the same release moves nothing.
    const settledRelease = (releaseAlpha: number): number => {
      const sim = create({
        width: 900,
        height: 470,
        random: lcg(0x5eed5),
        params: { releaseAlpha },
      })
      const { nodes, edges } = twoCommunities()
      sim.sync(nodes, edges)
      for (let i = 0; i < 800; i++) sim.tick()
      const before = positionsCopy(sim.positions())
      const seat = before.get('a1')
      if (seat === undefined) throw new Error('missing node')
      sim.pin('a1', seat.x, seat.y)
      sim.tick()
      sim.unpin('a1')
      for (let i = 0; i < 60; i++) sim.tick()
      const after = sim.positions()
      let total = 0
      for (const key of after.keys()) total += displacement(before, after, key)
      return total
    }
    expect(settledRelease(0)).toBeLessThan(0.5) // the shipped path: release is inert
    expect(settledRelease(0.9)).toBeGreaterThan(20) // the regime: release re-asserts
  })

  it('does NOT inject release energy for a node that was never pinned (the tap path)', () => {
    // The pointer layer unpins on TAP too ("release any prior pin") — under the
    // forceful regime a tap must not jolt the settled world. Only a release of a
    // node that was actually pinned carries the reheat.
    const sim = create({
      width: 900,
      height: 470,
      random: lcg(0x5eed5),
      params: { releaseAlpha: 0.9 },
    })
    const { nodes, edges } = twoCommunities()
    sim.sync(nodes, edges)
    for (let i = 0; i < 800; i++) sim.tick()
    const before = positionsCopy(sim.positions())

    sim.unpin('a1') // never pinned — the tap path's blanket release
    for (let i = 0; i < 60; i++) sim.tick()

    const after = sim.positions()
    let total = 0
    for (const key of after.keys()) total += displacement(before, after, key)
    expect(total).toBeLessThan(0.5)
  })

  it('alphaDecay dials how fast a reheat cools (higher = less total motion)', () => {
    // Same seed, same graph, one sync reheat — the only difference is the decay.
    // Faster decay must strictly cut the motion integrated over the settle.
    const totalMotion = (alphaDecay: number): number => {
      const sim = create({
        width: 4000,
        height: 4000,
        random: lcg(0xdecaf),
        params: { alphaDecay, boundaryStrength: 0, margin: 0 },
      })
      sim.sync([node('a'), node('b'), node('c')], [])
      let travelled = 0
      let prev = positionsCopy(sim.positions())
      for (let i = 0; i < 300; i++) {
        sim.tick()
        const now = sim.positions()
        for (const key of now.keys()) travelled += displacement(prev, now, key)
        prev = positionsCopy(now)
      }
      return travelled
    }
    const fast = totalMotion(0.1)
    const slow = totalMotion(0.01)
    expect(fast).toBeLessThan(slow)
  })

  it('velocityDecay dials the friction (higher = shorter travel under one impulse)', () => {
    // One free node given a single velocity impulse via a pin-release under a
    // dead field (all forces off): its coasting distance is a pure function of
    // the velocity decay. Heavier friction must travel strictly shorter.
    const coast = (velocityDecay: number): number => {
      const sim = create({
        width: 4000,
        height: 4000,
        random: lcg(0xf01c),
        params: {
          velocityDecay,
          chargeStrength: 0,
          boundaryStrength: 0,
          margin: 0,
          seedJitter: 0,
          // A hot release is the impulse source: the reheat scales the (tiny
          // but nonzero) force field; with every force zeroed the only motion
          // left is the boxCollide-free integration of existing velocity — so
          // seed velocity directly instead via two overlapping boxes.
          releaseAlpha: 0,
        },
      })
      sim.sync([node('a'), node('b')], [])
      // Two coincident boxes: the (non-alpha-scaled) box collide fires one
      // deterministic separation impulse; the coast length differs only by the
      // velocity decay.
      sim.setBoxes(
        new Map<string, NodeBox>([
          ['a', box(20)],
          ['b', box(20)],
        ]),
      )
      for (let i = 0; i < 200; i++) sim.tick()
      const p = sim.positions()
      const a = p.get('a')
      const b = p.get('b')
      if (a === undefined || b === undefined) throw new Error('missing node')
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    const heavy = coast(0.7)
    const light = coast(0.2)
    expect(heavy).toBeLessThan(light)
  })
})

// ── 3. THE SNAP-BACK PIN (the reveal regime's headline behaviour) ──────────

/** Strict segment intersection + crossing count (the clustering suite's tangle
 *  measure, over the given edge set). */
function countCrossings(edges: GraphEdge[], p: Map<string, Pos>): number {
  const orient = (o: Pos, q: Pos, r: Pos): number =>
    Math.sign((q.x - o.x) * (r.y - o.y) - (q.y - o.y) * (r.x - o.x))
  let crossings = 0
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e1 = edges[i]
      const e2 = edges[j]
      if (e1 === undefined || e2 === undefined) throw new Error('missing edge')
      if (e1.from === e2.from || e1.from === e2.to || e1.to === e2.from || e1.to === e2.to) continue
      const a = p.get(e1.from)
      const b = p.get(e1.to)
      const c = p.get(e2.from)
      const d = p.get(e2.to)
      if (a === undefined || b === undefined || c === undefined || d === undefined) {
        throw new Error('missing position')
      }
      const d1 = orient(c, d, a)
      const d2 = orient(c, d, b)
      const d3 = orient(a, b, c)
      const d4 = orient(a, b, d)
      if (d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0) crossings++
    }
  }
  return crossings
}

/** Mean position of one community's nodes. */
function centroid(p: Map<string, Pos>, ids: string[]): Pos {
  let x = 0
  let y = 0
  for (const id of ids) {
    const pos = p.get(id)
    if (pos === undefined) throw new Error(`missing node ${id}`)
    x += pos.x
    y += pos.y
  }
  return { x: x / ids.length, y: y / ids.length }
}

describe('ForceSim snap-back under REVEAL_FORCE_PARAMS (MYT-89 audit v4)', () => {
  it('a dragged node released far across the world snaps back into its community, the world holding', () => {
    // The reveal's contract: the settled world INSISTS on its shape. A force
    // layout's equilibrium is only defined up to its symmetries (a leaf ring
    // re-closes with the returning node docked at the nearest open slot), so
    // the honest observables are NOT per-node coordinates but: the drag
    // displacement COLLAPSES (the node visibly flies back), the node re-enters
    // its own community (dist-to-community-centroid back at ring scale), every
    // BYSTANDER holds its seat (a re-settle, not a reshuffle), the crossing
    // count stays bounded (no lingering user-made tangle), and the whole thing
    // is CONVERGED within 240 ticks (~4s at 60fps). Thresholds carry ~1.3–2×
    // slack over the measured run at the locked profile (ratio 0.41, rejoin 74,
    // maxOther 65, Δcrossings +6, drift 0.10) — tight enough that the shipped
    // default path (which leaves the node AT the drop point, ratio ~1.0) fails
    // the headline assertions.
    const { nodes, edges, a } = twoCommunities()
    const sim = create({
      width: 900,
      height: 470,
      random: lcg(0x2f6e2b1),
      params: REVEAL_FORCE_PARAMS,
    })
    // The reveal's mount path: the settled world lands in ONE sync (nodes +
    // edges together — the route mounts a fresh sim at the gen→reveal swap).
    sim.sync(nodes, edges)
    sim.setBoxes(new Map<string, NodeBox>(nodes.map((n) => [n.displayId, box(50)])))
    for (let i = 0; i < 900; i++) sim.tick()

    const equilibrium = positionsCopy(sim.positions())
    const seat = equilibrium.get('a3')
    if (seat === undefined) throw new Error('missing node')
    const crossingsBefore = countCrossings(edges, equilibrium)

    // The drag: the far corner, clean across the other community (~500px).
    const dragX = seat.x > 0 ? -380 : 380
    const dragY = seat.y > 0 ? -190 : 190
    const dragDistance = Math.hypot(dragX - seat.x, dragY - seat.y)
    expect(dragDistance).toBeGreaterThan(300)
    sim.pin('a3', dragX, dragY)
    for (let i = 0; i < 30; i++) sim.tick()
    sim.unpin('a3')
    for (let i = 0; i < 240; i++) sim.tick()

    const after = positionsCopy(sim.positions())
    // The snap: the drag displacement collapsed by half or better (the shipped
    // default path holds ratio ~1.0 — the node stays where it was dropped).
    expect(displacement(equilibrium, after, 'a3') / dragDistance).toBeLessThan(0.5)
    // The return: the node is back INSIDE its own community — its distance to
    // the community centroid is at ring scale again, nowhere near the drop.
    const own = centroid(after, a)
    const rejoined = after.get('a3')
    if (rejoined === undefined) throw new Error('missing node')
    expect(Math.hypot(rejoined.x - own.x, rejoined.y - own.y)).toBeLessThan(100)
    // The world held: every bystander re-seats near where the equilibrium had
    // it — the release reheat re-settles the fabric, never reshuffles it.
    for (const key of after.keys()) {
      if (key === 'a3') continue
      expect(displacement(equilibrium, after, key), `${key} reshuffled`).toBeLessThan(120)
    }
    // No lingering user-made tangle: the crossing count stays bounded at its
    // equilibrium level (± the fixture's re-settle noise — the count is a
    // coarse, jumpy measure on 23 edges in a cramped 900×470).
    expect(countCrossings(edges, after)).toBeLessThanOrEqual(crossingsBefore + 8)
    // Converged: 40 more ticks move nothing perceptible — the snap is OVER
    // within the 240-tick window, not still drifting.
    for (let i = 0; i < 40; i++) sim.tick()
    let drift = 0
    for (const key of after.keys()) drift = Math.max(drift, displacement(after, sim.positions(), key))
    expect(drift).toBeLessThan(1)
  })

  it('the reveal profile stays a PARTIAL preset over the locked FORCE_PARAMS', () => {
    // The additive-preset discipline: the profile overrides ONLY its own knobs —
    // never a locked spread value it doesn't mean to own. Guards an accidental
    // full-params export (which would silently freeze future FORCE_PARAMS tuning
    // out of the reveal).
    const lockedKeys = Object.keys(REVEAL_FORCE_PARAMS)
    expect(lockedKeys).not.toContain('chargeStrength')
    expect(lockedKeys).not.toContain('chargeDistanceMax')
    expect(lockedKeys).not.toContain('collisionPadding')
    expect(lockedKeys).not.toContain('seedJitter')
    expect(lockedKeys).not.toContain('margin')
    // …and the snap-back essentials are present.
    expect(REVEAL_FORCE_PARAMS.releaseAlpha).toBeGreaterThan(0)
  })
})
