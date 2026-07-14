import { describe, it, expect } from 'vitest'
import { snapshotToGraph, type GraphSeedSource } from '../snapshot-to-graph.ts'

// snapshotToGraph (MYT-94 Task 4): the canonical known-tier snapshot → finalized
// graph seed adapter, extracted from `useWorldGenStream`'s private `snapshotToSeed`
// and made the ONE source of truth (the worldgen stream + the in-session knowledge
// cache both consume it). These pin the finalized node/edge shape AND the required
// enforced-ignorance leak contract: the adapter emits EXACTLY the snapshot's edges
// and NEVER synthesizes one — so a secret-tier edge the server already filtered out
// of `relationships` cannot reappear on the client.

const ENTITIES: GraphSeedSource['entities'] = [
  { id: 'ent-bela', entityType: 'npc', name: 'Bela Ostry' },
  { id: 'ent-ines', entityType: 'npc', name: 'Captain Ines Marrow' },
  { id: 'ent-tower', entityType: 'location', name: 'The Ebbwright Tower' },
]

describe('snapshotToGraph', () => {
  it('maps every entity to a finalized node (kind = entityType, displayId = id)', () => {
    const { nodes } = snapshotToGraph({ entities: ENTITIES, relationships: [] })

    expect(nodes).toHaveLength(ENTITIES.length)
    expect(nodes).toEqual([
      {
        synthKey: 'ent-bela',
        kind: 'npc',
        name: 'Bela Ostry',
        displayId: 'ent-bela',
        state: 'finalized',
        lastEventIndex: -1,
      },
      {
        synthKey: 'ent-ines',
        kind: 'npc',
        name: 'Captain Ines Marrow',
        displayId: 'ent-ines',
        state: 'finalized',
        lastEventIndex: -1,
      },
      {
        synthKey: 'ent-tower',
        kind: 'location',
        name: 'The Ebbwright Tower',
        displayId: 'ent-tower',
        state: 'finalized',
        lastEventIndex: -1,
      },
    ])
  })

  it('maps every relationship to a snap edge (from/to/relationship, arrivalIndex -1)', () => {
    const relationships: GraphSeedSource['relationships'] = [
      { sourceEntityId: 'ent-bela', targetEntityId: 'ent-tower', relationshipType: 'frequents' },
      { sourceEntityId: 'ent-ines', targetEntityId: 'ent-tower', relationshipType: 'anchored_in' },
    ]

    const { edges } = snapshotToGraph({ entities: ENTITIES, relationships })

    expect(edges).toHaveLength(relationships.length)
    expect(edges).toEqual([
      {
        synthKey: 'seed:ent-bela->ent-tower:frequents',
        from: 'ent-bela',
        to: 'ent-tower',
        relationship: 'frequents',
        arrivalIndex: -1,
        sourceStage: 'snap',
      },
      {
        synthKey: 'seed:ent-ines->ent-tower:anchored_in',
        from: 'ent-ines',
        to: 'ent-tower',
        relationship: 'anchored_in',
        arrivalIndex: -1,
        sourceStage: 'snap',
      },
    ])
  })

  it('returns an empty seed for an empty snapshot', () => {
    expect(snapshotToGraph({ entities: [], relationships: [] })).toEqual({ nodes: [], edges: [] })
  })

  it('emits ONLY snapshot edges and never synthesizes one — a filtered secret edge cannot leak', () => {
    // The required enforced-ignorance leak assertion (spec §6, plan Task 4 step 1c;
    // live-verified server-side in tmp/sdd/myt94-verify-notes.md step 3). Bela and
    // Ines are BOTH known-tier entities; a `secret_alliance` edge between them was
    // seeded server-side but the known-tier world-snapshot filter dropped it, so it
    // is ABSENT from the client's parsed `relationships`. The adapter must render
    // exactly the edges it is given and invent none — so no edge ever connects the
    // two known entities the leaked edge would have joined.
    const knownRelationships: GraphSeedSource['relationships'] = [
      { sourceEntityId: 'ent-bela', targetEntityId: 'ent-tower', relationshipType: 'frequents' },
      { sourceEntityId: 'ent-ines', targetEntityId: 'ent-tower', relationshipType: 'anchored_in' },
    ]
    const source: GraphSeedSource = { entities: ENTITIES, relationships: knownRelationships }

    const { edges } = snapshotToGraph(source)

    // No invented edges: exactly one output edge per input relationship.
    expect(edges).toHaveLength(knownRelationships.length)
    // Every output edge traces back to an input relationship (nothing synthesized).
    for (const edge of edges) {
      expect(knownRelationships).toContainEqual({
        sourceEntityId: edge.from,
        targetEntityId: edge.to,
        relationshipType: edge.relationship,
      })
    }
    // The filtered secret edge (Bela <-> Ines) reaches the seed in NEITHER direction.
    const leaked = edges.some(
      (e) =>
        (e.from === 'ent-bela' && e.to === 'ent-ines') ||
        (e.from === 'ent-ines' && e.to === 'ent-bela'),
    )
    expect(leaked).toBe(false)
  })
})
