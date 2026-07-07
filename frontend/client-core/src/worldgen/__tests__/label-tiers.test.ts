import { describe, expect, it } from 'vitest'
import type { GraphNode } from '../graph-reducers.ts'
import {
  ANCHOR_KINDS,
  DENSITY_PARAMS,
  growthFrom,
  labelBudget,
  labeledDisplayIds,
} from '../label-tiers.ts'

// Label tiering (MYT-89 density redesign). A real generation lands ~46 entities —
// full boxes for all of them claim ~half the desktop virtual space and ~80% of a
// phone's, so WHICH nodes wear a name is a deliberate, deterministic tier:
// anchors (world/campaign/faction/pc) always; pinned keys (selection/focus) always;
// the rest by RECENCY within an area-derived budget. Pure geometry — the tests pin
// determinism, the anchor guarantee, the budget math, and the recency ordering.

const node = (
  displayId: string,
  kind: string,
  lastEventIndex: number,
): GraphNode => ({
  synthKey: displayId,
  kind,
  name: displayId,
  displayId,
  state: 'live',
  lastEventIndex,
})

/** A space whose budget is easy to reason about: area / areaPerLabel = 4. */
const SMALL = { width: 200, height: 200 } // 40_000 px²
const PARAMS = { areaPerLabel: 10_000, minLabels: 0 }

describe('labelBudget — the area-derived label count', () => {
  it('floors area / areaPerLabel', () => {
    expect(labelBudget(SMALL, { ...DENSITY_PARAMS, ...PARAMS })).toBe(4)
    expect(labelBudget({ width: 250, height: 199 }, { ...DENSITY_PARAMS, ...PARAMS })).toBe(4) // 49_750
  })

  it('never drops below minLabels (a tiny pane still names a few)', () => {
    expect(labelBudget({ width: 10, height: 10 }, { ...DENSITY_PARAMS, areaPerLabel: 10_000, minLabels: 6 })).toBe(6)
  })
})

describe('labeledDisplayIds — anchors, pins, recency, determinism', () => {
  it('prioritises anchors within the budget (world/campaign, then pc, then factions)', () => {
    // Budget 4: the world + the pc + the two FRESHEST factions win; the npc loses.
    const nodes = [
      node('n', 'npc', 9), // freshest overall — but anchors outrank it
      node('f-old', 'faction', 1),
      node('f-new', 'faction', 2),
      node('f-newest', 'faction', 3),
      node('w', 'world', 0),
      node('p', 'pc', 4),
    ]
    const labeled = labeledDisplayIds(nodes, SMALL, { params: PARAMS })
    expect(labeled).toEqual(new Set(['w', 'p', 'f-newest', 'f-new']))
  })

  it('caps even anchors at the budget (a tight phone pane trims to the skeleton)', () => {
    // 6 factions in a space whose budget is 4: only the 4 freshest wear names.
    const nodes = [0, 1, 2, 3, 4, 5].map((i) => node(`f${String(i)}`, 'faction', i))
    const labeled = labeledDisplayIds(nodes, SMALL, { params: PARAMS })
    expect(labeled).toEqual(new Set(['f5', 'f4', 'f3', 'f2']))
  })

  it('fills the remaining budget with the most-RECENT non-anchor nodes', () => {
    const nodes = [
      node('w', 'world', 0), // anchor — first in priority
      node('old-npc', 'npc', 1),
      node('mid-loc', 'location', 2),
      node('new-npc', 'npc', 3),
      node('newest-loc', 'location', 4),
    ]
    // Budget 4 → the world anchor + the 3 newest others; the OLDEST npc retires.
    const labeled = labeledDisplayIds(nodes, SMALL, { params: PARAMS })
    expect(labeled).toEqual(new Set(['w', 'newest-loc', 'new-npc', 'mid-loc']))
  })

  it('always labels pinned keys (selection / tap focus), without eating anchors', () => {
    const nodes = [
      node('f', 'faction', 0),
      node('a', 'npc', 1),
      node('b', 'npc', 2),
      node('c', 'npc', 3),
    ]
    // Budget 4; pinning the OLDEST npc keeps it labeled.
    const labeled = labeledDisplayIds(nodes, SMALL, { params: PARAMS, pinned: ['a', undefined] })
    expect(labeled.has('a')).toBe(true)
    expect(labeled.has('f')).toBe(true) // the anchor survives the pin
  })

  it('subtracts a reservedArea (the status-card keep-out) from the budget space', () => {
    const nodes = [0, 1, 2, 3].map((i) => node(`n${String(i)}`, 'npc', i))
    // 40_000 px² gives budget 4; reserving 25_000 leaves 15_000 → budget 1.
    const labeled = labeledDisplayIds(nodes, SMALL, { params: PARAMS, reservedArea: 25_000 })
    expect(labeled).toEqual(new Set(['n3'])) // only the freshest survives
  })

  it('is deterministic (same inputs → the identical set) and stable on recency ties', () => {
    const nodes = [
      node('first', 'npc', 5),
      node('second', 'npc', 5), // tie — array order breaks it
      node('third', 'npc', 5),
    ]
    const params = { areaPerLabel: 20_000, minLabels: 0 } // budget 2 of 3
    const a = labeledDisplayIds(nodes, SMALL, { params })
    const b = labeledDisplayIds(nodes, SMALL, { params })
    expect(a).toEqual(b)
    expect(a).toEqual(new Set(['first', 'second'])) // stable sort keeps arrival order
  })

  it('labels everything when the budget covers the whole graph', () => {
    const nodes = [node('a', 'npc', 0), node('b', 'location', 1)]
    const labeled = labeledDisplayIds(nodes, { width: 900, height: 470 }, { params: PARAMS })
    expect(labeled.size).toBe(2)
  })

  it('exposes the anchor kinds as the world skeleton (world/campaign/faction/pc)', () => {
    expect(ANCHOR_KINDS).toEqual(new Set(['world', 'campaign', 'faction', 'pc']))
  })
})

describe('growthFrom — the shared graph↔fog growth derivation (C5)', () => {
  it('derives the growth input from the node count + the locked density defaults', () => {
    expect(growthFrom(30)).toEqual({
      nodeCount: 30,
      startCount: DENSITY_PARAMS.growthStartCount,
      perNode: DENSITY_PARAMS.growthPerNode,
    })
  })

  it('honours partial overrides (the tuning harness)', () => {
    expect(growthFrom(10, { growthStartCount: 5, growthPerNode: 20 })).toEqual({
      nodeCount: 10,
      startCount: 5,
      perNode: 20,
    })
  })
})
