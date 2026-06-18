// MYT-74d T1: migration 029 adds session_messages.content_tsv (a generated
// tsvector) + a PARTIAL GIN index over the prose-bearing message types
// (dm_text, player_message). Runs against the already-migrated mythrun_test DB.
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

describe('migration 029 — session_messages.content_tsv FTS', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('migration029')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  it('adds session_messages.content_tsv (tsvector, generated)', async () => {
    const { rows } = await pool.query<{
      column_name: string
      data_type: string
      is_generated: string
    }>(
      `SELECT column_name, data_type, is_generated
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'session_messages'
          AND column_name = 'content_tsv'`,
    )
    expect(rows).toEqual([
      { column_name: 'content_tsv', data_type: 'tsvector', is_generated: 'ALWAYS' },
    ])
  })

  it('creates a partial GIN index over the prose-bearing types', async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_session_messages_content_tsv'`,
    )
    expect(rows).toHaveLength(1)
    const def = rows[0]?.indexdef ?? ''
    expect(def).toContain('USING gin')
    expect(def).toContain('content_tsv')
    expect(def).toContain('message_type')
    expect(def).toContain("'dm_text'")
    expect(def).toContain("'player_message'")
  })

  it('auto-populates content_tsv and matches a term via websearch_to_tsquery', async () => {
    const sessionId = await seedSession(pool, scope)
    await pool.query(
      `INSERT INTO session_messages (id, session_id, seq, message_type, content)
       VALUES ($1, $2, 0, 'dm_text', 'The harbourmaster guards the ledger.')`,
      [uuidv7(), sessionId],
    )
    const { rows } = await pool.query<{ match: boolean }>(
      `SELECT (content_tsv @@ websearch_to_tsquery('english', 'harbourmaster')) AS match
         FROM session_messages WHERE session_id = $1`,
      [sessionId],
    )
    expect(rows).toEqual([{ match: true }])
  })
})
