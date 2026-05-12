// Repo helper for the pipeline status surface. Returns the LATEST
// pipeline_runs row per (stage, user_id) tuple for a campaign — both
// world-keyed and campaign-keyed rows are unioned through the
// composition rule documented in parent spec §9 Resume Endpoint.
//
// cost_usd is NUMERIC(10,6) in the schema; `pg` returns NUMERIC as
// string by default. The query casts to ::float8 so the column lands
// in JS as `number`. This is local to the query (no global pg.types
// parser override).

import type { Pool } from 'pg'
import type { PipelineRunRow } from '../sse/derive-phase.js'

export interface PipelineRunsRepo {
  /**
   * Returns the latest pipeline_runs row per (stage, user_id) tuple
   * for a campaign. Empty if the campaign doesn't exist (caller's
   * auth pre-handler should already have 403'd in that case).
   */
  readonly listLatestForCampaign: (campaignId: string) => Promise<readonly PipelineRunRow[]>
}

interface PipelineRunRowRaw {
  readonly stage: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly user_id: string | null
  readonly world_id: string | null
  readonly campaign_id: string | null
  readonly started_at: Date | null
  readonly completed_at: Date | null
  readonly cost_usd: number
}

const QUERY = `
  WITH all_runs AS (
    SELECT stage, status, user_id, world_id, campaign_id,
           started_at, completed_at, COALESCE(cost_usd, 0)::float8 AS cost_usd
    FROM pipeline_runs
    WHERE campaign_id = $1
       OR world_id = (SELECT world_id FROM campaigns WHERE id = $1)
  )
  SELECT DISTINCT ON (stage, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid))
         stage, status, user_id, world_id, campaign_id,
         started_at, completed_at, cost_usd
  FROM all_runs
  ORDER BY stage,
           COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
           started_at DESC NULLS LAST
`

export function createPipelineRunsRepo(pool: Pool): PipelineRunsRepo {
  return {
    async listLatestForCampaign(campaignId: string): Promise<readonly PipelineRunRow[]> {
      const result = await pool.query<PipelineRunRowRaw>(QUERY, [campaignId])
      return result.rows
    },
  }
}
