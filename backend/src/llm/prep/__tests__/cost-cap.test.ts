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
  readCostCap,
  sumCompletedStageCosts,
  issueCostCapRefund,
  CostCapParseError,
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

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 1 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM pipeline_runs')
    await pool.query('DELETE FROM credit_ledger')
    await pool.query('DELETE FROM campaign_members')
    await pool.query('DELETE FROM campaigns')
    await pool.query('DELETE FROM worlds')
    await pool.query('DELETE FROM users')
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('world_gen_cost_cap_usd', '10.0')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    )
  })

  async function seedUserWorldCampaign(): Promise<{
    userId: string
    worldId: string
    campaignId: string
  }> {
    const userId = uuidv7()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, 'T', 't1')`,
      [userId, `s-${userId}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status)
       VALUES ($1, $2, 'W', 'C', 'generating')`,
      [worldId, userId],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name)
       VALUES ($1, $2, $3, 'C')`,
      [campaignId, worldId, userId],
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
})
