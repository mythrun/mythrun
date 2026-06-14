// backend/src/world/retrieval/types.ts
//
// MYT-71 §5/§6 — resolver result types. accessLevel is the EXISTING AccessLevel
// from repo/facts.ts (known | discoverable | secret, migration 014); never
// re-declare a public/private union here. narrativeStatus is the EXISTING
// NarrativeStatus from the same module. entityType is the NARROW EntityType
// from repo/entities.ts ('npc' | 'location' | 'faction' | 'item') — it does NOT
// include 'pc'. searchLore / findSimilarEntities exclude PCs by construction.
// The graph result types (KnownCharacter, FactionNode) carry runtime 'pc' rows,
// but the type-level widening (GraphEntityType = EntityType | 'pc') is owned by
// the graph task (MYT-71 T8), not here — these stay typed `EntityType` per the
// sketch; T8 widens if typecheck forces it.
//
// Score = 1 - cosine_distance, range [-1, 1]. Higher is more similar.
import type { AccessLevel, NarrativeStatus } from '../../repo/facts.js'
import type { EntityType } from '../../repo/entities.js'

/** One hit from searchLore — either a fact row or an entity (name/kernel) row. */
export interface LoreHit {
  readonly source: 'fact' | 'entity'
  readonly factId?: string
  readonly entityId: string
  readonly entityName: string
  readonly topic?: string
  readonly content: string
  readonly accessLevel: AccessLevel
  readonly narrativeStatus?: NarrativeStatus
  readonly score: number
}

/** One candidate from findSimilarEntities (match-vs-mint input). */
export interface EntityCandidate {
  readonly entityId: string
  readonly name: string
  readonly entityType: EntityType
  readonly score: number
}

/** One node from a character-graph walk (`depth` = hops from the seed). */
export interface KnownCharacter {
  readonly entityId: string
  readonly name: string
  readonly entityType: EntityType
  readonly depth: number
}

/** One node from a faction-hierarchy walk (`parentId` null at a root). */
export interface FactionNode {
  readonly entityId: string
  readonly name: string
  readonly entityType: EntityType
  readonly parentId: string | null
  readonly depth: number
}
