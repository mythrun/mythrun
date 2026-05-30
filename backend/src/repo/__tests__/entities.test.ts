import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { createRepo, type Repo } from '../index.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('entities repo', () => {
  let pool: Pool
  let repo: Repo
  let userId: string
  let worldId: string
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    scope = makeTestScope('entities')
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
    userId = uuidv7()
    worldId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
  })

  it('insert writes a row', async () => {
    const id = uuidv7()
    await entities.insert(pool, {
      id,
      worldId,
      entityType: 'location',
      name: 'Eredil',
      accessLevel: 'known',
      createdIn: 'stage:test',
    })

    const row = await pool.query<{ entity_type: string; name: string }>(
      `SELECT entity_type, name FROM entities WHERE id = $1`,
      [id],
    )
    expect(row.rows[0]).toEqual({ entity_type: 'location', name: 'Eredil' })
  })

  it('findByWorldAndName returns null when no match', async () => {
    const found = await entities.findByWorldAndName(pool, worldId, 'Nowhere')
    expect(found).toBeNull()
  })

  it('findByWorldAndName returns the entity when name matches', async () => {
    const id = uuidv7()
    await entities.insert(pool, {
      id,
      worldId,
      entityType: 'faction',
      name: 'House Eyrin',
      accessLevel: 'known',
      createdIn: 'stage:test',
    })
    const found = await entities.findByWorldAndName(pool, worldId, 'House Eyrin')
    expect(found?.id).toBe(id)
  })

  it('listByWorld returns all entities for the world', async () => {
    await entities.insert(pool, {
      id: uuidv7(),
      worldId,
      entityType: 'location',
      name: 'A',
      accessLevel: 'known',
      createdIn: 'stage:test',
    })
    await entities.insert(pool, {
      id: uuidv7(),
      worldId,
      entityType: 'faction',
      name: 'B',
      accessLevel: 'known',
      createdIn: 'stage:test',
    })
    const rows = await entities.listByWorld(pool, worldId)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.name).sort()).toEqual(['A', 'B'])
  })

  // myth-exac T05: access_level threading + listByWorld filter.
  it('insert writes access_level to the new column', async () => {
    const entityId = uuidv7()
    await entities.insert(pool, {
      id: entityId,
      worldId,
      entityType: 'location',
      name: `${scope.id}-loc`,
      accessLevel: 'discoverable',
      createdIn: 'stage:test',
    })
    const { rows } = await pool.query<{ access_level: string }>(
      `SELECT access_level FROM entities WHERE id = $1`,
      [entityId],
    )
    expect(rows[0]?.access_level).toBe('discoverable')
  })

  it('listByWorld filters by accessLevels when provided', async () => {
    for (const tier of ['known', 'discoverable', 'secret'] as const) {
      await entities.insert(pool, {
        id: uuidv7(),
        worldId,
        entityType: 'location',
        name: `${scope.id}-${tier}`,
        accessLevel: tier,
        createdIn: 'stage:test',
      })
    }
    const known = await entities.listByWorld(pool, worldId, { accessLevels: ['known'] })
    expect(known).toHaveLength(1)
    expect(known[0]?.accessLevel).toBe('known')

    const all = await entities.listByWorld(pool, worldId, {
      accessLevels: ['known', 'discoverable', 'secret'],
    })
    expect(all).toHaveLength(3)
  })

  it('writes created_in when provided', async () => {
    const id = uuidv7()
    await entities.insert(pool, {
      id,
      worldId,
      entityType: 'faction',
      name: 'Test Faction',
      accessLevel: 'known',
      createdIn: 'stage:test',
    })
    const row = await pool.query<{ created_in: string }>(
      `SELECT created_in FROM entities WHERE id = $1`,
      [id],
    )
    expect(row.rows[0]?.created_in).toBe('stage:test')
  })

  // Stage-6 starting-situation name-resolution read. Returns location entities
  // (id + name only), excluding non-location types.
  it('listLocationsByWorld returns only location entities (id + name)', async () => {
    const locId = uuidv7()
    await entities.insert(pool, {
      id: locId, worldId, entityType: 'location', name: 'The Drowned Quarter', accessLevel: 'known', createdIn: 'stage:test',
    })
    // Non-location entities must be excluded.
    await entities.insert(pool, {
      id: uuidv7(), worldId, entityType: 'npc', name: 'Mother Ehren', accessLevel: 'known', createdIn: 'stage:test',
    })
    await entities.insert(pool, {
      id: uuidv7(), worldId, entityType: 'faction', name: 'Salt Guild', accessLevel: 'known', createdIn: 'stage:test',
    })

    const locations = await repo.entities.listLocationsByWorld(worldId)
    expect(locations).toEqual([{ id: locId, name: 'The Drowned Quarter' }])
  })

  // Stage-4 / stage-4b idempotency wipe: delete every entity a given stage
  // created for a world, scoped by both world_id and created_in.
  it('deleteByWorldAndCreatedIn removes only rows matching world + created_in', async () => {
    const consolId = uuidv7()
    const otherStageId = uuidv7()
    await entities.insert(pool, {
      id: consolId, worldId, entityType: 'npc', name: 'Ghost A', accessLevel: 'known', createdIn: 'stage:entity_consolidation',
    })
    await entities.insert(pool, {
      id: otherStageId, worldId, entityType: 'npc', name: 'Keep B', accessLevel: 'known', createdIn: 'stage:locations_and_npcs',
    })

    await repo.entities.deleteByWorldAndCreatedIn(worldId, 'stage:entity_consolidation')

    const remaining = await pool.query<{ id: string }>(
      `SELECT id FROM entities WHERE world_id = $1 ORDER BY id`,
      [worldId],
    )
    expect(remaining.rows.map((r) => r.id)).toEqual([otherStageId].sort())
    // The consolidation-stage entity is gone; the other-stage entity remains.
    expect(remaining.rows.some((r) => r.id === consolId)).toBe(false)
  })
})
