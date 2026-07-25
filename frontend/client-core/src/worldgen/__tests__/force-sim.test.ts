import { describe, it, expect } from 'vitest'
import { create, FORCE_PARAMS } from '../force-sim.ts'
import type { ForceParams, NodeBox, StaticKeepOut } from '../force-sim.ts'
import type { GraphNode, GraphEdge } from '../graph-reducers.ts'

// The world-gen graph populates live as entities stream in over ~10 minutes.
// The physics must NOT reset every time a new entity arrives (spec §6, the
// "Vidia-I2" fix): a `sync` MERGES the incoming set into a persistent internal
// node array — survivors keep their settled position + momentum, only genuinely
// new synthKeys are seeded near centre, and removed ones drop out. These tests
// prove that node-identity guarantee against the real d3-force wrapper.

// A viewport big enough that the small graphs these identity/link/pin tests build
// never reach the containment boundary — so containment (BUG 2.2) is invisible to
// them and they assert the same behaviour they always did (a pin at (100, 200) is
// well within the ±2000 half-dimensions). The dedicated containment suite below
// uses a deliberately tiny viewport to force the escape-then-clamp.
const VIEWPORT = { width: 4000, height: 4000 }

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

/** A node whose render identity (`displayId`) differs from its `synthKey` — the
 *  post-finalize reality: a live-won node keeps its `${stage}/…` synthKey but its
 *  `displayId` swaps to the real entity UUID. Edges reference that UUID. */
function heteroNode(synthKey: string, displayId: string): GraphNode {
  return {
    synthKey,
    kind: 'faction',
    name: displayId,
    displayId,
    state: 'finalized',
    lastEventIndex: 0,
  }
}

function edge(synthKey: string, from: string, to: string): GraphEdge {
  return { synthKey, from, to, relationship: 'allied', arrivalIndex: 0, sourceStage: 'weave' }
}

function dist(positions: Map<string, { x: number; y: number }>, a: string, b: string): number {
  const pa = positions.get(a)
  const pb = positions.get(b)
  if (pa === undefined || pb === undefined) throw new Error('missing node')
  return Math.hypot(pa.x - pb.x, pa.y - pb.y)
}

const EPS = 1e-6

/** Deterministic LCG (the generator every force-sim suite inlines). Used to PIN the
 *  initial node placement for the stochastic-settle link tests below: `seedNode` draws
 *  the seed positions from the injected RNG, so an un-seeded (`Math.random`) run makes
 *  the settled layout — and any distance-inequality assertion over it — non-reproducible. */
function lcg(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

/** A representative icon+label collision box (SIGNED offset extents relative to the node
 *  position) — the shape the fog reserves per entity (WorldGenFog `labelBoxExtents`): the icon
 *  at the LEFT, the text label extending RIGHT by `textWidth`, the box centred slightly ABOVE
 *  the anchor (the `LABEL_CAP_Y_OFFSET = 3` capsule), height = the reference `[-16, +9]` clear
 *  window (25). A wider label = more horizontal extent, SAME height — the asymmetry the
 *  rectangular collide packs around. The sim takes plain NUMBERS (no DOM / canvas). */
function box(textWidth: number): NodeBox {
  const sz = 11 // ENTITY_SIZE.DEFAULT
  return { left: -sz / 2, right: sz + textWidth, top: -15.5, bottom: 9.5 }
}

interface Pos {
  x: number
  y: number
}

/** The signed X/Y overlap of two OFFSET boxes at their node positions (positive = overlap). */
function boxOverlap(pa: Pos, ba: NodeBox, pb: Pos, bb: NodeBox): { x: number; y: number } {
  return {
    x: Math.min(pa.x + ba.right, pb.x + bb.right) - Math.max(pa.x + ba.left, pb.x + bb.left),
    y: Math.min(pa.y + ba.bottom, pb.y + bb.bottom) - Math.max(pa.y + ba.top, pb.y + bb.top),
  }
}

/** Two OFFSET boxes are DISJOINT when they don't overlap on at least one axis (accounting for
 *  the vertical offset baked into `top`/`bottom`). */
function boxesDisjoint(pa: Pos, ba: NodeBox, pb: Pos, bb: NodeBox): boolean {
  const o = boxOverlap(pa, ba, pb, bb)
  return o.x <= EPS || o.y <= EPS
}

/** Only the rectangular collide acts (charge / centre / boundary off, no padding, no seed
 *  jitter so every node starts coincident at the origin) — isolates the box separation so a
 *  disjoint settle is attributable to collide alone, not to charge repulsion. */
const COLLIDE_ONLY: Partial<ForceParams> = {
  chargeStrength: 0,
  centerStrength: 0,
  boundaryStrength: 0,
  collisionPadding: 0,
  seedJitter: 0,
  margin: 0,
}

describe('ForceSim node-identity preservation', () => {
  it('keeps a survivor at its settled position across a sync that adds a node', () => {
    const sim = create(VIEWPORT)

    sim.sync([node('a'), node('b')], [])
    for (let i = 0; i < 50; i++) sim.tick()

    const settled = sim.positions().get('a')
    if (settled === undefined) throw new Error('a not present')
    // A two-node repulsion settles the survivor off-origin, so the equality
    // assertion below is meaningful (not a trivial 0,0 == 0,0).
    expect(Math.hypot(settled.x, settled.y)).toBeGreaterThan(0)

    // A new entity streams in. The survivor must NOT teleport.
    sim.sync([node('a'), node('b'), node('c')], [])

    const after = sim.positions()
    expect(after.get('a')).toEqual(settled)

    // The genuinely-new node exists, seeded within the JITTER ENVELOPE near centre
    // (max hypot = (seedJitter/2)·√2 < seedJitter) so it flies out organically from
    // the middle rather than snapping in from d3's phyllotaxis spiral. The exact
    // envelope is the tunable `seedJitter` (MYT-89 audit #4), not the old ±1px.
    const fresh = after.get('c')
    if (fresh === undefined) throw new Error('c not present')
    expect(Math.hypot(fresh.x, fresh.y)).toBeLessThan(FORCE_PARAMS.seedJitter)
  })

  it('preserves every survivor when a burst of new nodes arrives at once', () => {
    const sim = create(VIEWPORT)

    sim.sync([node('a'), node('b')], [])
    for (let i = 0; i < 50; i++) sim.tick()
    const before = sim.positions()

    const burst = [node('a'), node('b')]
    for (let i = 0; i < 20; i++) burst.push(node(`new-${String(i)}`))
    sim.sync(burst, [])

    const after = sim.positions()
    expect(after.get('a')).toEqual(before.get('a'))
    expect(after.get('b')).toEqual(before.get('b'))
    expect(after.size).toBe(22)
  })

  it('keeps a settled node at its position when it finalizes (synthKey stable, displayId synthKey→UUID)', () => {
    // The post-finalize reality: a live-won node keeps its `${stage}/…` synthKey but
    // its `displayId` swaps from that synthKey to the real entity UUID. The sim keys
    // INTERNAL identity on the STABLE synthKey, so the node keeps its object ref and
    // its settled position across the finalize — it must NOT be delete-then-reseeded
    // to centre (the regression this test guards). Positions are reported in the
    // EXTERNAL displayId space, which is the thing that swaps.
    const synthKey = 'world_and_factions/factions/0'
    const uuid = '018f7b21-dddd-7000-8000-000000000004'
    const sim = create(VIEWPORT)

    // Pre-finalize: displayId === synthKey. Settle a two-node layout off-origin.
    sim.sync([node(synthKey), node('b')], [])
    for (let i = 0; i < 50; i++) sim.tick()

    const settled = sim.positions().get(synthKey)
    if (settled === undefined) throw new Error('node not present pre-finalize')
    // Off-origin, so the equality assertion below is meaningful (not 0,0 == 0,0).
    expect(Math.hypot(settled.x, settled.y)).toBeGreaterThan(0)

    // Finalize: SAME synthKey, displayId synthKey→UUID.
    sim.sync([heteroNode(synthKey, uuid), node('b')], [])

    const after = sim.positions()
    // The external key moved from the synthKey to the UUID (displayId space)…
    expect(after.has(synthKey)).toBe(false)
    const moved = after.get(uuid)
    if (moved === undefined) throw new Error('node not present post-finalize')
    // …but the settled position is IDENTICAL — the node did NOT teleport to centre.
    expect(moved).toEqual(settled)
  })

  it('drops a synthKey that is absent from the next sync', () => {
    const sim = create(VIEWPORT)

    sim.sync([node('a'), node('b')], [])
    for (let i = 0; i < 10; i++) sim.tick()
    expect(sim.positions().has('b')).toBe(true)

    sim.sync([node('a')], [])
    const after = sim.positions()
    expect(after.has('b')).toBe(false)
    expect(after.has('a')).toBe(true)
  })
})

describe('ForceSim link force', () => {
  it('pulls a linked pair closer than the unlinked pairs under identical forces', () => {
    // Seeded (not `Math.random`) so the settle is REPRODUCIBLE. The invariant holds
    // for the overwhelming majority of seed layouts, but an unlucky un-seeded start
    // that drops the unlinked node C between the pair does not fully resolve in 300
    // ticks — a rare (~0.4%/run) flake that surfaces once in a while under full-suite
    // load. This fixed seed pins a representative layout (the linked pair settles ~72px
    // shorter than either unlinked pair); it changes NO sim value, only the RNG stream.
    const sim = create({ ...VIEWPORT, random: lcg(0xbadd1e) })

    // a-b linked; a-c and b-c only repel. Same global charge/centre forces act
    // on all three, so the linked side must end up the shortest.
    sim.sync([node('a'), node('b'), node('c')], [edge('e-ab', 'a', 'b')])
    for (let i = 0; i < 300; i++) sim.tick()

    const p = sim.positions()
    expect(dist(p, 'a', 'b')).toBeLessThan(dist(p, 'a', 'c'))
    expect(dist(p, 'a', 'b')).toBeLessThan(dist(p, 'b', 'c'))
  })

  it('ignores an edge whose endpoint is not a known node (no crash)', () => {
    const sim = create(VIEWPORT)
    expect(() => {
      sim.sync([node('a')], [edge('e-ax', 'a', 'ghost')])
      for (let i = 0; i < 10; i++) sim.tick()
    }).not.toThrow()
  })

  it('connects a live-won node to a seed-only node across a UUID edge (BUG 2.1)', () => {
    // The BUG 2.1 reconciliation: nodes render/simulate in `displayId` space, and
    // edges reference entity UUIDs (= the endpoints' `displayId`). A live-won node
    // keeps a `${stage}/…` synthKey but a UUID displayId; a seed-only node's
    // synthKey IS its UUID. Keying the sim on synthKey (the old behaviour) made
    // `buildLinks` look the edge's UUID endpoints up in a synthKey map and MISS —
    // the edge dropped, so nothing pulled the pair together. Keyed on displayId the
    // edge is retained and the linked pair settles closer than an unlinked control.
    const uuidA = '018f7b21-aaaa-7000-8000-000000000001'
    const uuidB = '018f7b21-bbbb-7000-8000-000000000002'
    const uuidC = '018f7b21-cccc-7000-8000-000000000003'
    // Seeded for the same reason as the sibling link test above: the distance
    // inequality is a stochastic-settle assertion, so the initial placement must be
    // pinned (un-seeded `Math.random` under-resolves on a rare unlucky layout). This
    // seed settles the linked pair ~43px shorter than either unlinked pair.
    const sim = create({ ...VIEWPORT, random: lcg(0x2f6e2b1) })

    sim.sync(
      [
        heteroNode('world_and_factions/factions/0', uuidA),
        heteroNode(uuidB, uuidB),
        heteroNode(uuidC, uuidC),
      ],
      [edge('e-ab', uuidA, uuidB)],
    )
    for (let i = 0; i < 300; i++) sim.tick()

    const p = sim.positions()
    // Positions are keyed by displayId (the UUID) — the render/edge id-space.
    expect(dist(p, uuidA, uuidB)).toBeLessThan(dist(p, uuidA, uuidC))
    expect(dist(p, uuidA, uuidB)).toBeLessThan(dist(p, uuidB, uuidC))
  })
})

describe('ForceSim pin / unpin', () => {
  it('fixes a node at the pin across ticks, then frees it on unpin', () => {
    const sim = create(VIEWPORT)

    sim.sync([node('a'), node('b')], [])
    sim.pin('a', 100, 200)
    for (let i = 0; i < 20; i++) sim.tick()

    expect(sim.positions().get('a')).toEqual({ x: 100, y: 200 })

    sim.unpin('a')
    for (let i = 0; i < 30; i++) sim.tick()

    // Freed, the node moves off the pin under the residual repulsion/centre.
    expect(sim.positions().get('a')).not.toEqual({ x: 100, y: 200 })
  })

  it('is a no-op when pinning a synthKey that is not in the sim', () => {
    const sim = create(VIEWPORT)
    sim.sync([node('a')], [])

    // A drag-pin racing a `stage-reset` that already dropped the node: the pin
    // must not resurrect it or throw — the unknown key is simply ignored.
    expect(() => {
      sim.pin('ghost', 10, 20)
    }).not.toThrow()
    expect(sim.positions().has('ghost')).toBe(false)
    expect(sim.positions().size).toBe(1)
  })

  it('is a no-op when unpinning a synthKey that is not in the sim', () => {
    const sim = create(VIEWPORT)
    sim.sync([node('a')], [])

    expect(() => {
      sim.unpin('ghost')
    }).not.toThrow()
    expect(sim.positions().has('ghost')).toBe(false)
    expect(sim.positions().size).toBe(1)
  })
})

describe('ForceSim alpha readout (ux-run2 myth-uis1p — pin-on-settle)', () => {
  it('reports the sync reheat, then decays toward zero over ticks', () => {
    const sim = create(VIEWPORT)
    sim.sync([node('a'), node('b')], [])
    // A sync injects reheat energy — the field is HOT right after.
    const hot = sim.alpha()
    expect(hot).toBeGreaterThan(0.05)
    // The energy cools tick by tick (d3's alphaDecay) — this is the signal the
    // ui's pin-on-settle waits for before freezing labeled nodes in place.
    for (let i = 0; i < 400; i++) sim.tick()
    expect(sim.alpha()).toBeLessThan(0.05)
    expect(sim.alpha()).toBeLessThan(hot)
  })
})

describe('ForceSim viewport containment (BUG 2.2)', () => {
  it('keeps every node inside the centred draw space under strong repulsion', () => {
    // BUG 2.2: nodes escape the viewport ("should be impossible"). A dense cloud of
    // mutually-repelling nodes with NO links is pure outward pressure — before
    // containment (a boundary force + distanceMax + the per-tick clamp) the cloud
    // blows well past the half-dimensions and nodes draw off-screen. A deliberately
    // tiny viewport makes the escape unmissable; the assertion is the hard guarantee.
    // `margin: 0` pins the FULL-edge clamp this test was written for (the containment
    // margin — MYT-89 follow-up — has its own inset test below); without it the default
    // margin would inset the bound past this tiny viewport's half-height and the test
    // would collapse to the centre line, no longer exercising the ±half clamp.
    const width = 100
    const height = 80
    const sim = create({ width, height, params: { margin: 0 } })

    const many: GraphNode[] = []
    for (let i = 0; i < 30; i++) many.push(node(`n-${String(i)}`))
    sim.sync(many, [])
    for (let i = 0; i < 500; i++) sim.tick()

    const halfW = width / 2
    const halfH = height / 2
    for (const [key, p] of sim.positions()) {
      expect(Math.abs(p.x), `${key} escaped on x`).toBeLessThanOrEqual(halfW)
      expect(Math.abs(p.y), `${key} escaped on y`).toBeLessThanOrEqual(halfH)
    }
  })
})

describe('ForceSim containment margin inset (MYT-89 follow-up)', () => {
  it('holds settled nodes inside the INSET bound ±(half − margin), strictly within ±half', () => {
    // A CSS-style containment margin: the per-tick clamp insets from the full
    // half-dimensions to ±(half − margin), so a boundary node settles a label-safe
    // distance BEFORE the frame edge (its NAME clears the viewport instead of clipping).
    // A dense mutually-repelling cloud (pure outward pressure) packs against the inset
    // bound; every node must land within it — and thus STRICTLY inside the full ±half.
    // Deterministic LCG seeding so the settle is reproducible.
    const random = lcg(0x2f6e2b1)
    const width = 200
    const height = 160
    const margin = 40
    const sim = create({ width, height, params: { margin }, random })

    const many: GraphNode[] = []
    for (let i = 0; i < 30; i++) many.push(node(`n-${String(i)}`))
    sim.sync(many, [])
    for (let i = 0; i < 500; i++) sim.tick()

    const halfW = width / 2 // 100
    const halfH = height / 2 // 80
    const boundW = halfW - margin // 60
    const boundH = halfH - margin // 40
    // The inset is a REAL inset — strictly inside the full half on both axes.
    expect(boundW).toBeLessThan(halfW)
    expect(boundH).toBeLessThan(halfH)

    const pts = [...sim.positions().values()]
    for (const p of pts) {
      // Within the inset bound — and therefore strictly inside the full ±half.
      expect(Math.abs(p.x)).toBeLessThanOrEqual(boundW)
      expect(Math.abs(p.y)).toBeLessThanOrEqual(boundH)
      expect(Math.abs(p.x)).toBeLessThan(halfW)
      expect(Math.abs(p.y)).toBeLessThan(halfH)
    }

    // The inset is the ACTIVE bound, not incidental centring: the outward pressure
    // packs at least one node AGAINST it on each axis. A broken clamp still using the
    // full half would let a node past boundW/boundH and the per-node loop above fails;
    // this guards the opposite — that the margin isn't so aggressive nothing reaches it.
    const maxAbsX = Math.max(...pts.map((p) => Math.abs(p.x)))
    const maxAbsY = Math.max(...pts.map((p) => Math.abs(p.y)))
    expect(maxAbsX).toBeGreaterThan(boundW - 1)
    expect(maxAbsY).toBeGreaterThan(boundH - 1)
  })
})

describe('ForceSim box-aware containment (MYT-89 label-clip fix)', () => {
  // The bug: the per-tick clamp bounded the ICON point, so a node's NAME (drawn to the RIGHT of
  // the icon — box.right px past it — and offset vertically) could clip out of the viewport even
  // with the icon safely inside. The fix clamps the whole icon+label BOX into the inset bound, not
  // the icon point. A viewport where the clamp is easy to reason about: half = 200, margin 50 →
  // bound = 150. Pinning a node past an edge then ticking once is the cleanest driver: d3 seats a
  // pinned node at x = fx during the integration step, then the per-tick clamp bounds it, so
  // `positions()` reports the clamped coordinate deterministically (one tick, no settle needed).
  const CONTAIN = { width: 400, height: 400, params: { margin: 50 } }
  const BOUND = 150 // half (200) − margin (50)

  it('clamps a RIGHT-extending box so the LABEL edge stays in-frame, not just the icon', () => {
    const sim = create(CONTAIN)
    sim.sync([node('a')], [])
    const b = box(100) // wide right label: right = 11 + 100 = 111
    sim.setBoxes(new Map<string, NodeBox>([['a', b]]))
    sim.pin('a', 1000, 0) // way past the right edge
    sim.tick()

    // The icon insets to `bound − box.right`, so the box's RIGHT edge lands exactly ON the inset
    // bound (x + box.right = BOUND) — the NAME clears the frame. Pre-fix the icon sat at ±BOUND
    // and the label ran off; the exact value guards against both under- and over-clamping.
    expect(sim.positions().get('a')?.x).toBeCloseTo(BOUND - b.right, 6)
  })

  it('clamps a LEFT-extending box so its left edge stays in-frame', () => {
    // Mirror of the right case: a box whose LEFT extent dominates (a left-hung label). The icon
    // insets to the RIGHT by |box.left| so the box's left edge lands on −BOUND (x + box.left).
    const sim = create(CONTAIN)
    sim.sync([node('a')], [])
    const b: NodeBox = { left: -100, right: 5, top: -15.5, bottom: 9.5 }
    sim.setBoxes(new Map<string, NodeBox>([['a', b]]))
    sim.pin('a', -1000, 0)
    sim.tick()

    expect(sim.positions().get('a')?.x).toBeCloseTo(-BOUND - b.left, 6)
  })

  it('clamps the box on the Y axis too (top/bottom extents)', () => {
    // The vertical mirror — the label clear-window (top/bottom) is held inside the inset so a node
    // near the top edge doesn't clip its label window above the icon (box top edge lands on −BOUND).
    const sim = create(CONTAIN)
    sim.sync([node('a')], [])
    const b: NodeBox = { left: -5, right: 5, top: -40, bottom: 20 }
    sim.setBoxes(new Map<string, NodeBox>([['a', b]]))
    sim.pin('a', 0, -1000) // past the top edge
    sim.tick()

    expect(sim.positions().get('a')?.y).toBeCloseTo(-BOUND - b.top, 6)
  })

  it('falls back to the icon-point clamp for a node with NO measured box (unchanged)', () => {
    // A node the ui hasn't measured yet (box === undefined) keeps the pre-fix behaviour: the ICON
    // point is clamped to ±bound (no box to inset by). The existing containment suites also rely
    // on this — they never set boxes.
    const sim = create(CONTAIN)
    sim.sync([node('a')], []) // no setBoxes → box stays undefined
    sim.pin('a', 1000, 1000)
    sim.tick()

    expect(sim.positions().get('a')?.x).toBeCloseTo(BOUND, 6)
    expect(sim.positions().get('a')?.y).toBeCloseTo(BOUND, 6)
  })

  it('centres a box WIDER than the available span instead of inverting the bound', () => {
    // A label wider than the whole inset span (rare: a name wider than the viewport). The computed
    // upper bound falls BELOW the lower — clamping to either edge would be arbitrary and could
    // invert. Instead the box is centred in the span, overflowing symmetrically. bound = 50 here;
    // the asymmetric box (left −100, right +300) centres at ((−50 − −100) + (50 − 300)) / 2 = −100,
    // independent of which edge it is driven toward.
    const sim = create({ width: 200, height: 200, params: { margin: 50 } }) // bound = 50
    sim.sync([node('a')], [])
    const b: NodeBox = { left: -100, right: 300, top: -15.5, bottom: 9.5 }
    sim.setBoxes(new Map<string, NodeBox>([['a', b]]))

    sim.pin('a', 1000, 0)
    sim.tick()
    expect(sim.positions().get('a')?.x).toBeCloseTo(-100, 6)

    sim.pin('a', -1000, 0)
    sim.tick()
    expect(sim.positions().get('a')?.x).toBeCloseTo(-100, 6)
  })
})

describe('ForceSim spread (MYT-89 audit #4)', () => {
  it('spreads a burst to FILL the space (not a central clump), contained + non-overlapping', () => {
    // The audit-#4 bug: nodes clumped in the centre of the 900×470 draw space. The
    // re-tuned DEFAULTS (stronger charge, wider distanceMax, no centre pull, box collide,
    // real seed jitter) must instead SPREAD the graph to fill the space. Deterministic
    // seeding (an injected LCG) so the settled layout is reproducible — big seedJitter
    // means no coincident nodes, so d3's internal coincidence jiggle never fires either.
    const random = lcg(0x2f6e2b1)
    const width = 900
    const height = 470
    const sim = create({ width, height, random })

    const many: GraphNode[] = []
    for (let i = 0; i < 24; i++) many.push(node(`n-${String(i)}`))
    sim.sync(many, [])
    // Real icon+label boxes are the collision unit now (a modest ~50px label each) — set them
    // before settling so the rectangular collide has geometry to separate.
    const nodeBox = box(50)
    const boxes = new Map<string, NodeBox>(many.map((n) => [n.displayId, nodeBox]))
    sim.setBoxes(boxes)
    for (let i = 0; i < 600; i++) sim.tick()

    const p = sim.positions()
    const pts = [...p.values()]
    const xs = pts.map((pt) => pt.x)
    const ys = pts.map((pt) => pt.y)
    const xSpan = Math.max(...xs) - Math.min(...xs)
    const ySpan = Math.max(...ys) - Math.min(...ys)

    // SPREAD: the settled bounding box covers a large fraction of the space on BOTH
    // axes — the re-tune fills 900×470 rather than clumping near centre.
    expect(xSpan).toBeGreaterThan(0.5 * width) // > 450 of 900
    expect(ySpan).toBeGreaterThan(0.5 * height) // > 235 of 470

    // CONTAINMENT (B2 intact): the per-tick hard clamp still bounds the now-much-stronger
    // repulsion — no node escapes the centred draw space.
    const halfW = width / 2
    const halfH = height / 2
    for (const pt of pts) {
      expect(Math.abs(pt.x)).toBeLessThanOrEqual(halfW)
      expect(Math.abs(pt.y)).toBeLessThanOrEqual(halfH)
    }

    // NO OVERLAP: the rectangular collide keeps every pair of icon+label BOXES disjoint (not
    // merely centres a fixed distance apart) — so no label ever overlaps a neighbour's icon or
    // text. The offset AABBs are disjoint on at least one axis for every pair.
    const entries = [...p.values()]
    entries.forEach((a, i) => {
      entries.slice(i + 1).forEach((b) => {
        expect(boxesDisjoint(a, nodeBox, b, nodeBox)).toBe(true)
      })
    })
  })
})

describe('ForceSim rectangular box collision (MYT-89 re-audit)', () => {
  it('keeps every icon+label box disjoint after settle — collide-only, wide + narrow boxes', () => {
    // The re-audit fix: collide on the node's icon + FULL text label BOX (an offset AABB), not
    // a circle around the icon. Representative dims — one WIDE (long-label) box beside several
    // NARROW ones, all seeded coincident at the origin (COLLIDE_ONLY). After settle every pair
    // of offset boxes must be disjoint — the vertical offset (top/bottom asymmetry) included.
    const sim = create({ width: 900, height: 470, params: COLLIDE_ONLY })
    sim.sync([node('wide'), node('n1'), node('n2'), node('n3')], [])
    const boxes = new Map<string, NodeBox>([
      ['wide', box(200)],
      ['n1', box(20)],
      ['n2', box(40)],
      ['n3', box(10)],
    ])
    sim.setBoxes(boxes)
    for (let i = 0; i < 500; i++) sim.tick()

    const p = sim.positions()
    const ids = [...boxes.keys()]
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const idA = ids[i]
        const idB = ids[j]
        if (idA === undefined || idB === undefined) throw new Error('missing id')
        const pa = p.get(idA)
        const pb = p.get(idB)
        const ba = boxes.get(idA)
        const bb = boxes.get(idB)
        if (pa === undefined || pb === undefined || ba === undefined || bb === undefined) {
          throw new Error('missing node / box')
        }
        expect(boxesDisjoint(pa, ba, pb, bb), `${idA} and ${idB} overlap`).toBe(true)
      }
    }
  })

  it('a wide label claims horizontal room — a neighbour is pushed clear of the FULL label, not just the icon', () => {
    // A wide node pinned at the origin; a narrow node placed INSIDE the wide label region (same
    // row, x-overlap < the box height so the minimum-overlap axis is X → a horizontal push).
    // The narrow node must end clear of the wide box's RIGHT edge — i.e., past the whole 200px
    // label, not merely the icon: the CORE of the re-audit (text never overlaps a neighbour).
    const sim = create({ width: 1200, height: 470, params: COLLIDE_ONLY })
    sim.sync([node('wide'), node('narrow')], [])
    const wideBox = box(200) // right extent = 211
    const narrowBox = box(10) // right extent = 21
    sim.setBoxes(new Map<string, NodeBox>([['wide', wideBox], ['narrow', narrowBox]]))

    sim.pin('wide', 0, 0)
    sim.pin('narrow', 195, 0) // inside the wide label (wide right edge = 211)
    sim.tick() // seat the pinned start
    sim.unpin('narrow')
    for (let i = 0; i < 500; i++) sim.tick()

    const p = sim.positions()
    const wide = p.get('wide')
    const narrow = p.get('narrow')
    if (wide === undefined || narrow === undefined) throw new Error('missing node')

    // The narrow box's LEFT edge sits at/beyond the wide box's RIGHT edge — it cleared the whole
    // icon + 200px label…
    expect(narrow.x + narrowBox.left).toBeGreaterThanOrEqual(wide.x + wideBox.right - EPS)
    // …which is FAR past what an icon-only circle keep-out (~sz px) would demand.
    expect(narrow.x).toBeGreaterThan(wide.x + 200)
    expect(boxesDisjoint(wide, wideBox, narrow, narrowBox)).toBe(true)
  })

  it('a wide label does NOT force excess vertical spacing (rectangles pack tighter than a circumscribing circle)', () => {
    // Two IDENTICAL wide nodes, coincident at the origin (COLLIDE_ONLY). The minimum-overlap
    // axis for two wide boxes is VERTICAL, so they stack — separated by ~the box HEIGHT, with no
    // horizontal spread. A circle CIRCUMSCRIBING the wide box would force the centres a full
    // DIAMETER apart on every axis; the rectangle separates by a small fraction of that. This is
    // the "packs tighter than a circle" guarantee — a wide label doesn't bloat vertical spacing.
    const sim = create({ width: 900, height: 470, params: COLLIDE_ONLY })
    sim.sync([node('a'), node('b')], [])
    const wide = box(200)
    sim.setBoxes(new Map<string, NodeBox>([['a', wide], ['b', wide]]))
    for (let i = 0; i < 500; i++) sim.tick()

    const p = sim.positions()
    const pa = p.get('a')
    const pb = p.get('b')
    if (pa === undefined || pb === undefined) throw new Error('missing node')
    const dx = Math.abs(pa.x - pb.x)
    const dy = Math.abs(pa.y - pb.y)
    const boxW = wide.right - wide.left // 216.5
    const boxH = wide.bottom - wide.top // 25

    // Stacked vertically: separated by ~the box height, no horizontal spread.
    expect(dx).toBeLessThan(1e-3)
    expect(dy).toBeGreaterThanOrEqual(boxH - EPS)

    // TIGHTER THAN A CIRCLE: a circle enclosing the wide box has radius hypot(w/2, h/2); circle
    // collision would force the centres ≥ that DIAMETER apart. The rectangle uses only ~the
    // height — the wide HORIZONTAL extent never leaks into the vertical spacing.
    const circleDiameter = 2 * Math.hypot(boxW / 2, boxH / 2)
    expect(dy).toBeLessThan(circleDiameter)
    expect(dy).toBeLessThan(boxW)
    expect(boxesDisjoint(pa, wide, pb, wide)).toBe(true)
  })

  it('skips a not-yet-measured node (box undefined) in the pairwise collide, even beside a measured one', () => {
    // A node the ui has NOT measured yet seeds `box: undefined` and must be ignored by collision
    // until its label is measured. Here a MEASURED node (index 0, so it clears the outer guard and
    // enters the inner pass) sits coincident with an UNMEASURED node (index 1); the inner
    // `bBox === undefined` guard skips the pair, so they never separate. seedJitter 0 seeds both at
    // the origin — two MEASURED boxes would be shoved apart (see the "packs tighter" test above), so
    // staying coincident is the proof that the unmeasured node was skipped.
    const sim = create({ width: 900, height: 470, params: COLLIDE_ONLY })
    sim.sync([node('measured'), node('unmeasured')], [])
    sim.setBoxes(new Map<string, NodeBox>([['measured', box(200)]])) // only 'measured' is measured
    for (let i = 0; i < 200; i++) sim.tick()

    const p = sim.positions()
    const m = p.get('measured')
    const u = p.get('unmeasured')
    if (m === undefined || u === undefined) throw new Error('missing node')
    expect(Math.hypot(u.x, u.y)).toBeLessThan(EPS) // unmeasured node never pushed
    expect(Math.hypot(m.x, m.y)).toBeLessThan(EPS) // nor the measured one on its account
  })
})

describe('ForceSim static keep-out (the status-card footprint, MYT-89 density)', () => {
  // The T1 declutter added an IMMOVABLE keep-out rect: the ui measures the DOM status-card
  // overlay's box and hands it over via `setKeepOuts`, and the collide force shoves NODES out
  // from under it (the rect never moves — `separateFromStatic` puts the FULL overlap on the
  // node's velocity along the minimum-overlap axis). These tests drive that against the real
  // sim: an immovable rect centred at the origin, a single node with a measured box (so the
  // box-collide considers it), and COLLIDE_ONLY so ONLY the keep-out acts — the settle is
  // attributable to `separateFromStatic` alone, not to charge/centre/boundary. Deterministic:
  // no charge, no seed jitter, pin→seat→unpin gives an exact start.
  const KO_VIEWPORT = { width: 1000, height: 1000 } // roomy: the ±100 starts never hit the clamp
  const RECT: StaticKeepOut = { left: -50, top: -50, right: 50, bottom: 50 }
  const SMALL: NodeBox = { left: -5, right: 5, top: -5, bottom: 5 } // a small symmetric box

  /** The signed overlap of an offset box (at `p`) with a keep-out rect, per axis (positive =
   *  overlap) — the same test `separateFromStatic` runs, so `≤ EPS on either axis` = cleared. */
  function rectOverlap(p: Pos, b: NodeBox, ko: StaticKeepOut): { x: number; y: number } {
    return {
      x: Math.min(p.x + b.right, ko.right) - Math.max(p.x + b.left, ko.left),
      y: Math.min(p.y + b.bottom, ko.bottom) - Math.max(p.y + b.top, ko.top),
    }
  }
  function clearsRect(p: Pos, b: NodeBox, ko: StaticKeepOut): boolean {
    const o = rectOverlap(p, b, ko)
    return o.x <= EPS || o.y <= EPS
  }

  /** Seat a single boxed node at an exact (x, y) inside/near `rects`, release it, and settle
   *  under the keep-out force alone. Pinning zeroes the node's velocity during the seat tick,
   *  so the release starts from a clean, deterministic pose. */
  function settleWithKeepOut(
    startX: number,
    startY: number,
    nodeBox: NodeBox,
    rects: readonly StaticKeepOut[],
  ): Pos {
    const sim = create({ ...KO_VIEWPORT, params: COLLIDE_ONLY })
    sim.sync([node('a')], [])
    sim.setBoxes(new Map<string, NodeBox>([['a', nodeBox]]))
    sim.setKeepOuts(rects)
    sim.pin('a', startX, startY)
    sim.tick() // seat at the pinned start (velocity zeroed)
    sim.unpin('a')
    for (let i = 0; i < 600; i++) sim.tick()
    const p = sim.positions().get('a')
    if (p === undefined) throw new Error('missing node')
    return p
  }

  it('shoves an overlapping node out along the X axis, in BOTH directions', () => {
    // Near the LEFT edge of the rect (small x-overlap, full-height y-overlap) → the minimum-overlap
    // axis is X, and the node centre sits left of the rect centre → pushed further LEFT (dir −1)
    // until its box's RIGHT edge clears the rect's LEFT edge.
    const left = settleWithKeepOut(-48, 0, SMALL, [RECT])
    expect(left.x).toBeLessThan(-48) // migrated outward, not inward
    expect(left.x + SMALL.right).toBeLessThanOrEqual(RECT.left + EPS)
    expect(clearsRect(left, SMALL, RECT)).toBe(true)

    // Mirror: near the RIGHT edge → pushed RIGHT (dir +1) until its box's LEFT edge clears the
    // rect's RIGHT edge. Covers the other arm of the X-axis direction ternary.
    const right = settleWithKeepOut(48, 0, SMALL, [RECT])
    expect(right.x).toBeGreaterThan(48)
    expect(right.x + SMALL.left).toBeGreaterThanOrEqual(RECT.right - EPS)
    expect(clearsRect(right, SMALL, RECT)).toBe(true)
  })

  it('shoves an overlapping node out along the Y axis, in BOTH directions', () => {
    // Near the TOP edge (small y-overlap, full-width x-overlap) → the minimum-overlap axis is Y,
    // node centre above the rect centre → pushed UP (dir −1) until its box's BOTTOM clears the top.
    const top = settleWithKeepOut(0, -48, SMALL, [RECT])
    expect(top.y).toBeLessThan(-48)
    expect(top.y + SMALL.bottom).toBeLessThanOrEqual(RECT.top + EPS)
    expect(clearsRect(top, SMALL, RECT)).toBe(true)

    // Mirror: near the BOTTOM edge → pushed DOWN (dir +1) until its box's TOP clears the bottom.
    const bottom = settleWithKeepOut(0, 48, SMALL, [RECT])
    expect(bottom.y).toBeGreaterThan(48)
    expect(bottom.y + SMALL.top).toBeGreaterThanOrEqual(RECT.bottom - EPS)
    expect(clearsRect(bottom, SMALL, RECT)).toBe(true)
  })

  it('leaves a node that already clears the rect on one axis untouched (both early returns)', () => {
    // A box entirely LEFT of the rect: no x-overlap → `separateFromStatic` early-returns on
    // `overlapX ≤ 0` and never touches the velocity. With no other force acting, the node holds
    // its exact seeded pose.
    const xClear = settleWithKeepOut(-100, 0, SMALL, [RECT])
    expect(xClear.x).toBeCloseTo(-100, 6)
    expect(xClear.y).toBeCloseTo(0, 6)

    // A box that overlaps on x but is entirely ABOVE the rect: passes the x check, then
    // early-returns on `overlapY ≤ 0`. Covers the second early-return arm.
    const yClear = settleWithKeepOut(0, -100, SMALL, [RECT])
    expect(yClear.x).toBeCloseTo(0, 6)
    expect(yClear.y).toBeCloseTo(-100, 6)
  })

  it('replaces the keep-out set in place — a later setKeepOuts([]) drops the constraint', () => {
    // `setKeepOuts` mutates the SAME array the collide force closed over (`length = 0` then push),
    // so a second call REPLACES the set rather than appending. Arm a rect, then replace it with an
    // empty set: a node parked dead-centre of the (now-cleared) rect must NOT be shoved.
    const sim = create({ ...KO_VIEWPORT, params: COLLIDE_ONLY })
    sim.sync([node('a')], [])
    sim.setBoxes(new Map<string, NodeBox>([['a', SMALL]]))
    sim.setKeepOuts([RECT])
    sim.setKeepOuts([]) // replace in place → the constraint is gone
    sim.pin('a', 0, 0) // dead centre of RECT — a live keep-out WOULD have pushed it out
    sim.tick()
    sim.unpin('a')
    for (let i = 0; i < 600; i++) sim.tick()

    const p = sim.positions().get('a')
    if (p === undefined) throw new Error('missing node')
    expect(p.x).toBeCloseTo(0, 6)
    expect(p.y).toBeCloseTo(0, 6)
    // Control: it is genuinely still inside RECT — so "not pushed" is the cleared set, not luck.
    expect(clearsRect(p, SMALL, RECT)).toBe(false)
  })

  it('reheats a settled sim so the cloud migrates out from under a newly-measured card', () => {
    // `setKeepOuts` bumps alpha (a settled sim would otherwise be frozen and never migrate out
    // from under a card measured late). Settle to convergence, then hand over a keep-out placed
    // FAR from every node (no push) — the reheat alone must re-energise the layout so nodes drift.
    const sim = create(VIEWPORT)
    sim.sync([node('a'), node('b'), node('c')], [])
    for (let i = 0; i < 600; i++) sim.tick()
    const before = new Map([...sim.positions()].map(([k, p]) => [k, { ...p }]))

    sim.setKeepOuts([{ left: 1000, top: 1000, right: 1100, bottom: 1100 }]) // far corner → reheat only
    for (let i = 0; i < 50; i++) sim.tick()

    const moved = [...sim.positions()].some(([k, p]) => {
      const b = before.get(k)
      return b !== undefined && Math.hypot(p.x - b.x, p.y - b.y) > 0.5
    })
    expect(moved).toBe(true)
  })
})
