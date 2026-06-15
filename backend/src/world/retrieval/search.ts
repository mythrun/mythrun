// backend/src/world/retrieval/search.ts
//
// MYT-71 Task 7 — the searchLore / findSimilarEntities orchestration over the
// T6 world-retrieval binder (repo/world-retrieval.ts). This module is pure
// orchestration: embed the query (Voyage, OUTSIDE any tx — slow I/O never sits
// inside BEGIN/COMMIT, per MYT-55), then run the cosine search inside a SHORT
// read tx via `repo.transaction(fn, { hnswIterativeScan })`. The BEGIN prelude
// (db/transaction.ts) issues `SET LOCAL hnsw.iterative_scan = 'relaxed_order'`
// (config.HNSW_ITERATIVE_SCAN) so the world-scope post-filter doesn't starve
// the HNSW top-k. The SET LOCAL is transaction-scoped and lands in the same tx
// as the search SELECT because the prelude is part of that tx's BEGIN. ALL DB
// access goes through the repo layer (no raw .query/.connect here) — the
// mythrun/no-raw-db-access rule forbids a hand-managed read tx outside repo/db.
//
// TWO ERROR POLICIES (deliberate, asymmetric):
//   - searchLore is TOTAL: ANY thrown error (embed OR query) → logger.warn +
//     return []. MYT-72 narrates a blank rather than crashing the turn; lore
//     retrieval is best-effort context, never a hard dependency.
//   - findSimilarEntities THROWS on failure: it is the canon WRITE path
//     (match-vs-mint). Swallowing an embed blip and returning [] would mint a
//     duplicate canonical entity, so the failure must propagate.
//
// OVER-PULL: no access_level filter anywhere — the binder enforces none (the
// Slow Thinker is the tier-safety boundary). PCs are excluded by the binder's
// searchEntities (`entity_type <> 'pc'`).

import type { LoreFactDbHit, LoreEntityDbHit } from '../../repo/world-retrieval.js'
import { expectCommitted, type Repo } from '../../repo/index.js'
import type { VoyageEmbedder } from '../../llm/embed.js'
import type { EntityType } from '../../repo/entities.js'
import type { LoreHit, EntityCandidate } from './types.js'
import {
  HNSW_ITERATIVE_SCAN,
  SEARCH_LORE_DEFAULT_LIMIT,
  SEARCH_LORE_MAX_LIMIT,
} from './config.js'

/** Minimal logger surface this module needs (structured warn). */
export interface SearchLogger {
  warn: (obj: unknown, msg?: string) => void
}

/** Dependencies for the search resolvers. `embedder` provides the read-path
 *  query embedding; `repo` runs the short vector-scan read tx through
 *  `repo.transaction` (the BEGIN prelude SET LOCALs hnsw.iterative_scan in the
 *  same tx as the search SELECT); `logger` records searchLore's swallowed
 *  failures. */
export interface SearchDeps {
  readonly embedder: VoyageEmbedder
  readonly repo: Pick<Repo, 'transaction'>
  readonly logger: SearchLogger
}

/** searchLore / findSimilarEntities options. `limit` defaults +
 *  caps via config; `entityType` narrows findSimilarEntities to one kind. */
export interface SearchLoreOpts {
  readonly limit?: number
}
export interface FindSimilarOpts {
  readonly limit?: number
  readonly entityType?: EntityType
}

export interface SearchResolvers {
  searchLore: (
    worldId: string,
    queryText: string,
    opts: SearchLoreOpts,
  ) => Promise<LoreHit[]>
  findSimilarEntities: (
    worldId: string,
    text: string,
    opts: FindSimilarOpts,
  ) => Promise<EntityCandidate[]>
}

/** Convert a Voyage embedding (number[]) to the pgvector `'[f1,…,fN]'` text
 *  literal the binder's `$::vector` cast expects (pg has no native vector
 *  param type). */
function toVectorLiteral(v: readonly number[]): string {
  return `[${v.join(',')}]`
}

/** Clamp a caller-supplied limit into [1, SEARCH_LORE_MAX_LIMIT], defaulting
 *  when unset. */
function resolveLimit(limit: number | undefined): number {
  const requested = limit ?? SEARCH_LORE_DEFAULT_LIMIT
  return Math.min(requested, SEARCH_LORE_MAX_LIMIT)
}

/** Map one fact DB hit to a LoreHit (`source:'fact'`, carrying factId/topic/
 *  narrativeStatus). */
function factToHit(r: LoreFactDbHit): LoreHit {
  return {
    source: 'fact',
    factId: r.fact_id,
    entityId: r.entity_id,
    entityName: r.entity_name,
    topic: r.topic,
    content: r.content,
    accessLevel: r.access_level,
    narrativeStatus: r.narrative_status,
    score: r.score,
  }
}

/** Map one entity DB hit to a LoreHit (`source:'entity'`, NO factId/topic/
 *  narrativeStatus — its content is the entity name). */
function entityToHit(r: LoreEntityDbHit): LoreHit {
  return {
    source: 'entity',
    entityId: r.entity_id,
    entityName: r.name,
    content: r.name,
    accessLevel: r.access_level,
    score: r.score,
  }
}

/** Map one entity DB hit to an EntityCandidate. The binder excludes PCs, so the
 *  GraphEntityType narrows safely to the PC-free EntityType. */
function toCandidate(r: LoreEntityDbHit): EntityCandidate {
  return {
    entityId: r.entity_id,
    name: r.name,
    entityType: r.entity_type as EntityType,
    score: r.score,
  }
}

/** TxOpts pinning the read tx's BEGIN prelude to SET LOCAL hnsw.iterative_scan
 *  (config value) so the world post-filter doesn't starve the HNSW top-k. */
const VECTOR_SCAN_OPTS = { hnswIterativeScan: HNSW_ITERATIVE_SCAN } as const

export function createSearchResolvers(deps: SearchDeps): SearchResolvers {
  const { embedder, repo, logger } = deps

  /**
   * Cosine-rank facts ∪ entities for a world. Embeds the query (outside the tx),
   * over-pulls both arms at the (clamped) limit, merges + re-ranks by score
   * DESC, and slices to the limit. TOTAL: any throw → warn + []. PCs excluded
   * by the binder; all access tiers over-pulled.
   */
  async function searchLore(
    worldId: string,
    queryText: string,
    opts: SearchLoreOpts,
  ): Promise<LoreHit[]> {
    const limit = resolveLimit(opts.limit)
    try {
      const vec = await embedder.embedQuery(queryText)
      const lit = toVectorLiteral(vec)
      const result = await repo.transaction(
        async (tx) =>
          Promise.all([
            tx.worldRetrieval.searchFacts(worldId, lit, limit),
            tx.worldRetrieval.searchEntities(worldId, lit, limit),
          ]),
        VECTOR_SCAN_OPTS,
      )
      const [facts, entities] = expectCommitted(result)
      const merged = [...facts.map(factToHit), ...entities.map(entityToHit)]
      merged.sort((a, b) => b.score - a.score)
      return merged.slice(0, limit)
    } catch (err) {
      logger.warn({ err, worldId }, 'searchLore failed; returning empty')
      return []
    }
  }

  /**
   * Cosine-rank candidate entities for match-vs-mint. Embeds the query (outside
   * the tx) and over-pulls the entity arm (PCs excluded, optional entityType
   * narrow). THROWS on any failure — this is the canon write path; an empty on
   * a transient blip would mint a duplicate canonical entity.
   */
  async function findSimilarEntities(
    worldId: string,
    text: string,
    opts: FindSimilarOpts,
  ): Promise<EntityCandidate[]> {
    const limit = resolveLimit(opts.limit)
    const vec = await embedder.embedQuery(text)
    const lit = toVectorLiteral(vec)
    // EntityType ⊂ GraphEntityType (the binder's narrow param), so the filter
    // widens with no cast.
    const result = await repo.transaction(
      (tx) => tx.worldRetrieval.searchEntities(worldId, lit, limit, opts.entityType),
      VECTOR_SCAN_OPTS,
    )
    return expectCommitted(result).map(toCandidate)
  }

  return { searchLore, findSimilarEntities }
}
