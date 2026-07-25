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
    })
    expect(sides.has('a')).toBe(false)
  })
})
