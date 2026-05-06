import type { PoolClient } from 'pg'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { createPgPool } from '../../../db/postgres.js'
import { runMigrations } from '../../../db/migrate.js'
import { guardTestDatabase } from '../../../db/__tests__/guard-db.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: (): void => {
      // discard log output
    },
  }
  return pino({ base: { component: 'migrate' } }, sink)
}

/**
 * Module-level pool shared across all withTx calls in a test file.
 * `max: 1` keeps every test on the same physical connection so SET LOCAL
 * semantics are deterministic. Vitest's `fileParallelism: false` keeps
 * separate test files from racing on schema bootstrap.
 */
export const pool = createPgPool(databaseUrl, { max: 1 })

/** True once schema has been built; idempotency guard for ensureSchema(). */
let poolReady = false

export async function ensureSchema(): Promise<void> {
  if (poolReady) return
  await guardTestDatabase(databaseUrl)
  await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
  await pool.query('DROP SCHEMA public CASCADE')
  await pool.query('CREATE SCHEMA public')
  await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
  await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
  await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  poolReady = true
}

/**
 * Run `fn` inside a Postgres transaction that is ALWAYS rolled back when the
 * callback resolves or rejects. Tests get a clean slate without truncation.
 *
 * The `tx` argument is a `pg.PoolClient` on which BEGIN has already been
 * issued. It satisfies `ClientLike` (has a `.query` method).
 */
export async function withTx(fn: (tx: PoolClient) => Promise<void>): Promise<void> {
  await ensureSchema()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    try {
      await fn(client)
    } finally {
      await client.query('ROLLBACK')
    }
  } finally {
    client.release()
  }
}
