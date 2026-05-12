import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { uuidv7 } from '../uuidv7.js'
import { createPipelineRunsRepo } from '../pipeline-runs.js'

describe('pipeline-runs repo', () => {
  let pool: Pool

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM pipeline_runs')
  })

  async function insertCampaign(): Promise<{ campaignId: string; worldId: string; userId: string }> {
    const userId = uuidv7()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, `s-${userId}`, 'Test', `t${userId.slice(-6)}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept) VALUES ($1, $2, 'W', 'C')`,
      [worldId, userId],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name) VALUES ($1, $2, $3, 'C')`,
      [campaignId, worldId, userId],
    )
    return { campaignId, worldId, userId }
  }

  it('returns empty array when no runs exist for the campaign', async () => {
    const { campaignId } = await insertCampaign()
    const repo = createPipelineRunsRepo(pool)
    const rows = await repo.listLatestForCampaign(campaignId)
    expect(rows).toEqual([])
  })

  it('returns world-keyed and campaign-keyed rows in one query', async () => {
    const { campaignId, worldId, userId } = await insertCampaign()
    await pool.query(
      `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, cost_usd, user_id)
       VALUES ($1, $2, 'concept_intake', 'completed', now(), 0.5, $3)`,
      [uuidv7(), worldId, userId],
    )
    await pool.query(
      `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, cost_usd, user_id)
       VALUES ($1, $2, 'character_concept', 'running', now(), 1.25, $3)`,
      [uuidv7(), campaignId, userId],
    )
    const repo = createPipelineRunsRepo(pool)
    const rows = await repo.listLatestForCampaign(campaignId)
    expect(rows).toHaveLength(2)
    const stages = rows.map((r) => r.stage).sort()
    expect(stages).toEqual(['character_concept', 'concept_intake'])
  })

  it('returns cost_usd as number, not string (NUMERIC ::float8 cast)', async () => {
    const { campaignId, worldId, userId } = await insertCampaign()
    await pool.query(
      `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, cost_usd, user_id)
       VALUES ($1, $2, 'concept_intake', 'completed', now(), 0.500000, $3)`,
      [uuidv7(), worldId, userId],
    )
    const repo = createPipelineRunsRepo(pool)
    const rows = await repo.listLatestForCampaign(campaignId)
    expect(rows[0]).toBeDefined()
    expect(typeof rows[0]?.cost_usd).toBe('number')
    expect(rows[0]?.cost_usd).toBeCloseTo(0.5)
  })

  it('returns only the LATEST row per (stage, user_id) when a stage has retries', async () => {
    // Schema's idx_pipeline_runs_unique forbids two rows with the same
    // (COALESCE(world_id, campaign_id), stage, user_id) tuple, so two
    // retries cannot share a world-keying. We exercise the DISTINCT ON
    // dedup by inserting one world-keyed row and one campaign-keyed row
    // for the same (stage, user_id) — the unique index permits this
    // because COALESCE(world_id, campaign_id) differs, and the query's
    // DISTINCT ON (stage, user_id) collapses the pair to the latest.
    const { campaignId, worldId, userId } = await insertCampaign()
    await pool.query(
      `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, cost_usd, user_id)
       VALUES ($1, $2, 'concept_intake', 'failed', now() - interval '1 hour', 0.1, $3)`,
      [uuidv7(), worldId, userId],
    )
    await pool.query(
      `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, cost_usd, user_id)
       VALUES ($1, $2, 'concept_intake', 'completed', now(), 0.3, $3)`,
      [uuidv7(), campaignId, userId],
    )
    const repo = createPipelineRunsRepo(pool)
    const rows = await repo.listLatestForCampaign(campaignId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('completed')
    expect(rows[0]?.cost_usd).toBeCloseTo(0.3)
  })
})
