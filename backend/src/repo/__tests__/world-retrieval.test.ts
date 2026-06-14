// backend/src/repo/__tests__/world-retrieval.test.ts
//
// MYT-71 Task 6 — the world-retrieval SQL substrate (pgvector + recursive-CTE
// binder). Real PG (mythrun_test); scoped fixtures.
//
// Vector inputs are hand-injected deterministic vector(512) UNIT vectors (a 1
// at a chosen axis, 0 elsewhere) so cosine ordering is hand-verifiable and
// index-independent. For two distinct unit axes the cosine distance is exactly
// 1 (score 0); for the same axis the distance is 0 (score 1). A query vector on
// axis A therefore ranks entities/facts embedded on axis A above those on any
// other axis.
//
// The vector reads run inside a tx that issues `SET LOCAL hnsw.iterative_scan =
// 'relaxed_order'` before the SELECT — that's the orchestration layer's job
// (search.ts/graph.ts in later tasks); the test mirrors it so cosine order is
// deterministic and HNSW returns every matching row.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { facts } from '../facts.js'
import { createRepo, type Repo } from '../index.js'
import { worldRetrievalNs } from '../world-retrieval.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const VECTOR_DIMS = 512

/** Build the pgvector text literal for a unit vector with a 1 at `axis`. */
function unitVec(axis: number): string {
  const parts = new Array<string>(VECTOR_DIMS).fill('0')
  parts[axis] = '1'
  return `[${parts.join(',')}]`
}

/** Run `fn` inside a tx that SET LOCALs iterative_scan='relaxed_order' first,
 *  mirroring what the orchestration layer does around a vector read. */
async function inScanTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`)
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

describe('world-retrieval repo (MYT-71 T6)', () => {
  let pool: Pool
  let repo: Repo
  let scope: TestScope
  let userId: string
  let worldA: string
  let worldB: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    scope = makeTestScope('world-retrieval')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
    userId = uuidv7()
    worldA = uuidv7()
    worldB = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldA, userId, scope.worldName(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldB, userId, scope.worldName(1)],
    )
  })

  // Seed an entity with a deterministic embedding on `axis`.
  async function seedEntity(
    worldId: string,
    entityType: 'npc' | 'location' | 'faction' | 'item' | 'pc',
    name: string,
    axis: number | null,
    accessLevel: 'known' | 'discoverable' | 'secret' = 'known',
  ): Promise<string> {
    const id = uuidv7()
    if (entityType === 'pc') {
      await repo.entities.insertPc({ id, worldId, name })
    } else {
      await entities.insert(pool, {
        id, worldId, entityType, name, accessLevel, createdIn: 'stage:test',
      })
    }
    if (axis !== null) {
      await repo.entities.updateEmbedding(id, unitVec(axis))
    }
    return id
  }

  // Seed a fact on `entityId` with a deterministic embedding on `axis`.
  async function seedFact(
    entityId: string,
    topic: string,
    content: string,
    accessLevel: 'known' | 'discoverable' | 'secret',
    axis: number | null,
  ): Promise<string> {
    await facts.insertMany(pool, [{ entityId, topic, accessLevel, content }])
    const row = await pool.query<{ id: string }>(
      `SELECT id FROM facts WHERE entity_id = $1 AND topic = $2 ORDER BY id DESC LIMIT 1`,
      [entityId, topic],
    )
    const factId = row.rows[0]?.id
    if (factId === undefined) throw new Error('expected fact row')
    if (axis !== null) {
      await repo.facts.updateEmbedding(factId, unitVec(axis))
    }
    return factId
  }

  // ── searchFacts ──────────────────────────────────────────────────────────

  it('searchFacts ranks by cosine, returns ALL tiers, scores 1-distance, world-isolated', async () => {
    const ent = await seedEntity(worldA, 'npc', 'Mara', 0)
    // axis-0 facts (near the query), one per tier — all must be returned.
    const known = await seedFact(ent, 'history', 'k', 'known', 0)
    const disc = await seedFact(ent, 'lore', 'd', 'discoverable', 0)
    const secret = await seedFact(ent, 'plot', 's', 'secret', 0)
    // A far fact on axis 1 — returned (no tier/embedding filter beyond non-null)
    // but ranked last.
    const far = await seedFact(ent, 'aside', 'far', 'known', 1)
    // A fact with NULL embedding — must NOT appear.
    await seedFact(ent, 'unembedded', 'none', 'known', null)
    // A worldB fact on the SAME axis — must NEVER appear (cross-world isolation).
    const entB = await seedEntity(worldB, 'npc', 'Other', 0)
    await seedFact(entB, 'history', 'bw', 'known', 0)

    const hits = await inScanTx(pool, (c) =>
      worldRetrievalNs(c).searchFacts(worldA, unitVec(0), 10),
    )

    const ids = hits.map((h) => h.fact_id)
    expect(ids).toEqual(expect.arrayContaining([known, disc, secret, far]))
    // All three tiers present (over-pull; no access_level predicate).
    expect(new Set(hits.map((h) => h.access_level))).toEqual(
      new Set(['known', 'discoverable', 'secret']),
    )
    // No worldB fact leaked in.
    for (const h of hits) {
      expect(h.entity_id).not.toBe(entB)
    }
    // axis-0 facts (score≈1) rank above the axis-1 far fact (score≈0).
    const axis0Scores = hits.filter((h) => h.fact_id !== far).map((h) => h.score)
    const farScore = hits.find((h) => h.fact_id === far)?.score
    expect(farScore).toBeDefined()
    if (farScore === undefined) throw new Error('expected far fact score')
    for (const s of axis0Scores) {
      expect(s).toBeGreaterThan(farScore)
      expect(s).toBeCloseTo(1, 5)
    }
    expect(farScore).toBeCloseTo(0, 5)
    // The closest hit carries entity name/topic/narrative_status fields.
    const top = hits[0]
    expect(top?.entity_name).toBe('Mara')
    expect(top?.narrative_status).toBe('undelivered')
    expect(typeof top?.topic).toBe('string')
  })

  it('searchFacts honors the limit', async () => {
    const ent = await seedEntity(worldA, 'npc', 'Mara', 0)
    for (let i = 0; i < 5; i++) await seedFact(ent, `t${String(i)}`, 'c', 'known', 0)
    const hits = await inScanTx(pool, (c) =>
      worldRetrievalNs(c).searchFacts(worldA, unitVec(0), 2),
    )
    expect(hits).toHaveLength(2)
  })

  // ── searchEntities ───────────────────────────────────────────────────────

  it('searchEntities excludes pc, ranks by cosine, world-isolated', async () => {
    const npc = await seedEntity(worldA, 'npc', 'Mara', 0)
    const loc = await seedEntity(worldA, 'location', 'Wharf', 1)
    const pc = await seedEntity(worldA, 'pc', 'Ada', 0) // must be excluded
    // NULL-embedding entity → excluded.
    await seedEntity(worldA, 'item', 'Lantern', null)
    // worldB entity on the same axis → excluded by world scope.
    const otherWorld = await seedEntity(worldB, 'npc', 'Stranger', 0)

    const hits = await inScanTx(pool, (c) =>
      worldRetrievalNs(c).searchEntities(worldA, unitVec(0), 10),
    )
    const ids = hits.map((h) => h.entity_id)
    expect(ids).toContain(npc)
    expect(ids).toContain(loc)
    expect(ids).not.toContain(pc)
    expect(ids).not.toContain(otherWorld)
    // axis-0 npc (score≈1) ranks above the axis-1 location (score≈0).
    expect(hits[0]?.entity_id).toBe(npc)
    expect(hits[0]?.score).toBeCloseTo(1, 5)
    expect(hits.find((h) => h.entity_id === loc)?.score).toBeCloseTo(0, 5)
    expect(hits[0]?.name).toBe('Mara')
    expect(hits[0]?.entity_type).toBe('npc')
  })

  it('searchEntities filters to a single entity_type when provided', async () => {
    const npc = await seedEntity(worldA, 'npc', 'Mara', 0)
    await seedEntity(worldA, 'location', 'Wharf', 0)
    await seedEntity(worldA, 'faction', 'Salt Guild', 0)
    const hits = await inScanTx(pool, (c) =>
      worldRetrievalNs(c).searchEntities(worldA, unitVec(0), 10, 'npc'),
    )
    expect(hits.map((h) => h.entity_id)).toEqual([npc])
    expect(hits.every((h) => h.entity_type === 'npc')).toBe(true)
  })

  it('searchEntities honors the limit', async () => {
    for (let i = 0; i < 4; i++) await seedEntity(worldA, 'npc', `N${String(i)}`, 0)
    const hits = await inScanTx(pool, (c) =>
      worldRetrievalNs(c).searchEntities(worldA, unitVec(0), 2),
    )
    expect(hits).toHaveLength(2)
  })

  // ── charactersKnownTo ────────────────────────────────────────────────────

  it('charactersKnownTo walks both directions, dedups a diamond, is cycle-safe, depth-bounds', async () => {
    // Graph: root → A, root → B (out-edges); C → root (in-edge, must be reached
    // by traversing the relationship backwards). A → D and B → D (diamond — D is
    // reachable two ways, must appear ONCE at its min depth 2). D → E (depth 3).
    // Plus a reachable cycle: A → C (so root→A→C→root revisits root within the
    // depth budget — the path array must block re-adding root, proving cycle-
    // safety). The cycle deliberately routes through A/C, not D, so it doesn't
    // create a spurious depth-1 shortcut to D.
    const root = await seedEntity(worldA, 'npc', 'Root', 0)
    const a = await seedEntity(worldA, 'npc', 'A', 0)
    const b = await seedEntity(worldA, 'npc', 'B', 0)
    const c = await seedEntity(worldA, 'npc', 'C', 0)
    const d = await seedEntity(worldA, 'npc', 'D', 0)
    const e = await seedEntity(worldA, 'npc', 'E', 0) // depth 3 via D→E
    const insert = async (src: string, tgt: string): Promise<void> => {
      await pool.query(
        `INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description)
         VALUES ($1, $2, $3, 'knows', 'd')`,
        [uuidv7(), src, tgt],
      )
    }
    await insert(root, a) // depth 1 (out)
    await insert(root, b) // depth 1 (out)
    await insert(c, root) // depth 1 (in — backwards edge)
    await insert(a, d) // depth 2
    await insert(b, d) // depth 2 (diamond)
    await insert(d, e) // depth 3
    await insert(a, c) // reachable cycle: root→A→C→root revisits root (path-blocked)

    const rows = await worldRetrievalNs(pool).charactersKnownTo(root, 3)

    const byId = new Map(rows.map((r) => [r.entity_id, r]))
    // root itself is depth 0.
    expect(byId.get(root)?.depth).toBe(0)
    // direct neighbors (both directions) at depth 1.
    expect(byId.get(a)?.depth).toBe(1)
    expect(byId.get(b)?.depth).toBe(1)
    expect(byId.get(c)?.depth).toBe(1)
    // D appears exactly once, at its MIN depth (2).
    const dRows = rows.filter((r) => r.entity_id === d)
    expect(dRows).toHaveLength(1)
    expect(dRows[0]?.depth).toBe(2)
    // E at depth 3 (within maxDepth).
    expect(byId.get(e)?.depth).toBe(3)
    expect(byId.get(e)?.name).toBe('E')
    expect(byId.get(e)?.entity_type).toBe('npc')
  })

  it('charactersKnownTo respects maxDepth (excludes nodes deeper than the bound)', async () => {
    const root = await seedEntity(worldA, 'npc', 'Root', 0)
    const a = await seedEntity(worldA, 'npc', 'A', 0)
    const b = await seedEntity(worldA, 'npc', 'B', 0)
    const insert = async (src: string, tgt: string): Promise<void> => {
      await pool.query(
        `INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description)
         VALUES ($1, $2, $3, 'knows', 'd')`,
        [uuidv7(), src, tgt],
      )
    }
    await insert(root, a) // depth 1
    await insert(a, b) // depth 2 — must be excluded at maxDepth=1
    const rows = await worldRetrievalNs(pool).charactersKnownTo(root, 1)
    const ids = rows.map((r) => r.entity_id)
    expect(ids).toContain(root)
    expect(ids).toContain(a)
    expect(ids).not.toContain(b)
  })

  // ── factionTree ──────────────────────────────────────────────────────────

  it('factionTree returns the subtree with correct parent_id + depth', async () => {
    const root = await seedEntity(worldA, 'faction', 'Crown', 0)
    const child1 = await seedEntity(worldA, 'faction', 'House A', 0)
    const child2 = await seedEntity(worldA, 'faction', 'House B', 0)
    const grandchild = await seedEntity(worldA, 'faction', 'Cadet Branch', 0)
    const insertH = async (parent: string, child: string): Promise<void> => {
      await pool.query(
        `INSERT INTO entity_hierarchy (id, parent_entity_id, child_entity_id) VALUES ($1, $2, $3)`,
        [uuidv7(), parent, child],
      )
    }
    await insertH(root, child1)
    await insertH(root, child2)
    await insertH(child1, grandchild)

    const rows = await worldRetrievalNs(pool).factionTree(root, 5)
    const byId = new Map(rows.map((r) => [r.entity_id, r]))
    expect(byId.get(root)?.depth).toBe(0)
    expect(byId.get(root)?.parent_id).toBeNull()
    expect(byId.get(child1)?.depth).toBe(1)
    expect(byId.get(child1)?.parent_id).toBe(root)
    expect(byId.get(child2)?.depth).toBe(1)
    expect(byId.get(child2)?.parent_id).toBe(root)
    expect(byId.get(grandchild)?.depth).toBe(2)
    expect(byId.get(grandchild)?.parent_id).toBe(child1)
    expect(byId.get(grandchild)?.name).toBe('Cadet Branch')
    expect(byId.get(grandchild)?.entity_type).toBe('faction')
  })

  it('factionTree respects maxDepth (returns rows where depth <= maxDepth)', async () => {
    const root = await seedEntity(worldA, 'faction', 'Crown', 0)
    const child = await seedEntity(worldA, 'faction', 'House A', 0)
    const grandchild = await seedEntity(worldA, 'faction', 'Cadet', 0)
    const insertH = async (parent: string, c: string): Promise<void> => {
      await pool.query(
        `INSERT INTO entity_hierarchy (id, parent_entity_id, child_entity_id) VALUES ($1, $2, $3)`,
        [uuidv7(), parent, c],
      )
    }
    await insertH(root, child) // depth 1
    await insertH(child, grandchild) // depth 2 — excluded at maxDepth=1
    const rows = await worldRetrievalNs(pool).factionTree(root, 1)
    const ids = rows.map((r) => r.entity_id)
    expect(ids).toContain(root)
    expect(ids).toContain(child)
    expect(ids).not.toContain(grandchild)
  })

  // ── listFactsToEmbed (T9 embedWorld input) ────────────────────────────────

  it('listFactsToEmbed(false) returns only NULL-embedding facts; force returns all; world-isolated', async () => {
    const ent = await seedEntity(worldA, 'npc', 'Mara', 0)
    // Two embedded facts (axis 0) + two un-embedded (axis null). Over-pull: tiers
    // span all three so the absence of an access_level filter is exercised.
    await seedFact(ent, 'embedded-k', 'ek', 'known', 0)
    await seedFact(ent, 'embedded-s', 'es', 'secret', 0)
    const unA = await seedFact(ent, 'fresh-k', 'fk', 'known', null)
    const unB = await seedFact(ent, 'fresh-d', 'fd', 'discoverable', null)
    // A worldB un-embedded fact — must never appear (cross-world isolation).
    const entB = await seedEntity(worldB, 'npc', 'Other', null)
    await seedFact(entB, 'fresh-bw', 'bw', 'known', null)

    const incremental = await worldRetrievalNs(pool).listFactsToEmbed(worldA, false)
    expect(incremental.map((r) => r.id).sort()).toEqual([unA, unB].sort())
    // Returns the content to embed, no other shape.
    expect(new Set(incremental.map((r) => r.content))).toEqual(new Set(['fk', 'fd']))

    const all = await worldRetrievalNs(pool).listFactsToEmbed(worldA, true)
    expect(all).toHaveLength(4) // both embedded + both fresh
    // worldB fact never leaked into either result.
    for (const r of [...incremental, ...all]) {
      expect(r.content).not.toBe('bw')
    }
  })

  // ── listEntitiesToEmbed (T9 embedWorld input) ─────────────────────────────

  it('listEntitiesToEmbed excludes pc, composes name + prose, force toggles NULL filter, world-isolated', async () => {
    // npc with a prose kernel (name + prose composed) — un-embedded.
    const npc = await seedEntity(worldA, 'npc', 'Mara', null)
    await pool.query(
      `INSERT INTO prose_kernels (id, entity_id, content) VALUES ($1, $2, 'A salt-eaten harbor witch.')`,
      [uuidv7(), npc],
    )
    // location with NO kernel — name only (COALESCE → '' trailing space).
    const loc = await seedEntity(worldA, 'location', 'Wharf', null)
    // an embedded entity (axis 0) — excluded by the false branch, included by force.
    const embedded = await seedEntity(worldA, 'faction', 'Salt Guild', 0)
    // a pc — must be excluded from BOTH branches (not world lore).
    await seedEntity(worldA, 'pc', 'Ada', null)
    // worldB entity — cross-world isolation.
    const otherWorld = await seedEntity(worldB, 'npc', 'Stranger', null)

    const incremental = await worldRetrievalNs(pool).listEntitiesToEmbed(worldA, false)
    const byId = new Map(incremental.map((r) => [r.id, r]))
    expect(byId.get(npc)?.text).toBe('Mara A salt-eaten harbor witch.')
    expect(byId.get(loc)?.text).toBe('Wharf ') // name + space + '' (no kernel)
    // Only the two un-embedded non-pc entities; embedded + pc + worldB excluded.
    expect(incremental.map((r) => r.id).sort()).toEqual([npc, loc].sort())
    expect(byId.has(embedded)).toBe(false)
    expect(byId.has(otherWorld)).toBe(false)

    const all = await worldRetrievalNs(pool).listEntitiesToEmbed(worldA, true)
    const allIds = all.map((r) => r.id)
    expect(allIds.sort()).toEqual([npc, loc, embedded].sort()) // pc still excluded
    expect(allIds).not.toContain(otherWorld)
  })
})
