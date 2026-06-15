// backend/src/repo/world-retrieval.ts
//
// MYT-71 Task 6 — the world-store retrieval SQL substrate (pgvector cosine
// search + recursive-CTE graph walks). The heavy read SQL lives here behind the
// canonical `worldRetrievalNs(c)` binder, exactly like every other repo module.
//
// OVER-PULL — there is NO `access_level` predicate anywhere in this file. All
// queries return `known` / `discoverable` / `secret` rows. The tier gate is a
// downstream concern (the Slow Thinker is the safety boundary); a tier filter
// here would be a BUG.
//
// WORLD SCOPE — `facts` has no `world_id` column (schema drift since migration
// 001), so fact searches scope through `JOIN entities e ON e.id = f.entity_id
// WHERE e.world_id = $1`, mirroring the world-scoped reads in facts.ts /
// world-snapshot-view.ts. Entity searches scope on `entities.world_id` directly.
//
// pgvector SEAM — `<=>` is cosine DISTANCE; score = `1 - (embedding <=> $q)`,
// range [-1, 1], higher = more similar. pg has no native vector param type, so
// the caller passes the `'[f1,…,f512]'` TEXT form and the SQL casts `$2::vector`.
// The vector reads here assume the CALLER has already opened a read tx and
// issued `SET LOCAL hnsw.iterative_scan = 'relaxed_order'` (pgvector ≥ 0.8 — the
// image is 0.8.2). That `SET LOCAL` is the ORCHESTRATION layer's job
// (search.ts / graph.ts, later tasks); this binder takes an already-prepared
// `ClientLike` and never opens its own tx.
//
// The DB-row result types below are snake_case (raw column names). The
// camelCase resolver types (LoreHit, EntityCandidate, KnownCharacter,
// FactionNode) live in world/retrieval/types.ts; the snake→camel mapping happens
// in search.ts / graph.ts (Tasks 7/8), which import the DB-row types from here.

import type { ClientLike } from './_types.js'
import type { AccessLevel, NarrativeStatus } from './facts.js'

/** entity_type values returned by the graph walks — includes 'pc' (a PC entity
 *  can appear in a character graph). The lore searches never return 'pc'. */
export type GraphEntityType = 'npc' | 'location' | 'faction' | 'item' | 'pc'

/** One fact hit from `searchFacts` (snake_case DB columns). */
export interface LoreFactDbHit {
  readonly fact_id: string
  readonly entity_id: string
  readonly entity_name: string
  readonly topic: string
  readonly content: string
  readonly access_level: AccessLevel
  readonly narrative_status: NarrativeStatus
  readonly score: number
}

/** One entity hit from `searchEntities` (snake_case DB columns). */
export interface LoreEntityDbHit {
  readonly entity_id: string
  readonly name: string
  readonly entity_type: GraphEntityType
  readonly access_level: AccessLevel
  readonly score: number
}

/** One node from `charactersKnownTo` (snake_case DB columns). Carries
 *  `access_level` so the downstream Slow-Thinker vet can tier-gate graph hits
 *  (over-pull: no tier predicate in the walk; the gate is downstream). */
export interface KnownCharacterDbRow {
  readonly entity_id: string
  readonly name: string
  readonly entity_type: GraphEntityType
  readonly access_level: AccessLevel
  readonly depth: number
}

/** One node from `factionTree` (snake_case DB columns; `parent_id` null at the
 *  root). Carries `access_level` for the same downstream tier-gate reason as
 *  KnownCharacterDbRow. */
export interface FactionNodeDbRow {
  readonly entity_id: string
  readonly name: string
  readonly entity_type: GraphEntityType
  readonly access_level: AccessLevel
  readonly parent_id: string | null
  readonly depth: number
}

/** One fact the embedder must (re-)embed. `content` is the text to embed. */
export interface FactToEmbedRow {
  readonly id: string
  readonly content: string
}

/** One entity the embedder must (re-)embed. `text` is the `name + prose_kernel
 *  .content` blob that gets embedded (prose is baked into the entity vector). */
export interface EntityToEmbedRow {
  readonly id: string
  readonly text: string
}

/**
 * Composable binder over a single ClientLike. Holds the canonical world-
 * retrieval SQL so `repo.worldRetrieval.X` and `tx.worldRetrieval.X` share one
 * body. The vector-search methods assume the caller already SET LOCAL
 * hnsw.iterative_scan in the read tx (see the module header).
 */
export function worldRetrievalNs(c: ClientLike) {
  return {
    /**
     * Cosine-ranked fact search across a world. Over-pulls all tiers; only
     * NULL-embedding rows (unsearchable until embedded) are excluded. World
     * scope is the entities JOIN (facts have no world_id). Score = 1 - distance.
     */
    searchFacts: async (
      worldId: string,
      queryVecLiteral: string,
      limit: number,
    ): Promise<readonly LoreFactDbHit[]> => {
      const result = await c.query<LoreFactDbHit>(
        `SELECT f.id AS fact_id, e.id AS entity_id, e.name AS entity_name,
                f.topic, f.content, f.access_level, f.narrative_status,
                (1 - (f.embedding <=> $2::vector)) AS score
           FROM facts f
           JOIN entities e ON e.id = f.entity_id
          WHERE e.world_id = $1 AND f.embedding IS NOT NULL
          ORDER BY f.embedding <=> $2::vector
          LIMIT $3`,
        [worldId, queryVecLiteral, limit],
      )
      return result.rows
    },
    /**
     * Cosine-ranked entity search across a world. Excludes PCs (`entity_type <>
     * 'pc'`) and NULL-embedding rows; over-pulls all tiers. Optional
     * `entityType` narrows to one kind. Used by BOTH searchLore's entity arm
     * and findSimilarEntities. No prose_kernels join — prose is baked into the
     * embedding at write time. Score = 1 - distance.
     */
    searchEntities: async (
      worldId: string,
      queryVecLiteral: string,
      limit: number,
      entityType?: GraphEntityType,
    ): Promise<readonly LoreEntityDbHit[]> => {
      const params: unknown[] = [worldId, queryVecLiteral]
      let typeClause = ''
      if (entityType !== undefined) {
        params.push(entityType)
        typeClause = ` AND entity_type = $${String(params.length)}`
      }
      params.push(limit)
      const result = await c.query<LoreEntityDbHit>(
        `SELECT id AS entity_id, name, entity_type, access_level,
                (1 - (embedding <=> $2::vector)) AS score
           FROM entities
          WHERE world_id = $1 AND entity_type <> 'pc' AND embedding IS NOT NULL${typeClause}
          ORDER BY embedding <=> $2::vector
          LIMIT $${String(params.length)}`,
        params,
      )
      return result.rows
    },
    /**
     * Characters reachable from `rootEntityId` within `maxDepth` hops over the
     * `relationships` graph, traversing edges in BOTH directions (the recursive
     * term UNION ALLs source→target and target→source expansions). Cycle-safe
     * via a `path` array (`WHERE NOT next_id = ANY(path)`). DISTINCT ON
     * (entity_id) keeping the MIN depth dedups diamonds. The root is depth 0.
     * The `nameFilter` is NOT applied here — it's graph.ts's post-filter (T8).
     */
    charactersKnownTo: async (
      rootEntityId: string,
      maxDepth: number,
    ): Promise<readonly KnownCharacterDbRow[]> => {
      const result = await c.query<KnownCharacterDbRow>(
        `WITH RECURSIVE walk AS (
           SELECT $1::uuid AS entity_id, 0 AS depth, ARRAY[$1::uuid] AS path
           UNION ALL
           SELECT next_id, w.depth + 1, w.path || next_id
             FROM walk w
             CROSS JOIN LATERAL (
               SELECT r.target_entity_id AS next_id
                 FROM relationships r
                WHERE r.source_entity_id = w.entity_id
               UNION ALL
               SELECT r.source_entity_id AS next_id
                 FROM relationships r
                WHERE r.target_entity_id = w.entity_id
             ) edges
            WHERE w.depth < $2
              AND NOT edges.next_id = ANY(w.path)
         )
         SELECT DISTINCT ON (m.entity_id)
                m.entity_id, e.name, e.entity_type, e.access_level, m.depth
           FROM walk m
           JOIN entities e ON e.id = m.entity_id
          ORDER BY m.entity_id, m.depth`,
        [rootEntityId, maxDepth],
      )
      return result.rows
    },
    /**
     * The faction subtree rooted at `rootEntityId`, depth-bounded by `maxDepth`,
     * walking `entity_hierarchy` parent→child. `child_entity_id` is UNIQUE so
     * the hierarchy is a strict tree (no diamonds, no path array needed). Returns
     * rows where `depth <= maxDepth`; the root is depth 0 with `parent_id` NULL.
     * T8 (graph.ts) owns the `truncated` determination — it flags truncation
     * when any returned row sits at `depth === maxDepth` (that node may have
     * unreturned children below the bound).
     */
    factionTree: async (
      rootEntityId: string,
      maxDepth: number,
    ): Promise<readonly FactionNodeDbRow[]> => {
      const result = await c.query<FactionNodeDbRow>(
        `WITH RECURSIVE tree AS (
           SELECT $1::uuid AS entity_id, NULL::uuid AS parent_id, 0 AS depth
           UNION ALL
           SELECT eh.child_entity_id, eh.parent_entity_id, t.depth + 1
             FROM tree t
             JOIN entity_hierarchy eh ON eh.parent_entity_id = t.entity_id
            WHERE t.depth < $2
         )
         SELECT t.entity_id, e.name, e.entity_type, e.access_level, t.parent_id, t.depth
           FROM tree t
           JOIN entities e ON e.id = t.entity_id
          ORDER BY t.depth, t.entity_id`,
        [rootEntityId, maxDepth],
      )
      return result.rows
    },
    /**
     * Facts that the embedder (T9 `embedWorld`) must embed. World scope is the
     * entities JOIN (facts have no world_id). Over-pull — NO access_level
     * predicate; every tier's facts get embedded. When `force` is false only
     * un-embedded rows (`f.embedding IS NULL`) are returned (the incremental
     * backfill); when true the whole world's facts (a full re-embed).
     */
    listFactsToEmbed: async (
      worldId: string,
      force: boolean,
    ): Promise<readonly FactToEmbedRow[]> => {
      const nullClause = force ? '' : ' AND f.embedding IS NULL'
      const result = await c.query<FactToEmbedRow>(
        `SELECT f.id, f.content
           FROM facts f
           JOIN entities e ON e.id = f.entity_id
          WHERE e.world_id = $1${nullClause}`,
        [worldId],
      )
      return result.rows
    },
    /**
     * Entities that the embedder (T9 `embedWorld`) must embed. Excludes PCs
     * (`entity_type <> 'pc'` — PCs are not world lore). `text` is the entity's
     * `name` concatenated with its prose-kernel content (LEFT JOIN; COALESCE to
     * '' when no kernel — prose_kernels.entity_id is UNIQUE so at most one row).
     * When `force` is false only un-embedded entities are returned; when true
     * every non-PC entity (a full re-embed).
     */
    listEntitiesToEmbed: async (
      worldId: string,
      force: boolean,
    ): Promise<readonly EntityToEmbedRow[]> => {
      const nullClause = force ? '' : ' AND e.embedding IS NULL'
      const result = await c.query<EntityToEmbedRow>(
        `SELECT e.id, (e.name || ' ' || COALESCE(pk.content, '')) AS text
           FROM entities e
           LEFT JOIN prose_kernels pk ON pk.entity_id = e.id
          WHERE e.world_id = $1 AND e.entity_type <> 'pc'${nullClause}`,
        [worldId],
      )
      return result.rows
    },
  }
}
