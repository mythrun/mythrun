// myth-g4hf3 — tripwireVerdicts binder integration: pins the INSERT SQL against
// the real migration-037 schema (column names, enum CHECK, FK cascade). The
// scribe worker's unit suite drives the routing with a fake; this is the one
// place the real SQL executes under test.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { createRepo } from '../index.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('tripwireVerdicts repo', () => {
  let pool: Pool
  let scope: TestScope
  let campaignId: string
  let sessionId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('tripwireverdicts')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
    const userId = uuidv7()
    const worldId = uuidv7()
    campaignId = uuidv7()
    sessionId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'complete')`,
      [worldId, userId, scope.worldName(0)],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, status) VALUES ($1, $2, $3, $4, 'setup')`,
      [campaignId, worldId, userId, scope.campaignName(0)],
    )
    await pool.query(
      `INSERT INTO sessions (id, campaign_id, session_number, status) VALUES ($1, $2, 1, 'active')`,
      [sessionId, campaignId],
    )
  })

  it('insert lands one row per verdict; null secretRef round-trips', async () => {
    const repo = createRepo(pool)
    const turnId = uuidv7()
    await repo.tripwireVerdicts.insert({
      campaignId,
      sessionId,
      turnId,
      severity: 'hard_reveal',
      confidence: 0.85,
      secretRef: '[SECRET-2]',
    })
    await repo.tripwireVerdicts.insert({
      campaignId,
      sessionId,
      turnId: uuidv7(),
      severity: 'none',
      confidence: 1,
      secretRef: null,
    })

    const rows = await pool.query<{
      turn_id: string
      severity: string
      confidence: number
      secret_ref: string | null
    }>(
      `SELECT turn_id, severity, confidence, secret_ref FROM tripwire_verdicts
        WHERE session_id = $1 ORDER BY created_at, id`,
      [sessionId],
    )
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows[0]?.turn_id).toBe(turnId)
    expect(rows.rows[0]?.severity).toBe('hard_reveal')
    expect(rows.rows[0]?.confidence).toBeCloseTo(0.85, 5)
    expect(rows.rows[0]?.secret_ref).toBe('[SECRET-2]')
    expect(rows.rows[1]?.severity).toBe('none')
    expect(rows.rows[1]?.secret_ref).toBeNull()
  })

  it('a session delete cascades its verdicts (FK CASCADE)', async () => {
    const repo = createRepo(pool)
    await repo.tripwireVerdicts.insert({
      campaignId,
      sessionId,
      turnId: uuidv7(),
      severity: 'soft_consistency',
      confidence: 0.5,
      secretRef: '[CONSISTENCY]',
    })
    await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId])
    const rows = await pool.query(`SELECT 1 FROM tripwire_verdicts WHERE session_id = $1`, [sessionId])
    expect(rows.rowCount).toBe(0)
  })
})
