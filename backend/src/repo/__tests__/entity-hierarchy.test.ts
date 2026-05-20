import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { entityHierarchy } from '../entity-hierarchy.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: (): void => undefined }
  return pino({ base: { component: 'migrate' } }, sink)
}

describe('entityHierarchy repo', () => {
  let pool: Pool
  let parentId: string
  let childId: string
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
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
    const worldId = uuidv7()
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
    await entities.insert(pool, { id: parentId, worldId, entityType: 'location', name: 'P', accessLevel: 'known' })
    await entities.insert(pool, { id: childId, worldId, entityType: 'location', name: 'C', accessLevel: 'known' })
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
        id: otherParentId, worldId: otherWorldId, entityType: 'location', name: 'OP', accessLevel: 'known',
      })
      await entities.insert(pool, {
        id: otherChildId, worldId: otherWorldId, entityType: 'location', name: 'OC', accessLevel: 'known',
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
})
