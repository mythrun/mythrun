import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '../applyMigrations.ts'

const databaseUrl = process.env.WIKI_DATABASE_URL ?? process.env.DATABASE_URL

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = resolve(here, '../../../../backend/migrations')

// This file and schemaExtractor.test.ts both apply the backend migrations to the
// SAME database (WIKI_DATABASE_URL/DATABASE_URL). Migration 001 runs
// `CREATE EXTENSION IF NOT EXISTS pgcrypto`, which writes the database-global
// `pg_extension` catalog — not the per-test schema. Two of those running
// concurrently race ("duplicate key value violates pg_extension_name_index"),
// which fires on a FRESH database (CI's Postgres service) but not a warm one
// (local mythrun_dev already has pgcrypto, so the statement no-ops). The wiki
// `test` script runs with `--no-file-parallelism` (package.json) so these two
// integration files never execute concurrently. If you re-enable file
// parallelism, give each DB-applying file its own database first.
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
    // Drops an isolated, test-owned schema — not the shared public/default
    // schema the lint rule guards against. The bootstrap convention in
    // backend/src/__tests__/CONVENTIONS.md targets shared-state DROPs, not
    // dedicated test-schema lifecycles like this one.
    // eslint-disable-next-line no-restricted-syntax
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
