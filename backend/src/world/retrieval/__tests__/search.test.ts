// backend/src/world/retrieval/__tests__/search.test.ts
//
// MYT-71 Task 7 — searchLore / findSimilarEntities orchestration over the T6
// world-retrieval binder. DB-FREE: the binder + the read tx are mocked through
// a fake `repo.transaction` that invokes the callback against a fake
// `tx.worldRetrieval` returning already-mapped DB-row hits (LoreFactDbHit /
// LoreEntityDbHit) with scores set directly. The real cosine ranking is the T6
// binder test's job; here we verify the ORCHESTRATION: embed → merge facts ∪
// entities → re-rank by score DESC → slice; the limit clamp; the
// hnswIterativeScan TxOpt; the TOTAL-vs-THROWS error asymmetry; and that the
// entityType filter is forwarded to searchEntities. PC-exclusion is the
// binder's job (`entity_type <> 'pc'`), so the entity stub simply omits PCs.

import { describe, expect, it, vi } from 'vitest'
import type { VoyageEmbedder } from '../../../llm/embed.js'
import type {
  LoreFactDbHit,
  LoreEntityDbHit,
  GraphEntityType,
} from '../../../repo/world-retrieval.js'
import type { Repo } from '../../../repo/index.js'
import { SEARCH_LORE_MAX_LIMIT } from '../config.js'
import { createSearchResolvers, type SearchDeps } from '../search.js'

// ── builders for the fake binder's already-mapped DB rows ──────────────────

function factHit(over: Partial<LoreFactDbHit> & { fact_id: string; score: number }): LoreFactDbHit {
  return {
    entity_id: 'ent-default',
    entity_name: 'Default',
    topic: 'topic',
    content: 'content',
    access_level: 'known',
    narrative_status: 'undelivered',
    ...over,
  }
}

function entityHit(
  over: Partial<LoreEntityDbHit> & { entity_id: string; score: number },
): LoreEntityDbHit {
  return {
    name: 'Default',
    entity_type: 'npc',
    access_level: 'known',
    ...over,
  }
}

// ── fake repo whose transaction(cb, opts) captures opts + runs cb(fakeTx) ───

interface FakeBinder {
  facts?: readonly LoreFactDbHit[]
  entities?: readonly LoreEntityDbHit[]
  /** When set, searchFacts rejects with this (the in-tx query-arm throw). */
  factsError?: Error
}

interface FakeRepoHandle {
  repo: Pick<Repo, 'transaction'>
  /** TxOpts captured from the last repo.transaction call. */
  capturedOpts: { hnswIterativeScan?: string } | undefined
  searchFacts: ReturnType<typeof vi.fn>
  searchEntities: ReturnType<typeof vi.fn>
}

function makeFakeRepo(binder: FakeBinder): FakeRepoHandle {
  const handle = {
    capturedOpts: undefined as { hnswIterativeScan?: string } | undefined,
  } as FakeRepoHandle

  // searchFacts(worldId, lit, limit) → up to `limit` fact rows (or throw).
  const searchFacts = vi.fn((_worldId: string, _lit: string, limit: number) => {
    if (binder.factsError) return Promise.reject(binder.factsError)
    return Promise.resolve((binder.facts ?? []).slice(0, limit))
  })
  // searchEntities(worldId, lit, limit, entityType?) → up to `limit` rows,
  // filtered by entityType when provided (mirrors the binder's typeClause).
  const searchEntities = vi.fn(
    (_worldId: string, _lit: string, limit: number, entityType?: GraphEntityType) => {
      const all = binder.entities ?? []
      const filtered = entityType === undefined ? all : all.filter((e) => e.entity_type === entityType)
      return Promise.resolve(filtered.slice(0, limit))
    },
  )

  const fakeTx = { worldRetrieval: { searchFacts, searchEntities } }
  const transaction = vi.fn(
    (cb: (tx: typeof fakeTx) => Promise<unknown>, opts?: { hnswIterativeScan?: string }) => {
      handle.capturedOpts = opts
      return cb(fakeTx)
    },
  )

  handle.repo = { transaction } as unknown as Pick<Repo, 'transaction'>
  handle.searchFacts = searchFacts
  handle.searchEntities = searchEntities
  return handle
}

// ── embedder + logger stubs ─────────────────────────────────────────────────

function stubEmbedder(impl: () => Promise<number[]>): VoyageEmbedder {
  return {
    embedQuery: vi.fn(impl),
    embedDocuments: vi.fn(() => Promise.resolve([])),
  }
}
function okEmbedder(): VoyageEmbedder {
  return stubEmbedder(() => Promise.resolve([1, 0, 0]))
}
function stubLogger(): { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() }
}

function makeDeps(over: Partial<SearchDeps> & { repo: Pick<Repo, 'transaction'> }): SearchDeps {
  return {
    embedder: over.embedder ?? okEmbedder(),
    repo: over.repo,
    logger: over.logger ?? stubLogger(),
  }
}

// ── searchLore ──────────────────────────────────────────────────────────────

describe('searchLore (MYT-71 T7)', () => {
  it('merges facts ∪ entities, re-ranks by score DESC, shapes each source', async () => {
    // Unsorted input across both arms; the resolver must re-rank by score DESC.
    const fake = makeFakeRepo({
      facts: [
        factHit({ fact_id: 'f-far', entity_id: 'e1', entity_name: 'Mara', topic: 'aside', content: 'a rumor', access_level: 'discoverable', score: 0.1 }),
        factHit({ fact_id: 'f-near', entity_id: 'e1', entity_name: 'Mara', topic: 'history', content: 'the siege', score: 0.95 }),
      ],
      entities: [
        entityHit({ entity_id: 'e2', name: 'Wharf', entity_type: 'location', score: 0.2 }),
        entityHit({ entity_id: 'e1', name: 'Mara', entity_type: 'npc', score: 0.9 }),
      ],
    })
    const hits = await createSearchResolvers(makeDeps({ repo: fake.repo })).searchLore('w', 'q', {})

    // Both a fact AND an entity appear.
    expect(hits.some((h) => h.source === 'fact')).toBe(true)
    expect(hits.some((h) => h.source === 'entity')).toBe(true)
    // Re-ranked by score DESC: monotonically non-increasing.
    for (let i = 1; i < hits.length; i++) {
      const prev = hits[i - 1]
      const cur = hits[i]
      if (prev === undefined || cur === undefined) throw new Error('hit gap')
      expect(prev.score).toBeGreaterThanOrEqual(cur.score)
    }
    // Top hit is the highest-scoring across the union (the near fact, 0.95).
    expect(hits[0]?.source).toBe('fact')
    expect(hits[0]?.score).toBe(0.95)

    // Fact rows carry factId/topic/narrativeStatus.
    const factHitOut = hits.find((h) => h.source === 'fact' && h.factId === 'f-near')
    expect(factHitOut).toBeDefined()
    if (factHitOut === undefined) throw new Error('expected near fact hit')
    expect(factHitOut.factId).toBe('f-near')
    expect(factHitOut.topic).toBe('history')
    expect(factHitOut.narrativeStatus).toBe('undelivered')
    expect(factHitOut.entityId).toBe('e1')
    expect(factHitOut.entityName).toBe('Mara')
    expect(factHitOut.content).toBe('the siege')

    // Entity rows do NOT carry factId/topic/narrativeStatus; content = name.
    const entHitOut = hits.find((h) => h.source === 'entity' && h.entityId === 'e1')
    expect(entHitOut).toBeDefined()
    if (entHitOut === undefined) throw new Error('expected entity hit')
    expect(entHitOut.factId).toBeUndefined()
    expect(entHitOut.topic).toBeUndefined()
    expect(entHitOut.narrativeStatus).toBeUndefined()
    expect(entHitOut.entityName).toBe('Mara')
    expect(entHitOut.content).toBe('Mara')
  })

  it('pins hnswIterativeScan=relaxed_order on the read tx', async () => {
    const fake = makeFakeRepo({ facts: [], entities: [] })
    await createSearchResolvers(makeDeps({ repo: fake.repo })).searchLore('w', 'q', {})
    expect(fake.capturedOpts?.hnswIterativeScan).toBe('relaxed_order')
  })

  it('over-pulls all three access tiers (no access_level filter)', async () => {
    const fake = makeFakeRepo({
      facts: [
        factHit({ fact_id: 'k', access_level: 'known', score: 0.9 }),
        factHit({ fact_id: 'd', access_level: 'discoverable', score: 0.8 }),
        factHit({ fact_id: 's', access_level: 'secret', score: 0.7 }),
      ],
      entities: [],
    })
    const hits = await createSearchResolvers(makeDeps({ repo: fake.repo })).searchLore('w', 'q', {})
    const tiers = new Set(hits.filter((h) => h.source === 'fact').map((h) => h.accessLevel))
    expect(tiers).toEqual(new Set(['known', 'discoverable', 'secret']))
  })

  it('returns [] and logs warn when the embedder rejects (totality)', async () => {
    const fake = makeFakeRepo({ facts: [], entities: [] })
    const logger = stubLogger()
    const resolvers = createSearchResolvers(
      makeDeps({
        repo: fake.repo,
        embedder: stubEmbedder(() => Promise.reject(new Error('voyage timeout'))),
        logger,
      }),
    )
    expect(await resolvers.searchLore('w', 'q', {})).toEqual([])
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('returns [] and logs warn when the vector query throws (totality)', async () => {
    const fake = makeFakeRepo({ factsError: new Error('cast error'), entities: [] })
    const logger = stubLogger()
    const resolvers = createSearchResolvers(makeDeps({ repo: fake.repo, logger }))
    expect(await resolvers.searchLore('w', 'q', {})).toEqual([])
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('honors limit (per-arm + final slice) and caps it at SEARCH_LORE_MAX_LIMIT', async () => {
    // 6 facts on one arm; with limit 3 the per-arm slice + final slice → 3.
    const facts = Array.from({ length: 6 }, (_v, i) =>
      factHit({ fact_id: `f${String(i)}`, score: 1 - i * 0.1 }),
    )
    const fake = makeFakeRepo({ facts, entities: [] })
    const resolvers = createSearchResolvers(makeDeps({ repo: fake.repo }))

    const limited = await resolvers.searchLore('w', 'q', { limit: 3 })
    expect(limited).toHaveLength(3)
    // The per-arm limit passed to the binder is the requested limit.
    expect(fake.searchFacts).toHaveBeenLastCalledWith('w', expect.any(String), 3)

    // An over-max limit is clamped to SEARCH_LORE_MAX_LIMIT before reaching the
    // binder (asserts the clamp directly via the forwarded arg).
    await resolvers.searchLore('w', 'q', { limit: 9_999 })
    expect(fake.searchFacts).toHaveBeenLastCalledWith('w', expect.any(String), SEARCH_LORE_MAX_LIMIT)
    expect(fake.searchEntities).toHaveBeenLastCalledWith('w', expect.any(String), SEARCH_LORE_MAX_LIMIT)
  })
})

// ── findSimilarEntities ──────────────────────────────────────────────────

describe('findSimilarEntities (MYT-71 T7)', () => {
  it('maps binder-ranked rows to EntityCandidate[] in order (binder excludes pc + other worlds)', async () => {
    // The binder returns rows already ORDER BY cosine (best first);
    // findSimilarEntities trusts that order and does NOT re-rank — so the
    // stub lists them best-first to mirror the real binder output.
    const fake = makeFakeRepo({
      entities: [
        entityHit({ entity_id: 'e1', name: 'Mara', entity_type: 'npc', score: 0.9 }),
        entityHit({ entity_id: 'e2', name: 'Wharf', entity_type: 'location', score: 0.2 }),
      ],
    })
    const cands = await createSearchResolvers(makeDeps({ repo: fake.repo })).findSimilarEntities(
      'w',
      'a tall woman',
      {},
    )
    expect(cands.map((c) => c.entityId)).toEqual(['e1', 'e2'])
    expect(cands[0]?.name).toBe('Mara')
    expect(cands[0]?.entityType).toBe('npc')
    expect(cands[0]?.score).toBe(0.9)
    expect(cands[1]?.entityType).toBe('location')
  })

  it('pins hnswIterativeScan=relaxed_order on the read tx', async () => {
    const fake = makeFakeRepo({ entities: [] })
    await createSearchResolvers(makeDeps({ repo: fake.repo })).findSimilarEntities('w', 'q', {})
    expect(fake.capturedOpts?.hnswIterativeScan).toBe('relaxed_order')
  })

  it('forwards the optional entityType filter to searchEntities', async () => {
    const fake = makeFakeRepo({
      entities: [
        entityHit({ entity_id: 'e1', name: 'Mara', entity_type: 'npc', score: 0.9 }),
        entityHit({ entity_id: 'e2', name: 'Wharf', entity_type: 'location', score: 0.8 }),
        entityHit({ entity_id: 'e3', name: 'Salt Guild', entity_type: 'faction', score: 0.7 }),
      ],
    })
    const cands = await createSearchResolvers(makeDeps({ repo: fake.repo })).findSimilarEntities(
      'w',
      'q',
      { entityType: 'npc' },
    )
    // entityType reached the binder, which filtered to npc only.
    expect(fake.searchEntities).toHaveBeenLastCalledWith('w', expect.any(String), expect.any(Number), 'npc')
    expect(cands.map((c) => c.entityId)).toEqual(['e1'])
    expect(cands.every((c) => c.entityType === 'npc')).toBe(true)
  })

  it('THROWS when the embedder rejects (canon write path — never [])', async () => {
    const fake = makeFakeRepo({ entities: [] })
    const resolvers = createSearchResolvers(
      makeDeps({
        repo: fake.repo,
        embedder: stubEmbedder(() => Promise.reject(new Error('voyage timeout'))),
      }),
    )
    await expect(resolvers.findSimilarEntities('w', 'q', {})).rejects.toThrow('voyage timeout')
  })
})
