// MYT-74a T1: migration 027 adds the append-only fact-supersede substrate
// (facts.superseded_by self-FK + facts.superseded_at) and the
// sessions.reconciled_at completion marker. This file runs against the
// already-migrated mythrun_test DB (the controller runs `pnpm db:migrate:test`
// before it), so it asserts the live schema shape + the ON DELETE SET NULL
// behavior — it does NOT drop/re-run migrations (globalSetup owns bootstrap).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from './guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('migration 027 — fact supersede', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('migration027')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  it('adds facts.superseded_by (uuid) and facts.superseded_at (timestamptz)', async () => {
    const { rows } = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'facts'
          AND column_name IN ('superseded_by', 'superseded_at')
        ORDER BY column_name`,
    )
    expect(rows).toEqual([
      { column_name: 'superseded_at', data_type: 'timestamp with time zone' },
      { column_name: 'superseded_by', data_type: 'uuid' },
    ])
  })

  it('self-FK on facts.superseded_by is ON DELETE SET NULL', async () => {
    // confdeltype = 'n' is SET NULL. The FK is on `facts` (conrelid) and
    // references `facts` (confrelid) — the self-FK introduced by 027.
    const { rows } = await pool.query<{ confdeltype: string }>(
      `SELECT c.confdeltype
         FROM pg_constraint c
         JOIN pg_class src ON src.oid = c.conrelid
         JOIN pg_class tgt ON tgt.oid = c.confrelid
         JOIN pg_namespace n ON n.oid = src.relnamespace
        WHERE c.contype = 'f' AND n.nspname = 'public'
          AND src.relname = 'facts' AND tgt.relname = 'facts'`,
    )
    expect(rows).toEqual([{ confdeltype: 'n' }])
  })

  it('adds sessions.reconciled_at (timestamptz)', async () => {
    const { rows } = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sessions'
          AND column_name = 'reconciled_at'`,
    )
    expect(rows).toEqual([
      { column_name: 'reconciled_at', data_type: 'timestamp with time zone' },
    ])
  })

  it('deleting the pointed-to fact SET-NULLs superseded_by (no FK abort)', async () => {
    const userId = uuidv7()
    const worldId = uuidv7()
    const entityId = uuidv7()
    const f1 = uuidv7()
    const f2 = uuidv7()

    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
    await pool.query(
      `INSERT INTO entities (id, world_id, entity_type, name, access_level)
       VALUES ($1, $2, 'location', 'X', 'known')`,
      [entityId, worldId],
    )
    // Two facts: f1 (the original) and f2 (the appended correction).
    await pool.query(
      `INSERT INTO facts (id, entity_id, topic, access_level, content, narrative_status)
       VALUES ($1, $2, 't', 'known', 'original', 'undelivered')`,
      [f1, entityId],
    )
    await pool.query(
      `INSERT INTO facts (id, entity_id, topic, access_level, content, narrative_status)
       VALUES ($1, $2, 't', 'known', 'correction', 'undelivered')`,
      [f2, entityId],
    )
    // Point f1 at f2 (a correction supersedes the original).
    await pool.query(`UPDATE facts SET superseded_by = $2 WHERE id = $1`, [f1, f2])

    // Delete the pointed-to fact. Under the bare NO ACTION default this would
    // FK-abort; ON DELETE SET NULL nulls f1.superseded_by instead.
    await pool.query(`DELETE FROM facts WHERE id = $1`, [f2])

    const { rows } = await pool.query<{ id: string; superseded_by: string | null }>(
      `SELECT id, superseded_by FROM facts WHERE id = $1`,
      [f1],
    )
    expect(rows).toEqual([{ id: f1, superseded_by: null }])
  })
})
