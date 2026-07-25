import { describe, expect, it, vi } from 'vitest'
import type { GraphEdge, GraphNode } from '@mythrun/client-core/contract'
import type { LabelSide } from '../../WorldGenFog/fog-obstacles.ts'
import {
  chooseLabelSides,
  graphSyncKey,
  PIN_SETTLE_ALPHA,
  pinSettledLabels,
} from '../graph-stability.ts'

// Graph stability (ux-run2 myth-uis1p): the content fingerprint that stops
// identity-only re-renders from reheating the sim, and the pin-on-settle that
// freezes each labeled node once the field cools — the "fixed world being
// revealed" fiction.

const node = (synthKey: string, over: Partial<GraphNode> = {}): GraphNode => ({
  synthKey,
  kind: 'npc',
  name: synthKey,
  displayId: synthKey,
  state: 'live',
  lastEventIndex: 0,
  ...over,
})

const edge = (synthKey: string, over: Partial<GraphEdge> = {}): GraphEdge => ({
  synthKey,
  from: 'a',
  to: 'b',
  relationship: 'allied',
  arrivalIndex: 0,
  sourceStage: 'weave',
  ...over,
})

describe('graphSyncKey — the identity-only re-render guard', () => {
  it('gives structurally-equal graphs the SAME key across fresh array identities', () => {
    expect(graphSyncKey([node('a'), node('b')], [edge('e')])).toBe(
      graphSyncKey([node('a'), node('b')], [edge('e')]),
    )
  })

  it('changes when any consumed node field moves (the finalize displayId swap included)', () => {
    const base = graphSyncKey([node('a')], [])
    expect(graphSyncKey([node('a', { displayId: 'uuid-1' })], [])).not.toBe(base)
    expect(graphSyncKey([node('a', { lastEventIndex: 3 })], [])).not.toBe(base)
    expect(graphSyncKey([node('a', { name: 'renamed' })], [])).not.toBe(base)
  })

  it('changes on edge arrival and on edge-field movement', () => {
    const base = graphSyncKey([node('a')], [edge('e')])
    expect(graphSyncKey([node('a')], [edge('e'), edge('f')])).not.toBe(base)
    expect(graphSyncKey([node('a')], [edge('e', { sourceStage: 'snap' })])).not.toBe(base)
  })
})

describe('pinSettledLabels — pin once cooled, never mid-flight', () => {
  const stubSim = (alpha: number) => ({
    alpha: () => alpha,
    positions: () =>
      new Map([
        ['a', { x: 10, y: 20 }],
        ['b', { x: -30, y: 5 }],
      ]),
    pin: vi.fn(),
  })

  it('does NOTHING while the field is hot (a node pinned at its seed would freeze the layout unformed)', () => {
    const sim = stubSim(PIN_SETTLE_ALPHA)
    pinSettledLabels(sim, new Set(['a']), new Set())
    expect(sim.pin).not.toHaveBeenCalled()
  })

  it('pins each labeled node at its current position once settled, exactly once — and reports the fresh count', () => {
    const sim = stubSim(PIN_SETTLE_ALPHA / 10)
    const pinned = new Set<string>()
    expect(pinSettledLabels(sim, new Set(['a', 'b']), pinned)).toBe(2)
    expect(sim.pin).toHaveBeenCalledWith('a', 10, 20)
    expect(sim.pin).toHaveBeenCalledWith('b', -30, 5)
    expect(pinned).toEqual(new Set(['a', 'b']))
    // The next frame's call is a no-op — the memory holds.
    expect(pinSettledLabels(sim, new Set(['a', 'b']), pinned)).toBe(0)
    expect(sim.pin).toHaveBeenCalledTimes(2)
  })

  it('skips labeled ids without a position and ids already pinned', () => {
    const sim = stubSim(0)
    const pinned = new Set(['a'])
    expect(pinSettledLabels(sim, new Set(['a', 'ghost', 'b']), pinned)).toBe(1)
    expect(sim.pin).toHaveBeenCalledExactlyOnceWith('b', -30, 5)
  })
})

describe('chooseLabelSides — the first collision-free slot, east preferred (myth-uis1p)', () => {
  // Two npc nodes on one row. `widthOf` fixes the label at 60px, so an EAST box
  // spans roughly [x-4.5, x+78] — at dx=40 the left node's east label runs
  // through the right node's box; flipping WEST ([x-78, x+4.5]) frees it.
  const widthOf = (): number => 60
  const pair = (): GraphNode[] => [node('a'), node('b')]
  const positionsAt = (dx: number) =>
    new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: dx, y: 0 }],
    ])

  it('keeps EAST when the east slot is free', () => {
    const sides = new Map<string, LabelSide>()
    chooseLabelSides({
      nodes: pair(),
      positions: positionsAt(400),
      labeled: new Set(['a', 'b']),
      pinned: new Set(['a', 'b']),
      widthOf,
      sides,
      suppressed: new Set<string>(),
    })
    expect(sides.get('a')).toBe('e')
    expect(sides.get('b')).toBe('e')
  })

  it('flips WEST when the east slot is occupied by a pinned neighbour', () => {
    const sides = new Map<string, LabelSide>()
    chooseLabelSides({
      nodes: pair(),
      positions: positionsAt(40),
      labeled: new Set(['a', 'b']),
      pinned: new Set(['a', 'b']),
      widthOf,
      sides,
      suppressed: new Set<string>(),
    })
    // 'a' chooses first: its east box hits 'b' → west is free → 'w'.
    expect(sides.get('a')).toBe('w')
    // 'b' then keeps east: 'a' has moved its box west, the slot is clear.
    expect(sides.get('b')).toBe('e')
  })

  it('never chooses for an UNPINNED label (the collision force still owns it) and stays sticky once chosen', () => {
    const sides = new Map<string, LabelSide>([['b', 'w']])
    chooseLabelSides({
      nodes: pair(),
      positions: positionsAt(40),
      labeled: new Set(['a', 'b']),
      pinned: new Set(['b']),
      widthOf,
      sides,
      suppressed: new Set<string>(),
    })
    expect(sides.has('a')).toBe(false) // unpinned → no committed side
    expect(sides.get('b')).toBe('w') // sticky — never re-chosen while worn
  })

  it('forgets the side of a RETIRED label so a later promotion chooses fresh', () => {
    const sides = new Map<string, LabelSide>([['a', 'w']])
    chooseLabelSides({
      nodes: pair(),
      positions: positionsAt(400),
      labeled: new Set(['b']),
      pinned: new Set(['b']),
      widthOf,
      sides,
      suppressed: new Set<string>(),
    })
    expect(sides.has('a')).toBe(false)
  })
})

// The declutter guarantees run 3 found missing (myth-k0sja). Run 3's live map printed
// "The Well of Names" straight through "The Ward Refectory" in one east slot, fused a
// second pair, grazed a third — and produced not one west-slotted label — because when
// neither slot was free the resolver fell back to east and overprinted.
describe('chooseLabelSides — the ux-run3 declutter guarantees (myth-k0sja)', () => {
  const widthOf = (): number => 60
  /** `n` npc nodes stacked in one place — every label wants the same slot. */
  const cluster = (n: number): GraphNode[] =>
    Array.from({ length: n }, (_, i) => node(`n${String(i)}`, { lastEventIndex: i }))
  const stacked = (n: number, dy: number): Map<string, { x: number; y: number }> =>
    new Map(Array.from({ length: n }, (_, i) => [`n${String(i)}`, { x: 0, y: i * dy }]))

  /** Resolve a whole cluster and report which ids ended up wearing a name. */
  function resolve(nodes: GraphNode[], positions: Map<string, { x: number; y: number }>) {
    const sides = new Map<string, LabelSide>()
    const suppressed = new Set<string>()
    const ids = nodes.map((n) => n.displayId)
    chooseLabelSides({
      nodes,
      positions,
      labeled: new Set(ids),
      pinned: new Set(ids),
      widthOf,
      sides,
      suppressed,
    })
    return { sides, suppressed }
  }

  it('SUPPRESSES rather than overprints when neither slot is free', () => {
    // Three pinned markers in a column 30px apart — their glyphs clear each other, but
    // a 25px label clear box plus the clearance pad does not. The run-3 shape exactly:
    // the middle name has nowhere to go and used to print through its neighbour.
    const { sides, suppressed } = resolve(cluster(3), stacked(3, 30))
    expect(suppressed).toEqual(new Set(['n1']))
    expect(sides.get('n0')).toBe('e')
    expect(sides.get('n2')).toBe('e')
    // Seniority decides who keeps a name: the oldest arrival is never the one demoted.
    expect(suppressed.has('n0')).toBe(false)
  })

  it('grants AT MOST ONE label per slot — a double-print is impossible by construction', () => {
    const nodes = cluster(6)
    const positions = stacked(6, 4) // 4px apart: far tighter than a 25px clear box
    const { sides, suppressed } = resolve(nodes, positions)
    for (const id of sides.keys()) expect(suppressed.has(id)).toBe(false)
    // Every committed label's box is disjoint from every other committed label's box.
    const boxes = [...sides].map(([id, side]) => {
      const p = positions.get(id)
      if (p === undefined) throw new Error('missing position')
      return { id, side, y: p.y }
    })
    for (const a of boxes) {
      for (const b of boxes) {
        if (a.id === b.id) continue
        // Same slot ⇒ the clear boxes (25px tall) must not overlap.
        if (a.side === b.side) expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(25)
      }
    }
  })

  it('flips losers WEST before giving up — both slots are used before anything retires', () => {
    // Two nodes one clear-box apart vertically is fine; put them on one row so the
    // east slot can hold only one and the second must mirror.
    const nodes = cluster(2)
    const { sides, suppressed } = resolve(nodes, new Map([
      ['n0', { x: 0, y: 0 }],
      ['n1', { x: 40, y: 0 }],
    ]))
    expect(suppressed.size).toBe(0)
    expect(new Set(sides.values())).toEqual(new Set(['e', 'w']))
  })

  it('enforces MINIMUM CLEARANCE — a merely-grazing pair is separated too', () => {
    // 26px apart: the two 25px clear boxes do NOT strictly intersect, but the names
    // read as one smear. The clearance pad must still push the second off east.
    const { sides } = resolve(cluster(2), stacked(2, 26))
    expect(sides.get('n0')).toBe('e')
    expect(sides.get('n1')).not.toBe('e')
  })

  it('is DETERMINISTIC — array order never changes the outcome', () => {
    const positions = stacked(5, 6)
    const forward = resolve(cluster(5), positions)
    const reversed = resolve(cluster(5).reverse(), positions)
    expect([...reversed.sides].sort()).toEqual([...forward.sides].sort())
    expect([...reversed.suppressed].sort()).toEqual([...forward.suppressed].sort())
  })

  it('forgets a suppression when the label RETIRES, so a later promotion tries again', () => {
    const sides = new Map<string, LabelSide>()
    const suppressed = new Set(['n1'])
    chooseLabelSides({
      nodes: cluster(2),
      positions: stacked(2, 400),
      labeled: new Set(['n0']),
      pinned: new Set(['n0', 'n1']),
      widthOf,
      sides,
      suppressed,
    })
    expect(suppressed.has('n1')).toBe(false)
  })

  it('never suppresses an UNPINNED label — the collision force still owns a hot field', () => {
    const sides = new Map<string, LabelSide>()
    const suppressed = new Set<string>()
    chooseLabelSides({
      nodes: cluster(3),
      positions: stacked(3, 0),
      labeled: new Set(['n0', 'n1', 'n2']),
      pinned: new Set(['n0']),
      widthOf,
      sides,
      suppressed,
    })
    expect(suppressed.size).toBe(0)
  })
})
