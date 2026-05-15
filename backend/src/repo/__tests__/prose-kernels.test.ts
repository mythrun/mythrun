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
import { proseKernels } from '../prose-kernels.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: (): void => undefined }
  return pino({ base: { component: 'migrate' } }, sink)
}

describe('proseKernels repo', () => {
  let pool: Pool
  let entityId: string
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
    scope = makeTestScope('prose-kernels')
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
      id: entityId, worldId, entityType: 'location', name: 'X',
    })
  })

  it('insert writes a prose_kernel row for the entity', async () => {
    await proseKernels.insert(pool, { entityId, content: 'A forested region.' })
    const row = await pool.query<{ content: string }>(
      `SELECT content FROM prose_kernels WHERE entity_id = $1`, [entityId],
    )
    expect(row.rows[0]?.content).toBe('A forested region.')
  })

  it('insert errors when entity_id already has a prose_kernel (UNIQUE violation)', async () => {
    await proseKernels.insert(pool, { entityId, content: 'first' })
    await expect(
      proseKernels.insert(pool, { entityId, content: 'second' }),
    ).rejects.toThrow()
  })

  it('updateByEntityId replaces the existing content', async () => {
    await proseKernels.insert(pool, { entityId, content: 'original' })
    await proseKernels.updateByEntityId(pool, entityId, { content: 'revised' })
    const row = await pool.query<{ content: string }>(
      `SELECT content FROM prose_kernels WHERE entity_id = $1`, [entityId],
    )
    expect(row.rows[0]?.content).toBe('revised')
  })

  it('updateByEntityId is a no-op when no row exists (zero affected rows)', async () => {
    const affected = await proseKernels.updateByEntityId(pool, entityId, { content: 'x' })
    expect(affected).toBe(0)
  })
})
