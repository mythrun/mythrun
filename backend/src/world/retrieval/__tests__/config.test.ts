// backend/src/world/retrieval/__tests__/config.test.ts
import { describe, expect, it } from 'vitest'
import {
  VOYAGE_EMBED_MODEL, EMBED_DIM, VOYAGE_OUTPUT_DIMENSION,
  VOYAGE_INPUT_TYPE_DOC, VOYAGE_INPUT_TYPE_QUERY,
  VOYAGE_BATCH_MAX_INPUTS, VOYAGE_BATCH_MAX_TOKENS,
  VOYAGE_DOC_TIMEOUT_MS, VOYAGE_QUERY_TIMEOUT_MS, VOYAGE_MAX_RETRIES_429,
  HNSW_EF_SEARCH, HNSW_ITERATIVE_SCAN,
  SEARCH_LORE_DEFAULT_LIMIT, SEARCH_LORE_MAX_LIMIT,
  GRAPH_DEFAULT_DEPTH, GRAPH_MAX_DEPTH,
} from '../config.js'

describe('world/retrieval/config', () => {
  it('pins the §9 embedding constants', () => {
    expect(VOYAGE_EMBED_MODEL).toBe('voyage-4-lite')
    expect(EMBED_DIM).toBe(512)
    expect(VOYAGE_OUTPUT_DIMENSION).toBe(512)
    expect(VOYAGE_INPUT_TYPE_DOC).toBe('document')
    expect(VOYAGE_INPUT_TYPE_QUERY).toBe('query')
  })
  it('pins the batch + timeout knobs (doc generous, query tight)', () => {
    expect(VOYAGE_BATCH_MAX_INPUTS).toBeLessThanOrEqual(1000)
    expect(VOYAGE_BATCH_MAX_TOKENS).toBeGreaterThan(0)
    expect(VOYAGE_DOC_TIMEOUT_MS).toBeGreaterThan(VOYAGE_QUERY_TIMEOUT_MS)
    expect(VOYAGE_MAX_RETRIES_429).toBeGreaterThan(0)
  })
  it('pins the search + graph bounds', () => {
    expect(SEARCH_LORE_DEFAULT_LIMIT).toBe(10)
    expect(SEARCH_LORE_MAX_LIMIT).toBe(50)
    expect(GRAPH_DEFAULT_DEPTH).toBe(2)
    expect(GRAPH_MAX_DEPTH).toBe(5)
    expect(HNSW_ITERATIVE_SCAN).toBe('relaxed_order')
    expect(HNSW_EF_SEARCH).toBeGreaterThan(0)
  })
})
