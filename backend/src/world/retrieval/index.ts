// backend/src/world/retrieval/index.ts
//
// MYT-71 — the world-store retrieval surface. This barrel re-exports the entry
// functions MYT-72 (FT lookup tools / ST gate) and MYT-73 (Scribe match-vs-mint)
// call: the search resolvers (semantic lore + match-vs-mint), the graph walks
// (characters-known / faction tree), and the embed write-path. The camelCase
// result types are imported directly from their submodules (search.ts / graph.ts
// / types.ts) by consumers; internal tuning constants (config.ts) and the
// snake_case DB-row types (repo/world-retrieval.ts) are deliberately not
// re-exported — consumers depend on the resolver surface, not the SQL layer.
//
// OVER-PULL is the whole-substrate posture: nothing here filters by access_level
// (the Slow Thinker gate in MYT-72 is the single tier-safety boundary).

// ── Semantic search (search.ts) ──
export { createSearchResolvers } from './search.js'

// ── Graph walks (graph.ts) ──
export { charactersKnownTo, factionTree } from './graph.js'

// ── Embed write-path (embed-write.ts) ──
export { embedWorld } from './embed-write.js'
