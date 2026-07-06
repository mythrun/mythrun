import { describe, it, expect } from 'vitest'
import { create } from '../force-sim.ts'
import type { GraphNode, GraphEdge } from '../graph-reducers.ts'

// The world-gen graph populates live as entities stream in over ~10 minutes.
// The physics must NOT reset every time a new entity arrives (spec §6, the
// "Vidia-I2" fix): a `sync` MERGES the incoming set into a persistent internal
// node array — survivors keep their settled position + momentum, only genuinely
// new synthKeys are seeded near centre, and removed ones drop out. These tests
// prove that node-identity guarantee against the real d3-force wrapper.

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
  return { synthKey, kind: 'faction', name: displayId, displayId, state: 'finalized', lastEventIndex: 0 }
}

function edge(synthKey: string, from: string, to: string): GraphEdge {
  return { synthKey, from, to, relationship: 'allied' }
}

function dist(
  positions: Map<string, { x: number; y: number }>,
  a: string,
  b: string,
): number {
  const pa = positions.get(a)
  const pb = positions.get(b)
  if (pa === undefined || pb === undefined) throw new Error('missing node')
  return Math.hypot(pa.x - pb.x, pa.y - pb.y)
}

describe('ForceSim node-identity preservation', () => {
  it('keeps a survivor at its settled position across a sync that adds a node', () => {
    const sim = create()

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

    // The genuinely-new node exists, seeded NEAR CENTRE (small jitter) so it
    // flies out organically rather than snapping in from d3's phyllotaxis spiral.
    const fresh = after.get('c')
    if (fresh === undefined) throw new Error('c not present')
    expect(Math.hypot(fresh.x, fresh.y)).toBeLessThan(5)
  })

  it('preserves every survivor when a burst of new nodes arrives at once', () => {
    const sim = create()

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
    const sim = create()

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
    const sim = create()

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
    const sim = create()

    // a-b linked; a-c and b-c only repel. Same global charge/centre forces act
    // on all three, so the linked side must end up the shortest.
    sim.sync([node('a'), node('b'), node('c')], [edge('e-ab', 'a', 'b')])
    for (let i = 0; i < 300; i++) sim.tick()

    const p = sim.positions()
    expect(dist(p, 'a', 'b')).toBeLessThan(dist(p, 'a', 'c'))
    expect(dist(p, 'a', 'b')).toBeLessThan(dist(p, 'b', 'c'))
  })

  it('ignores an edge whose endpoint is not a known node (no crash)', () => {
    const sim = create()
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
    const sim = create()

    sim.sync(
      [heteroNode('world_and_factions/factions/0', uuidA), heteroNode(uuidB, uuidB), heteroNode(uuidC, uuidC)],
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
    const sim = create()

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
    const sim = create()
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
    const sim = create()
    sim.sync([node('a')], [])

    expect(() => {
      sim.unpin('ghost')
    }).not.toThrow()
    expect(sim.positions().has('ghost')).toBe(false)
    expect(sim.positions().size).toBe(1)
  })
})
