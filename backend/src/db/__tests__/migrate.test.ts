import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { createPgPool } from '../postgres.js'
import { runMigrations } from '../migrate.js'
import { guardTestDatabase } from './guard-db.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

async function resetSchema(pool: Pool): Promise<void> {
  await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
  await pool.query('DROP SCHEMA public CASCADE')
  await pool.query('CREATE SCHEMA public')
  await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
  await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
}

function makeFixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'myt-32-'))
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents)
  }
  return dir
}

function makeSpyLogger() {
  const lines: Record<string, unknown>[] = []
  const sink: DestinationStream = {
    write: (s: string) => {
      lines.push(JSON.parse(s) as Record<string, unknown>)
    },
  }
  const logger = pino(
    {
      base: { component: 'migrate' },
      serializers: { err: pino.stdSerializers.err },
    },
    sink,
  )
  return { logger, lines }
}

describe('runMigrations (integration)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 5 })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetSchema(pool)
  })

  let fixtureDir: string | undefined
  afterEach(() => {
    if (fixtureDir) {
      rmSync(fixtureDir, { recursive: true, force: true })
      fixtureDir = undefined
    }
  })

  it('Test 1: empty DB — applies all migrations in order', async () => {
    fixtureDir = makeFixtureDir({
      '001_a.sql': 'CREATE TABLE a (id INT);',
      '002_b.sql': 'CREATE TABLE b (id INT);',
      '003_c.sql': 'CREATE TABLE c (id INT);',
    })
    const { logger } = makeSpyLogger()
    const applied = await runMigrations({ pool, migrationsDir: fixtureDir, logger })

    expect(applied.map((m) => m.version)).toEqual(['001_a.sql', '002_b.sql', '003_c.sql'])
    for (const m of applied) {
      expect(m.durationMs).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(m.durationMs)).toBe(true)
    }
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`,
    )
    expect(tables.rows.map((r) => r.table_name)).toEqual(['_migrations', 'a', 'b', 'c'])
    const rows = await pool.query<{ version: string }>(
      `SELECT version FROM _migrations ORDER BY version`,
    )
    expect(rows.rows.map((r) => r.version)).toEqual(['001_a.sql', '002_b.sql', '003_c.sql'])
  })

  it('Test 4: empty migrations directory — returns []', async () => {
    fixtureDir = makeFixtureDir({})
    const { logger } = makeSpyLogger()
    const applied = await runMigrations({ pool, migrationsDir: fixtureDir, logger })
    expect(applied).toEqual([])
    const exists = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='_migrations'`,
    )
    expect(exists.rows[0]?.count).toBe('1')
  })

  it('Test 5: second run is a no-op', async () => {
    fixtureDir = makeFixtureDir({
      '001_a.sql': 'CREATE TABLE a (id INT);',
      '002_b.sql': 'CREATE TABLE b (id INT);',
    })
    const { logger } = makeSpyLogger()
    const first = await runMigrations({ pool, migrationsDir: fixtureDir, logger })
    expect(first.map((m) => m.version)).toEqual(['001_a.sql', '002_b.sql'])
    const second = await runMigrations({ pool, migrationsDir: fixtureDir, logger })
    expect(second).toEqual([])
    const rows = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM _migrations`,
    )
    expect(rows.rows[0]?.count).toBe('2')
  })
})
