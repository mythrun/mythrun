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

  // ── data-layer unification: coherence rename + world-gen input loaders ────

  // myth-gp2c Cluster C: PC-entity insert for character-integration. Bakes
  // in the entity_type='pc' + access_level='known' literals.
  it('insertPc writes a pc entity with type pc + access_level known', async () => {
    const id = uuidv7()
    await repo.entities.insertPc({ id, worldId, name: 'Ada the Cleric' })
    const row = await pool.query<{ entity_type: string; name: string; access_level: string }>(
      `SELECT entity_type, name, access_level FROM entities WHERE id = $1`,
      [id],
    )
    expect(row.rows[0]).toEqual({
      entity_type: 'pc',
      name: 'Ada the Cleric',
      access_level: 'known',
    })
  })

  it('updateName renames an entity (coherence-pass apply-patch)', async () => {
    const id = uuidv7()
    await entities.insert(pool, {
      id, worldId, entityType: 'npc', name: 'Mara', accessLevel: 'known', createdIn: 'stage:test',
    })
    await repo.entities.updateName({ id, name: 'Mara Salt-Hand' })
    const row = await pool.query<{ name: string }>(`SELECT name FROM entities WHERE id = $1`, [id])
    expect(row.rows[0]?.name).toBe('Mara Salt-Hand')
  })

  it('listProseByTypeForStartingSituation returns location/npc/faction rows with prose, ordered', async () => {
    const locId = uuidv7()
    const npcId = uuidv7()
    const facId = uuidv7()
    const itemId = uuidv7()
    await entities.insert(pool, { id: locId, worldId, entityType: 'location', name: 'Wharf', accessLevel: 'known', createdIn: 'stage:test' })
    await entities.insert(pool, { id: npcId, worldId, entityType: 'npc', name: 'Mara', accessLevel: 'known', createdIn: 'stage:test' })
    await entities.insert(pool, { id: facId, worldId, entityType: 'faction', name: 'Salt Guild', accessLevel: 'known', createdIn: 'stage:test' })
    // Items must be EXCLUDED by the entity_type filter.
    await entities.insert(pool, { id: itemId, worldId, entityType: 'item', name: 'Lantern', accessLevel: 'known', createdIn: 'stage:test' })
    await pool.query(`INSERT INTO prose_kernels (id, entity_id, content) VALUES ($1, $2, 'A salt-eaten wharf.')`, [uuidv7(), locId])
    // npcId deliberately has NO prose kernel → prose null (LEFT JOIN).

    const rows = await repo.entities.listProseByTypeForStartingSituation(worldId)
    const byType = new Map(rows.map((r) => [r.entity_type, r]))
    expect(rows).toHaveLength(3) // item excluded
    expect(byType.get('location')?.prose).toBe('A salt-eaten wharf.')
    expect(byType.get('npc')?.prose).toBeNull()
    expect(byType.get('faction')?.name).toBe('Salt Guild')
  })

  it('listProseByTypeForStage3 returns only location + faction rows with prose', async () => {
    const locId = uuidv7()
    const facId = uuidv7()
    await entities.insert(pool, { id: locId, worldId, entityType: 'location', name: 'Wharf', accessLevel: 'known', createdIn: 'stage:test' })
    await entities.insert(pool, { id: facId, worldId, entityType: 'faction', name: 'Salt Guild', accessLevel: 'known', createdIn: 'stage:test' })
    // npc must be EXCLUDED (stage 3 only reads location + faction).
    await entities.insert(pool, { id: uuidv7(), worldId, entityType: 'npc', name: 'Mara', accessLevel: 'known', createdIn: 'stage:test' })
    await pool.query(`INSERT INTO prose_kernels (id, entity_id, content) VALUES ($1, $2, 'A salt-eaten wharf.')`, [uuidv7(), locId])

    const rows = await repo.entities.listProseByTypeForStage3(worldId)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.entity_type).sort()).toEqual(['faction', 'location'])
    expect(rows.find((r) => r.entity_type === 'location')?.prose).toBe('A salt-eaten wharf.')
  })

  // MYT-71 T6: updateEmbedding sets the pgvector embedding + embedded_at.
  it('updateEmbedding sets embedding + stamps embedded_at', async () => {
    const id = uuidv7()
    await entities.insert(pool, {
      id, worldId, entityType: 'npc', name: 'Mara', accessLevel: 'known', createdIn: 'stage:test',
    })
    const lit = `[${['1', ...new Array<string>(511).fill('0')].join(',')}]`
    const affected = await repo.entities.updateEmbedding(id, lit)
    expect(affected).toBe(1)
    const row = await pool.query<{ embedding: string | null; embedded_at: Date | null }>(
      `SELECT embedding, embedded_at FROM entities WHERE id = $1`,
      [id],
    )
    expect(row.rows[0]?.embedding).not.toBeNull()
    expect(row.rows[0]?.embedded_at).not.toBeNull()
  })

  it('updateEmbedding returns 0 for an unknown id', async () => {
    const lit = `[${['1', ...new Array<string>(511).fill('0')].join(',')}]`
    const affected = await repo.entities.updateEmbedding(
      '019dccef-0000-7000-8000-000000000099',
      lit,
    )
    expect(affected).toBe(0)
  })

  // data-layer unification: the location-selection drift-defense check
  // absorbed from the inline read in location-selection.ts.
  it('existsInWorld true for a seeded entity, false for a ghost id or wrong world', async () => {
    const id = uuidv7()
    await entities.insert(pool, {
      id,
      worldId,
      entityType: 'location',
      name: 'Wharf',
      accessLevel: 'known',
      createdIn: 'stage:test',
    })
    expect(await repo.entities.existsInWorld(id, worldId)).toBe(true)
    // Ghost id.
    expect(
      await repo.entities.existsInWorld('019dccef-0000-7000-8000-000000000000', worldId),
    ).toBe(false)
    // Right id, wrong world.
    expect(
      await repo.entities.existsInWorld(id, '019dccef-0000-7000-8000-000000000001'),
    ).toBe(false)
  })
})
