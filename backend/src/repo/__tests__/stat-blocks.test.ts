import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { statBlocks } from '../stat-blocks.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: (): void => undefined }
  return pino({ base: { component: 'migrate' } }, sink)
}

describe('statBlocks.listByIds (myth-exac)', () => {
  let pool: Pool

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

  it('returns stat blocks for the given IDs', async () => {
    const id1 = uuidv7()
    const id2 = uuidv7()
    const id3 = uuidv7()
    for (const id of [id1, id2, id3]) {
      await pool.query(
        `INSERT INTO stat_blocks (id, name, armor_class, hit_points, speed, str, dex, con, int, wis, cha)
         VALUES ($1, $2, 12, 10, '30ft', 10, 10, 10, 10, 10, 10)`,
        [id, `test-sb-${id.slice(0, 6)}`],
      )
    }

    const rows = await statBlocks.listByIds(pool, [id1, id2])
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.id).sort()).toEqual([id1, id2].sort())

    // Cleanup the seeded rows directly — stat_blocks has no world_id,
    // so the shared test-scope cleanup helper doesn't apply.
    await pool.query(`DELETE FROM stat_blocks WHERE id = ANY($1)`, [[id1, id2, id3]])
  })

  it('returns [] for empty ids list', async () => {
    const rows = await statBlocks.listByIds(pool, [])
    expect(rows).toEqual([])
  })
})
