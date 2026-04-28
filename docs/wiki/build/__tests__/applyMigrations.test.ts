import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '../applyMigrations.ts'

const databaseUrl = process.env.WIKI_DATABASE_URL ?? process.env.DATABASE_URL

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = resolve(here, '../../../../backend/migrations')

describe.skipIf(databaseUrl === undefined)('applyMigrations (integration)', () => {
  let pool: Pool
  let client: PoolClient

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    client = await pool.connect()
    await client.query('DROP SCHEMA IF EXISTS wiki_test CASCADE')
    await client.query('CREATE SCHEMA wiki_test')
    await client.query('SET search_path TO wiki_test, public')
  })

  afterEach(() => {
    client.release()
  })

  it('applies every migration and yields a populated schema', async () => {
    await applyMigrations(client, migrationsDir)

    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
    )
    expect(tables.rows.length).toBeGreaterThanOrEqual(35)
  })

  it('throws when a migration file references a missing table', async () => {
    await expect(applyMigrations(client, '/nonexistent')).rejects.toThrow()
  })
})
