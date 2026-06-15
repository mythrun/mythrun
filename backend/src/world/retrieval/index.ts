// backend/src/world/retrieval/index.ts
//
// MYT-71 — the world-store retrieval surface. This barrel is the ONLY entry
// point MYT-72 (FT lookup tools / ST gate) and MYT-73 (Scribe match-vs-mint)
// import: the search resolvers (semantic lore + match-vs-mint), the graph walks
// (characters-known / faction tree), the embed write-path, and every camelCase
// result type. Internal tuning constants (config.ts) and the snake_case DB-row
// types (repo/world-retrieval.ts) are deliberately NOT re-exported — consumers
// depend on the resolver surface, not the SQL layer.
//
// OVER-PULL is the whole-substrate posture: nothing here filters by access_level
// (the Slow Thinker gate in MYT-72 is the single tier-safety boundary).

// ── Semantic search (search.ts) ──
export { createSearchResolvers } from './search.js'
export type {
  SearchResolvers,
  SearchDeps,
  SearchLogger,
  SearchLoreOpts,
  FindSimilarOpts,
} from './search.js'

// ── Graph walks (graph.ts) ──
export { charactersKnownTo, factionTree } from './graph.js'
export type { GraphDeps, CharactersKnownToOpts, GraphEntityType } from './graph.js'

// ── Embed write-path (embed-write.ts) ──
export { embedWorld } from './embed-write.js'
export type { EmbedDeps, EmbedWorldOpts, EmbedSummary } from './embed-write.js'

// ── Result types (types.ts) ──
export type { LoreHit, EntityCandidate, KnownCharacter, FactionNode } from './types.js'
