import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '../applyMigrations.ts'

const databaseUrl = process.env.WIKI_DATABASE_URL ?? process.env.DATABASE_URL

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = resolve(here, '../../../../backend/migrations')

describe.skipIf(databaseUrl === undefined)('applyMigrations (integration)', () => {
  let pool: Pool

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('DROP SCHEMA IF EXISTS wiki_test CASCADE')
    await pool.query('CREATE SCHEMA wiki_test')
    await pool.query('SET search_path TO wiki_test, public')
  })

  it('applies every migration and yields a populated schema', async () => {
    await applyMigrations(pool, migrationsDir)

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
    )
    expect(tables.rows.length).toBeGreaterThanOrEqual(35)
  })

  it('throws when a migration file references a missing table', async () => {
    await expect(applyMigrations(pool, '/nonexistent')).rejects.toThrow()
  })
})
