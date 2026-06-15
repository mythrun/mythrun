// backend/src/world/retrieval/graph.ts
//
// MYT-71 Task 8 — graph-walk ORCHESTRATION over the T6 world-retrieval binder.
// Thin deterministic shell (ZFC: no reasoning here): clamp the depth, call the
// recursive-CTE binder, apply a mechanical nameFilter, map snake→camel, and
// derive the factionTree truncation flag. All the heavy SQL (both-direction
// walk, cycle-safety via the path array, DISTINCT ON min-depth dedup, the
// hierarchy subtree) lives in the binder; this module never opens a tx and never
// touches the vector column (graph walks are pure structural reads).
//
// ERROR PROPAGATION — these functions deliberately DO NOT catch DB errors. There
// is no totality/degradation contract at this layer; MYT-72's tool-error
// handling is the catch site. A binder/DB failure surfaces to the caller as-is.
//
// OVER-PULL — no access_level predicate anywhere (the binder has none either);
// `known`/`discoverable`/`secret` rows all flow through. The tier gate is the
// Slow Thinker, downstream. PCs are INCLUDED on the graph paths (the binder does
// not filter `entity_type = 'pc'` here), so the result entityType can carry 'pc'.
//
// entityType TYPING DECISION (see report): T4's KnownCharacter/FactionNode
// (world/retrieval/types.ts) type entityType as the NARROW EntityType (no 'pc'),
// but the graph rows carry 'pc' at runtime. types.ts is another wave's file and
// must NOT be edited, and strict TS forbids the cast a narrow type would need.
// So the graph-facing result types are defined HERE as KnownCharacter /
// FactionNode, structurally identical to T4's shapes but with entityType:
// GraphEntityType (EntityType | 'pc'). This keeps the mapping cast-free and
// honest about the 'pc' rows. Recommendation for the merge: T4's graph result
// types should ultimately carry GraphEntityType too.

import type { Repo } from '../../repo/index.js'
import type {
  GraphEntityType,
  KnownCharacterDbRow,
  FactionNodeDbRow,
} from '../../repo/world-retrieval.js'
import { GRAPH_DEFAULT_DEPTH, GRAPH_MAX_DEPTH } from './config.js'
import type { KnownCharacter, FactionNode } from './types.js'

/** Re-export so consumers can name the widened graph entity type. */
export type { GraphEntityType }

/** Dependency subset — only the world-retrieval binder is needed. Pinned as a
 *  Pick over Repo so a full `repo` or a hand-built `{ worldRetrieval }` both fit. */
export interface GraphDeps {
  readonly repo: Pick<Repo, 'worldRetrieval'>
}

/** Options for {@link charactersKnownTo}. */
export interface CharactersKnownToOpts {
  /** Case-insensitive, trimmed exact-name post-filter (mechanical, no fuzzy). */
  readonly nameFilter?: string
  /** Traversal depth; defaults GRAPH_DEFAULT_DEPTH, hard-capped GRAPH_MAX_DEPTH. */
  readonly maxDepth?: number
}

/** Clamp a requested depth to [0, GRAPH_MAX_DEPTH], defaulting when absent. */
function resolveDepth(requested?: number): number {
  const depth = requested ?? GRAPH_DEFAULT_DEPTH
  if (depth > GRAPH_MAX_DEPTH) return GRAPH_MAX_DEPTH
  if (depth < 0) return 0
  return depth
}

/** Normalize a name for the mechanical filter: lower(btrim(name)) equality. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

function toKnownCharacter(row: KnownCharacterDbRow): KnownCharacter {
  return {
    entityId: row.entity_id,
    name: row.name,
    entityType: row.entity_type,
    accessLevel: row.access_level,
    depth: row.depth,
  }
}

function toFactionNode(row: FactionNodeDbRow): FactionNode {
  return {
    entityId: row.entity_id,
    name: row.name,
    entityType: row.entity_type,
    accessLevel: row.access_level,
    parentId: row.parent_id,
    depth: row.depth,
  }
}

/**
 * Characters reachable from `entityId` within the (clamped) depth over the
 * relationship graph — both edge directions, cycle-safe, diamond-deduped to the
 * min depth (all owned by the binder; the result is already a SET). An optional
 * `nameFilter` is applied as a normalized JS exact-match post-filter. PCs are
 * included. DB errors propagate.
 */
export async function charactersKnownTo(
  deps: GraphDeps,
  entityId: string,
  opts: CharactersKnownToOpts,
): Promise<KnownCharacter[]> {
  const depth = resolveDepth(opts.maxDepth)
  const rows = await deps.repo.worldRetrieval.charactersKnownTo(entityId, depth)
  const mapped = rows.map(toKnownCharacter)
  if (opts.nameFilter === undefined) return mapped
  const wanted = normalizeName(opts.nameFilter)
  return mapped.filter((c) => normalizeName(c.name) === wanted)
}

/**
 * The faction subtree rooted at `entityId`. Walks `entity_hierarchy` at
 * GRAPH_MAX_DEPTH (the binder returns rows where depth <= maxDepth). `truncated`
 * is true when any returned node sits at exactly GRAPH_MAX_DEPTH — that node may
 * have unreturned children below the bound, so the subtree may extend deeper.
 * DB errors propagate.
 */
export async function factionTree(
  deps: GraphDeps,
  entityId: string,
): Promise<{ nodes: FactionNode[]; truncated: boolean }> {
  const rows = await deps.repo.worldRetrieval.factionTree(entityId, GRAPH_MAX_DEPTH)
  const nodes = rows.map(toFactionNode)
  const truncated = nodes.some((n) => n.depth === GRAPH_MAX_DEPTH)
  return { nodes, truncated }
}
