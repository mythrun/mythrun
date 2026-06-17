// MYT-74b T1: migration 028 adds session_messages.trigger_kind — the
// originating turn trigger kind on each DM-authored row, so the post-session
// analysis can STRUCTURALLY exclude correction/farewell rows from NPC
// voice-excerpt selection (an enforced-ignorance boundary). This file runs
// against the already-migrated mythrun_test DB (the controller runs
// `pnpm db:migrate:test` before it), so it asserts the live schema shape +
// the CHECK behavior — it does NOT drop/re-run migrations (globalSetup owns
// bootstrap).
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

// Seed the full FK chain a session_messages row needs:
// users -> worlds -> campaigns -> sessions. Returns the session id so the
// caller can insert the message row under it. All rows are scope-named, so
// cleanupTestScope removes the whole chain via its CASCADE deletes.
async function seedSession(pool: Pool, scope: TestScope): Promise<string> {
  const userId = uuidv7()
  const worldId = uuidv7()
  const campaignId = uuidv7()
  const sessionId = uuidv7()

  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
  )
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
    [worldId, userId, scope.worldName(0)],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name) VALUES ($1, $2, $3, $4)`,
    [campaignId, worldId, userId, scope.campaignName(0)],
  )
  await pool.query(
    `INSERT INTO sessions (id, campaign_id, session_number, status) VALUES ($1, $2, 1, 'active')`,
    [sessionId, campaignId],
  )
  return sessionId
}

describe('migration 028 — session_messages.trigger_kind', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('migration028')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  it('adds session_messages.trigger_kind (text, nullable)', async () => {
    const { rows } = await pool.query<{
      column_name: string
      data_type: string
      is_nullable: string
    }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'session_messages'
          AND column_name = 'trigger_kind'`,
    )
    expect(rows).toEqual([
      { column_name: 'trigger_kind', data_type: 'text', is_nullable: 'YES' },
    ])
  })

  it('accepts a valid trigger_kind (farewell)', async () => {
    const sessionId = await seedSession(pool, scope)
    const messageId = uuidv7()
    await pool.query(
      `INSERT INTO session_messages (id, session_id, seq, message_type, content, trigger_kind)
       VALUES ($1, $2, 0, 'dm_text', 'The campfire dims.', 'farewell')`,
      [messageId, sessionId],
    )
    const { rows } = await pool.query<{ trigger_kind: string | null }>(
      `SELECT trigger_kind FROM session_messages WHERE id = $1`,
      [messageId],
    )
    expect(rows).toEqual([{ trigger_kind: 'farewell' }])
  })

  it('allows NULL trigger_kind (player rows / pre-migration rows)', async () => {
    const sessionId = await seedSession(pool, scope)
    const messageId = uuidv7()
    await pool.query(
      `INSERT INTO session_messages (id, session_id, seq, message_type, content)
       VALUES ($1, $2, 0, 'player_message', 'I draw my sword.')`,
      [messageId, sessionId],
    )
    const { rows } = await pool.query<{ trigger_kind: string | null }>(
      `SELECT trigger_kind FROM session_messages WHERE id = $1`,
      [messageId],
    )
    expect(rows).toEqual([{ trigger_kind: null }])
  })

  it('rejects a bogus trigger_kind with a CHECK violation (23514)', async () => {
    const sessionId = await seedSession(pool, scope)
    const messageId = uuidv7()
    await expect(
      pool.query(
        `INSERT INTO session_messages (id, session_id, seq, message_type, content, trigger_kind)
         VALUES ($1, $2, 0, 'dm_text', 'x', 'bogus')`,
        [messageId, sessionId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })
})
