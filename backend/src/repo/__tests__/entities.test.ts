import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: (): void => undefined }
  return pino({ base: { component: 'migrate' } }, sink)
}

describe('entities repo', () => {
  let pool: Pool
  let userId: string
  let worldId: string
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
    })
    await entities.insert(pool, {
      id: uuidv7(),
      worldId,
      entityType: 'faction',
      name: 'B',
      accessLevel: 'known',
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
})
