import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { entityHierarchy } from '../entity-hierarchy.js'

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

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })
  afterAll(async () => {
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query('DELETE FROM entity_hierarchy')
    await pool.query('DELETE FROM entities')
    await pool.query('DELETE FROM worlds')
    await pool.query("DELETE FROM users WHERE cognito_sub != 'system:mythrun'")
    const userId = uuidv7()
    const worldId = uuidv7()
    parentId = uuidv7()
    childId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, `bypass:h-${userId.slice(-6)}`, 'H', `h${userId.slice(-6)}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, 'W', 'C', 'generating')`,
      [worldId, userId],
    )
    await entities.insert(pool, { id: parentId, worldId, entityType: 'location', name: 'P' })
    await entities.insert(pool, { id: childId, worldId, entityType: 'location', name: 'C' })
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
    })
    await expect(
      entityHierarchy.insert(pool, { parentEntityId: otherParent, childEntityId: childId }),
    ).rejects.toThrow()
  })
})
