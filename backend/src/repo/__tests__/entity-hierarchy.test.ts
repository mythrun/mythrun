import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { entityHierarchy, entityHierarchyNs } from '../entity-hierarchy.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('entityHierarchy repo', () => {
  let pool: Pool
  let parentId: string
  let childId: string
  let worldId: string
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('entity-hierarchy')
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
    parentId = uuidv7()
    childId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
    await entities.insert(pool, { id: parentId, worldId, entityType: 'location', name: 'P', accessLevel: 'known', createdIn: 'stage:test' })
    await entities.insert(pool, { id: childId, worldId, entityType: 'location', name: 'C', accessLevel: 'known', createdIn: 'stage:test' })
  })

  it('insert writes a hierarchy row', async () => {
    await entityHierarchy.insert(pool, { parentEntityId: parentId, childEntityId: childId })
    const row = await pool.query<{ parent_entity_id: string; child_entity_id: string }>(
      `SELECT parent_entity_id, child_entity_id FROM entity_hierarchy WHERE child_entity_id = $1`,
      [childId],
    )
    expect(row.rows[0]).toEqual({ parent_entity_id: parentId, child_entity_id: childId })
  })

  it('insert errors on UNIQUE(child_entity_id) conflict', async () => {
    await entityHierarchy.insert(pool, { parentEntityId: parentId, childEntityId: childId })
    const otherParent = uuidv7()
    const worldLookup = await pool.query<{ world_id: string }>(
      `SELECT world_id FROM entities WHERE id = $1`,
      [parentId],
    )
    const worldRow = worldLookup.rows[0]
    if (!worldRow) throw new Error('parent entity world_id lookup failed')
    await entities.insert(pool, {
      id: otherParent,
      worldId: worldRow.world_id,
      entityType: 'location',
      name: 'Other',
      accessLevel: 'known',
      createdIn: 'stage:test',
    })
    await expect(
      entityHierarchy.insert(pool, { parentEntityId: otherParent, childEntityId: childId }),
    ).rejects.toThrow()
  })

  describe('listForWorld', () => {
    // myth-exac T06: returns hierarchy rows scoped to the given world
    // via JOIN to entities (entity_hierarchy has no world_id column).
    // Snapshot-view (T19) uses this to scope parent→child edges to one
    // world without leaking rows authored under a sibling world.
    it('returns rows whose parent entity belongs to the world', async () => {
      // Stage two worlds with one hierarchy row in each so the JOIN
      // filter is doing real work (not "happens to be the only row").
      const worldLookup = await pool.query<{ world_id: string }>(
        `SELECT world_id FROM entities WHERE id = $1`,
        [parentId],
      )
      const ownWorldRow = worldLookup.rows[0]
      if (!ownWorldRow) throw new Error('parent entity world_id lookup failed')
      const ownWorldId = ownWorldRow.world_id

      // Insert the in-scope hierarchy row.
      await entityHierarchy.insert(pool, { parentEntityId: parentId, childEntityId: childId })

      // Now build a sibling world with its own parent/child entities + row.
      const otherUserId = uuidv7()
      const otherWorldId = uuidv7()
      const otherParentId = uuidv7()
      const otherChildId = uuidv7()
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [otherUserId, scope.userSub(1), scope.displayName(1), scope.username(1)],
      )
      await pool.query(
        `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
        [otherWorldId, otherUserId, scope.worldName(1)],
      )
      await entities.insert(pool, {
        id: otherParentId, worldId: otherWorldId, entityType: 'location', name: 'OP', accessLevel: 'known', createdIn: 'stage:test',
      })
      await entities.insert(pool, {
        id: otherChildId, worldId: otherWorldId, entityType: 'location', name: 'OC', accessLevel: 'known', createdIn: 'stage:test',
      })
      await entityHierarchy.insert(pool, {
        parentEntityId: otherParentId, childEntityId: otherChildId,
      })

      const rows = await entityHierarchy.listForWorld(pool, ownWorldId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.parentEntityId).toBe(parentId)
      expect(rows[0]?.childEntityId).toBe(childId)
    })

    it('returns [] when the world has no hierarchy rows', async () => {
      const worldLookup = await pool.query<{ world_id: string }>(
        `SELECT world_id FROM entities WHERE id = $1`,
        [parentId],
      )
      const ownWorldRow = worldLookup.rows[0]
      if (!ownWorldRow) throw new Error('parent entity world_id lookup failed')
      const rows = await entityHierarchy.listForWorld(pool, ownWorldRow.world_id)
      expect(rows).toEqual([])
    })
  })

  describe('listExistingChildIds', () => {
    // Stage-4 straggler pre-filter (design §D9 "stage 3 wins"): returns the
    // subset of supplied childIds that already have a hierarchy row AND whose
    // child belongs to the given world. The beforeEach already seeds parentId
    // + childId entities in `worldId`.
    it('returns child ids that already have a hierarchy row in the world', async () => {
      // childId already gets a hierarchy row; a second world-local child does not.
      await entityHierarchy.insert(pool, { parentEntityId: parentId, childEntityId: childId })
      const unlinkedChild = uuidv7()
      await entities.insert(pool, {
        id: unlinkedChild, worldId, entityType: 'location', name: 'Unlinked', accessLevel: 'known', createdIn: 'stage:test',
      })

      const existing = await entityHierarchyNs(pool).listExistingChildIds(
        [childId, unlinkedChild],
        worldId,
      )
      expect(existing).toEqual([childId])
    })

    it('excludes a linked child that belongs to a different world', async () => {
      // childId has a hierarchy row in `worldId`. Query it against a SIBLING
      // world id → the world-scope sub-select drops it.
      await entityHierarchy.insert(pool, { parentEntityId: parentId, childEntityId: childId })

      const otherUserId = uuidv7()
      const otherWorldId = uuidv7()
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [otherUserId, scope.userSub(1), scope.displayName(1), scope.username(1)],
      )
      await pool.query(
        `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
        [otherWorldId, otherUserId, scope.worldName(1)],
      )

      const existing = await entityHierarchyNs(pool).listExistingChildIds([childId], otherWorldId)
      expect(existing).toEqual([])
    })

    it('returns [] when no supplied child has a hierarchy row', async () => {
      const existing = await entityHierarchyNs(pool).listExistingChildIds([childId], worldId)
      expect(existing).toEqual([])
    })
  })
})
