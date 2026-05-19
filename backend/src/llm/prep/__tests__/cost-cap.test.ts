// backend/src/llm/prep/__tests__/cost-cap.test.ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../../db/__tests__/guard-db.js'
import { runMigrations } from '../../../db/migrate.js'
import { createPgPool } from '../../../db/postgres.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../../repo/__tests__/_helpers/test-scope.js'
import {
  readCostCap,
  sumCompletedStageCosts,
  issueCostCapRefund,
  CostCapParseError,
  readCharacterCreationCostCap,
  sumCharacterCreationStageCosts,
} from '../cost-cap.js'

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

describe('cost-cap', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 1 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
    scope = makeTestScope('cost-cap')
  })

  afterAll(async () => {
    // myth-5jdo: scoped cleanup before pool teardown — leaves seeded
    // dev users + system user intact for the next test file.
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    // myth-5jdo: scoped cleanup replaces the prior blanket DELETEs.
    await cleanupTestScope(pool, scope)
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('world_gen_cost_cap_usd', '10.0')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    )
  })

  async function seedUserWorldCampaign(userIndex = 0): Promise<{
    userId: string
    worldId: string
    campaignId: string
  }> {
    const userId = uuidv7()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(userIndex), scope.displayName(userIndex), scope.username(userIndex)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status)
       VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, userId, scope.worldName(userIndex)],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name)
       VALUES ($1, $2, $3, $4)`,
      [campaignId, worldId, userId, scope.campaignName(userIndex)],
    )
    return { userId, worldId, campaignId }
  }

  describe('readCostCap', () => {
    it('returns the parsed value', async () => {
      const cap = await readCostCap(pool)
      expect(cap).toBeCloseTo(10.0)
    })

    it('throws CostCapParseError if the row is missing', async () => {
      await pool.query(`DELETE FROM settings WHERE key = 'world_gen_cost_cap_usd'`)
      await expect(readCostCap(pool)).rejects.toBeInstanceOf(CostCapParseError)
    })

    it('throws CostCapParseError if the value is not a positive number', async () => {
      await pool.query(
        `UPDATE settings SET value = 'not-a-number' WHERE key = 'world_gen_cost_cap_usd'`,
      )
      await expect(readCostCap(pool)).rejects.toBeInstanceOf(CostCapParseError)
      await pool.query(`UPDATE settings SET value = '-1' WHERE key = 'world_gen_cost_cap_usd'`)
      await expect(readCostCap(pool)).rejects.toBeInstanceOf(CostCapParseError)
    })
  })

  describe('sumCompletedStageCosts', () => {
    it('returns 0 for a world with no runs', async () => {
      const { worldId } = await seedUserWorldCampaign()
      const sum = await sumCompletedStageCosts(pool, worldId)
      expect(sum).toBe(0)
    })

    it('sums only completed stages (skips failed + running + pending)', async () => {
      const { worldId, userId } = await seedUserWorldCampaign()
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, cost_usd, user_id)
         VALUES ($1, $2, 'concept_intake', 'completed', now(), 1.50, NULL)`,
        [uuidv7(), worldId],
      )
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, cost_usd, user_id)
         VALUES ($1, $2, 'world_and_factions', 'failed', now(), 0.75, NULL)`,
        [uuidv7(), worldId],
      )
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, cost_usd, user_id)
         VALUES ($1, $2, 'starting_situation', 'running', now(), 0, NULL)`,
        [uuidv7(), worldId],
      )
      const sum = await sumCompletedStageCosts(pool, worldId)
      expect(sum).toBeCloseTo(1.5)
      // user_id filter is also enforced: charcreation rows shouldn't count
      // here because they have user_id set.
      void userId
    })

    it('returns cost_usd as JS number, not string', async () => {
      const { worldId } = await seedUserWorldCampaign()
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, cost_usd, user_id)
         VALUES ($1, $2, 'concept_intake', 'completed', now(), 0.500000, NULL)`,
        [uuidv7(), worldId],
      )
      const sum = await sumCompletedStageCosts(pool, worldId)
      expect(typeof sum).toBe('number')
      expect(sum).toBeCloseTo(0.5)
    })
  })

  describe('issueCostCapRefund', () => {
    it('rolls back the transaction when an inner query fails', async () => {
      // Exercises the catch + ROLLBACK arm (cost-cap.ts:71-72). Passing
      // a userId that does not exist in `users` violates the
      // credit_ledger FK; the INSERT throws inside the BEGIN/COMMIT pair
      // and the wrapper must ROLLBACK before re-raising.
      const { worldId } = await seedUserWorldCampaign()
      const missingUserId = uuidv7()
      await expect(
        issueCostCapRefund(pool, { userId: missingUserId, worldId }),
      ).rejects.toBeDefined()
      // World status MUST remain unchanged — the UPDATE inside the same
      // tx was rolled back along with the failing INSERT. (If ROLLBACK
      // didn't run, the world would now be 'failed'.)
      const world = await pool.query<{ status: string }>(
        `SELECT status FROM worlds WHERE id = $1`,
        [worldId],
      )
      expect(world.rows[0]?.status).toBe('generating')
      // No credit_ledger row was inserted for the missing user.
      const ledger = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM credit_ledger WHERE user_id = $1`,
        [missingUserId],
      )
      expect(ledger.rows[0]?.count).toBe('0')
    })

    it('marks world failed + inserts +1 credit_ledger refund in one transaction', async () => {
      const { userId, worldId } = await seedUserWorldCampaign()
      // Existing debit row from create-campaign flow. The debit polarity +
      // source_id CHECKs (migration 004) require a non-null source_id; the
      // worldId is the canonical source for a world-gen debit.
      await pool.query(
        `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type, source_id)
         VALUES ($1, $2, 'world_gen', -1, 'debit', $3)`,
        [uuidv7(), userId, worldId],
      )
      await issueCostCapRefund(pool, { userId, worldId })

      const world = await pool.query<{ status: string }>(
        `SELECT status FROM worlds WHERE id = $1`,
        [worldId],
      )
      expect(world.rows[0]?.status).toBe('failed')

      const ledger = await pool.query<{ amount: number; source_type: string }>(
        `SELECT amount::float8 AS amount, source_type FROM credit_ledger
         WHERE user_id = $1 ORDER BY granted_at ASC`,
        [userId],
      )
      expect(ledger.rows).toHaveLength(2)
      expect(ledger.rows[0]?.amount).toBe(-1)
      expect(ledger.rows[1]?.amount).toBe(1)
      expect(ledger.rows[1]?.source_type).toBe('cost_cap_refund')
    })
  })

  describe('readCharacterCreationCostCap', () => {
    it('reads the seeded $5.00 default from migration 016', async () => {
      const cap = await readCharacterCreationCostCap(pool)
      expect(cap).toBeCloseTo(5.0)
    })

    it('throws CostCapParseError if the row is missing', async () => {
      await pool.query(`DELETE FROM settings WHERE key = 'character_creation_cost_cap_usd'`)
      await expect(readCharacterCreationCostCap(pool)).rejects.toBeInstanceOf(CostCapParseError)
      // Restore for the next test in this describe.
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('character_creation_cost_cap_usd', '5.00')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      )
    })

    it('throws CostCapParseError if the value is not a positive number', async () => {
      await pool.query(
        `UPDATE settings SET value = 'not-a-number' WHERE key = 'character_creation_cost_cap_usd'`,
      )
      await expect(readCharacterCreationCostCap(pool)).rejects.toBeInstanceOf(CostCapParseError)
      await pool.query(
        `UPDATE settings SET value = '-1' WHERE key = 'character_creation_cost_cap_usd'`,
      )
      await expect(readCharacterCreationCostCap(pool)).rejects.toBeInstanceOf(CostCapParseError)
      // Restore for subsequent tests.
      await pool.query(
        `UPDATE settings SET value = '5.00' WHERE key = 'character_creation_cost_cap_usd'`,
      )
    })
  })

  describe('sumCharacterCreationStageCosts', () => {
    it('returns 0 when no rows', async () => {
      const { campaignId } = await seedUserWorldCampaign()
      const sum = await sumCharacterCreationStageCosts(pool, campaignId)
      expect(sum).toBe(0)
    })

    it('sums completed rows for the given campaign across all user_ids', async () => {
      // Per spec §Cost-cap coverage: char-creation rows are keyed on
      // (campaign_id, user_id) with world_id NULL. The aggregator must
      // sum across every user's per-player runs for the campaign.
      const { campaignId, userId: userId0 } = await seedUserWorldCampaign(0)
      // Second user — separate row in `users` so the FK on pipeline_runs
      // resolves. We don't need campaign_members here because the SUM
      // query reads pipeline_runs directly.
      const userId1 = uuidv7()
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId1, scope.userSub(1), scope.displayName(1), scope.username(1)],
      )
      // Four completed per-player rows (2 stages × 2 users) — sums to 0.12.
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, cost_usd, user_id)
         VALUES ($1, $2, 'character_concepts', 'completed', now(), 0.03, $3)`,
        [uuidv7(), campaignId, userId0],
      )
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, cost_usd, user_id)
         VALUES ($1, $2, 'character_details', 'completed', now(), 0.03, $3)`,
        [uuidv7(), campaignId, userId0],
      )
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, cost_usd, user_id)
         VALUES ($1, $2, 'character_concepts', 'completed', now(), 0.03, $3)`,
        [uuidv7(), campaignId, userId1],
      )
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, cost_usd, user_id)
         VALUES ($1, $2, 'character_details', 'completed', now(), 0.03, $3)`,
        [uuidv7(), campaignId, userId1],
      )
      const sum = await sumCharacterCreationStageCosts(pool, campaignId)
      expect(sum).toBeCloseTo(0.12, 6)
    })

    it('excludes non-completed rows and world-gen rows (user_id IS NULL)', async () => {
      const { campaignId, userId, worldId } = await seedUserWorldCampaign()
      // Running row — excluded by status filter.
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, cost_usd, user_id)
         VALUES ($1, $2, 'character_concepts', 'running', now(), 0.10, $3)`,
        [uuidv7(), campaignId, userId],
      )
      // World-gen row (user_id NULL) keyed via world_id — excluded by the
      // user_id IS NOT NULL filter even though the same campaign_id-less
      // row would never match anyway.
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, cost_usd, user_id)
         VALUES ($1, $2, 'concept_intake', 'completed', now(), 1.00, NULL)`,
        [uuidv7(), worldId],
      )
      const sum = await sumCharacterCreationStageCosts(pool, campaignId)
      expect(sum).toBe(0)
    })
  })
})
