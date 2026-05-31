import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { relationships, relationshipsNs } from '../relationships.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('relationships repo', () => {
  let pool: Pool
  let worldId: string
  let entA: string
  let entB: string
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('relationships')
  })
  afterAll(async () => {
    // myth-5jdo: cleanup only this scope's rows; the seeded dev users
    // + system user + demo world remain intact for the next test file.
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    // myth-5jdo: scoped cleanup replaces the prior blanket DELETEs. We
    // remove only THIS scope's rows from the prior iteration, so the
    // seeded dev users + system user keep existing across tests.
    await cleanupTestScope(pool, scope)
    const userId = uuidv7()
    worldId = uuidv7()
    entA = uuidv7()
    entB = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
    await entities.insert(pool, { id: entA, worldId, entityType: 'faction', name: 'A', accessLevel: 'known', createdIn: 'stage:test' })
    await entities.insert(pool, { id: entB, worldId, entityType: 'location', name: 'B', accessLevel: 'known', createdIn: 'stage:test' })
  })

  it('insertMany writes relationship rows', async () => {
    await relationships.insertMany(pool, [
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'A controls B.', synthKey: 'test/rel/0' },
    ])
    const rows = await pool.query<{ relationship_type: string; description: string }>(
      `SELECT relationship_type, description FROM relationships WHERE source_entity_id = $1`,
      [entA],
    )
    expect(rows.rows[0]).toEqual({ relationship_type: 'controls', description: 'A controls B.' })
  })

  // data-layer unification: caller-supplied-id single insert (coherence
  // fix_relationship / add_relationship mint newId + synth_key together).
  it('insertOne inserts a single relationship with a caller-supplied id + synthKey', async () => {
    const relId = uuidv7()
    await relationshipsNs(pool).insertOne({
      id: relId, sourceEntityId: entA, targetEntityId: entB,
      relationshipType: 'home_of', description: 'A is home of B.', synthKey: 'coherence_pass/edges/x',
    })
    const row = await pool.query<{ id: string; relationship_type: string; synth_key: string }>(
      `SELECT id, relationship_type, synth_key FROM relationships WHERE id = $1`, [relId],
    )
    expect(row.rows[0]).toEqual({ id: relId, relationship_type: 'home_of', synth_key: 'coherence_pass/edges/x' })
  })

  // myth-gp2c Cluster C: character-integration edge insert — minted id, NO
  // synth_key column (stays NULL, distinct from insertOne/insertMany).
  it('insertIntegrationEdge inserts an edge with a minted id and NULL synth_key', async () => {
    await relationshipsNs(pool).insertIntegrationEdge({
      sourceEntityId: entA,
      targetEntityId: entB,
      relationshipType: 'sibling_of',
      description: 'A and B are siblings.',
    })
    const row = await pool.query<{
      relationship_type: string; description: string; synth_key: string | null
    }>(
      `SELECT relationship_type, description, synth_key FROM relationships WHERE source_entity_id = $1`,
      [entA],
    )
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0]).toEqual({
      relationship_type: 'sibling_of',
      description: 'A and B are siblings.',
      synth_key: null,
    })
  })

  it('insertMany with empty array is a no-op', async () => {
    await relationships.insertMany(pool, [])
    // Scope to entities created in this test's beforeEach. Unscoped
    // SELECT count(*) collides with parallel-running tests in other
    // worlds (myth-oehx parallel-execution discipline).
    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM relationships WHERE source_entity_id = $1`,
      [entA],
    )
    expect(count.rows[0]?.count).toBe('0')
  })

  it('listByWorld returns rows joined via source entity', async () => {
    await relationships.insertMany(pool, [
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'X', synthKey: 'test/rel/0' },
    ])
    const rows = await relationships.listByWorld(pool, worldId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.relationshipType).toBe('controls')
  })

  it('deleteByWorld removes all relationships whose source entity is in the world', async () => {
    await relationships.insertMany(pool, [
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'X', synthKey: 'test/rel/0' },
    ])
    await relationships.deleteByWorld(pool, worldId)
    // Scope to the test's source entities — parallel siblings may have
    // their own relationships in flight.
    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM relationships WHERE source_entity_id = $1`,
      [entA],
    )
    expect(count.rows[0]?.count).toBe('0')
  })

  it('updateById updates the type + description', async () => {
    await relationships.insertMany(pool, [
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'old', synthKey: 'test/rel/0' },
    ])
    const row = await pool.query<{ id: string }>(
      `SELECT id FROM relationships WHERE source_entity_id = $1`,
      [entA],
    )
    expect(row.rows[0]).toBeDefined()
    const id = row.rows[0]?.id ?? ''
    await relationships.updateById(pool, id, { relationshipType: 'rules', description: 'new' })
    const after = await pool.query<{ relationship_type: string; description: string }>(
      `SELECT relationship_type, description FROM relationships WHERE id = $1`, [id],
    )
    expect(after.rows[0]).toEqual({ relationship_type: 'rules', description: 'new' })
  })

  it('updateById applies a single-field patch (description only)', async () => {
    // Covers the relationshipType-undefined branch of the conditional
    // set-builder. The both-fields case is covered by the test above.
    await relationships.insertMany(pool, [
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'old', synthKey: 'test/rel/0' },
    ])
    const row = await pool.query<{ id: string }>(
      `SELECT id FROM relationships WHERE source_entity_id = $1`,
      [entA],
    )
    expect(row.rows[0]).toBeDefined()
    const id = row.rows[0]?.id ?? ''
    const affected = await relationships.updateById(pool, id, { description: 'new' })
    expect(affected).toBe(1)
    const after = await pool.query<{ relationship_type: string; description: string }>(
      `SELECT relationship_type, description FROM relationships WHERE id = $1`, [id],
    )
    // Type is unchanged; description rewritten.
    expect(after.rows[0]).toEqual({ relationship_type: 'controls', description: 'new' })
  })

  it('updateById is a no-op when the patch is empty (returns 0)', async () => {
    // Covers the sets.length === 0 early-return path.
    await relationships.insertMany(pool, [
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'unchanged', synthKey: 'test/rel/0' },
    ])
    const row = await pool.query<{ id: string }>(
      `SELECT id FROM relationships WHERE source_entity_id = $1`,
      [entA],
    )
    const id = row.rows[0]?.id ?? ''
    const affected = await relationships.updateById(pool, id, {})
    expect(affected).toBe(0)
  })

  it('deleteById removes a single row', async () => {
    await relationships.insertMany(pool, [
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'x', synthKey: 'test/rel/0' },
    ])
    const row = await pool.query<{ id: string }>(
      `SELECT id FROM relationships WHERE source_entity_id = $1`,
      [entA],
    )
    expect(row.rows[0]).toBeDefined()
    await relationships.deleteById(pool, row.rows[0]?.id ?? '')
    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM relationships WHERE source_entity_id = $1`,
      [entA],
    )
    expect(count.rows[0]?.count).toBe('0')
  })

  describe('listAmong', () => {
    // myth-exac T06: returns only relationships whose BOTH endpoints are
    // in the provided entityIds set. Snapshot-view consumer (T19) uses
    // this to scope relationships to a fact-filtered entity set.
    it('returns relationships where both endpoints are in the id set (subset)', async () => {
      // Seed a third entity so we can author a relationship that is
      // partially-in-set (entA→entC) and confirm it is excluded.
      const entC = uuidv7()
      await entities.insert(pool, {
        id: entC, worldId, entityType: 'location', name: 'C', accessLevel: 'known', createdIn: 'stage:test',
      })
      await relationships.insertMany(pool, [
        { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'A→B', synthKey: 'test/rel/0' },
        { sourceEntityId: entA, targetEntityId: entC, relationshipType: 'borders', description: 'A→C', synthKey: 'test/rel/1' },
      ])

      const rows = await relationships.listAmong(pool, [entA, entB])
      expect(rows).toHaveLength(1)
      expect(rows[0]?.sourceEntityId).toBe(entA)
      expect(rows[0]?.targetEntityId).toBe(entB)
      expect(rows[0]?.relationshipType).toBe('controls')
    })

    it('returns every relationship when the id set is a full superset', async () => {
      const entC = uuidv7()
      await entities.insert(pool, {
        id: entC, worldId, entityType: 'location', name: 'C', accessLevel: 'known', createdIn: 'stage:test',
      })
      await relationships.insertMany(pool, [
        { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'A→B', synthKey: 'test/rel/0' },
        { sourceEntityId: entA, targetEntityId: entC, relationshipType: 'borders', description: 'A→C', synthKey: 'test/rel/1' },
      ])

      const rows = await relationships.listAmong(pool, [entA, entB, entC])
      expect(rows).toHaveLength(2)
    })

    it('returns [] for an empty entity id list (no round-trip)', async () => {
      await relationships.insertMany(pool, [
        { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'A→B', synthKey: 'test/rel/0' },
      ])
      const rows = await relationships.listAmong(pool, [])
      expect(rows).toEqual([])
    })
  })
})

describe('relationships table — synth_key column', () => {
  // myth-p4sz / myth-imxg.1: persist a wire-format synth_key on relationships
  // rows so coherence_pass stage 7 can look up the existing row's identity
  // when emitting edge-removed SSE events. Migration 020 adds the column as
  // nullable TEXT and backfills existing rows with deterministic placeholders.
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
  })
  afterAll(async () => {
    await pool.end()
  })

  it('has a nullable text synth_key column', async () => {
    const { rows } = await pool.query<{ data_type: string; is_nullable: 'YES' | 'NO' }>(
      `SELECT data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'relationships' AND column_name = 'synth_key'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.data_type).toBe('text')
    expect(rows[0]?.is_nullable).toBe('YES')
  })
})

describe('relationships.insertMany — writes synth_key', () => {
  // myth-imxg.2: the repo layer carries synthKey end-to-end. insertMany
  // persists it on write; listByWorld + listAmong SELECT and return it so
  // stage 7 (coherence pass) can address the row on the wire by its synth_key.
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('relationships-synthkey')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  it('persists the supplied synthKey and listByWorld returns it', async () => {
    const userId = uuidv7()
    const worldId = uuidv7()
    const entA = uuidv7()
    const entB = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
    await entities.insert(pool, {
      id: entA, worldId, entityType: 'faction', name: 'A', accessLevel: 'known', createdIn: 'stage:test',
    })
    await entities.insert(pool, {
      id: entB, worldId, entityType: 'location', name: 'B', accessLevel: 'known', createdIn: 'stage:test',
    })

    const synthKey = 'entity_relationships/relationships/0'
    const [relId] = await relationships.insertMany(pool, [{
      sourceEntityId: entA,
      targetEntityId: entB,
      relationshipType: 'adjacent_to',
      description: 'Test edge.',
      synthKey,
    }])

    const rows = await relationships.listByWorld(pool, worldId)
    const row = rows.find((r) => r.id === relId)
    expect(row?.synthKey).toBe(synthKey)

    // listAmong is the snapshot-view read path; it should expose synthKey too.
    const amongRows = await relationships.listAmong(pool, [entA, entB])
    const amongRow = amongRows.find((r) => r.id === relId)
    expect(amongRow?.synthKey).toBe(synthKey)
  })
})
