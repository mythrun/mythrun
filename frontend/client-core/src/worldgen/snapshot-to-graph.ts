import type { GraphEdge, GraphNode } from './graph-reducers.ts'

// snapshotToGraph (MYT-94 Task 4): the CANONICAL known-tier snapshot → finalized
// graph seed adapter. Extracted from `useWorldGenStream`'s private `snapshotToSeed`
// and made the single source of truth so the two consumers share ONE known-tier
// projection instead of a divergent second adapter (spec §6 / plan Ambiguity G):
//
//   - the world-gen streaming graph rehydrates its seed from it (`useWorldGenStream`
//     delegates here — the connect-frame gen-seed AND the post-boundary world-snapshot
//     fetch both feed it), and
//   - the in-session Relationship Graph tab's knowledge cache projects it (Task 2).
//
// ENFORCED IGNORANCE (spec §6). The known-tier guarantee is INHERITED from the
// source: `WorldGenSnapshot.relationships` is already server-filtered to known-tier
// (the `relationships.listAmong` double filter — access_level='known' AND both
// endpoints in the known set; live-verified in tmp/sdd/myt94-verify-notes.md step 3).
// This adapter renders EXACTLY the edges the snapshot carries and synthesizes none,
// so a secret-tier edge the server already dropped can never reappear on the client
// (the required leak assertion pins this — snapshot-to-graph.test.ts).

/** The finalized graph seed the Relationship Graph tab AND the world-gen
 *  rehydration path render: known-tier entities → nodes + relationships → edges,
 *  all `finalized`/`snap` (pre-stream, non-animating). */
export interface GraphSeed {
  readonly nodes: GraphNode[]
  readonly edges: GraphEdge[]
}

/** The structural slice `snapshotToGraph` reads — the known-tier entities +
 *  relationships committed so far. Both the mid-gen connect frame (myth-gcsp1) and
 *  the persisted `WorldGenSnapshot` satisfy it, so one adapter feeds both callers;
 *  the wider `WorldGenSnapshot` (facts/hierarchy/introduction) is assignable to it. */
export interface GraphSeedSource {
  readonly entities: readonly {
    readonly id: string
    readonly entityType: string
    readonly name: string
  }[]
  readonly relationships: readonly {
    readonly sourceEntityId: string
    readonly targetEntityId: string
    readonly relationshipType: string
  }[]
}

/** Convert a known-tier snapshot (or the mid-gen connect-frame gen-seed) into
 *  finalized seed nodes/edges. Persisted rows carry the real entity UUID, so a seed
 *  node is `finalized` with `displayId === synthKey === id`; `lastEventIndex` is -1
 *  (pre-stream). A pre-existing snapshot edge should not animate as a weave, so it
 *  carries the `snap` stage + the -1 `arrivalIndex` sentinel. */
export function snapshotToGraph(source: GraphSeedSource): GraphSeed {
  const nodes = source.entities.map(
    (e): GraphNode => ({
      synthKey: e.id,
      kind: e.entityType,
      name: e.name,
      displayId: e.id,
      state: 'finalized',
      lastEventIndex: -1,
    }),
  )
  const edges = source.relationships.map(
    (r): GraphEdge => ({
      synthKey: `seed:${r.sourceEntityId}->${r.targetEntityId}:${r.relationshipType}`,
      from: r.sourceEntityId,
      to: r.targetEntityId,
      relationship: r.relationshipType,
      arrivalIndex: -1,
      sourceStage: 'snap',
    }),
  )
  return { nodes, edges }
}
