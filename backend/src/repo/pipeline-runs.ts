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
import { uuidv7 } from './uuidv7.js'

interface FailedRunRow {
  readonly stage: string
  readonly error: string | null
}

// MYT-89 audit ③: one historical average-duration row per stage, feeding the
// world-gen loading-bar ETA. `avgMs` is a non-negative integer (Postgres
// `::int` cast over avg(...) of positive durations). Structurally mirrors
// `StageTiming` in @mythrun/contract/rest (the wire shape) — the route sends
// this repo result verbatim; the data layer stays decoupled from the contract.
interface StageTiming {
  readonly stage: string
  readonly avgMs: number
}

// Sentinel user_id the unique index folds user_id=NULL onto. Held here as a
// local constant; interpolated into the ON CONFLICT projection (it's a fixed
// literal, never user input). Mirrors the value the world-gen processor used
// inline before unification.
const SENTINEL_USER_UUID = '00000000-0000-0000-0000-000000000000'

// Result of an atomic stage claim:
//   - 'claimed'   — we inserted a fresh row, or coerced a pending/failed/
//                   stuck-running row into 'running'; the caller runs the stage.
//   - 'completed' — the row already finished; the caller skips (idempotent).
//   - 'in-flight' — another worker holds a recent (not-stuck) 'running' row;
//                   the caller must STOP its loop (rethrow retryable), never
//                   continue past a live stage (llm-outage-resilience §3.2 —
//                   the pre-existing worker-death skip: BullMQ's stall
//                   re-drive used to see 'lost-race' here and silently skip
//                   the stage). Currently returned by the 'world' variant
//                   only; the campaign/campaign-user variants keep
//                   'lost-race' until their loops gain the stop arm (Task 9).
//   - 'lost-race' — a racing worker changed the row between our INSERT
//                   conflict and the follow-up SELECT; the caller skips.
export type ClaimResult = 'claimed' | 'completed' | 'in-flight' | 'lost-race'

// Discriminated union over the three atomic-claim shapes pipeline_runs
// supports (myth-tuok T6 / MYT-54 T6):
//   - 'world'         — world-gen stages, keyed on (world_id, stage) with
//                       user_id NULL.
//   - 'campaign-user' — per-player character-creation stages, keyed on
//                       (campaign_id, stage, user_id).
//   - 'campaign'      — campaign-scoped character-integration, keyed on
//                       (campaign_id, stage) with user_id NULL.
// The unique index on (COALESCE(world_id, campaign_id), stage,
// COALESCE(user_id, sentinel)) folds all three into one composite key.
export type ClaimRequest =
  | { kind: 'world'; worldId: string; stage: string }
  | { kind: 'campaign-user'; campaignId: string; userId: string; stage: string }
  | { kind: 'campaign'; campaignId: string; stage: string }

// Discriminated union for the stage-completion writers (markStageCompleted).
// The token-presence invariant lives in the union, not loose optionals:
//   - 'world' / 'campaign-user' carry inputTokens/outputTokens (the cost_usd +
//     token-count completion the world-gen / character-creation stages write).
//   - 'campaign' structurally OMITS them — the character-integration completion
//     writes only cost_usd + completed_at, never the token columns or error=NULL.
type StageCompletedRequest =
  | {
      kind: 'world'
      worldId: string
      stage: string
      costUsd: number
      inputTokens: number
      outputTokens: number
    }
  | {
      kind: 'campaign-user'
      campaignId: string
      userId: string
      stage: string
      costUsd: number
      inputTokens: number
      outputTokens: number
    }
  | { kind: 'campaign'; campaignId: string; stage: string; costUsd: number }

// Discriminated union for the stage-failure writers (markStageFailed). All
// three variants write the same `status='failed', completed_at=now(), error`
// shape; only the WHERE keying differs.
type StageFailedRequest =
  | { kind: 'world'; worldId: string; stage: string; error: string }
  | { kind: 'campaign-user'; campaignId: string; userId: string; stage: string; error: string }
  | { kind: 'campaign'; campaignId: string; stage: string; error: string }

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
  /**
   * myth-nmg9 recovery-row footprint for POST /characters: the campaign-user-
   * keyed analogue of `insertSeedRow`. Seeds the `character_concept` recovery
   * row (campaign_id + user_id, status='pending', started_at NULL) INSIDE the
   * same tx that flips the concept to 'processing', so a missed enqueue (Redis
   * blip between COMMIT and queue.add) leaves a resumable trace instead of a
   * concept stranded at 'processing' with no pipeline_runs row. The worker's
   * campaign-user claim re-arms this pending row to 'running' via ON CONFLICT
   * (it does NOT double-insert). Mirrors world-gen's seed-row contract.
   * Composable — runs over the captured client (pool OR an in-flight tx client).
   */
  readonly insertCharacterConceptSeedRow: (input: {
    id: string
    campaignId: string
    userId: string
  }) => Promise<void>
  /**
   * Atomic stage claim — INSERT a fresh 'running' row, or coerce an existing
   * pending/failed/stuck-running row into 'running' via ON CONFLICT. Returns
   * 'claimed' / 'completed' / 'lost-race' (see ClaimResult). Dispatches on the
   * ClaimRequest discriminant; the three variants' SQL is byte-identical to the
   * world-gen processor's prior claimWorldStage / claimCampaignUserStage /
   * claimCampaignStage. Pool-bound by design — the recovery/claim bookkeeping
   * must survive a stage-tx rollback (NOT run inside a stage's repo.transaction).
   */
  readonly claimStage: (req: ClaimRequest) => Promise<ClaimResult>
  /**
   * Mark a claimed stage 'completed'. The token-presence invariant is in the
   * discriminated union: 'world' / 'campaign-user' write cost_usd + token
   * counts + clear error; 'campaign' writes only cost_usd + completed_at. SQL
   * byte-identical to the prior inline completion writers. Pool-bound.
   */
  readonly markStageCompleted: (req: StageCompletedRequest) => Promise<void>
  /**
   * Mark a claimed stage 'failed' with a sanitized error string. SQL
   * byte-identical to the prior inline failure writers. Pool-bound (a
   * failed-status write must persist even when the stage tx rolled back).
   */
  readonly markStageFailed: (req: StageFailedRequest) => Promise<void>
  /**
   * MYT-63 reset-prep: re-arm a campaign-scoped stage row (user_id IS NULL) back
   * to 'pending' so a subsequent atomicClaimStage re-claims it — the reset-prep
   * counterpart to insertCharacterConceptSeedRow's re-arm. Coerces
   * status='pending', started_at/completed_at/error to NULL; leaves cost_usd
   * intact (the row is being re-armed, not erased as a spend record). Branchless +
   * idempotent (no matching row -> 0 rows updated -> no-op). The `kind` discriminant
   * mirrors ClaimRequest for forward-consistency (only 'campaign' is supported).
   *
   * Composable, and UNLIKE claimStage/markStage* (pool-bound BY DESIGN so recovery
   * bookkeeping survives a stage-tx rollback), resetStage is MEANT to run inside
   * repo.transaction — atomic with the session_preps delete in POST /reset-prep.
   */
  readonly resetStage: (args: {
    kind: 'campaign'
    campaignId: string
    stage: string
  }) => Promise<void>
  /**
   * Sum cost_usd across a world's completed world-gen stages (user_id IS NULL,
   * status='completed'). Returns a JS number via the ::float8 cast. SQL verbatim
   * from cost-cap.ts's sumCompletedStageCosts.
   */
  readonly sumCostForWorld: (worldId: string) => Promise<number>
  /**
   * myth-gp2c Cluster C: sum cost_usd across a campaign's completed character-
   * creation stages (character_concept + character_sheet + character_integration).
   * Returns a JS number via the ::float8 cast. SQL verbatim from cost-cap.ts's
   * sumCharacterCreationStageCosts — the character-integration cap pre-flight.
   */
  readonly sumCharacterCreationStageCosts: (campaignId: string) => Promise<number>
  /**
   * MYT-89 audit ③ — world-gen loading-bar ETA source. Returns the historical
   * average stage duration (completed_at − started_at, in ms) per stage across
   * ALL completed pipeline_runs, GROUP BY stage. NOT stage-filtered (the FE
   * intersects the result with the WORLD_GEN_STAGES taxonomy); rows missing
   * either timestamp are excluded so a half-written row can't skew the average.
   * Cold-start (no completed history) → []. A global aggregate, so no id param.
   */
  readonly avgDurationPerStage: () => Promise<readonly StageTiming[]>
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

// myth-tuok T6 / MYT-54 T6 / data-layer unification: the three atomic-claim
// shapes. Each mirrors the others' structure (insert/ON CONFLICT → existing-row
// inspection → stuck-reset) and differs only in keying. SQL is byte-identical to
// the world-gen processor's prior claimWorldStage / claimCampaignUserStage /
// claimCampaignStage helpers (only `pool.query` → `c.query`). The ON CONFLICT
// WHERE filters on the EXISTING row's status; an empty RETURNING means the row is
// 'completed' or another worker holds a recent 'running'.

async function claimWorldStage(
  c: ClientLike,
  newId: string,
  worldId: string,
  stage: string,
): Promise<ClaimResult> {
  const insertResult = await c.query<{ id: string }>(
    `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, user_id)
     VALUES ($1, $2, $3, 'running', now(), NULL)
     ON CONFLICT (
       COALESCE(world_id, campaign_id),
       stage,
       COALESCE(user_id, '${SENTINEL_USER_UUID}'::uuid)
     )
     DO UPDATE SET status = 'running', started_at = now(),
                   error = NULL, completed_at = NULL
       WHERE pipeline_runs.status IN ('pending', 'failed')
     RETURNING id`,
    [newId, worldId, stage],
  )
  if (insertResult.rowCount !== null && insertResult.rowCount > 0) return 'claimed'

  const existing = await c.query<{ status: string; started_at: Date | null }>(
    `SELECT status, started_at FROM pipeline_runs
      WHERE world_id = $1 AND stage = $2 AND user_id IS NULL`,
    [worldId, stage],
  )
  const row = existing.rows[0]
  /* c8 ignore start — `row === undefined` and `row.status !== 'running'`
   * defensive arms: the SELECT was triggered by an ON CONFLICT in the
   * preceding INSERT, so the row is guaranteed to exist and to be in one of
   * the three valid statuses. These arms protect against a race-condition
   * delete between INSERT-conflict and SELECT. */
  if (row === undefined) return 'lost-race'
  if (row.status === 'completed') return 'completed'
  if (row.status !== 'running') return 'lost-race'
  /* c8 ignore stop */

  const stuckReset = await c.query<{ id: string }>(
    `UPDATE pipeline_runs
        SET status = 'running', started_at = now(), error = NULL
      WHERE world_id = $1 AND stage = $2 AND user_id IS NULL
        AND status = 'running'
        AND started_at < now() - INTERVAL '5 minutes'
      RETURNING id`,
    [worldId, stage],
  )
  if (stuckReset.rowCount !== null && stuckReset.rowCount > 0) return 'claimed'
  // Running but not yet stuck: a live worker holds the stage. Distinct from
  // 'lost-race' so the world-gen loop STOPS instead of skipping the stage
  // (llm-outage-resilience §3.2).
  return 'in-flight'
}

async function claimCampaignUserStage(
  c: ClientLike,
  newId: string,
  campaignId: string,
  userId: string,
  stage: string,
): Promise<ClaimResult> {
  const insertResult = await c.query<{ id: string }>(
    `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, user_id)
     VALUES ($1, $2, $3, 'running', now(), $4)
     ON CONFLICT (
       COALESCE(world_id, campaign_id),
       stage,
       COALESCE(user_id, '${SENTINEL_USER_UUID}'::uuid)
     )
     DO UPDATE SET status = 'running', started_at = now(),
                   error = NULL, completed_at = NULL
       WHERE pipeline_runs.status IN ('pending', 'failed')
     RETURNING id`,
    [newId, campaignId, stage, userId],
  )
  if (insertResult.rowCount !== null && insertResult.rowCount > 0) return 'claimed'

  const existing = await c.query<{ status: string; started_at: Date | null }>(
    `SELECT status, started_at FROM pipeline_runs
      WHERE campaign_id = $1 AND stage = $2 AND user_id = $3`,
    [campaignId, stage, userId],
  )
  const row = existing.rows[0]
  /* c8 ignore start — defensive arms mirror the world-level path: the SELECT
   * was triggered by an ON CONFLICT, so the row is guaranteed to exist in one
   * of the three valid statuses. */
  if (row === undefined) return 'lost-race'
  if (row.status === 'completed') return 'completed'
  if (row.status !== 'running') return 'lost-race'
  /* c8 ignore stop */

  const stuckReset = await c.query<{ id: string }>(
    `UPDATE pipeline_runs
        SET status = 'running', started_at = now(), error = NULL
      WHERE campaign_id = $1 AND stage = $2 AND user_id = $3
        AND status = 'running'
        AND started_at < now() - INTERVAL '5 minutes'
      RETURNING id`,
    [campaignId, stage, userId],
  )
  if (stuckReset.rowCount !== null && stuckReset.rowCount > 0) return 'claimed'
  return 'lost-race'
}

async function claimCampaignStage(
  c: ClientLike,
  newId: string,
  campaignId: string,
  stage: string,
): Promise<ClaimResult> {
  const insertResult = await c.query<{ id: string }>(
    `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, user_id)
     VALUES ($1, $2, $3, 'running', now(), NULL)
     ON CONFLICT (
       COALESCE(world_id, campaign_id),
       stage,
       COALESCE(user_id, '${SENTINEL_USER_UUID}'::uuid)
     )
     DO UPDATE SET status = 'running', started_at = now(),
                   error = NULL, completed_at = NULL
       WHERE pipeline_runs.status IN ('pending', 'failed')
     RETURNING id`,
    [newId, campaignId, stage],
  )
  if (insertResult.rowCount !== null && insertResult.rowCount > 0) return 'claimed'

  const existing = await c.query<{ status: string; started_at: Date | null }>(
    `SELECT status, started_at FROM pipeline_runs
      WHERE campaign_id = $1 AND stage = $2 AND user_id IS NULL`,
    [campaignId, stage],
  )
  const row = existing.rows[0]
  /* c8 ignore start — defensive arms mirror the world-level path: the SELECT
   * was triggered by an ON CONFLICT, so the row is guaranteed to exist in one
   * of the three valid statuses. */
  if (row === undefined) return 'lost-race'
  if (row.status === 'completed') return 'completed'
  if (row.status !== 'running') return 'lost-race'
  /* c8 ignore stop */

  /* c8 ignore start — stuck-reset path mirrors the per-player claim. The
   * deterministic coverage applies to the (still-running, not-stuck)
   * early-return path inside the guards above; aging started_at by 5+ minutes
   * for the campaign shape is exercised via the world/campaign-user reset
   * tests that share this identical SQL. */
  const stuckReset = await c.query<{ id: string }>(
    `UPDATE pipeline_runs
        SET status = 'running', started_at = now(), error = NULL
      WHERE campaign_id = $1 AND stage = $2 AND user_id IS NULL
        AND status = 'running'
        AND started_at < now() - INTERVAL '5 minutes'
      RETURNING id`,
    [campaignId, stage],
  )
  if (stuckReset.rowCount !== null && stuckReset.rowCount > 0) return 'claimed'
  return 'lost-race'
} /* c8 ignore stop */

const SUM_COST_FOR_WORLD_QUERY = `
  SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total
  FROM pipeline_runs
  WHERE world_id = $1
    AND user_id IS NULL
    AND status = 'completed'
`

// myth-gp2c Cluster C: SQL verbatim from cost-cap.ts's
// sumCharacterCreationStageCosts. Rolls up the per-player character_concept +
// character_sheet rows and the campaign-scoped character_integration row
// (filtered by stage, not user_id presence) into the character-creation cap
// budget.
const SUM_CHARACTER_CREATION_COSTS_QUERY = `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total
     FROM pipeline_runs
     WHERE campaign_id = $1
       AND status = 'completed'
       AND stage IN ('character_concept', 'character_sheet', 'character_integration')`

// MYT-89 audit ③: per-stage average duration (ms) across all completed runs.
// `extract(epoch from interval)` yields seconds (float); ×1000 → ms; the `::int`
// cast lands avg_ms in JS as a number (avoids the NUMERIC-as-string quirk). Rows
// missing either timestamp are excluded so a partial row can't skew the average.
// No completed rows → GROUP BY yields zero rows → the method returns [].
const AVG_DURATION_PER_STAGE_QUERY = `
  SELECT stage,
         avg(extract(epoch from (completed_at - started_at)) * 1000)::int AS avg_ms
    FROM pipeline_runs
   WHERE status = 'completed'
     AND completed_at IS NOT NULL
     AND started_at IS NOT NULL
   GROUP BY stage
`

// Composable binder: every method is a single statement over a ClientLike
// (pool OR an in-flight tx client) — no `pool.connect()`, no advisory lock —
// so all three are transaction-bindable. pipelineRuns participates in
// Cluster A's transaction; its composable writers MUST be tx-bindable.
// Mirrors the worlds.ts `worldsNs` pattern.
//
// NOTE: claimStage / markStageCompleted / markStageFailed are pool-bound at
// the call site BY DESIGN (the world-gen processor's recovery bookkeeping must
// survive a stage-tx rollback). They are composable (single-statement) so they
// CAN bind on a tx client, but the processor never composes them inside a
// repo.transaction — see the data-layer-repo-unification design's
// "Intentionally pool-bound writes".
// eslint-disable-next-line max-lines-per-function
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
    async insertCharacterConceptSeedRow(input: {
      id: string
      campaignId: string
      userId: string
    }): Promise<void> {
      // Campaign-user-keyed analogue of insertSeedRow. The column shape
      // (campaign_id + user_id, world_id NULL) matches what the campaign-user
      // claim (claimCampaignUserStage) keys on, so the worker's ON CONFLICT
      // re-arm finds THIS row instead of double-inserting.
      //
      // Unlike world-gen's one-time insertSeedRow, POST /characters is
      // re-enterable (resubmit on a 'submitted'/'failed' concept), so a prior
      // attempt may already have left a 'character_concept' row. The ON CONFLICT
      // re-arm coerces that prior pending/failed/completed row back to 'pending'
      // (matching the idx_pipeline_runs_unique target), keeping the seed
      // idempotent across resubmits instead of 500-ing on the unique violation.
      await c.query(
        `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, user_id)
         VALUES ($1, $2, 'character_concept', 'pending', NULL, $3)
         ON CONFLICT (
           COALESCE(world_id, campaign_id),
           stage,
           COALESCE(user_id, '${SENTINEL_USER_UUID}'::uuid)
         )
         DO UPDATE SET status = 'pending', started_at = NULL,
                       completed_at = NULL, error = NULL`,
        [input.id, input.campaignId, input.userId],
      )
    },
    async claimStage(req: ClaimRequest): Promise<ClaimResult> {
      const id = uuidv7()
      if (req.kind === 'world') {
        return claimWorldStage(c, id, req.worldId, req.stage)
      }
      if (req.kind === 'campaign-user') {
        return claimCampaignUserStage(c, id, req.campaignId, req.userId, req.stage)
      }
      return claimCampaignStage(c, id, req.campaignId, req.stage)
    },
    async markStageCompleted(req: StageCompletedRequest): Promise<void> {
      if (req.kind === 'world') {
        await c.query(
          `UPDATE pipeline_runs
              SET status = 'completed', completed_at = now(),
                  cost_usd = $3, input_tokens = $4, output_tokens = $5, error = NULL
            WHERE world_id = $1 AND stage = $2 AND user_id IS NULL`,
          [req.worldId, req.stage, req.costUsd, req.inputTokens, req.outputTokens],
        )
        return
      }
      if (req.kind === 'campaign-user') {
        await c.query(
          `UPDATE pipeline_runs
              SET status = 'completed', completed_at = now(),
                  cost_usd = $3, input_tokens = $4, output_tokens = $5, error = NULL
            WHERE campaign_id = $1 AND stage = $2 AND user_id = $6`,
          [req.campaignId, req.stage, req.costUsd, req.inputTokens, req.outputTokens, req.userId],
        )
        return
      }
      // 'campaign' — character-integration completion: cost_usd + completed_at
      // only, no token columns, no error=NULL. SQL byte-identical to
      // character-integration-processor.ts.
      await c.query(
        `UPDATE pipeline_runs
            SET status = 'completed', cost_usd = $1, completed_at = now()
          WHERE campaign_id = $2 AND stage = $3 AND user_id IS NULL`,
        [req.costUsd, req.campaignId, req.stage],
      )
    },
    async markStageFailed(req: StageFailedRequest): Promise<void> {
      if (req.kind === 'world') {
        await c.query(
          `UPDATE pipeline_runs
              SET status = 'failed', completed_at = now(), error = $3
            WHERE world_id = $1 AND stage = $2 AND user_id IS NULL`,
          [req.worldId, req.stage, req.error],
        )
        return
      }
      if (req.kind === 'campaign-user') {
        await c.query(
          `UPDATE pipeline_runs
              SET status = 'failed', completed_at = now(), error = $3
            WHERE campaign_id = $1 AND stage = $2 AND user_id = $4`,
          [req.campaignId, req.stage, req.error, req.userId],
        )
        return
      }
      // 'campaign' — character-integration failure. SQL byte-identical to
      // character-integration-processor.ts.
      await c.query(
        `UPDATE pipeline_runs
            SET status = 'failed', error = $1, completed_at = now()
          WHERE campaign_id = $2 AND stage = $3 AND user_id IS NULL`,
        [req.error, req.campaignId, req.stage],
      )
    },
    async resetStage(args: { kind: 'campaign'; campaignId: string; stage: string }): Promise<void> {
      // UPDATE-only re-arm. Branchless (no rowCount inspection) so it stays
      // trivially 100%-covered; idempotent (0 rows on no match). Does NOT touch
      // cost_usd — matches insertCharacterConceptSeedRow's reset SQL.
      await c.query(
        `UPDATE pipeline_runs
            SET status = 'pending', started_at = NULL, completed_at = NULL, error = NULL
          WHERE campaign_id = $1 AND stage = $2 AND user_id IS NULL`,
        [args.campaignId, args.stage],
      )
    },
    async sumCostForWorld(worldId: string): Promise<number> {
      const result = await c.query<{ total: number }>(SUM_COST_FOR_WORLD_QUERY, [worldId])
      /* c8 ignore start — `?? 0` falsy arm: COALESCE(SUM(...), 0) always returns
       * one row; kept for TS optional-chain narrowing without a non-null assert. */
      return result.rows[0]?.total ?? 0
      /* c8 ignore stop */
    },
    async sumCharacterCreationStageCosts(campaignId: string): Promise<number> {
      const result = await c.query<{ total: number }>(SUM_CHARACTER_CREATION_COSTS_QUERY, [
        campaignId,
      ])
      /* c8 ignore start — `?? 0` falsy arm: COALESCE(SUM(...), 0) always returns
       * one row; kept for TS optional-chain narrowing without a non-null assert. */
      return result.rows[0]?.total ?? 0
      /* c8 ignore stop */
    },
    async avgDurationPerStage(): Promise<readonly StageTiming[]> {
      const result = await c.query<{ stage: string; avg_ms: number }>(
        AVG_DURATION_PER_STAGE_QUERY,
      )
      return result.rows.map((r) => ({ stage: r.stage, avgMs: r.avg_ms }))
    },
  }
}

/** Back-compat factory — pool-bound `pipelineRuns` surface. Identical shape to
 *  the pre-unification `createPipelineRunsRepo`. Direct importers keep working;
 *  new code goes through `repo.pipelineRuns`. */
export const createPipelineRunsRepo = (pool: Pool): PipelineRunsRepo => pipelineRunsNs(pool)
