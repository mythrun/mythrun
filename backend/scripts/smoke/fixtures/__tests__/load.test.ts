import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { guardTestDatabase } from '../../../../src/db/__tests__/guard-db.js'
import { createTestPool } from '../../../../src/repo/__tests__/_helpers/test-pool.js'
import { loadFixture } from '../load.js'
import type { FixtureFile } from '../types.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

const SHARED_USER = '019700e0-0000-7000-8000-00000000d001' // globalSetup dev-user-1 (seeded)
const WORLD_ID = '019e0000-0000-7000-8000-0000000000a1'
const ENTITY_ID = '019e0000-0000-7000-8000-0000000000b1'

function tinyFixture(): FixtureFile {
  return {
    name: 'toolkit-test-tiny',
    capturedAt: '2026-06-03T00:00:00.000Z',
    schemaVersion: '022_session_preps_unique.sql',
    rootCampaignId: WORLD_ID,
    rootWorldId: WORLD_ID,
    tables: [
      { name: 'users', shared: true, rows: [{ id: SHARED_USER, cognito_sub: 'fixture:should-not-insert', display_name: 'X', username: 'fixture_x' }] },
      { name: 'worlds', shared: false, rows: [{ id: WORLD_ID, created_by: SHARED_USER, name: 'Fixture World', concept: 'a tiny test world', status: 'complete', vocabulary_registry: { entries: [], adjacent_franchises: [] } }] },
      { name: 'entities', shared: false, rows: [{ id: ENTITY_ID, world_id: WORLD_ID, entity_type: 'location', name: 'Fixture Cove', access_level: 'known' }] },
    ],
  }
}

describe('loadFixture (smoke-fixture toolkit)', () => {
  let pool: Pool
  const fixturePath = join(FIX_DIR, 'toolkit-test-tiny.json')

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
  })
  afterAll(async () => {
    rmSync(fixturePath, { force: true })
    await pool.query(`DELETE FROM entities WHERE id = $1`, [ENTITY_ID])
    await pool.query(`DELETE FROM worlds WHERE id = $1`, [WORLD_ID])
    await pool.end()
  })
  beforeEach(() => {
    writeFileSync(fixturePath, JSON.stringify(tinyFixture()), 'utf8')
  })

  it('loads the graph; jsonb column round-trips; shared row uses ON CONFLICT (not re-inserted)', async () => {
    const before = await pool.query<{ cognito_sub: string }>(`SELECT cognito_sub FROM users WHERE id = $1`, [SHARED_USER])
    expect(before.rows).toHaveLength(1)
    const seededSub = before.rows[0]?.cognito_sub

    await loadFixture(pool, 'toolkit-test-tiny')

    const world = await pool.query<{ status: string; vocabulary_registry: unknown }>(`SELECT status, vocabulary_registry FROM worlds WHERE id = $1`, [WORLD_ID])
    expect(world.rows[0]?.status).toBe('complete')
    expect(world.rows[0]?.vocabulary_registry).toEqual({ entries: [], adjacent_franchises: [] })
    const ent = await pool.query(`SELECT id FROM entities WHERE id = $1`, [ENTITY_ID])
    expect(ent.rows).toHaveLength(1)
    const after = await pool.query<{ cognito_sub: string }>(`SELECT cognito_sub FROM users WHERE id = $1`, [SHARED_USER])
    expect(after.rows[0]?.cognito_sub).toBe(seededSub)
    expect(after.rows[0]?.cognito_sub).not.toBe('fixture:should-not-insert')
  })

  it('is idempotent — loading twice leaves exactly one graph (delete-then-load), shared row survives', async () => {
    await loadFixture(pool, 'toolkit-test-tiny')
    await loadFixture(pool, 'toolkit-test-tiny')
    const worlds = await pool.query(`SELECT id FROM worlds WHERE id = $1`, [WORLD_ID])
    expect(worlds.rows).toHaveLength(1)
    const users = await pool.query(`SELECT id FROM users WHERE id = $1`, [SHARED_USER])
    expect(users.rows).toHaveLength(1)
  })

  it('throws a regenerate-hint when a row has a column the schema lacks', async () => {
    const base = tinyFixture()
    const bad: FixtureFile = {
      ...base,
      tables: base.tables.map((t) =>
        t.name === 'worlds'
          ? { ...t, rows: t.rows.map((r) => ({ ...r, nonexistent_column: 'boom' })) }
          : t,
      ),
    }
    writeFileSync(fixturePath, JSON.stringify(bad), 'utf8')
    await expect(loadFixture(pool, 'toolkit-test-tiny')).rejects.toThrow(/regenerate via capture\.ts/)
  })
})
