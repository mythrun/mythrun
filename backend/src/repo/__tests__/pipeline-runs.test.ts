import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { uuidv7 } from '../uuidv7.js'
import { createPipelineRunsRepo, pipelineRunsNs } from '../pipeline-runs.js'

describe('pipeline-runs repo', () => {
  let pool: Pool

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
  })

  afterAll(async () => {
    await pool.end()
  })

  // No blanket `DELETE FROM pipeline_runs` here: every test below inserts its
  // own campaign/world/user with fresh uuidv7 ids and queries scope strictly by
  // those ids, so a test only ever reads its own rows. A global DELETE was
  // redundant for this file and raced scoped pipeline_runs rows in other
  // parallel-fork test files (myth-ehvj). Schema bootstrap is globalSetup's job.

  async function insertCampaign(): Promise<{
    campaignId: string
    worldId: string
    userId: string
  }> {
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

  describe('getLatestFailedForWorld', () => {
    it('returns the latest failed row for a world', async () => {
      const { worldId, userId } = await insertCampaign()
      // Older failed run.
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, completed_at, error, user_id)
         VALUES ($1, $2, 'concept_intake', 'failed', now() - interval '1 hour', now() - interval '50 minutes', 'old error', $3)`,
        [uuidv7(), worldId, userId],
      )
      // Newer failed run on a different stage.
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, completed_at, error, user_id)
         VALUES ($1, $2, 'world_overview', 'failed', now() - interval '5 minutes', now(), 'latest error', $3)`,
        [uuidv7(), worldId, userId],
      )
      const repo = createPipelineRunsRepo(pool)
      const result = await repo.getLatestFailedForWorld(worldId)
      expect(result).not.toBeNull()
      expect(result?.stage).toBe('world_overview')
      expect(result?.error).toBe('latest error')
    })

    it('returns null when no failed rows exist', async () => {
      const { worldId } = await insertCampaign()
      const repo = createPipelineRunsRepo(pool)
      const result = await repo.getLatestFailedForWorld(worldId)
      expect(result).toBeNull()
    })

    it('returns null for an unknown worldId', async () => {
      const repo = createPipelineRunsRepo(pool)
      const result = await repo.getLatestFailedForWorld(uuidv7())
      expect(result).toBeNull()
    })
  })

  // ── data-layer unification: claimStage / markStage* / sumCostForWorld ─────
  // These binders home the atomic-claim + completion SQL the world-gen +
  // character processors used to issue inline. The processor / atomic-claim
  // tests cover the 'world' + 'campaign'/'campaign-user' claim paths; these
  // per-namespace tests cover the markStage* token-presence union (all three
  // kinds) + sumCostForWorld + the world-claim stuck-reset directly.

  // myth-nmg9: the campaign-user-keyed recovery seed for POST /characters.
  // Round-trip the insert, then prove the worker's campaign-user claim re-arms
  // the pre-seeded 'pending' row to 'running' (NOT a double-insert / error).
  describe('insertCharacterConceptSeedRow', () => {
    it("writes a 'pending' character_concept row keyed on (campaign_id, user_id), world_id NULL", async () => {
      const { campaignId, userId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await repo.insertCharacterConceptSeedRow({ id: uuidv7(), campaignId, userId })
      const row = await pool.query<{
        stage: string
        status: string
        user_id: string | null
        world_id: string | null
        started_at: Date | null
      }>(
        `SELECT stage, status, user_id, world_id, started_at FROM pipeline_runs
          WHERE campaign_id = $1 AND stage = 'character_concept' AND user_id = $2`,
        [campaignId, userId],
      )
      expect(row.rows).toHaveLength(1)
      expect(row.rows[0]?.status).toBe('pending')
      expect(row.rows[0]?.user_id).toBe(userId)
      expect(row.rows[0]?.world_id).toBeNull()
      expect(row.rows[0]?.started_at).toBeNull()
    })

    it("the campaign-user claim re-arms the pre-seeded 'pending' row to 'running' (single row, no double-insert)", async () => {
      const { campaignId, userId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await repo.insertCharacterConceptSeedRow({ id: uuidv7(), campaignId, userId })
      // The worker claims the campaign-user character_concept stage. The
      // pre-existing 'pending' row must be coerced to 'running' via ON CONFLICT.
      const result = await repo.claimStage({
        kind: 'campaign-user',
        campaignId,
        userId,
        stage: 'character_concept',
      })
      expect(result).toBe('claimed')
      const row = await pool.query<{ status: string; started_at: Date | null }>(
        `SELECT status, started_at FROM pipeline_runs
          WHERE campaign_id = $1 AND stage = 'character_concept' AND user_id = $2`,
        [campaignId, userId],
      )
      // Exactly one row (re-arm UPDATE, not a second INSERT) and now 'running'.
      expect(row.rows).toHaveLength(1)
      expect(row.rows[0]?.status).toBe('running')
      expect(row.rows[0]?.started_at).not.toBeNull()
    })

    it("is idempotent on resubmit — re-arms a prior 'failed' row back to 'pending' (no unique violation)", async () => {
      const { campaignId, userId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      // Simulate a prior failed attempt that already left a character_concept row.
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, completed_at, error, user_id)
         VALUES ($1, $2, 'character_concept', 'failed', now(), now(), 'boom', $3)`,
        [uuidv7(), campaignId, userId],
      )
      // Resubmit seeds again — must re-arm in place, not 500 on the unique index.
      await repo.insertCharacterConceptSeedRow({ id: uuidv7(), campaignId, userId })
      const row = await pool.query<{ status: string; error: string | null; started_at: Date | null; completed_at: Date | null }>(
        `SELECT status, error, started_at, completed_at FROM pipeline_runs
          WHERE campaign_id = $1 AND stage = 'character_concept' AND user_id = $2`,
        [campaignId, userId],
      )
      expect(row.rows).toHaveLength(1)
      expect(row.rows[0]?.status).toBe('pending')
      expect(row.rows[0]?.error).toBeNull()
      expect(row.rows[0]?.started_at).toBeNull()
      expect(row.rows[0]?.completed_at).toBeNull()
    })
  })

  describe('claimStage', () => {
    // llm-outage-resilience §3.2: a running-not-stuck row is a live in-flight
    // stage, not a lost race — the distinct result lets the stage loop STOP
    // instead of continuing past a stage another worker holds (the
    // pre-existing worker-death skip). Task 9 extends the arm to all three
    // variants (world / campaign-user / campaign) now that their loops stop.
    it("claims a fresh world-keyed row, then returns 'in-flight' on a recent re-claim", async () => {
      const { worldId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      expect(await repo.claimStage({ kind: 'world', worldId, stage: 'concept_intake' })).toBe('claimed')
      expect(await repo.claimStage({ kind: 'world', worldId, stage: 'concept_intake' })).toBe('in-flight')
    })

    it("returns 'completed' on re-entry against a completed world claim", async () => {
      const { worldId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await repo.claimStage({ kind: 'world', worldId, stage: 'concept_intake' })
      await pool.query(
        `UPDATE pipeline_runs SET status = 'completed', completed_at = now()
          WHERE world_id = $1 AND stage = 'concept_intake' AND user_id IS NULL`,
        [worldId],
      )
      expect(await repo.claimStage({ kind: 'world', worldId, stage: 'concept_intake' })).toBe('completed')
    })

    it("re-arms a failed world claim back to 'running'", async () => {
      const { worldId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await repo.claimStage({ kind: 'world', worldId, stage: 'concept_intake' })
      await pool.query(
        `UPDATE pipeline_runs SET status = 'failed', error = 'boom', completed_at = now()
          WHERE world_id = $1 AND stage = 'concept_intake' AND user_id IS NULL`,
        [worldId],
      )
      expect(await repo.claimStage({ kind: 'world', worldId, stage: 'concept_intake' })).toBe('claimed')
      const row = await pool.query<{ status: string; error: string | null }>(
        `SELECT status, error FROM pipeline_runs WHERE world_id = $1 AND stage = 'concept_intake' AND user_id IS NULL`,
        [worldId],
      )
      expect(row.rows[0]?.status).toBe('running')
      expect(row.rows[0]?.error).toBeNull()
    })

    it('reclaims a stuck (>5min running) world row via the stuck-reset path', async () => {
      const { worldId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, user_id)
         VALUES ($1, $2, 'concept_intake', 'running', now() - INTERVAL '6 minutes', NULL)`,
        [uuidv7(), worldId],
      )
      expect(await repo.claimStage({ kind: 'world', worldId, stage: 'concept_intake' })).toBe('claimed')
    })

    it('claims a campaign-user row keyed on (campaign_id, stage, user_id)', async () => {
      const { campaignId, userId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      expect(
        await repo.claimStage({ kind: 'campaign-user', campaignId, userId, stage: 'character_concept' }),
      ).toBe('claimed')
      const row = await pool.query<{ user_id: string | null; world_id: string | null }>(
        `SELECT user_id, world_id FROM pipeline_runs WHERE campaign_id = $1 AND stage = 'character_concept'`,
        [campaignId],
      )
      expect(row.rows[0]?.user_id).toBe(userId)
      expect(row.rows[0]?.world_id).toBeNull()
    })

    it('reclaims a stuck (>5min running) campaign-user row via the stuck-reset path', async () => {
      const { campaignId, userId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, user_id)
         VALUES ($1, $2, 'character_concept', 'running', now() - INTERVAL '6 minutes', $3)`,
        [uuidv7(), campaignId, userId],
      )
      expect(
        await repo.claimStage({ kind: 'campaign-user', campaignId, userId, stage: 'character_concept' }),
      ).toBe('claimed')
    })

    it("returns 'in-flight' for a campaign-user row that is running but not yet stuck", async () => {
      const { campaignId, userId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, user_id)
         VALUES ($1, $2, 'character_concept', 'running', now(), $3)`,
        [uuidv7(), campaignId, userId],
      )
      expect(
        await repo.claimStage({ kind: 'campaign-user', campaignId, userId, stage: 'character_concept' }),
      ).toBe('in-flight')
    })

    it('claims a campaign-scoped row with user_id NULL', async () => {
      const { campaignId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      expect(
        await repo.claimStage({ kind: 'campaign', campaignId, stage: 'character_integration' }),
      ).toBe('claimed')
      const row = await pool.query<{ user_id: string | null }>(
        `SELECT user_id FROM pipeline_runs WHERE campaign_id = $1 AND stage = 'character_integration' AND user_id IS NULL`,
        [campaignId],
      )
      expect(row.rows).toHaveLength(1)
    })

    it("returns 'in-flight' for a campaign-scoped row that is running but not yet stuck", async () => {
      const { campaignId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, user_id)
         VALUES ($1, $2, 'session-prep:1', 'running', now(), NULL)`,
        [uuidv7(), campaignId],
      )
      expect(
        await repo.claimStage({ kind: 'campaign', campaignId, stage: 'session-prep:1' }),
      ).toBe('in-flight')
    })

    it('reclaims a stuck (>5min running) campaign-scoped row via the stuck-reset path', async () => {
      const { campaignId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, user_id)
         VALUES ($1, $2, 'session-prep:1', 'running', now() - INTERVAL '6 minutes', NULL)`,
        [uuidv7(), campaignId],
      )
      expect(
        await repo.claimStage({ kind: 'campaign', campaignId, stage: 'session-prep:1' }),
      ).toBe('claimed')
    })
  })

  describe('markStageCompleted', () => {
    it("world variant writes cost + token columns and clears error", async () => {
      const { worldId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, error, user_id)
         VALUES ($1, $2, 'concept_intake', 'running', now(), 'prior', NULL)`,
        [uuidv7(), worldId],
      )
      await repo.markStageCompleted({
        kind: 'world', worldId, stage: 'concept_intake', costUsd: 0.5, inputTokens: 100, outputTokens: 50,
      })
      const row = await pool.query<{ status: string; cost_usd: string; input_tokens: number; output_tokens: number; error: string | null }>(
        `SELECT status, cost_usd, input_tokens, output_tokens, error FROM pipeline_runs WHERE world_id = $1 AND stage = 'concept_intake' AND user_id IS NULL`,
        [worldId],
      )
      expect(row.rows[0]?.status).toBe('completed')
      expect(Number(row.rows[0]?.cost_usd)).toBeCloseTo(0.5)
      expect(row.rows[0]?.input_tokens).toBe(100)
      expect(row.rows[0]?.output_tokens).toBe(50)
      expect(row.rows[0]?.error).toBeNull()
    })

    it('campaign-user variant writes cost + token columns keyed on user_id', async () => {
      const { campaignId, userId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, user_id)
         VALUES ($1, $2, 'character_concept', 'running', now(), $3)`,
        [uuidv7(), campaignId, userId],
      )
      await repo.markStageCompleted({
        kind: 'campaign-user', campaignId, userId, stage: 'character_concept', costUsd: 0.25, inputTokens: 10, outputTokens: 5,
      })
      const row = await pool.query<{ status: string; cost_usd: string; input_tokens: number }>(
        `SELECT status, cost_usd, input_tokens FROM pipeline_runs WHERE campaign_id = $1 AND stage = 'character_concept' AND user_id = $2`,
        [campaignId, userId],
      )
      expect(row.rows[0]?.status).toBe('completed')
      expect(Number(row.rows[0]?.cost_usd)).toBeCloseTo(0.25)
      expect(row.rows[0]?.input_tokens).toBe(10)
    })

    it('campaign variant writes ONLY cost_usd + completed_at (leaves token columns untouched)', async () => {
      const { campaignId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      // Seed pre-existing token counts; the campaign variant must NOT overwrite
      // them (its SQL names neither input_tokens nor output_tokens).
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, input_tokens, output_tokens, user_id)
         VALUES ($1, $2, 'character_integration', 'running', now(), 7, 3, NULL)`,
        [uuidv7(), campaignId],
      )
      await repo.markStageCompleted({ kind: 'campaign', campaignId, stage: 'character_integration', costUsd: 0.42 })
      const row = await pool.query<{ status: string; cost_usd: string; input_tokens: number; output_tokens: number; completed_at: Date | null }>(
        `SELECT status, cost_usd, input_tokens, output_tokens, completed_at FROM pipeline_runs WHERE campaign_id = $1 AND stage = 'character_integration' AND user_id IS NULL`,
        [campaignId],
      )
      expect(row.rows[0]?.status).toBe('completed')
      expect(Number(row.rows[0]?.cost_usd)).toBeCloseTo(0.42)
      expect(row.rows[0]?.input_tokens).toBe(7) // unchanged by the campaign variant
      expect(row.rows[0]?.output_tokens).toBe(3)
      expect(row.rows[0]?.completed_at).not.toBeNull()
    })
  })

})
