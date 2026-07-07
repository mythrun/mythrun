import { describe, it, expect } from 'vitest'
import { create } from '../force-sim.ts'
import type { GraphNode } from '../graph-reducers.ts'

// ForceSim.setSize — the RESPONSIVE pane resize (MYT-89). The graph's virtual space is
// pane-adaptive now (`virtualDims`), so a pane resize re-derives the sim's containment
// bounds live: a SHRINK re-clamps the settled cloud on the next tick, a GROW reheats so
// repulsion spreads the cloud into the new room, and positions are otherwise untouched
// (no reseed — the same identity/continuity guarantee as `sync`). Split from
// force-sim.test.ts for the file-size rail (mirrors force-sim-clustering.test.ts).

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
describe('ForceSim setSize (the responsive pane resize, MYT-89)', () => {
  it('re-clamps the cloud into the SMALLER inset bound after a shrink', () => {
    // Settle a dense repelling cloud against a roomy bound, then shrink the space:
    // the very next ticks must pull every node inside the NEW inset bound — the
    // clamp is re-derived, not frozen at the creation dims.
    const sim = create({ width: 400, height: 320, params: { margin: 0 } })
    const many: GraphNode[] = []
    for (let i = 0; i < 30; i++) many.push(node(`n-${String(i)}`))
    sim.sync(many, [])
    for (let i = 0; i < 300; i++) sim.tick()

    sim.setSize(100, 80)
    sim.tick() // one tick re-clamps everything (the clamp is per-tick + hard)
    for (const [key, p] of sim.positions()) {
      expect(Math.abs(p.x), `${key} escaped on x`).toBeLessThanOrEqual(50)
      expect(Math.abs(p.y), `${key} escaped on y`).toBeLessThanOrEqual(40)
    }
  })

  it('lets the cloud SPREAD into a grown space (the bound widens + the sim reheats)', () => {
    // Settle against a tiny bound (everything pinned to ±(half − margin)), then grow:
    // the reheat lets repulsion push the cloud past the OLD bound into the new room.
    const sim = create({ width: 100, height: 80, params: { margin: 0 } })
    const many: GraphNode[] = []
    for (let i = 0; i < 20; i++) many.push(node(`n-${String(i)}`))
    sim.sync(many, [])
    for (let i = 0; i < 300; i++) sim.tick()

    sim.setSize(600, 480)
    for (let i = 0; i < 300; i++) sim.tick()
    const spread = [...sim.positions().values()].map((p) => Math.hypot(p.x, p.y))
    // At least one node escapes the old 50×40 half-box into the grown space…
    expect(Math.max(...spread)).toBeGreaterThan(Math.hypot(50, 40))
    // …and everything respects the new bound.
    for (const p of sim.positions().values()) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(300)
      expect(Math.abs(p.y)).toBeLessThanOrEqual(240)
    }
  })

  it('is a no-op for the same dims (positions untouched, no reheat drift)', () => {
    const sim = create({ width: 400, height: 320 })
    sim.sync([node('a'), node('b')], [])
    for (let i = 0; i < 300; i++) sim.tick()
    const before = [...sim.positions().entries()].map(([k, p]) => [k, p.x, p.y])

    sim.setSize(400, 320)
    const after = [...sim.positions().entries()].map(([k, p]) => [k, p.x, p.y])
    expect(after).toEqual(before)
  })
})
