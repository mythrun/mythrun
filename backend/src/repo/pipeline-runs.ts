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
import type { ClientLike } from './_types.js'
import type { PipelineRunRow } from '../sse/derive-phase.js'

export interface FailedRunRow {
  readonly stage: string
  readonly error: string | null
}

export interface PipelineRunsRepo {
  /**
   * Returns the latest pipeline_runs row per (stage, user_id) tuple
   * for a campaign. Empty if the campaign doesn't exist (caller's
   * auth pre-handler should already have 403'd in that case).
   */
  readonly listLatestForCampaign: (campaignId: string) => Promise<readonly PipelineRunRow[]>
  /**
   * Returns the most-recently-failed pipeline_runs row for a world (any
   * stage, any user). Used by POST /resume to inspect the error and
   * decide whether to re-enqueue (transient infra blip) or 409 (stuck
   * on a not-yet-implemented stage / cost-cap fire). Spec lines 561–574.
   */
  readonly getLatestFailedForWorld: (worldId: string) => Promise<FailedRunRow | null>
  /**
   * myth-exac T20: returns true iff a pipeline_runs row exists for the
   * given (worldId, stage) tuple in `completed` status. Used by the
   * world-snapshot route to enforce the "not until stage 4 finishes"
   * gate. world-scoped (user_id IS NULL) — char-creation stages aren't
   * relevant to snapshot readiness.
   */
  readonly isStageCompleted: (worldId: string, stage: string) => Promise<boolean>
  /**
   * Cluster-A create-tx footprint: insert the concept_intake seed row
   * (status='pending', started_at NULL, user_id NULL). Composable — runs over
   * the captured client (pool OR an in-flight tx client). A missed enqueue
   * (Redis blip between COMMIT and queue.add) presents as `world_gen_failed`
   * via derivePhase instead of `not_started`, so the resume route can recover
   * from it (Hydra-Imp1, Phoenix-Imp4).
   */
  readonly insertSeedRow: (input: { id: string; worldId: string }) => Promise<void>
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

const LATEST_FAILED_QUERY = `
  SELECT stage, error
    FROM pipeline_runs
   WHERE world_id = $1
     AND status = 'failed'
   ORDER BY COALESCE(completed_at, started_at) DESC NULLS LAST
   LIMIT 1
`

// myth-exac T20: snapshot-readiness gate. The world-scoped (user_id IS
// NULL) row is what world-gen writes; char-creation stages are scoped
// to a user_id and are irrelevant to snapshot fetching.
const STAGE_COMPLETED_QUERY = `
  SELECT 1
    FROM pipeline_runs
   WHERE world_id = $1
     AND stage = $2
     AND status = 'completed'
     AND user_id IS NULL
   LIMIT 1
`

// Composable binder: every method is a single statement over a ClientLike
// (pool OR an in-flight tx client) — no `pool.connect()`, no advisory lock —
// so all three are transaction-bindable. pipelineRuns participates in
// Cluster A's transaction; its composable writers MUST be tx-bindable.
// Mirrors the worlds.ts `worldsNs` pattern.
export function pipelineRunsNs(c: ClientLike): PipelineRunsRepo {
  return {
    async listLatestForCampaign(campaignId: string): Promise<readonly PipelineRunRow[]> {
      const result = await c.query<PipelineRunRowRaw>(QUERY, [campaignId])
      return result.rows
    },
    async getLatestFailedForWorld(worldId: string): Promise<FailedRunRow | null> {
      const result = await c.query<FailedRunRow>(LATEST_FAILED_QUERY, [worldId])
      return result.rows[0] ?? null
    },
    async isStageCompleted(worldId: string, stage: string): Promise<boolean> {
      const result = await c.query(STAGE_COMPLETED_QUERY, [worldId, stage])
      return result.rows.length > 0
    },
    async insertSeedRow(input: { id: string; worldId: string }): Promise<void> {
      // SQL verbatim from executeCreateTransaction
      // (backend/src/routes/campaigns.ts).
      await c.query(
        `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, user_id)
         VALUES ($1, $2, 'concept_intake', 'pending', NULL, NULL)`,
        [input.id, input.worldId],
      )
    },
  }
}

/** Back-compat factory — pool-bound `pipelineRuns` surface. Identical shape to
 *  the pre-unification `createPipelineRunsRepo`. Direct importers keep working;
 *  new code goes through `repo.pipelineRuns`. */
export const createPipelineRunsRepo = (pool: Pool): PipelineRunsRepo => pipelineRunsNs(pool)
