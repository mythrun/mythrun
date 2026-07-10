// backend/src/repo/gen-seed-view.ts
//
// myth-gcsp1: the mid-GENERATION graph REHYDRATION seed. The SSE connect-time
// snapshot frame (GET /status/stream) widens with this composition so a
// refresh/reconnect DURING generation returns to a POPULATED graph instead of an
// empty one — the live nodes/edges otherwise live only in the client's in-memory
// SSE fold and are lost on reload.
//
// KNOWN-TIER ONLY — by design AND by the security invariant. During generation
// the live `entity-added` / `edge-added` stream is already tier-gated to
// known-tier entities and both-endpoints-known edges (streaming-extractor.ts
// `shouldEmitEntity` / `shouldEmitEdge`). Composing this seed at the SAME
// known-tier filter reproduces EXACTLY what a continuously-connected member has
// already accumulated from the live stream, so a reconnecting client is caught
// up with ZERO new exposure. Discoverable/secret entities never streamed to the
// graph and never seed it here.
//
// This is a SEPARATE, gen-scoped surface. It does NOT touch — and does not
// weaken — the 409-gated world-snapshot route (the reveal boundary that is
// enforced-ignorance load-bearing for the wiki); that route keeps composing the
// full known-tier reveal only once `world_introduction` commits.
//
// Two lean reads (vs the world-snapshot view's seven): the graph only needs an
// entity's id/kind/name and a relationship's endpoints/type — no
// facts/prose/hierarchy/stat-block/world composition.

import type { ClientLike } from './_types.js'
import { entities } from './entities.js'
import { relationships } from './relationships.js'

/** A seed node's minimal shape — the graph reducer's `snapshotToSeed` reads
 *  exactly these three fields (id → the finalized displayId, entityType → kind,
 *  name). Mirrors the world-snapshot entities' subset the FE already consumes. */
export interface GenSeedEntity {
  readonly id: string
  readonly entityType: string
  readonly name: string
}

/** A seed edge's minimal shape — the same `relationships` triple the
 *  world-snapshot's graph edges carry, so one FE seed path handles both. */
export interface GenSeedRelationship {
  readonly sourceEntityId: string
  readonly targetEntityId: string
  readonly relationshipType: string
}

export interface GenSeed {
  readonly entities: readonly GenSeedEntity[]
  readonly relationships: readonly GenSeedRelationship[]
}

/** Compose the known-tier graph seed for a generating world: its known-tier
 *  entities and the known-tier relationships among them. Empty entity set →
 *  `relationships.listAmong` short-circuits to `[]`. */
async function fetch(client: ClientLike, worldId: string): Promise<GenSeed> {
  const entityRows = await entities.listByWorld(client, worldId, { accessLevels: ['known'] })
  const entityIds = entityRows.map((e) => e.id)
  const relationshipRows = await relationships.listAmong(client, entityIds, ['known'])
  return {
    entities: entityRows.map((e) => ({ id: e.id, entityType: e.entityType, name: e.name })),
    relationships: relationshipRows.map((r) => ({
      sourceEntityId: r.sourceEntityId,
      targetEntityId: r.targetEntityId,
      relationshipType: r.relationshipType,
    })),
  }
}

export const genSeedView = { fetch } as const
