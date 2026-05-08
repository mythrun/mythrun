import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { createPgPool } from '../postgres.js'
import { runMigrations } from '../migrate.js'
import { LOCK_KEY } from '../lock-key.js'
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
    const rows = await pool.query<{ count: string }>(`SELECT count(*)::text FROM _migrations`)
    expect(rows.rows[0]?.count).toBe('2')
  })

  it('Test 2: partial state — only unapplied migrations run', async () => {
    fixtureDir = makeFixtureDir({
      '001_a.sql': 'CREATE TABLE a (id INT)',
      '002_b.sql': 'CREATE TABLE b (id INT)',
      '003_c.sql': 'CREATE TABLE c (id INT)',
    })
    // Pre-state: 001 already "applied", and table a pre-exists
    await pool.query(
      'CREATE TABLE IF NOT EXISTS _migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    )
    await pool.query("INSERT INTO _migrations (version) VALUES ('001_a.sql')")
    await pool.query('CREATE TABLE a (id INT)')

    const { logger } = makeSpyLogger()
    const applied = await runMigrations({ pool, migrationsDir: fixtureDir, logger })
    expect(applied.map((m) => m.version)).toEqual(['002_b.sql', '003_c.sql'])
    const rows = await pool.query<{ version: string }>(
      `SELECT version FROM _migrations ORDER BY version`,
    )
    expect(rows.rows.map((r) => r.version)).toEqual(['001_a.sql', '002_b.sql', '003_c.sql'])
  })

  it('Test 3: failed migration aborts the run', async () => {
    fixtureDir = makeFixtureDir({
      '001_a.sql': 'CREATE TABLE a (id INT)',
      '002_broken.sql': 'THIS IS NOT VALID SQL;',
      '003_c.sql': 'CREATE TABLE c (id INT)',
    })
    const { logger } = makeSpyLogger()
    await expect(runMigrations({ pool, migrationsDir: fixtureDir, logger })).rejects.toThrow(
      /002_broken\.sql/,
    )

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('a','c')`,
    )
    expect(tables.rows.map((r) => r.table_name)).toEqual(['a'])
    const rows = await pool.query<{ version: string }>(
      `SELECT version FROM _migrations ORDER BY version`,
    )
    expect(rows.rows.map((r) => r.version)).toEqual(['001_a.sql'])
  })

  it('Test 3b: bookkeeping insert is inside the transaction', async () => {
    fixtureDir = makeFixtureDir({
      '001_ok.sql': 'CREATE TABLE ok (id INT)',
      '002_writes_then_fails.sql': 'CREATE TABLE x (id INT); SELECT 1/0;',
    })
    const { logger } = makeSpyLogger()
    await expect(runMigrations({ pool, migrationsDir: fixtureDir, logger })).rejects.toThrow()
    const xExists = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='x'`,
    )
    expect(xExists.rows[0]?.count).toBe('0')
    const rows = await pool.query<{ version: string }>(`SELECT version FROM _migrations`)
    expect(rows.rows.map((r) => r.version)).not.toContain('002_writes_then_fails.sql')
  })

  it('Test 6: non-.sql files and dotfiles are ignored', async () => {
    fixtureDir = makeFixtureDir({
      '001_a.sql': 'CREATE TABLE a (id INT)',
      '002_b.sql': 'CREATE TABLE b (id INT)',
      'README.md': '# notes',
      '.DS_Store': 'binary-noise',
      'notes.txt': 'plain',
    })
    const { logger } = makeSpyLogger()
    const applied = await runMigrations({ pool, migrationsDir: fixtureDir, logger })
    expect(applied.map((m) => m.version)).toEqual(['001_a.sql', '002_b.sql'])
  })

  it('Test 7: top-level COMMIT is rejected', async () => {
    fixtureDir = makeFixtureDir({
      '001_bad.sql': 'CREATE TABLE x (id INT);\nCOMMIT;',
    })
    const { logger } = makeSpyLogger()
    await expect(runMigrations({ pool, migrationsDir: fixtureDir, logger })).rejects.toThrow(
      /forbidden top-level transaction statement/,
    )
    const rows = await pool.query<{ count: string }>(`SELECT count(*)::text FROM _migrations`)
    expect(rows.rows[0]?.count).toBe('0')
  })

  it('Test 7b: PL/pgSQL DO blocks and CREATE FUNCTION bodies are accepted', async () => {
    fixtureDir = makeFixtureDir({
      '001_do_block.sql': `DO $$ BEGIN RAISE NOTICE 'hi'; END $$;`,
      '002_function.sql': `CREATE OR REPLACE FUNCTION f() RETURNS void AS $$
BEGIN
  RAISE NOTICE 'hi';
END
$$ LANGUAGE plpgsql;`,
    })
    const { logger } = makeSpyLogger()
    const applied = await runMigrations({ pool, migrationsDir: fixtureDir, logger })
    expect(applied.map((m) => m.version)).toEqual(['001_do_block.sql', '002_function.sql'])
  })

  it('Test 14: out-of-order migration is rejected', async () => {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS _migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    )
    await pool.query("INSERT INTO _migrations (version) VALUES ('001_a.sql'), ('003_c.sql')")
    fixtureDir = makeFixtureDir({
      '001_a.sql': 'CREATE TABLE a (id INT)',
      '002_b.sql': 'CREATE TABLE b (id INT)',
      '003_c.sql': 'CREATE TABLE c (id INT)',
    })
    const { logger } = makeSpyLogger()
    await expect(runMigrations({ pool, migrationsDir: fixtureDir, logger })).rejects.toThrow(
      /out-of-order.*002_b\.sql/,
    )
    const exists = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='b'`,
    )
    expect(exists.rows[0]?.count).toBe('0')
  })

  it('Test 15: drift warning when applied row has no file on disk', async () => {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS _migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    )
    await pool.query("INSERT INTO _migrations (version) VALUES ('999_ghost.sql')")
    fixtureDir = makeFixtureDir({ '001_a.sql': 'CREATE TABLE a (id INT)' })
    const { logger, lines } = makeSpyLogger()
    const applied = await runMigrations({ pool, migrationsDir: fixtureDir, logger })
    expect(applied.map((m) => m.version)).toEqual(['001_a.sql'])
    const drift = lines.find((l) => l.event === 'migrate.drift_missing_files')
    expect(drift).toBeDefined()
    expect(drift?.missing).toEqual(['999_ghost.sql'])
    expect(typeof drift?.hint).toBe('string')
    expect((drift?.hint as string).length).toBeGreaterThan(0)
  })

  it('Test 8: abortSignal requests a graceful stop between migrations', async () => {
    fixtureDir = makeFixtureDir({
      '001_a.sql': 'CREATE TABLE a (id INT)',
      '002_b.sql': 'CREATE TABLE b (id INT)',
      '003_c.sql': 'CREATE TABLE c (id INT)',
    })
    const controller = new AbortController()
    const lines: Record<string, unknown>[] = []
    const sink: DestinationStream = {
      write: (s: string) => {
        const obj = JSON.parse(s) as Record<string, unknown>
        lines.push(obj)
        if (obj.event === 'migrate.applied') {
          controller.abort()
        }
      },
    }
    const logger = pino(
      { base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } },
      sink,
    )
    const applied = await runMigrations({
      pool,
      migrationsDir: fixtureDir,
      logger,
      abortSignal: controller.signal,
    })
    expect(applied.map((m) => m.version)).toEqual(['001_a.sql'])
    const bExists = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='b'`,
    )
    expect(bExists.rows[0]?.count).toBe('0')
    const aborted = lines.find((l) => l.event === 'migrate.aborted')
    expect(aborted).toBeDefined()
  })

  it('Test 9: logger contract — emits expected events with shared runId', async () => {
    fixtureDir = makeFixtureDir({
      '001_a.sql': 'CREATE TABLE a (id INT)',
      '002_b.sql': 'CREATE TABLE b (id INT)',
      '003_c.sql': 'CREATE TABLE c (id INT)',
    })
    const { logger, lines } = makeSpyLogger()
    await runMigrations({ pool, migrationsDir: fixtureDir, logger, runId: 'fixed-run-id' })
    const events = lines.map((l) => l.event)
    expect(events).toContain('migrate.start')
    expect(events).toContain('migrate.lock_acquired')
    expect(events).toContain('migrate.plan')
    expect(events.filter((e) => e === 'migrate.applied')).toHaveLength(3)
    expect(events).toContain('migrate.lock_released')
    expect(events).toContain('migrate.done')
    expect(events).not.toContain('migrate.failed')
    for (const line of lines) {
      if (line.event === 'migrate.signal_received') continue
      expect(line.runId).toBe('fixed-run-id')
    }
    for (const line of lines) {
      expect(line.component).toBe('migrate')
    }
    const applied = lines.filter((l) => l.event === 'migrate.applied')
    for (const a of applied) {
      expect(a.version).toMatch(/^00\d_[abc]\.sql$/)
      expect(typeof a.durationMs).toBe('number')
    }
  })

  it('Test 11: error logs include serialized stack and pg fields', async () => {
    fixtureDir = makeFixtureDir({ '001_broken.sql': 'NOT SQL;' })
    const { logger, lines } = makeSpyLogger()
    await expect(runMigrations({ pool, migrationsDir: fixtureDir, logger })).rejects.toThrow()
    const failed = lines.find((l) => l.event === 'migrate.failed')
    expect(failed).toBeDefined()
    const err = failed?.err as Record<string, unknown> | undefined
    expect(typeof err?.message).toBe('string')
    expect(typeof err?.stack).toBe('string')
    // pg's std serializer captures `code` (SQLSTATE).
    expect(typeof err?.code).toBe('string')
  })

  it('Test 13: lock-wait heartbeat fires with holder info', async () => {
    fixtureDir = makeFixtureDir({ '001_a.sql': 'CREATE TABLE a (id INT)' })
    // Hold the lock from a separate client.
    const holder = createPgPool(databaseUrl, { max: 1 })
    const holderClient = await holder.connect()
    await holderClient.query("SET application_name = 'test-holder'")
    await holderClient.query('SELECT pg_advisory_lock($1)', [LOCK_KEY.toString()])
    try {
      const { logger, lines } = makeSpyLogger()
      const runPromise = runMigrations({ pool, migrationsDir: fixtureDir, logger })
      // Wait long enough for at least one heartbeat (5s + jitter).
      await new Promise((r) => setTimeout(r, 6500))
      // Release the holder so the runner can proceed.
      await holderClient.query('SELECT pg_advisory_unlock_all()')
      await runPromise
      const waiting = lines.filter((l) => l.event === 'migrate.lock_waiting')
      expect(waiting.length).toBeGreaterThanOrEqual(1)
      const first = waiting[0] ?? {}
      expect(typeof first.waitMsSoFar).toBe('number')
      const heldBy = first.holder as { applicationName: string | null } | null | undefined
      expect(heldBy?.applicationName).toBe('test-holder')
    } finally {
      holderClient.release()
      await holder.end()
    }
  }, 30_000)

  it('Test 12: application_name does not leak through pool checkout', async () => {
    // Pin the SET LOCAL + DISCARD ALL invariant. A regression to bare
    // `SET application_name` (without LOCAL) would leak the migrate's
    // application_name to the next pool checkout — the API server, in
    // future shared-pool topology. This test fails loudly if that happens.
    fixtureDir = makeFixtureDir({
      '001_a.sql': 'CREATE TABLE a (id INT)',
    })

    // Use a max:1 pool so the SAME client gets handed back after the
    // runner releases it. (With max>1, a fresh client could be created
    // and bypass the leak detection.)
    const singleClientPool = createPgPool(databaseUrl, { max: 1 })
    try {
      const { logger } = makeSpyLogger()
      await runMigrations({ pool: singleClientPool, migrationsDir: fixtureDir, logger })

      // Re-check out the same client and inspect application_name.
      const client = await singleClientPool.connect()
      try {
        const res = await client.query<{ name: string }>(
          `SELECT current_setting('application_name') AS name`,
        )
        // Default is empty string or driver default ('node-postgres'), but
        // critically NOT 'mythrun-migrate'. The runner's SET LOCAL +
        // DISCARD ALL must have reset session state.
        expect(res.rows[0]?.name).not.toBe('mythrun-migrate')
      } finally {
        client.release()
      }
    } finally {
      await singleClientPool.end()
    }
  })
})
