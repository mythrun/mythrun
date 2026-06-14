// backend/src/world/retrieval/config.ts
//
// MYT-71 §9 — world-retrieval tuning constants. This module is data only:
// no DB, no network. The embedding pipeline (MYT-72), the searchLore /
// findSimilarEntities readers, and the graph walk all import their knobs from
// here so there is a single place to re-tune. The match-vs-mint score
// threshold is NOT here — it is a model-calibrated constant owned by MYT-73.
//
// Score convention (used by every consumer): score = 1 - cosine_distance,
// range [-1, 1]. Higher is more similar.

// ── Embedding model ─────────────────────────────────────────────────────────

/**
 * Voyage embedding model id. voyage-4-lite is the current lite tier (verified
 * 2026-06-14; voyage-3.x-lite is legacy). RE-VERIFY against Voyage's live model
 * list at build time before each release — model ids drift and silently 400.
 */
export const VOYAGE_EMBED_MODEL = 'voyage-4-lite'

/**
 * Stored embedding dimensionality. Must match the pgvector column width in the
 * embeddings migration AND VOYAGE_OUTPUT_DIMENSION below. 512 is the truncated
 * output we request from Voyage (Matryoshka) — a good recall/size tradeoff at
 * this corpus scale.
 */
export const EMBED_DIM = 512

/**
 * Output dimension requested from the Voyage API (`output_dimension`). Kept as
 * a separate constant from EMBED_DIM so the wire request and the storage width
 * are visibly the same number rather than coincidentally equal.
 */
export const VOYAGE_OUTPUT_DIMENSION = 512

/** Voyage `input_type` for the write path (lore/entity documents being indexed). */
export const VOYAGE_INPUT_TYPE_DOC = 'document'

/** Voyage `input_type` for the read path (a player/turn query being matched). */
export const VOYAGE_INPUT_TYPE_QUERY = 'query'

// ── Batching ────────────────────────────────────────────────────────────────

/** Max inputs per Voyage embed request — the provider's hard per-call cap. */
export const VOYAGE_BATCH_MAX_INPUTS = 1000

/**
 * Conservative per-request token ceiling. Well under the model's ~1M-token
 * limit; never binding at this corpus scale — it exists as a guardrail so a
 * pathological oversized batch fails fast on our side rather than at the API.
 */
export const VOYAGE_BATCH_MAX_TOKENS = 120_000

// ── Timeouts + retries ──────────────────────────────────────────────────────

/**
 * Document (write-path) embed timeout. Generous: indexing runs offline during
 * world-gen / Scribe, where latency is not player-visible and a large batch is
 * worth waiting on.
 */
export const VOYAGE_DOC_TIMEOUT_MS = 60_000

/**
 * Query (read-path) embed timeout. Tight: this is on the MYT-72 turn path, in
 * front of a waiting player. Fail fast rather than stall a turn.
 */
export const VOYAGE_QUERY_TIMEOUT_MS = 5_000

/** Max retries on a 429 (rate-limit) response before giving up. */
export const VOYAGE_MAX_RETRIES_429 = 3

// ── HNSW search-time knobs ──────────────────────────────────────────────────

/**
 * pgvector HNSW `ef_search` (SET LOCAL hnsw.ef_search). Higher = better recall,
 * more candidate nodes visited per probe. 100 is a tuned midpoint for this
 * corpus size; revisit if recall@k drops once the world store grows.
 */
export const HNSW_EF_SEARCH = 100

/**
 * pgvector `hnsw.iterative_scan` mode. 'relaxed_order' lets the index keep
 * pulling candidates past the first ef_search batch when a LIMIT + filter
 * (access-tier) would otherwise return fewer rows than asked, trading a small
 * amount of ordering precision for filtered-recall completeness.
 */
export const HNSW_ITERATIVE_SCAN = 'relaxed_order'

// ── searchLore bounds ───────────────────────────────────────────────────────

/** Default number of lore hits returned when the caller does not specify. */
export const SEARCH_LORE_DEFAULT_LIMIT = 10

/** Hard ceiling on requested lore hits — clamps caller-supplied limits. */
export const SEARCH_LORE_MAX_LIMIT = 50

// ── Graph-walk bounds ───────────────────────────────────────────────────────

/** Default relationship-graph traversal depth when the caller does not specify. */
export const GRAPH_DEFAULT_DEPTH = 2

/** Hard ceiling on graph traversal depth — clamps caller-supplied depths. */
export const GRAPH_MAX_DEPTH = 5
