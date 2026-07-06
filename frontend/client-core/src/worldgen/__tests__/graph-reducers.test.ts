import { describe, it, expect } from 'vitest'
import type { PipelineEvent } from '@mythrun/contract/events'
import { deriveNodes, deriveEdges } from '../graph-reducers.ts'

// Fresh fixtures against the LIVE, flat PipelineEvent contract
// (@mythrun/contract/events): `entity-added` carries `name` / `entityKind`
// DIRECTLY — there is no `data` bag (the stale dev-tool shape). These exercise
// the reconciliation RULES lifted from the dev-tool's deriveInventory /
// derivePlaceholderBuffer, re-typed against the live union.

describe('deriveNodes', () => {
  it('maps entity-added to a live node keyed by synthKey', () => {
    const events: PipelineEvent[] = [
      {
        type: 'entity-added',
        synthKey: 'world_and_factions/factions/0',
        entityKind: 'faction',
        name: 'The Ember Court',
      },
    ]

    const nodes = deriveNodes(events)

    expect(nodes).toEqual([
      {
        synthKey: 'world_and_factions/factions/0',
        kind: 'faction',
        name: 'The Ember Court',
        displayId: 'world_and_factions/factions/0',
        state: 'live',
        lastEventIndex: 0,
      },
    ])
  })

  it('applies an entity-updated merge patch (renames on a string patch.name)', () => {
    const events: PipelineEvent[] = [
      { type: 'entity-added', synthKey: 's/0', entityKind: 'npc', name: 'Old Name' },
      { type: 'entity-updated', synthKey: 's/0', patch: { name: 'New Name', disposition: 'wary' } },
    ]

    const [node] = deriveNodes(events)

    expect(node?.name).toBe('New Name')
    expect(node?.lastEventIndex).toBe(1)
  })

  it('leaves the name unchanged when the patch has no string name', () => {
    const events: PipelineEvent[] = [
      { type: 'entity-added', synthKey: 's/0', entityKind: 'npc', name: 'Keeper' },
      { type: 'entity-updated', synthKey: 's/0', patch: { disposition: 'hostile' } },
    ]

    expect(deriveNodes(events)[0]?.name).toBe('Keeper')
  })

  it('ignores an entity-updated for an unknown synthKey', () => {
    const events: PipelineEvent[] = [
      { type: 'entity-updated', synthKey: 'ghost/0', patch: { name: 'Nobody' } },
    ]

    expect(deriveNodes(events)).toEqual([])
  })

  it('drops a node on entity-removed', () => {
    const events: PipelineEvent[] = [
      { type: 'entity-added', synthKey: 's/0', entityKind: 'npc', name: 'Doomed' },
      { type: 'entity-removed', synthKey: 's/0', reason: 'repair_dropped' },
    ]

    expect(deriveNodes(events)).toEqual([])
  })

  it('prefix-deletes only the reset stage on stage-reset', () => {
    const events: PipelineEvent[] = [
      { type: 'entity-added', synthKey: 'stage_a/0', entityKind: 'location', name: 'Keep' },
      { type: 'entity-added', synthKey: 'stage_a/1', entityKind: 'location', name: 'Bridge' },
      { type: 'entity-added', synthKey: 'stage_b/0', entityKind: 'npc', name: 'Survivor' },
      { type: 'stage-reset', stage: 'stage_a' },
    ]

    const nodes = deriveNodes(events)

    expect(nodes.map((n) => n.synthKey)).toEqual(['stage_b/0'])
  })

  it('swaps displayId synthKey -> entityId and marks finalized', () => {
    const events: PipelineEvent[] = [
      { type: 'entity-added', synthKey: 's/0', entityKind: 'location', name: 'Keep' },
      { type: 'finalized', synthKey: 's/0', entityId: '0192f0aa-1111-7abc-8def-000000000001' },
    ]

    const [node] = deriveNodes(events)

    expect(node?.displayId).toBe('0192f0aa-1111-7abc-8def-000000000001')
    expect(node?.state).toBe('finalized')
    expect(node?.lastEventIndex).toBe(1)
  })

  it('ignores a finalized for an unknown synthKey', () => {
    const events: PipelineEvent[] = [{ type: 'finalized', synthKey: 'ghost/0', entityId: 'x' }]

    expect(deriveNodes(events)).toEqual([])
  })

  it('ignores non-entity events (e.g. cost-update)', () => {
    const events: PipelineEvent[] = [{ type: 'cost-update', cumulativeUsd: 0.42 }]

    expect(deriveNodes(events)).toEqual([])
  })

  it('returns nodes in chronological arrival order with lastEventIndex tracking updates', () => {
    const events: PipelineEvent[] = [
      { type: 'entity-added', synthKey: 's/0', entityKind: 'npc', name: 'First' },
      { type: 'entity-added', synthKey: 's/1', entityKind: 'npc', name: 'Second' },
      { type: 'entity-updated', synthKey: 's/0', patch: { name: 'First (edited)' } },
    ]

    const nodes = deriveNodes(events)

    expect(nodes.map((n) => n.synthKey)).toEqual(['s/0', 's/1'])
    expect(nodes[0]?.lastEventIndex).toBe(2)
    expect(nodes[1]?.lastEventIndex).toBe(1)
  })

  it('reconciles a ghost + its placeholder to ONE node, not two', () => {
    const events: PipelineEvent[] = [
      {
        type: 'entity-added',
        synthKey: 'entity_consolidation/ghosts/0',
        entityKind: 'npc',
        name: 'The Ghost',
        placeholderId: 'new-3',
      },
      { type: 'entity-added', synthKey: 'locations_and_npcs/locations/0', entityKind: 'location', name: 'Keep' },
      {
        type: 'edge-added',
        synthKey: 'entity_relationships/relationships/0',
        from: 'new-3',
        to: 'locations_and_npcs/locations/0',
        relationship: 'guards',
      },
    ]

    const keys = deriveNodes(events).map((n) => n.synthKey)

    expect(keys).toEqual(['entity_consolidation/ghosts/0', 'locations_and_npcs/locations/0'])
    expect(keys).not.toContain('new-3')
  })
})

describe('deriveEdges', () => {
  it('renders an edge with real endpoints (from/to/relationship), ignoring non-edge events', () => {
    const events: PipelineEvent[] = [
      { type: 'phase', phase: 'world_gen' },
      { type: 'entity-added', synthKey: 's/0', entityKind: 'npc', name: 'A' },
      {
        type: 'edge-added',
        synthKey: 'entity_relationships/relationships/0',
        from: 's/0',
        to: 's/1',
        relationship: 'allied_with',
      },
    ]

    expect(deriveEdges(events)).toEqual([
      {
        synthKey: 'entity_relationships/relationships/0',
        from: 's/0',
        to: 's/1',
        relationship: 'allied_with',
        arrivalIndex: 2,
        sourceStage: 'weave',
      },
    ])
  })

  it('records arrivalIndex (first-seen event order) and classifies sourceStage by prefix', () => {
    const events: PipelineEvent[] = [
      {
        type: 'edge-added',
        synthKey: 'entity_relationships/relationships/0',
        from: 's/0',
        to: 's/1',
        relationship: 'allied_with',
      },
      {
        type: 'edge-added',
        synthKey: 'entity_consolidation/relationships/0',
        from: 's/2',
        to: 's/3',
        relationship: 'serves',
      },
      {
        type: 'edge-added',
        synthKey: 'coherence_pass/edges/0',
        from: 's/4',
        to: 's/5',
        relationship: 'rivals',
      },
    ]

    const byKey = new Map(deriveEdges(events).map((e) => [e.synthKey, e]))

    expect(byKey.get('entity_relationships/relationships/0')).toMatchObject({
      arrivalIndex: 0,
      sourceStage: 'weave',
    })
    expect(byKey.get('entity_consolidation/relationships/0')).toMatchObject({
      arrivalIndex: 1,
      sourceStage: 'weave',
    })
    expect(byKey.get('coherence_pass/edges/0')).toMatchObject({
      arrivalIndex: 2,
      sourceStage: 'snap',
    })
  })

  it('keeps the original arrivalIndex when an existing edge synthKey is re-added', () => {
    const events: PipelineEvent[] = [
      {
        type: 'edge-added',
        synthKey: 'entity_relationships/relationships/0',
        from: 's/0',
        to: 's/1',
        relationship: 'allied_with',
      },
      { type: 'entity-added', synthKey: 's/filler', entityKind: 'npc', name: 'Filler' },
      {
        type: 'edge-added',
        synthKey: 'entity_relationships/relationships/0',
        from: 's/0',
        to: 's/1',
        relationship: 'allied_with',
      },
    ]

    const [edge] = deriveEdges(events)

    expect(edge?.arrivalIndex).toBe(0)
  })

  it('buffers a placeholder edge until the ghost entity-added resolves it', () => {
    const beforeGhost: PipelineEvent[] = [
      {
        type: 'edge-added',
        synthKey: 'entity_relationships/relationships/0',
        from: 'new-3',
        to: 's/loc',
        relationship: 'guards',
      },
    ]

    // Buffered: the placeholder endpoint has no resolution yet.
    expect(deriveEdges(beforeGhost)).toEqual([])

    const withGhost: PipelineEvent[] = [
      ...beforeGhost,
      {
        type: 'entity-added',
        synthKey: 'entity_consolidation/ghosts/0',
        entityKind: 'npc',
        name: 'Ghost',
        placeholderId: 'new-3',
      },
    ]

    // Resolved: the buffered edge's `from` is rewritten to the ghost synthKey.
    expect(deriveEdges(withGhost)).toEqual([
      {
        synthKey: 'entity_relationships/relationships/0',
        from: 'entity_consolidation/ghosts/0',
        to: 's/loc',
        relationship: 'guards',
        arrivalIndex: 0,
        sourceStage: 'weave',
      },
    ])
  })

  it('buffers when the `to` endpoint is an unresolved placeholder', () => {
    const events: PipelineEvent[] = [
      {
        type: 'edge-added',
        synthKey: 'entity_relationships/relationships/0',
        from: 's/real',
        to: 'new-99',
        relationship: 'serves',
      },
    ]

    expect(deriveEdges(events)).toEqual([])
  })

  it('drops an edge on edge-removed', () => {
    const events: PipelineEvent[] = [
      {
        type: 'edge-added',
        synthKey: 'entity_relationships/relationships/0',
        from: 's/0',
        to: 's/1',
        relationship: 'rivals',
      },
      { type: 'edge-removed', synthKey: 'entity_relationships/relationships/0', reason: 'coherence_deleted' },
    ]

    expect(deriveEdges(events)).toEqual([])
  })

  it('prefix-deletes only the reset stage on stage-reset', () => {
    const events: PipelineEvent[] = [
      {
        type: 'edge-added',
        synthKey: 'entity_relationships/relationships/0',
        from: 's/0',
        to: 's/1',
        relationship: 'guards',
      },
      {
        type: 'edge-added',
        synthKey: 'other_stage/relationships/0',
        from: 's/2',
        to: 's/3',
        relationship: 'allied_with',
      },
      { type: 'stage-reset', stage: 'entity_relationships' },
    ]

    expect(deriveEdges(events).map((e) => e.synthKey)).toEqual(['other_stage/relationships/0'])
  })
})
