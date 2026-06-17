// backend/src/repo/__tests__/world-retrieval-supersede.test.ts
//
// MYT-74a Task T7 — superseded facts must NEVER resurface to canon readers.
// Migration 027 added `facts.superseded_by UUID` (nullable); live canon =
// `superseded_by IS NULL`. This suite pins the three live-only `FROM facts`
// read paths owned by T7:
//   1. world-retrieval.searchFacts   (semantic search_lore fact arm)
//   2. world-retrieval.listFactsToEmbed (embed backfill)
//   3. world-inventory.load          (prep/coherence composite read)
//
// Independent of T5's `setSuperseded` — the supersede column is seeded directly
// via raw SQL so this suite never depends on facts.ts changes.
//
// Real PG (mythrun_test); scoped fixtures. The vector read runs inside a tx that
// SET LOCALs iterative_scan='relaxed_order' first (the orchestration layer's job
// around a vector read), mirroring world-retrieval.test.ts.

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

/** A non-zero pgvector literal so embedded rows are searchable (NOT NULL). All
 *  facts share the same vector — supersede filtering, not cosine order, is the
 *  thing under test. */
const VEC_LITERAL = `[${new Array<string>(VECTOR_DIMS).fill('0.01').join(',')}]`

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

describe('world-store supersede filtering (MYT-74a T7)', () => {
  let pool: Pool
  let repo: Repo
  let scope: TestScope
  let userId: string
  let worldId: string
  let entityId: string
  let liveFactId: string
  let supersededFactId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    scope = makeTestScope('world-retrieval-supersede')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  // Seed a user + world + entity + TWO facts (both embedded); mark one fact
  // superseded by the other via RAW SQL (T7 is independent of T5's
  // setSuperseded — seed the column directly).
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
    userId = uuidv7()
    worldId = uuidv7()
    entityId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
    await entities.insert(pool, {
      id: entityId,
      worldId,
      entityType: 'npc',
      name: 'Mara',
      accessLevel: 'known',
      createdIn: 'stage:test',
    })

    // Two facts on the entity. `live` is the correction; `stale` is superseded
    // by it. Both embedded so both are search-eligible absent the filter.
    await facts.insertMany(pool, [
      { entityId, topic: 'history', accessLevel: 'known', content: 'CORRECTED' },
      { entityId, topic: 'history-old', accessLevel: 'known', content: 'OUTDATED' },
    ])
    const rows = await pool.query<{ id: string; content: string }>(
      `SELECT id, content FROM facts WHERE entity_id = $1`,
      [entityId],
    )
    const live = rows.rows.find((r) => r.content === 'CORRECTED')
    const stale = rows.rows.find((r) => r.content === 'OUTDATED')
    if (live === undefined || stale === undefined) throw new Error('expected both facts seeded')
    liveFactId = live.id
    supersededFactId = stale.id

    await repo.facts.updateEmbedding(liveFactId, VEC_LITERAL)
    await repo.facts.updateEmbedding(supersededFactId, VEC_LITERAL)

    // Point the stale fact's superseded_by at the live one (raw SQL seed —
    // independent of T5). This is what every read path under test must filter on.
    await pool.query(`UPDATE facts SET superseded_by = $1 WHERE id = $2`, [
      liveFactId,
      supersededFactId,
    ])
  })

  it('searchFacts excludes the superseded fact', async () => {
    // The pgvector read runs under iterative_scan='relaxed_order' (the
    // orchestration layer's job), mirroring world-retrieval.test.ts.
    const hits = await inScanTx(pool, (c) =>
      worldRetrievalNs(c).searchFacts(worldId, VEC_LITERAL, 10),
    )
    const ids = hits.map((h) => h.fact_id)
    expect(ids).toContain(liveFactId)
    expect(ids).not.toContain(supersededFactId)
  })

  it('listFactsToEmbed(false) excludes the superseded fact', async () => {
    // Re-null both embeddings so the incremental (embedding IS NULL) arm returns
    // them — exercises the supersede filter on the backfill path.
    await pool.query(`UPDATE facts SET embedding = NULL, embedded_at = NULL WHERE entity_id = $1`, [
      entityId,
    ])
    const rows = await repo.worldRetrieval.listFactsToEmbed(worldId, false)
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(liveFactId)
    expect(ids).not.toContain(supersededFactId)
  })

  it('listFactsToEmbed(force) excludes the superseded fact', async () => {
    const rows = await repo.worldRetrieval.listFactsToEmbed(worldId, true)
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(liveFactId)
    expect(ids).not.toContain(supersededFactId)
  })

  it('worldInventory.load excludes the superseded fact from its facts collection', async () => {
    const inventory = await repo.worldInventory.load(worldId)
    expect(inventory.factsById.has(liveFactId)).toBe(true)
    expect(inventory.factsById.has(supersededFactId)).toBe(false)
  })
})
