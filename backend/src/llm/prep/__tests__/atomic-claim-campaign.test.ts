// backend/src/llm/prep/__tests__/atomic-claim-campaign.test.ts
//
// MYT-54 T6: atomicClaimStage gains a third arm —
//   { kind: 'campaign'; campaignId: string; stage: string }
// for campaign-scoped, user_id IS NULL claims. Mirrors the world-gen
// claim shape (also user_id IS NULL) but keys on campaign_id; the
// character-integration worker (MYT-54) uses this to claim a single
// row per (campaign, stage) without a per-user fan-out.
//
// The unique index idx_pipeline_runs_unique on
//   (COALESCE(world_id, campaign_id), stage, COALESCE(user_id, sentinel))
// already enforces uniqueness for this shape (verified in T1) — no new
// index required.
//
// Integration style: real Postgres + raw-SQL seed (no fixture helper
// needed; seed mirrors the per-player atomic-claim test in
// world-gen-processor.test.ts).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import pino, { type DestinationStream } from 'pino'

import { guardTestDatabase } from '../../../db/__tests__/guard-db.js'
import { runMigrations } from '../../../db/migrate.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../../repo/__tests__/_helpers/test-pool.js'
import { atomicClaimStage } from '../world-gen-processor.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: () => {
      // discard log output
    },
  }
  return pino(
    { base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } },
    sink,
  )
}

interface SeedResult {
  readonly userId: string
  readonly worldId: string
  readonly campaignId: string
}

describe("atomicClaimStage with kind: 'campaign'", () => {
  let pool: Pool
  let scope: TestScope
  let userCounter: number

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    await runMigrations({
      pool,
      migrationsDir: REAL_MIGRATIONS_DIR,
      logger: silentLogger(),
    })
    scope = makeTestScope('atomic-claim-campaign')
    userCounter = 0
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  async function seedCampaign(): Promise<SeedResult> {
    const userId = uuidv7()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    const n = userCounter++
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(n), scope.displayName(n), scope.username(n)],
    )
    // worlds row required because campaigns.world_id is a NOT NULL FK.
    // The campaign-scoped claim itself does NOT touch worlds.
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status)
       VALUES ($1, $2, $3, 'a concept for testing', 'generating')`,
      [worldId, userId, scope.worldName(n)],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name)
       VALUES ($1, $2, $3, $4)`,
      [campaignId, worldId, userId, scope.campaignName(n)],
    )
    return { userId, worldId, campaignId }
  }

  it('claims a campaign-scoped stage with user_id=NULL', async () => {
    const { campaignId } = await seedCampaign()

    const claim = await atomicClaimStage(pool, {
      kind: 'campaign',
      campaignId,
      stage: 'character_integration',
    })
    expect(claim).toBe('claimed')

    // Verify the row landed under the campaign-scoped key shape:
    // world_id NULL, campaign_id set, user_id NULL, status 'running'.
    const row = await pool.query<{
      world_id: string | null
      campaign_id: string
      user_id: string | null
      stage: string
      status: string
    }>(
      `SELECT world_id, campaign_id, user_id, stage, status FROM pipeline_runs
        WHERE campaign_id = $1 AND stage = $2 AND user_id IS NULL`,
      [campaignId, 'character_integration'],
    )
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0]?.world_id).toBeNull()
    expect(row.rows[0]?.campaign_id).toBe(campaignId)
    expect(row.rows[0]?.user_id).toBeNull()
    expect(row.rows[0]?.status).toBe('running')
  })

  it("returns 'completed' on re-entry against an already-completed claim", async () => {
    const { campaignId } = await seedCampaign()

    const first = await atomicClaimStage(pool, {
      kind: 'campaign',
      campaignId,
      stage: 'character_integration',
    })
    expect(first).toBe('claimed')

    // Manually mark the row completed (simulates a prior successful run).
    await pool.query(
      `UPDATE pipeline_runs
          SET status = 'completed', completed_at = now()
        WHERE campaign_id = $1 AND stage = $2 AND user_id IS NULL`,
      [campaignId, 'character_integration'],
    )

    const second = await atomicClaimStage(pool, {
      kind: 'campaign',
      campaignId,
      stage: 'character_integration',
    })
    expect(second).toBe('completed')
  })

  it("returns 'claimed' on re-entry against a failed claim (re-runnable)", async () => {
    const { campaignId } = await seedCampaign()

    const first = await atomicClaimStage(pool, {
      kind: 'campaign',
      campaignId,
      stage: 'character_integration',
    })
    expect(first).toBe('claimed')

    // Manually flip to 'failed' (simulates a prior crashed run that BullMQ
    // will retry; the claim helper must coerce the failed row back to
    // 'running' via ON CONFLICT DO UPDATE WHERE status IN ('pending','failed')).
    await pool.query(
      `UPDATE pipeline_runs
          SET status = 'failed', completed_at = now(), error = 'prior crash'
        WHERE campaign_id = $1 AND stage = $2 AND user_id IS NULL`,
      [campaignId, 'character_integration'],
    )

    const second = await atomicClaimStage(pool, {
      kind: 'campaign',
      campaignId,
      stage: 'character_integration',
    })
    expect(second).toBe('claimed')

    // Confirm the row was re-armed: status='running', error cleared.
    const row = await pool.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM pipeline_runs
        WHERE campaign_id = $1 AND stage = $2 AND user_id IS NULL`,
      [campaignId, 'character_integration'],
    )
    expect(row.rows[0]?.status).toBe('running')
    expect(row.rows[0]?.error).toBeNull()
  })
})
