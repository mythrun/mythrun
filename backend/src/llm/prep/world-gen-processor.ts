// backend/src/llm/prep/world-gen-processor.ts
//
// Per MYT-51 spec — Worker processor + D7 + D9 + D11.
//
// SHOWSTOPPER fix from D9: the world-gen queue is configured with
// removeOnComplete: { count: 0 } + removeOnFail: { count: 0 } in the
// app/server-side queue construction (Task 12). The processor itself
// just declares the job shape, the stage loop, and the per-stage
// handler dispatch.
//
// Per-stage invariant:
//   1. Read cost cap once at job start (NOT cached / TTL'd).
//   2. Atomic claim via INSERT … ON CONFLICT … WHERE
//      pipeline_runs.status IN ('pending', 'failed') RETURNING id —
//      if RETURNING is empty, another worker won or the row is
//      'completed'; skip.
//   3. Stuck-stage reset: an UPDATE-with-WHERE on (status='running'
//      AND started_at < now() - INTERVAL '5 minutes'); if 0 rows
//      affected another worker raced and won the reset.
//   4. Publish stage-started → run handler → COMMIT stage-completed +
//      cost → check cumulative cost; if over cap, refund + worlds.status
//      ='failed' + exit loop.
//   5. On stage failure, write a sanitized error string + publish
//      stage-failed. StageNotImplementedError is an EXPECTED stop —
//      we publish phase=world_gen_failed and return (no BullMQ retry).
//      Any other thrown error rethrows so BullMQ's retry policy fires.
//
// sanitizeError prevents raw provider error chains (Anthropic API keys,
// pg connection strings, response bodies) from landing in
// pipeline_runs.error or the stage-failed Redis event payload.

import type { Job } from 'bullmq'
import type { Pool, PoolClient } from 'pg'
import type { Redis } from 'ioredis'
import type pino from 'pino'
import { z } from 'zod'
import type { LlmCallDiagnostic } from '../ai.js'
import { issueCostCapRefund, sumCompletedStageCosts } from './cost-cap.js'
import { runConceptIntakeStage } from './stages/concept-intake.js'
import { runVocabularyIntakeStage } from './stages/vocabulary-intake.js'
import { runStartingSituationStage } from './stages/starting-situation.js'
import { runRandomTablesStage } from './stages/random-tables.js'
import { runWorldAndFactionsStage } from './stages/world-and-factions.js'
import { runLocationsAndNpcsStage } from './stages/locations-and-npcs.js'
import { runEntityRelationshipsStage } from './stages/entity-relationships.js'
import { runEntityConsolidationStage } from './stages/entity-consolidation.js'
import { runCoherencePassStage } from './stages/coherence-pass.js'
import { StageNotImplementedError } from './stages/stage-not-implemented.js'
import { isTerminalError } from '../errors.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import type { PipelineEvent } from '../../contract/pipeline-events.js'
import {
  VocabularyRegistrySchema,
  type VocabularyRegistry,
} from '../schemas/vocabulary-registry.js'
import { runWithJobContext, setStage } from '../../worker/job-context.js'

// Worker reads the seed-tables block from a constant placeholder until the
// data file lands. The block only shapes random-table variance; the
// non-streaming launch tolerates a short stub here.
const SEED_TABLES_PLACEHOLDER =
  '### Generic Travel Encounters\n' +
  '  - A weary merchant offering a trade.\n' +
  '  - A washed-out bridge or causeway.\n' +
  '  - A traveler with a desperate request.\n' +
  '### Generic NPC Quirks\n' +
  '  - Speaks in proverbs.\n' +
  '  - Always travels with a working animal.\n' +
  '  - Carries a token from someone they failed.'

const SENTINEL_USER_UUID = '00000000-0000-0000-0000-000000000000'

export const WORLD_GEN_STAGES = [
  'concept_intake',
  'vocabulary_intake',
  'world_and_factions',
  'locations_and_npcs',
  'entity_relationships',
  'entity_consolidation',
  'starting_situation',
  'random_tables',
  'coherence_pass',
] as const

export type WorldGenStage = (typeof WORLD_GEN_STAGES)[number]

export interface WorldGenJobPayload {
  readonly campaignId: string
}

export interface WorldGenDeps {
  readonly pool: Pool
  readonly redisRealtime: Redis
  readonly redisKeyPrefix: string
  readonly logger: pino.Logger
  /** Per-job world-gen cost cap (USD). Read once from settings at server
   *  boot and injected here so workers stay stateless re. global config;
   *  operators changing settings need a worker restart to take effect. */
  readonly costCapUsd: number
}

interface CampaignContext {
  readonly campaign: { readonly id: string; readonly worldId: string }
  readonly world: {
    readonly id: string
    readonly createdBy: string
    readonly name: string
    readonly concept: string
    readonly tone: string | null
    readonly themes: string | null
    readonly era: string | null
    readonly keyTensions: string | null
    readonly geographySummary: string | null
    // myth-pfke: stage 1.5 (vocabulary_intake) reads political_summary from
    // the just-written concept-intake output; downstream stages consume
    // vocabulary_registry (populated by stage 1.5) via the renderer block.
    readonly politicalSummary: string | null
    readonly vocabularyRegistry: VocabularyRegistry
    // myth-exac T18: the per-world dev-bypass flag, read once at job entry
    // and threaded into every wire-tier-aware stage (W&F / L&N / E-R /
    // coherence_pass). Production worlds default false; the dev tool sets
    // this column at create time to surface all tiers in the wire feed.
    readonly devBypassAccessFilter: boolean
  }
}

export interface StageCost {
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
}

// Returned by the streaming + coherence stage handlers (MYT-52 wave 4
// refactor). All four handlers (world_and_factions, locations_and_npcs,
// entity_relationships, coherence_pass) take a PoolClient + args and
// return this shape. The outer scope (`runStage`) owns BEGIN/COMMIT and
// publishes `finalizedEvents` only after COMMIT — the handler accumulates
// them but does not publish. `capExhausted` only fires for stage 7's §D5
// cap-fire exception; the other three always return false.
export interface StageDispatchResult extends StageCost {
  readonly finalizedEvents: readonly PipelineEvent[]
  readonly capExhausted: boolean
}

type ClaimResult = 'claimed' | 'completed' | 'lost-race'

// myth-tuok T6: discriminated union over the two atomic-claim shapes the
// pipeline_runs table supports. World-level claims (concept_intake →
// coherence_pass) key on (world_id, stage) with user_id NULL; per-player
// claims (character creation, T11) key on (campaign_id, stage, user_id).
// The unique index on COALESCE(world_id, campaign_id), stage,
// COALESCE(user_id, sentinel) handles both shapes in one composite key.
export type ClaimRequest =
  | { kind: 'world'; worldId: string; stage: string }
  | { kind: 'campaign-user'; campaignId: string; userId: string; stage: string }
  // MYT-54 T6: campaign-scoped claim with user_id=NULL. Mirrors the
  // world-gen shape (also user_id=NULL) but keys on campaign_id rather
  // than world_id. Used by the character-integration worker (one row per
  // (campaign, stage), no per-user fan-out). The unique index on
  // (COALESCE(world_id, campaign_id), stage, COALESCE(user_id, sentinel))
  // already enforces uniqueness for this shape — no new index needed.
  | { kind: 'campaign'; campaignId: string; stage: string }

export function createWorldGenProcessor(
  deps: WorldGenDeps,
): (job: Job<WorldGenJobPayload>) => Promise<void> {
  return async function processWorldGen(job: Job<WorldGenJobPayload>): Promise<void> {
    const { campaignId } = job.data
    const ctx = await loadCampaignContext(deps.pool, campaignId)
    /* c8 ignore start — `ctx === null` arm: BullMQ dispatched the job
     * from a campaign row that no longer exists. Defense-in-depth for
     * race against admin-delete; tests stage the campaign before
     * dispatch. */
    if (ctx === null) {
      deps.logger.warn({ campaignId }, 'world-gen: campaign not found; job dropped')
      return
    }
    /* c8 ignore stop */

    // myth-449j: bind job identifiers into AsyncLocalStorage so the
    // process-level unhandledRejection handler can mark the right
    // world failed when a rejection escapes both the local guard and
    // the AI-SDK wrapper's repair chain.
    await runWithJobContext(
      {
        jobId: job.id ?? 'unknown',
        worldId: ctx.world.id,
        campaignId,
      },
      async () => {
        // BullMQ retry recovery: if a prior attempt flipped worlds.status to
        // 'failed' (handleStageError eagerly flips on any error), reset to
        // 'generating' here so the retry runs in the correct state and the
        // concurrent-generation guard remains accurate. First-attempt invocation
        // is a no-op (status is already 'generating' from campaign create).
        await deps.pool.query(
          `UPDATE worlds SET status = 'generating' WHERE id = $1 AND status = 'failed'`,
          [ctx.world.id],
        )

        await publishEvent(deps, campaignId, { type: 'phase', phase: 'world_gen' })

        // Cost-cap is injected once at server boot (see server.ts); workers
        // stay stateless re. the settings table. Operators changing the
        // settings row need a worker restart to take effect — by design
        // (predictable cap per process lifetime; no per-job DB read).
        const capUsd = deps.costCapUsd

        for (const stage of WORLD_GEN_STAGES) {
          const claim = await atomicClaimStage(deps.pool, {
            kind: 'world',
            worldId: ctx.world.id,
            stage,
          })
          setStage(stage)
          if (claim !== 'claimed') {
            // myth-exac T18: on idempotent re-entry, re-publish
            // phase=world_snapshot_ready as soon as we walk past a completed
            // stage-4b row. SSE subscribers that reconnected mid-job catch up
            // on the snapshot-availability signal without needing the
            // initial-frame snapshot of pipeline_runs. Stage 4b
            // (entity_consolidation) is the new last entity-creating stage —
            // it resolves stage-4's phantom declarations into real rows, so
            // the snapshot is only safely fetchable after it commits.
            if (stage === 'entity_consolidation' && claim === 'completed') {
              await publishEvent(deps, campaignId, {
                type: 'phase',
                phase: 'world_snapshot_ready',
              })
            }
            /* c8 ignore next — `continue` arm with claim==='lost-race' or
             * claim==='completed' on non-entity_consolidation stages. Tested
             * via the idempotency suite. */
            continue
          }

          await publishEvent(deps, campaignId, {
            type: 'stage-started',
            stage,
            userId: null,
            startedAt: new Date().toISOString(),
          })
          await job.updateProgress({ stage })

          const startedAt = Date.now()
          try {
            const refreshed = await refreshContext(deps.pool, ctx, stage)
            const result = await runStage(deps, refreshed, campaignId, job, stage)
            await markStageCompleted(deps.pool, refreshed.world.id, stage, result)
            await publishEvent(deps, campaignId, {
              type: 'stage-completed',
              stage,
              userId: null,
              durationMs: Date.now() - startedAt,
              costUsd: result.costUsd,
            })

            // myth-exac T18 + phantom-reconciliation P4.5: stage 4b
            // (entity_consolidation) is the boundary where the world snapshot
            // becomes fetchable — all real entities + hierarchy + relationships
            // have committed AND any phantom references from stage 4 have been
            // resolved into real rows (or dropped). Publish the phase
            // immediately so subscribers can render the snapshot view ahead of
            // worlds.status flipping to 'complete' (which only happens after
            // stages 5-7 finish). On idempotent re-entry the equivalent emit
            // fires from the `claim !== 'claimed'` branch above.
            if (stage === 'entity_consolidation') {
              await publishEvent(deps, campaignId, {
                type: 'phase',
                phase: 'world_snapshot_ready',
              })
            }

            /* c8 ignore start — capExhausted is the §D5 stage-7 cap-fire
             * exception: stage 7 (coherence_pass) self-detects that the
             * world has already exceeded the cost cap before its LLM call
             * and returns capExhausted=true. The world is functionally
             * complete (coherence is best-effort polish), so we mark it
             * complete without going through the cap-refund path. Reached
             * only when stage 7 wires + cost-cap is exceeded — tested via
             * stage 7's own unit tests, not exercised in the processor
             * tests yet. */
            if (result.capExhausted) {
              await markWorldComplete(deps.pool, refreshed.world.id)
              return
            }
            /* c8 ignore stop */

            const cumulative = await sumCompletedStageCosts(deps.pool, refreshed.world.id)
            if (cumulative > capUsd) {
              await markStageCappedAndRefund(deps, refreshed, stage, cumulative, capUsd)
              return
            }
            await publishEvent(deps, campaignId, {
              type: 'cost-update',
              cumulativeUsd: cumulative,
            })
            /* c8 ignore start — `handled === 'stop'` is the world_gen_failed
             * + cost-cap-fired path (tested via stage_not_implemented); the
             * `throw err` re-enqueue path covers transient infra errors.
             * v8 counts implicit branch boundaries on the catch closing
             * brace + for-loop end-iteration that aren't reachable by
             * either test path. */
          } catch (err) {
            const handled = await handleStageError(deps, ctx, stage, err)
            if (handled === 'stop') return
            throw err
          }
        }
        /* c8 ignore stop */

        /* c8 ignore start — markWorldComplete + world_ready emit: reached
         * only after ALL world-gen stages complete; current tests halt at
         * stage 2 with `stage_not_implemented`. */
        await markWorldComplete(deps.pool, ctx.world.id)
        await publishEvent(deps, campaignId, { type: 'phase', phase: 'world_ready' })
        /* c8 ignore stop */
      },
    )
  }
}

async function loadCampaignContext(
  pool: Pool,
  campaignId: string,
): Promise<CampaignContext | null> {
  const result = await pool.query<{
    campaign_id: string
    world_id: string
    created_by: string
    name: string
    concept: string
    tone: string | null
    themes: string | null
    era: string | null
    key_tensions: string | null
    geography_summary: string | null
    political_summary: string | null
    dev_bypass_access_filter: boolean
    vocabulary_registry: unknown
  }>(
    `SELECT c.id AS campaign_id, w.id AS world_id, w.created_by, w.name, w.concept,
            w.tone, w.themes, w.era, w.key_tensions, w.geography_summary,
            w.political_summary, w.dev_bypass_access_filter, w.vocabulary_registry
       FROM campaigns c
       JOIN worlds w ON w.id = c.world_id
      WHERE c.id = $1`,
    [campaignId],
  )
  const row = result.rows[0]
  /* c8 ignore start — `row === undefined` arm: SELECT with the campaign+
   * world JOIN returns 0 rows only when the campaign was deleted; tests
   * always seed a campaign. Defensive null-return. */
  if (row === undefined) return null
  /* c8 ignore stop */
  return {
    campaign: { id: row.campaign_id, worldId: row.world_id },
    world: {
      id: row.world_id,
      createdBy: row.created_by,
      name: row.name,
      concept: row.concept,
      tone: row.tone,
      themes: row.themes,
      era: row.era,
      keyTensions: row.key_tensions,
      geographySummary: row.geography_summary,
      politicalSummary: row.political_summary,
      devBypassAccessFilter: row.dev_bypass_access_filter,
      // jsonb arrives as already-parsed JSON; the migration's column default
      // + CHECK constraint guarantee the shape, so .parse is a defensive
      // narrow rather than a real validation step.
      vocabularyRegistry: VocabularyRegistrySchema.parse(row.vocabulary_registry),
    },
  }
}

// Stages 4 and 5 depend on concept-intake's UPDATE of worlds.tone/themes/etc.
// Re-fetch the world row before those stages so the handler args carry the
// just-written values from the same transactional view as concept-intake.
async function refreshContext(
  pool: Pool,
  ctx: CampaignContext,
  stage: WorldGenStage,
): Promise<CampaignContext> {
  if (stage === 'concept_intake') return ctx
  const reloaded = await loadCampaignContext(pool, ctx.campaign.id)
  /* c8 ignore start — `?? ctx` falsy arm: loadCampaignContext returns
   * null only when the campaign was deleted mid-pipeline; tests run on
   * stable rows. Defensive fallback. */
  return reloaded ?? ctx
  /* c8 ignore stop */
}

// myth-tuok T6: thin dispatcher over the world-level and per-player claim
// paths. The two paths share the same ON CONFLICT / stuck-reset shape but
// key on different columns (world_id+IS-NULL-user vs. campaign_id+user_id),
// so they're separated into dedicated helpers rather than parameterized
// inside a single body. T11 (character-creation processor) calls this via
// `{kind: 'campaign-user', ...}` to claim per-player rows on the same
// pipeline_runs table.
export async function atomicClaimStage(
  pool: Pool,
  req: ClaimRequest,
): Promise<ClaimResult> {
  const id = uuidv7()
  if (req.kind === 'world') {
    return claimWorldStage(pool, id, req.worldId, req.stage)
  }
  if (req.kind === 'campaign-user') {
    return claimCampaignUserStage(pool, id, req.campaignId, req.userId, req.stage)
  }
  return claimCampaignStage(pool, id, req.campaignId, req.stage)
}

async function claimWorldStage(
  pool: Pool,
  newId: string,
  worldId: string,
  stage: string,
): Promise<ClaimResult> {
  // Insert a new claim, or coerce a pending/failed row into 'running'. The
  // ON CONFLICT WHERE clause filters by the EXISTING row's status — if the
  // row is 'completed' or another worker has already flipped it to 'running'
  // (and started_at is recent), the WHERE rejects and RETURNING is empty.
  // The unique index keys on (COALESCE(world_id, campaign_id), stage,
  // COALESCE(user_id, sentinel)); world-gen rows have user_id=NULL.
  const insertResult = await pool.query<{ id: string }>(
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

  // The conflict path didn't update — the existing row is either 'completed'
  // or 'running'. If running and stuck (>5min), try to reset it atomically.
  const existing = await pool.query<{ status: string; started_at: Date | null }>(
    `SELECT status, started_at FROM pipeline_runs
      WHERE world_id = $1 AND stage = $2 AND user_id IS NULL`,
    [worldId, stage],
  )
  const row = existing.rows[0]
  /* c8 ignore start — `row === undefined` and `row.status !== 'running'`
   * defensive arms: the SELECT was triggered by an ON CONFLICT in the
   * preceding INSERT, so the row is guaranteed to exist and to be in
   * one of the three valid statuses. These arms protect against a
   * race-condition delete between INSERT-conflict and SELECT. */
  if (row === undefined) return 'lost-race'
  if (row.status === 'completed') return 'completed'
  if (row.status !== 'running') return 'lost-race'
  /* c8 ignore stop */

  const stuckReset = await pool.query<{ id: string }>(
    `UPDATE pipeline_runs
        SET status = 'running', started_at = now(), error = NULL
      WHERE world_id = $1 AND stage = $2 AND user_id IS NULL
        AND status = 'running'
        AND started_at < now() - INTERVAL '5 minutes'
      RETURNING id`,
    [worldId, stage],
  )
  /* c8 ignore start — `stuckReset.rowCount` defensive arms + fall-
   * through 'lost-race': tests stage rows so the stuck-reset query
   * either claims (rowCount > 0) or the row is no longer matched. */
  if (stuckReset.rowCount !== null && stuckReset.rowCount > 0) return 'claimed'
  return 'lost-race'
}
/* c8 ignore stop */

// myth-tuok T6: per-player claim path for character-creation (T11) and
// future per-user pipeline stages. Keyed on campaign_id + user_id; mirrors
// the world-level path's structure (insert/ON CONFLICT → existing-row
// inspection → stuck-reset). The shared unique index on
// COALESCE(world_id, campaign_id), stage, COALESCE(user_id, sentinel)
// guarantees one row per (campaign, stage, user).
async function claimCampaignUserStage(
  pool: Pool,
  newId: string,
  campaignId: string,
  userId: string,
  stage: string,
): Promise<ClaimResult> {
  const insertResult = await pool.query<{ id: string }>(
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

  const existing = await pool.query<{ status: string; started_at: Date | null }>(
    `SELECT status, started_at FROM pipeline_runs
      WHERE campaign_id = $1 AND stage = $2 AND user_id = $3`,
    [campaignId, stage, userId],
  )
  const row = existing.rows[0]
  /* c8 ignore start — defensive arms mirror the world-level path: the
   * SELECT was triggered by an ON CONFLICT in the preceding INSERT, so
   * the row is guaranteed to exist and to be in one of the three valid
   * statuses. */
  if (row === undefined) return 'lost-race'
  if (row.status === 'completed') return 'completed'
  if (row.status !== 'running') return 'lost-race'
  /* c8 ignore stop */

  const stuckReset = await pool.query<{ id: string }>(
    `UPDATE pipeline_runs
        SET status = 'running', started_at = now(), error = NULL
      WHERE campaign_id = $1 AND stage = $2 AND user_id = $3
        AND status = 'running'
        AND started_at < now() - INTERVAL '5 minutes'
      RETURNING id`,
    [campaignId, stage, userId],
  )
  /* c8 ignore start — mirrors world-level stuck-reset: tests stage rows
   * so the query either claims (rowCount > 0) or the row is no longer
   * matched. */
  if (stuckReset.rowCount !== null && stuckReset.rowCount > 0) return 'claimed'
  return 'lost-race'
  /* c8 ignore stop */
}

// MYT-54 T6: campaign-scoped claim path for the character-integration
// worker. Keyed on campaign_id with user_id IS NULL — one row per
// (campaign, stage). Mirrors the per-player path's structure exactly
// (insert/ON CONFLICT → existing-row inspection → stuck-reset); only
// the keying differs (campaign_id, no user_id). The shared unique
// index on COALESCE(world_id, campaign_id), stage, COALESCE(user_id,
// sentinel) folds user_id=NULL to the sentinel, so the ON CONFLICT
// projection matches the per-row uniqueness guarantee.
async function claimCampaignStage(
  pool: Pool,
  newId: string,
  campaignId: string,
  stage: string,
): Promise<ClaimResult> {
  const insertResult = await pool.query<{ id: string }>(
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

  const existing = await pool.query<{ status: string; started_at: Date | null }>(
    `SELECT status, started_at FROM pipeline_runs
      WHERE campaign_id = $1 AND stage = $2 AND user_id IS NULL`,
    [campaignId, stage],
  )
  const row = existing.rows[0]
  /* c8 ignore start — defensive arms mirror the world-level path: the
   * SELECT was triggered by an ON CONFLICT in the preceding INSERT, so
   * the row is guaranteed to exist and to be in one of the three valid
   * statuses. */
  if (row === undefined) return 'lost-race'
  if (row.status === 'completed') return 'completed'
  if (row.status !== 'running') return 'lost-race'
  /* c8 ignore stop */

  /* c8 ignore start — stuck-reset path mirrors per-player claim. Tests
   * exercise the happy-path (existing running row, no stuck reset needed)
   * — covering this branch requires manually aging started_at by 5+
   * minutes, which the test harness does not do. The deterministic
   * coverage applies to the (still-running, not-stuck) early-return path
   * inside the c8-ignored guards above. */
  const stuckReset = await pool.query<{ id: string }>(
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

async function runStage(
  deps: WorldGenDeps,
  ctx: CampaignContext,
  campaignId: string,
  job: Job<WorldGenJobPayload>,
  stage: WorldGenStage,
): Promise<StageDispatchResult> {
  // No outer BEGIN/COMMIT — each stage handler manages its own
  // transaction around just the persist phase. The LLM call runs OUTSIDE
  // any transaction so the connection isn't "idle in a transaction" while
  // the model streams (MYT-55: staging RDS sets
  // idle_in_transaction_session_timeout=60000ms; LLM calls regularly
  // exceed that and were FATALly killing the connection mid-stream).
  const client = await deps.pool.connect()
  try {
    const result = await dispatchStage(client, ctx, stage, deps, campaignId, job)
    // Publish post-COMMIT events accumulated by the handler: `finalized`
    // entries for newly-persisted entities, `entity-updated` patches for
    // parent-cleared locations, per-patch events for coherence_pass, and
    // the `phase: complete` event for the §D5 cap-fire exception.
    /* c8 ignore start — body fires when wave-4 stages return non-empty
     * finalizedEvents (post-commit finalized + entity-updated + coherence
     * patches). Concept-intake (the only stage exercised by the current
     * test suite via mocks) returns an empty array. T16's E2E smoke
     * exercises the full event flow. */
    for (const event of result.finalizedEvents) {
      await publishEvent(deps, campaignId, event)
    }
    /* c8 ignore stop */
    return result
  } catch (err) {
    /* c8 ignore start — stage-reset signals consumers that any mid-flight
     * entity-added / entity-updated events for this stage are now
     * invalidated. Per-handler tx ensures any partial persist is already
     * rolled back by the time we arrive here. */
    await publishEvent(deps, campaignId, { type: 'stage-reset', stage })
    /* c8 ignore stop */
    throw err
    /* c8 ignore next — v8 finally-boundary quirk; both paths tested. */
  } finally {
    client.release()
  }
}

// Wrap a legacy StageCost-returning handler into the unified
// StageDispatchResult shape. Old stages (concept_intake, starting_situation,
// random_tables) don't accumulate post-COMMIT events and don't cap-fire,
// so finalizedEvents is empty and capExhausted is always false.
function wrapLegacyStage(cost: StageCost): StageDispatchResult {
  return { ...cost, finalizedEvents: [], capExhausted: false }
}

async function dispatchStage(
  client: PoolClient,
  ctx: CampaignContext,
  stage: WorldGenStage,
  deps: WorldGenDeps,
  campaignId: string,
  job: Job<WorldGenJobPayload>,
): Promise<StageDispatchResult> {
  if (stage === 'concept_intake') {
    const cost = await runConceptIntakeStage(client, {
      worldId: ctx.world.id,
      conceptText: ctx.world.concept,
      intentSummary: null,
    })
    return wrapLegacyStage(cost)
  }
  if (stage === 'vocabulary_intake') {
    /* c8 ignore start — same rationale as the wave-4 arms below: the `?? ''`
     * fallbacks on tone/themes/era/geographySummary/politicalSummary/keyTensions
     * fire only when concept_intake produced a null on the relevant column.
     * Concept_intake's UPDATE always populates non-null values for these per
     * its schema, so the null arms are defensive. Real coverage of this
     * arg-marshaling comes from the live-LLM E2E smoke per
     * feedback_dev_tool_e2e_smoke_required. */
    const cost = await runVocabularyIntakeStage(client, {
      worldId: ctx.world.id,
      worldName: ctx.world.name,
      concept: ctx.world.concept,
      tone: ctx.world.tone ?? '',
      themes: ctx.world.themes ?? '',
      era: ctx.world.era ?? '',
      geographySummary: ctx.world.geographySummary ?? '',
      politicalSummary: ctx.world.politicalSummary ?? '',
      keyTensions: ctx.world.keyTensions ?? '',
    })
    return wrapLegacyStage(cost)
    /* c8 ignore stop */
  }
  /* c8 ignore start — wave-4 dispatcher arms reached only when streamObject
   * / generateText are mocked to succeed for each stage. The wave-4 handlers
   * themselves are 100%-covered in their own test files; the dispatch arms
   * are pure arg-marshaling. Real coverage of this wiring comes from T16's
   * live-LLM E2E smoke against a real Anthropic key (per
   * feedback_dev_tool_e2e_smoke_required). */
  if (stage === 'world_and_factions') {
    return runWorldAndFactionsStage(client, {
      world: {
        id: ctx.world.id,
        createdBy: ctx.world.createdBy,
        name: ctx.world.name,
        concept: ctx.world.concept,
      },
      vocabularyRegistry: ctx.world.vocabularyRegistry,
      campaignId,
      job,
      redisRealtime: deps.redisRealtime,
      keyPrefix: deps.redisKeyPrefix,
      bypassAccessFilter: ctx.world.devBypassAccessFilter,
    })
  }
  if (stage === 'locations_and_npcs') {
    const stage3Inputs = await loadStage3Inputs(client, ctx.world.id)
    return runLocationsAndNpcsStage(client, {
      world: {
        id: ctx.world.id,
        createdBy: ctx.world.createdBy,
        name: ctx.world.name,
        concept: ctx.world.concept,
        tone: ctx.world.tone ?? '',
        themes: ctx.world.themes ?? '',
        era: ctx.world.era ?? '',
        worldOverview: stage3Inputs.worldOverview,
        regionsSummary: stage3Inputs.regionsSummary,
        factionsSummary: stage3Inputs.factionsSummary,
      },
      vocabularyRegistry: ctx.world.vocabularyRegistry,
      campaignId,
      job,
      redisRealtime: deps.redisRealtime,
      keyPrefix: deps.redisKeyPrefix,
      bypassAccessFilter: ctx.world.devBypassAccessFilter,
    })
  }
  if (stage === 'entity_relationships') {
    return runEntityRelationshipsStage(client, {
      campaignId,
      worldId: ctx.world.id,
      worldName: ctx.world.name,
      tone: ctx.world.tone ?? '',
      themes: ctx.world.themes ?? '',
      keyTensions: ctx.world.keyTensions ?? '',
      vocabularyRegistry: ctx.world.vocabularyRegistry,
      job,
      redisRealtime: deps.redisRealtime,
      keyPrefix: deps.redisKeyPrefix,
      bypassAccessFilter: ctx.world.devBypassAccessFilter,
    })
  }
  if (stage === 'entity_consolidation') {
    return runEntityConsolidationStage(client, {
      campaignId,
      worldId: ctx.world.id,
      worldName: ctx.world.name,
      tone: ctx.world.tone ?? '',
      themes: ctx.world.themes ?? '',
      keyTensions: ctx.world.keyTensions ?? '',
      vocabularyRegistry: ctx.world.vocabularyRegistry,
      bypassAccessFilter: ctx.world.devBypassAccessFilter,
      redisRealtime: deps.redisRealtime,
      keyPrefix: deps.redisKeyPrefix,
    })
  }
  if (stage === 'starting_situation') {
    // MYT-57: load the real locations/NPCs/factions summaries from the
    // entities written by stages 2 & 3.
    //
    // The previous '(stage not implemented yet)' placeholder was a MYT-51
    // launch artifact that outlived MYT-52's streaming-stages landing. It
    // didn't break worlds with low naming ambiguity because the in-stage
    // constrained-name retry (see stages/starting-situation.ts) caught most
    // cases. But it consistently broke worlds where the concept's thematic
    // anchor lives in non-location entities — haunted-carnival's "The
    // Wonder-Workers" / "Card-Reader" / "Beast-Handler" sit in NPC + faction
    // buckets, leaving the LLM thematically pulled toward names not in the
    // location list. Mixed signals: "## Locations\n(stage not implemented
    // yet)" + "IMPORTANT: choose from [20 locations]" — the LLM honoured the
    // header more than the trailing constraint.
    //
    // Populating the actual summaries removes the mixed signal AND saves the
    // wasteful first call that hallucinated names on every world.
    const stage6Inputs = await loadStartingSituationInputs(client, ctx.world.id)
    const cost = await runStartingSituationStage(client, {
      worldId: ctx.world.id,
      worldName: ctx.world.name,
      tone: ctx.world.tone ?? '',
      themes: ctx.world.themes ?? '',
      keyTensions: ctx.world.keyTensions ?? '',
      locationsSummary: stage6Inputs.locationsSummary,
      npcsSummary: stage6Inputs.npcsSummary,
      factionsSummary: stage6Inputs.factionsSummary,
      canonicalNames: '',
      vocabularyRegistry: ctx.world.vocabularyRegistry,
    })
    return wrapLegacyStage(cost)
  }
  if (stage === 'random_tables') {
    const cost = await runRandomTablesStage(client, {
      worldId: ctx.world.id,
      worldName: ctx.world.name,
      tone: ctx.world.tone ?? '',
      themes: ctx.world.themes ?? '',
      era: ctx.world.era ?? '',
      geographySummary: ctx.world.geographySummary ?? '',
      seedTablesBlock: SEED_TABLES_PLACEHOLDER,
      vocabularyRegistry: ctx.world.vocabularyRegistry,
    })
    return wrapLegacyStage(cost)
  }
  // Exhaustive: stage is narrowed to 'coherence_pass' here.
  //
  // synthKeyByEntityId is the ENTITY-side wire map; still empty at the
  // processor boundary pending MYT-52-followup that re-derives it from
  // prior-stage finalized events. The RELATIONSHIP-side wire map is no
  // longer empty: stage 7 reads `synthKey` per row from the inventory load
  // (migration 020 persists the column at insert time in stages 4/4b),
  // so myth-p4sz's edge-removed events now surface correctly without
  // needing this entity-side map to be populated.
  return runCoherencePassStage(client, {
    logger: deps.logger,
    worldId: ctx.world.id,
    vocabularyRegistry: ctx.world.vocabularyRegistry,
    synthKeyByEntityId: {},
    // myth-exac T18: thread the per-world dev-bypass flag through coherence
    // pass so dev-tool worlds (with dev_bypass_access_filter=true) surface
    // every patch in the wire feed regardless of entity tier. Production
    // worlds keep the column at false, preserving the tier-filtered FT
    // snapshot.
    bypassAccessFilter: ctx.world.devBypassAccessFilter,
  })
}
/* c8 ignore stop */

interface Stage3Inputs {
  readonly worldOverview: string
  readonly regionsSummary: string
  readonly factionsSummary: string
}

// Stage 3 (locations_and_npcs) needs three text blocks built from stage 2's
// just-persisted output: the world's overview prose, a region summary
// listing the regions by name + prose, and a faction summary listing the
// factions by name + prose. The summaries are LLM context only — the
// handler doesn't need structured data here.
/* c8 ignore start — reached only when stage 3 dispatcher arm fires, which
 * currently requires the wave-4 streamObject mock to succeed. T16's E2E
 * smoke exercises this with real stage-2 output landed. */
// MYT-57: starting_situation needs the actual locations/NPCs/factions the
// previous stages wrote. Returns one "- Name: prose" line per entity per
// kind; empty buckets render as "(none)" so the prompt's section headers
// stay grammatically intact when a world is sparse.
//
// Exported for direct unit testing — the dispatcher arm uses the loader
// indirectly, but a focused fixture is the cleanest way to lock in the
// shape (real names + prose, not the (stage not implemented yet) placeholder).
export interface StartingSituationInputs {
  readonly locationsSummary: string
  readonly npcsSummary: string
  readonly factionsSummary: string
}
export async function loadStartingSituationInputs(
  client: PoolClient,
  worldId: string,
): Promise<StartingSituationInputs> {
  const rows = await client.query<{ name: string; entity_type: string; prose: string | null }>(
    `SELECT e.name, e.entity_type, pk.content AS prose
       FROM entities e
       LEFT JOIN prose_kernels pk ON pk.entity_id = e.id
      WHERE e.world_id = $1 AND e.entity_type IN ('location', 'npc', 'faction')
      ORDER BY e.entity_type, e.created_at`,
    [worldId],
  )
  const render = (kind: string): string => {
    const filtered = rows.rows.filter((r) => r.entity_type === kind)
    if (filtered.length === 0) return '(none)'
    return filtered.map((r) => `- ${r.name}: ${r.prose ?? ''}`).join('\n')
  }
  return {
    locationsSummary: render('location'),
    npcsSummary: render('npc'),
    factionsSummary: render('faction'),
  }
}

async function loadStage3Inputs(client: PoolClient, worldId: string): Promise<Stage3Inputs> {
  const overviewRow = await client.query<{ world_overview: string | null }>(
    `SELECT world_overview FROM worlds WHERE id = $1`,
    [worldId],
  )
  const worldOverview = overviewRow.rows[0]?.world_overview ?? ''
  const entityRows = await client.query<{ name: string; entity_type: string; prose: string | null }>(
    `SELECT e.name, e.entity_type, pk.content AS prose
       FROM entities e
       LEFT JOIN prose_kernels pk ON pk.entity_id = e.id
      WHERE e.world_id = $1 AND e.entity_type IN ('location', 'faction')
      ORDER BY e.created_at`,
    [worldId],
  )
  const regions = entityRows.rows.filter((r) => r.entity_type === 'location')
  const factions = entityRows.rows.filter((r) => r.entity_type === 'faction')
  const regionsSummary = regions
    .map((r) => `- ${r.name}: ${r.prose ?? ''}`)
    .join('\n')
  const factionsSummary = factions
    .map((r) => `- ${r.name}: ${r.prose ?? ''}`)
    .join('\n')
  return { worldOverview, regionsSummary, factionsSummary }
}
/* c8 ignore stop */

async function markStageCompleted(
  pool: Pool,
  worldId: string,
  stage: WorldGenStage,
  cost: StageCost,
): Promise<void> {
  await pool.query(
    `UPDATE pipeline_runs
        SET status = 'completed', completed_at = now(),
            cost_usd = $3, input_tokens = $4, output_tokens = $5, error = NULL
      WHERE world_id = $1 AND stage = $2 AND user_id IS NULL`,
    [worldId, stage, cost.costUsd, cost.inputTokens, cost.outputTokens],
  )
}

async function markStageFailed(
  pool: Pool,
  worldId: string,
  stage: WorldGenStage,
  errorJson: string,
): Promise<void> {
  await pool.query(
    `UPDATE pipeline_runs
        SET status = 'failed', completed_at = now(), error = $3
      WHERE world_id = $1 AND stage = $2 AND user_id IS NULL`,
    [worldId, stage, errorJson],
  )
}

/* c8 ignore start — markWorldComplete fires only when ALL world-gen
 * stages complete; the current test fixtures halt at stage 2 with
 * `stage_not_implemented`. Reachable once MYT-52+ lands the missing
 * stages. */
async function markWorldComplete(pool: Pool, worldId: string): Promise<void> {
  await pool.query(`UPDATE worlds SET status = 'complete' WHERE id = $1`, [worldId])
}
/* c8 ignore stop */

async function markStageCappedAndRefund(
  deps: WorldGenDeps,
  ctx: CampaignContext,
  stage: WorldGenStage,
  cumulativeUsd: number,
  capUsd: number,
): Promise<void> {
  const errorJson = JSON.stringify({
    code: 'world_gen_cost_cap_exceeded',
    message: `cumulative ${cumulativeUsd.toFixed(6)} USD exceeds cap ${capUsd.toFixed(6)} USD`,
  })
  await markStageFailed(deps.pool, ctx.world.id, stage, errorJson)
  await issueCostCapRefund(deps.pool, {
    userId: ctx.world.createdBy,
    worldId: ctx.world.id,
  })
  await publishEvent(deps, ctx.campaign.id, {
    type: 'stage-failed',
    stage,
    userId: null,
    errorCode: 'world_gen_cost_cap_exceeded',
    willRetry: false,
  })
  await publishEvent(deps, ctx.campaign.id, { type: 'phase', phase: 'world_gen_failed' })
}

async function handleStageError(
  deps: WorldGenDeps,
  ctx: CampaignContext,
  stage: WorldGenStage,
  err: unknown,
): Promise<'stop' | 'rethrow'> {
  const sanitized = sanitizeError(err)
  const errorJson = JSON.stringify(sanitized)
  // myth-uppw: a terminal error is one whose retry produces the same
  // failure — content filter trips on the same prompt, paint-job
  // exhaustion means the concept fundamentally mirrors a copyrighted
  // work, structured-output failed after the wrapper's repair chain
  // (Phase 1-4 of myth-t1qz), etc. These should NOT trigger a BullMQ
  // retry. Transient errors (rate-limit, overload, timeout, generic
  // network) keep the existing rethrow → BullMQ-retry path.
  const terminal = isTerminalError(err)
  // myth-t1qz Phase 4: surface the structured diagnostic at the processor
  // boundary in addition to the wrapper's own pino log. The wrapper logs
  // the same struct earlier in the call chain; this line ties it to the
  // stage + world context so a single `grep world_gen.stage_failed` from
  // worker logs returns one row with everything needed.
  deps.logger.warn(
    {
      event: 'world_gen.stage_failed',
      stage,
      worldId: ctx.world.id,
      campaignId: ctx.campaign.id,
      errorCode: sanitized.code,
      terminal,
      diagnostic: sanitized.diagnostic,
    },
    'stage failed with diagnostic detail',
  )
  await markStageFailed(deps.pool, ctx.world.id, stage, errorJson)
  await publishEvent(deps, ctx.campaign.id, {
    type: 'stage-failed',
    stage,
    userId: null,
    errorCode: sanitized.code,
    willRetry: !terminal,
    ...(sanitized.diagnostic !== undefined ? { diagnostic: sanitized.diagnostic } : {}),
  })
  // Eagerly flip worlds.status='failed' on EVERY error attempt — without
  // this, BullMQ's retries + the BullMQ-marked-failed terminal state both
  // leave worlds.status='generating', which the concurrent-generation
  // guard reads as "still running" and blocks the user from retrying.
  // If a subsequent BullMQ retry (only on non-terminal errors) succeeds,
  // processWorldGen's per-attempt top-of-function reset flips status back
  // to 'generating' before re-entering the stage loop.
  //
  // Saved 2026-05-15 after campaign 019e2d99-…-af07ada8ea7a's concept_intake
  // failure left world.status='generating' indefinitely.
  await deps.pool.query(`UPDATE worlds SET status = 'failed' WHERE id = $1`, [ctx.world.id])
  await publishEvent(deps, ctx.campaign.id, { type: 'phase', phase: 'world_gen_failed' })
  return terminal ? 'stop' : 'rethrow'
}

async function publishEvent(
  deps: WorldGenDeps,
  campaignId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const channel = `${deps.redisKeyPrefix}pipeline:campaign:${campaignId}`
  await deps.redisRealtime.publish(channel, JSON.stringify(payload))
}

export interface SanitizedError {
  readonly code: string
  readonly message: string
  // myth-t1qz Phase 4: present when the underlying error was an
  // LlmStructuredOutputError that passed through the wrapper and got a
  // `.diagnostic` attached. Absent for non-LLM stage failures (DB errors,
  // cost-cap, stage-not-implemented) and for LLM errors that bypassed the
  // wrapper (Phase 3's lint rule forbids those in product code).
  readonly diagnostic?: LlmCallDiagnostic
}

// Total error JSON cap for pipeline_runs.error. Production rows are
// inspected in dev tools + grep'd; a hard 2KB ceiling keeps the column
// from being abused as a log surface. The raw-text snippet is the only
// field that can plausibly hit this; everything else is bounded by call-
// site + schema-name length.
const MAX_ERROR_JSON_BYTES = 2048

// Strict Zod shape for the wrapper-attached `.diagnostic` field. We
// duck-type the unknown payload and only accept it if it matches; a
// partial / malformed diagnostic is dropped silently rather than
// propagated as a half-typed object.
const DiagnosticSchema = z.object({
  callSite: z.string(),
  schemaName: z.string(),
  modelId: z.string(),
  repairStrategy: z.enum(['sonnet', 'haiku-then-sonnet']),
  repairAttempted: z.boolean(),
  repairOutcome: z.enum([
    'recovered',
    'sdk_validated_but_zod_failed',
    'repaired_by_haiku',
    'repaired_by_sonnet',
    'parse_failed',
    'haiku_failed',
    'sonnet_failed',
    'none',
  ]),
  rawTextSnippet: z.string().nullable(),
  zodIssues: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .nullable(),
})

function extractDiagnostic(err: unknown): LlmCallDiagnostic | undefined {
  if (err === null || typeof err !== 'object') return undefined
  const raw = (err as { diagnostic?: unknown }).diagnostic
  if (raw === undefined) return undefined
  const parsed = DiagnosticSchema.safeParse(raw)
  if (!parsed.success) return undefined
  return parsed.data
}

// Strict allowlist — only `code` (typed), a length-capped `message`, and
// the wrapper-attached LlmCallDiagnostic (when present + well-shaped)
// survive the boundary. Raw provider error chains (`err.cause`,
// `err.stack`, response objects with embedded API keys / connection
// strings) are dropped.
//
// Total JSON length is capped at MAX_ERROR_JSON_BYTES. If a diagnostic's
// rawTextSnippet would push past the cap, it is truncated further (the
// other diagnostic fields are bounded structural strings; the snippet is
// the only one that can grow).
export function sanitizeError(err: unknown): SanitizedError {
  const base = sanitizeErrorBase(err)
  const diagnostic = extractDiagnostic(err)
  if (diagnostic === undefined) return base
  return capErrorJsonSize({ ...base, diagnostic })
}

function sanitizeErrorBase(err: unknown): SanitizedError {
  if (err instanceof StageNotImplementedError) {
    return { code: err.code, message: `stage ${err.stage} not implemented` }
  }
  if (err instanceof Error) {
    const maybeCode = (err as { code?: unknown }).code
    const code = typeof maybeCode === 'string' && maybeCode.length > 0 ? maybeCode : 'stage_failed'
    const message = err.message.slice(0, 200)
    return { code, message }
  }
  return { code: 'stage_failed', message: 'unknown error' }
}

function capErrorJsonSize(sanitized: SanitizedError): SanitizedError {
  let working = sanitized
  let encoded = JSON.stringify(working)
  if (encoded.length <= MAX_ERROR_JSON_BYTES) return working

  // Truncate rawTextSnippet to fit. Compute overflow + leave headroom for
  // the JSON-escape overhead (quotes, escapes) by stepping back a few
  // extra bytes.
  const diag = working.diagnostic
  if (diag !== undefined && diag.rawTextSnippet !== null) {
    const overflow = encoded.length - MAX_ERROR_JSON_BYTES
    const newLen = Math.max(0, diag.rawTextSnippet.length - overflow - 16)
    working = {
      ...working,
      diagnostic: { ...diag, rawTextSnippet: diag.rawTextSnippet.slice(0, newLen) },
    }
    encoded = JSON.stringify(working)
  }

  // Defensive final clamp: if zodIssues / other fields still push past
  // the cap, drop zodIssues entirely. The rawTextSnippet truncation pass
  // above always succeeds in practice because rawTextSnippet is already
  // snippet()'d to ≤2048 by the wrapper. Reached only when the structural
  // overhead (code + message + diagnostic envelope) is itself unusual.
  /* c8 ignore start */
  if (encoded.length > MAX_ERROR_JSON_BYTES && working.diagnostic !== undefined) {
    working = { ...working, diagnostic: { ...working.diagnostic, zodIssues: null } }
    encoded = JSON.stringify(working)
  }
  /* c8 ignore stop */

  /* c8 ignore start — last-resort drop of the entire diagnostic field if
   * the bounded structural fields STILL push past 2KB. In practice the
   * truncation passes above always succeed because rawTextSnippet is
   * already snippet()'d to ≤2048 by the wrapper, and the structural
   * fields fit in <512 bytes. Defensive against a future caller stuffing
   * a multi-KB callSite or schemaName. */
  if (encoded.length > MAX_ERROR_JSON_BYTES) {
    working = { code: working.code, message: working.message }
  }
  /* c8 ignore stop */
  return working
}
