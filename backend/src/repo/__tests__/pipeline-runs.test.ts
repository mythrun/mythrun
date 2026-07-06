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
    it('claims a fresh world-keyed row, then returns lost-race on a recent re-claim', async () => {
      const { worldId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      expect(await repo.claimStage({ kind: 'world', worldId, stage: 'concept_intake' })).toBe('claimed')
      expect(await repo.claimStage({ kind: 'world', worldId, stage: 'concept_intake' })).toBe('lost-race')
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

    it('returns lost-race for a campaign-user row that is running but not yet stuck', async () => {
      const { campaignId, userId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, user_id)
         VALUES ($1, $2, 'character_concept', 'running', now(), $3)`,
        [uuidv7(), campaignId, userId],
      )
      expect(
        await repo.claimStage({ kind: 'campaign-user', campaignId, userId, stage: 'character_concept' }),
      ).toBe('lost-race')
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

  describe('markStageFailed', () => {
    it('world variant writes the error keyed on user_id IS NULL', async () => {
      const { worldId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, user_id)
         VALUES ($1, $2, 'concept_intake', 'running', now(), NULL)`,
        [uuidv7(), worldId],
      )
      await repo.markStageFailed({ kind: 'world', worldId, stage: 'concept_intake', error: 'world-err' })
      const row = await pool.query<{ status: string; error: string | null }>(
        `SELECT status, error FROM pipeline_runs WHERE world_id = $1 AND stage = 'concept_intake' AND user_id IS NULL`,
        [worldId],
      )
      expect(row.rows[0]?.status).toBe('failed')
      expect(row.rows[0]?.error).toBe('world-err')
    })

    it('campaign-user variant writes the error keyed on user_id', async () => {
      const { campaignId, userId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, user_id)
         VALUES ($1, $2, 'character_sheet', 'running', now(), $3)`,
        [uuidv7(), campaignId, userId],
      )
      await repo.markStageFailed({ kind: 'campaign-user', campaignId, userId, stage: 'character_sheet', error: 'cu-err' })
      const row = await pool.query<{ status: string; error: string | null }>(
        `SELECT status, error FROM pipeline_runs WHERE campaign_id = $1 AND stage = 'character_sheet' AND user_id = $2`,
        [campaignId, userId],
      )
      expect(row.rows[0]?.status).toBe('failed')
      expect(row.rows[0]?.error).toBe('cu-err')
    })

    it('campaign variant writes the error keyed on user_id IS NULL', async () => {
      const { campaignId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, user_id)
         VALUES ($1, $2, 'character_integration', 'running', now(), NULL)`,
        [uuidv7(), campaignId],
      )
      await repo.markStageFailed({ kind: 'campaign', campaignId, stage: 'character_integration', error: 'c-err' })
      const row = await pool.query<{ status: string; error: string | null }>(
        `SELECT status, error FROM pipeline_runs WHERE campaign_id = $1 AND stage = 'character_integration' AND user_id IS NULL`,
        [campaignId],
      )
      expect(row.rows[0]?.status).toBe('failed')
      expect(row.rows[0]?.error).toBe('c-err')
    })
  })

  describe('sumCostForWorld', () => {
    it('sums only completed world-gen (user_id IS NULL) rows and returns a JS number', async () => {
      const { worldId, userId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
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
      // A per-user row must NOT count (user_id filter).
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, cost_usd, user_id)
         VALUES ($1, $2, 'character_concept', 'completed', now(), 5.00, $3)`,
        [uuidv7(), worldId, userId],
      )
      const sum = await repo.sumCostForWorld(worldId)
      expect(typeof sum).toBe('number')
      expect(sum).toBeCloseTo(1.5)
    })

    it('returns 0 for a world with no completed rows', async () => {
      const { worldId } = await insertCampaign()
      expect(await pipelineRunsNs(pool).sumCostForWorld(worldId)).toBe(0)
    })
  })

  // myth-gp2c Cluster C: the character-integration cost-cap pre-flight sum.
  describe('sumCharacterCreationStageCosts', () => {
    it('sums completed character_concept/sheet/integration rows for the campaign', async () => {
      const { campaignId, userId } = await insertCampaign()
      // A second member so the "must NOT count" failed row has a distinct
      // (campaign_id, stage, user_id) tuple (idx_pipeline_runs_unique).
      const userId2 = uuidv7()
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId2, `s-${userId2}`, 'Test2', `t${userId2.slice(-6)}`],
      )
      const repo = pipelineRunsNs(pool)
      // Counts: per-player character_concept + character_sheet, and the
      // campaign-scoped character_integration (user_id IS NULL).
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, cost_usd, user_id)
         VALUES ($1, $2, 'character_concept', 'completed', now(), 1.00, $3)`,
        [uuidv7(), campaignId, userId],
      )
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, cost_usd, user_id)
         VALUES ($1, $2, 'character_sheet', 'completed', now(), 2.00, $3)`,
        [uuidv7(), campaignId, userId],
      )
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, cost_usd, user_id)
         VALUES ($1, $2, 'character_integration', 'completed', now(), 0.50, NULL)`,
        [uuidv7(), campaignId],
      )
      // A 'failed' character-creation row (distinct user) + an unrelated
      // completed stage must NOT count.
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, cost_usd, user_id)
         VALUES ($1, $2, 'character_sheet', 'failed', now(), 9.99, $3)`,
        [uuidv7(), campaignId, userId2],
      )
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, cost_usd, user_id)
         VALUES ($1, $2, 'concept_intake', 'completed', now(), 4.00, NULL)`,
        [uuidv7(), campaignId],
      )
      const sum = await repo.sumCharacterCreationStageCosts(campaignId)
      expect(typeof sum).toBe('number')
      expect(sum).toBeCloseTo(3.5)
    })

    it('returns 0 for a campaign with no completed character-creation rows', async () => {
      const { campaignId } = await insertCampaign()
      expect(await pipelineRunsNs(pool).sumCharacterCreationStageCosts(campaignId)).toBe(0)
    })
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

  describe('resetStage (MYT-63)', () => {
    it("coerces a completed campaign-scoped stage row back to 'pending', cost_usd intact", async () => {
      const { campaignId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await pool.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, completed_at, cost_usd, error, user_id)
         VALUES ($1, $2, 'session-prep:1', 'completed', now(), now(), 0.42, NULL, NULL)`,
        [uuidv7(), campaignId],
      )
      await repo.resetStage({ kind: 'campaign', campaignId, stage: 'session-prep:1' })
      const row = await pool.query<{
        status: string
        started_at: Date | null
        completed_at: Date | null
        cost_usd: string | null
      }>(
        `SELECT status, started_at, completed_at, cost_usd FROM pipeline_runs
          WHERE campaign_id = $1 AND stage = 'session-prep:1' AND user_id IS NULL`,
        [campaignId],
      )
      expect(row.rows[0]?.status).toBe('pending')
      expect(row.rows[0]?.started_at).toBeNull()
      expect(row.rows[0]?.completed_at).toBeNull()
      expect(Number(row.rows[0]?.cost_usd)).toBeCloseTo(0.42)
    })

    it('is idempotent when no matching row exists (no-op, resolves undefined)', async () => {
      const { campaignId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await expect(
        repo.resetStage({ kind: 'campaign', campaignId, stage: 'session-prep:9' }),
      ).resolves.toBeUndefined()
    })

    it('round-trip: reset a completed stage -> claimStage re-claims (not a completed skip)', async () => {
      const { campaignId } = await insertCampaign()
      const repo = pipelineRunsNs(pool)
      await repo.claimStage({ kind: 'campaign', campaignId, stage: 'session-prep:1' })
      await pool.query(
        `UPDATE pipeline_runs SET status='completed', completed_at=now()
          WHERE campaign_id=$1 AND stage='session-prep:1' AND user_id IS NULL`,
        [campaignId],
      )
      await repo.resetStage({ kind: 'campaign', campaignId, stage: 'session-prep:1' })
      expect(await repo.claimStage({ kind: 'campaign', campaignId, stage: 'session-prep:1' })).toBe(
        'claimed',
      )
    })
  })

  // MYT-89 audit ③: per-stage average duration for the world-gen loading-bar
  // ETA. The query is GLOBAL (GROUP BY stage, no id scope), so each test uses a
  // per-invocation UNIQUE stage name — the response's row for that stage
  // aggregates ONLY this test's seeded rows, immune to other files' /prior
  // runs' pipeline_runs rows.
  describe('avgDurationPerStage', () => {
    // Insert a completed pipeline_runs row for `stage` on a fresh world with a
    // known duration. Distinct worlds per call so two rows can share a stage
    // without tripping idx_pipeline_runs_unique (world_id, stage, user_id).
    async function insertCompletedRun(stage: string, durationSeconds: number): Promise<void> {
      const { worldId } = await insertCampaign()
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, completed_at, user_id)
         VALUES ($1, $2, $3, 'completed', now() - ($4 || ' seconds')::interval, now(), NULL)`,
        [uuidv7(), worldId, stage, String(durationSeconds)],
      )
    }

    it('averages completed durations per stage (ms), returning avgMs as a number', async () => {
      const stage = `myt89-avg-${uuidv7().slice(-12)}`
      await insertCompletedRun(stage, 2) // 2000ms
      await insertCompletedRun(stage, 4) // 4000ms → avg 3000ms
      const rows = await pipelineRunsNs(pool).avgDurationPerStage()
      const mine = rows.find((r) => r.stage === stage)
      expect(mine).toBeDefined()
      expect(typeof mine?.avgMs).toBe('number')
      expect(mine?.avgMs).toBe(3000)
    })

    it("excludes non-completed and missing-timestamp rows from the average", async () => {
      const stage = `myt89-excl-${uuidv7().slice(-12)}`
      await insertCompletedRun(stage, 6) // 6000ms — the ONLY row that should count
      // A 'failed' row with a real duration (status filter must drop it).
      const { worldId: wFailed } = await insertCampaign()
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, completed_at, user_id)
         VALUES ($1, $2, $3, 'failed', now() - interval '100 seconds', now(), NULL)`,
        [uuidv7(), wFailed, stage],
      )
      // A 'running' row (completed_at NULL) — the completed_at IS NOT NULL guard drops it.
      const { worldId: wRunning } = await insertCampaign()
      await pool.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, completed_at, user_id)
         VALUES ($1, $2, $3, 'running', now() - interval '100 seconds', NULL, NULL)`,
        [uuidv7(), wRunning, stage],
      )
      const rows = await pipelineRunsNs(pool).avgDurationPerStage()
      const mine = rows.find((r) => r.stage === stage)
      // Average is 6000, not skewed by the 100s failed/running rows.
      expect(mine?.avgMs).toBe(6000)
    })

    it('returns [] on empty history (cold-start: GROUP BY yields zero rows)', async () => {
      // Deterministic via a stub client — the live query is global, so a real
      // DB is never truly empty under parallel test load. The map-over-[] is the
      // cold-start path the FE relies on.
      const emptyClient = {
        query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      } as unknown as Parameters<typeof pipelineRunsNs>[0]
      expect(await pipelineRunsNs(emptyClient).avgDurationPerStage()).toEqual([])
    })
  })
})
