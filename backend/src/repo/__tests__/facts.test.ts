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
import { facts } from '../facts.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: (): void => undefined }
  return pino({ base: { component: 'migrate' } }, sink)
}

describe('facts repo', () => {
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
    scope = makeTestScope('facts')
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
    await entities.insert(pool, { id: entityId, worldId, entityType: 'location', name: 'X' })
  })

  it('insertMany stamps narrative_status=undelivered and source=prep on every row', async () => {
    await facts.insertMany(pool, [
      { entityId, topic: 'history', accessLevel: 'public', content: 'Founded long ago.' },
      { entityId, topic: 'secrets', accessLevel: 'secret', content: 'Hidden vault below.' },
    ])
    const rows = await pool.query<{
      topic: string; access_level: string; content: string; narrative_status: string; source: string
    }>(
      `SELECT topic, access_level, content, narrative_status, source FROM facts WHERE entity_id = $1 ORDER BY topic`,
      [entityId],
    )
    expect(rows.rows).toEqual([
      { topic: 'history', access_level: 'public', content: 'Founded long ago.', narrative_status: 'undelivered', source: 'prep' },
      { topic: 'secrets', access_level: 'secret', content: 'Hidden vault below.', narrative_status: 'undelivered', source: 'prep' },
    ])
  })

  it('insertMany with empty array is a no-op', async () => {
    await facts.insertMany(pool, [])
    const count = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM facts`)
    expect(count.rows[0]?.count).toBe('0')
  })

  it('updateContentById updates a single fact row', async () => {
    await facts.insertMany(pool, [
      { entityId, topic: 'history', accessLevel: 'public', content: 'wrong' },
    ])
    const row = await pool.query<{ id: string }>(`SELECT id FROM facts WHERE entity_id = $1`, [entityId])
    const factId = row.rows[0]?.id
    if (factId === undefined) throw new Error('expected fact row to exist')
    await facts.updateContentById(pool, factId, { content: 'corrected' })
    const updated = await pool.query<{ content: string }>(
      `SELECT content FROM facts WHERE id = $1`, [factId],
    )
    expect(updated.rows[0]?.content).toBe('corrected')
  })
})
