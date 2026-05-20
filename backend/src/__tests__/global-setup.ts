// backend/src/__tests__/global-setup.ts
//
// Vitest globalSetup script — runs once per test process at startup,
// BEFORE any test file imports. Centralizes the schema bootstrap +
// system-row seed so individual test files never have to do their
// own DROP SCHEMA / runMigrations / reseed.
//
// myth-oehx: this consolidation is what makes parallel test execution
// safe. Per-file beforeAll DROP SCHEMA blocks would race-collide under
// vitest fileParallelism: true.

import { config } from 'dotenv'
import { existsSync } from 'node:fs'
import { Pool } from 'pg'
import pino, { type DestinationStream } from 'pino'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { runMigrations } from '../db/migrate.js'
import { seedTestDatabase } from './_helpers/seed-test-database.js'

const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../migrations')

// globalSetup runs in a separate Vitest context from setupFiles, so we
// load the env files ourselves rather than relying on setup-env.ts.
// Paths match setup-env.ts (same directory depth): `.env.development`
// lives at backend/.env.development; `.env.worktree` lives at repo root.
config({ path: resolve(here, '../../../.env.development') })
const worktreeEnv = resolve(here, '../../../../.env.worktree')
if (existsSync(worktreeEnv)) {
  config({ path: worktreeEnv, override: true })
}

// Silent pino logger for the migration runner — globalSetup output
// otherwise drowns the test summary. Pattern matches the existing
// silentLogger() helper duplicated across the LLM stage test files.
function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: (): void => undefined }
  return pino({ base: { component: 'migrate' } }, sink)
}

// Vitest accepts `setup` as a named export OR a default export. Named
// matches the codebase convention (no-default-exports ESLint rule).
export async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL_TEST
  if (url === undefined || url === '') {
    throw new Error(
      'global-setup: DATABASE_URL_TEST is unset. .env.development should ' +
        'define it; see backend/.env.development.example.',
    )
  }

  const dbName = new URL(url).pathname.slice(1)
  if (!/^mythrun_test(_.+)?$/.test(dbName)) {
    throw new Error(
      `global-setup: DATABASE_URL_TEST points at "${dbName}", which is ` +
        'not on the test-database allowlist /^mythrun_test(_.+)?$/.',
    )
  }

  const pool = new Pool({ connectionString: url, max: 1 })
  try {
    await runMigrations({
      pool,
      migrationsDir: REAL_MIGRATIONS_DIR,
      logger: silentLogger(),
    })
    await seedTestDatabase(pool)
  } finally {
    await pool.end()
  }
}
