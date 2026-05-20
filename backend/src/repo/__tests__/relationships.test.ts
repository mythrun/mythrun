import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { relationships } from '../relationships.js'
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
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'A controls B.' },
    ])
    const rows = await pool.query<{ relationship_type: string; description: string }>(
      `SELECT relationship_type, description FROM relationships WHERE source_entity_id = $1`,
      [entA],
    )
    expect(rows.rows[0]).toEqual({ relationship_type: 'controls', description: 'A controls B.' })
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
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'X' },
    ])
    const rows = await relationships.listByWorld(pool, worldId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.relationshipType).toBe('controls')
  })

  it('deleteByWorld removes all relationships whose source entity is in the world', async () => {
    await relationships.insertMany(pool, [
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'X' },
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
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'old' },
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
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'old' },
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
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'unchanged' },
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
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'x' },
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
        { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'A→B' },
        { sourceEntityId: entA, targetEntityId: entC, relationshipType: 'borders', description: 'A→C' },
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
        { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'A→B' },
        { sourceEntityId: entA, targetEntityId: entC, relationshipType: 'borders', description: 'A→C' },
      ])

      const rows = await relationships.listAmong(pool, [entA, entB, entC])
      expect(rows).toHaveLength(2)
    })

    it('returns [] for an empty entity id list (no round-trip)', async () => {
      await relationships.insertMany(pool, [
        { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'A→B' },
      ])
      const rows = await relationships.listAmong(pool, [])
      expect(rows).toEqual([])
    })
  })
})
