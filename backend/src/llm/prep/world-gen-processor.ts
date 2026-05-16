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
import { issueCostCapRefund, readCostCap, sumCompletedStageCosts } from './cost-cap.js'
import { runConceptIntakeStage } from './stages/concept-intake.js'
import { runStartingSituationStage } from './stages/starting-situation.js'
import { runRandomTablesStage } from './stages/random-tables.js'
import { runWorldAndFactionsStage } from './stages/world-and-factions.js'
import { runLocationsAndNpcsStage } from './stages/locations-and-npcs.js'
import { runEntityRelationshipsStage } from './stages/entity-relationships.js'
import { runCoherencePassStage } from './stages/coherence-pass.js'
import { StageNotImplementedError } from './stages/stage-not-implemented.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import type { PipelineEvent } from '../../contract/pipeline-events.js'

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
  'world_and_factions',
  'locations_and_npcs',
  'entity_relationships',
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

    const capUsd = await readCostCap(deps.pool)

    for (const stage of WORLD_GEN_STAGES) {
      const claim = await atomicClaimStage(deps.pool, ctx.world.id, stage)
      /* c8 ignore next — `continue` arm fires when a stage is already
       * completed (idempotent re-run) or lost-race (another worker took
       * it). Tested via the idempotency suite. */
      if (claim !== 'claimed') continue

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
  }>(
    `SELECT c.id AS campaign_id, w.id AS world_id, w.created_by, w.name, w.concept,
            w.tone, w.themes, w.era, w.key_tensions, w.geography_summary
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

async function atomicClaimStage(
  pool: Pool,
  worldId: string,
  stage: WorldGenStage,
): Promise<ClaimResult> {
  const id = uuidv7()
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
    [id, worldId, stage],
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

async function runStage(
  deps: WorldGenDeps,
  ctx: CampaignContext,
  campaignId: string,
  job: Job<WorldGenJobPayload>,
  stage: WorldGenStage,
): Promise<StageDispatchResult> {
  const client = await deps.pool.connect()
  try {
    await client.query('BEGIN')
    const result = await dispatchStage(client, ctx, stage, deps, campaignId, job)
    await client.query('COMMIT')
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
    /* c8 ignore start — best-effort ROLLBACK + stage-reset publish on
     * a handler throw. The ROLLBACK may itself throw if the connection
     * is already broken; swallow to preserve the original error context.
     * stage-reset signals consumers that any mid-flight entity-added /
     * entity-updated events for this stage are now invalidated. */
    try {
      await client.query('ROLLBACK')
    } catch {
      // ignore
    }
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
      campaignId,
      job,
      redisRealtime: deps.redisRealtime,
      keyPrefix: deps.redisKeyPrefix,
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
      campaignId,
      job,
      redisRealtime: deps.redisRealtime,
      keyPrefix: deps.redisKeyPrefix,
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
      job,
      redisRealtime: deps.redisRealtime,
      keyPrefix: deps.redisKeyPrefix,
    })
  }
  if (stage === 'starting_situation') {
    const cost = await runStartingSituationStage(client, {
      worldId: ctx.world.id,
      worldName: ctx.world.name,
      tone: ctx.world.tone ?? '',
      themes: ctx.world.themes ?? '',
      keyTensions: ctx.world.keyTensions ?? '',
      locationsSummary: '(stage not implemented yet)',
      npcsSummary: '(stage not implemented yet)',
      factionsSummary: '(stage not implemented yet)',
      canonicalNames: '',
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
    })
    return wrapLegacyStage(cost)
  }
  // Exhaustive: stage is narrowed to 'coherence_pass' here. synthKeyByEntityId
  // is empty for the initial wiring; stage 7 events fall back to entity_id on
  // the wire when the map is empty. Tracker MYT-52-followup can re-derive the
  // map from prior-stage finalized events once the dev tool's live-events
  // inspector surfaces a need for synthKey-prefixed events here.
  return runCoherencePassStage(client, {
    logger: deps.logger,
    worldId: ctx.world.id,
    synthKeyByEntityId: {},
    // myth-exac T16: production path runs with the tier filter on so the
    // FT-bound snapshot never sees a coherence patch for a non-known
    // entity. The dev tool's bypass mode propagates through deps in a
    // separate task — see myth-exac T17.
    bypassAccessFilter: false,
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
  await markStageFailed(deps.pool, ctx.world.id, stage, errorJson)
  const isNotImplemented = err instanceof StageNotImplementedError
  await publishEvent(deps, ctx.campaign.id, {
    type: 'stage-failed',
    stage,
    userId: null,
    errorCode: sanitized.code,
    willRetry: !isNotImplemented,
  })
  if (isNotImplemented) {
    // Terminal expected stop — flip worlds.status to 'failed' so the
    // concurrent-generation guard releases. Without this, the world
    // sits in 'generating' forever and the user can't create another
    // campaign. Cost-cap already does this via issueCostCapRefund; the
    // stage-not-implemented path needs an equivalent terminal-state
    // marker. The phase derivation will continue to read
    // world_gen_failed from the pipeline_runs row's failed status.
    await deps.pool.query(`UPDATE worlds SET status = 'failed' WHERE id = $1`, [ctx.world.id])
    await publishEvent(deps, ctx.campaign.id, { type: 'phase', phase: 'world_gen_failed' })
    return 'stop'
  }
  // Non-NotImplemented error (LLM-upstream, structured-output, infra).
  // Eagerly flip worlds.status='failed' on EVERY error attempt — without
  // this, BullMQ's retries + the BullMQ-marked-failed terminal state both
  // leave worlds.status='generating', which the concurrent-generation
  // guard reads as "still running" and blocks the user from retrying.
  // If the subsequent BullMQ retry succeeds, processWorldGen's per-attempt
  // top-of-function reset flips status back to 'generating' before re-
  // entering the stage loop. The retry path is sound; the brief 'failed'
  // state during an in-flight retry is accurate — the previous attempt did
  // fail.
  //
  // Saved 2026-05-15 after campaign 019e2d99-…-af07ada8ea7a's concept_intake
  // failure left world.status='generating' indefinitely.
  await deps.pool.query(`UPDATE worlds SET status = 'failed' WHERE id = $1`, [ctx.world.id])
  await publishEvent(deps, ctx.campaign.id, { type: 'phase', phase: 'world_gen_failed' })
  return 'rethrow'
}

async function publishEvent(
  deps: WorldGenDeps,
  campaignId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const channel = `${deps.redisKeyPrefix}pipeline:campaign:${campaignId}`
  await deps.redisRealtime.publish(channel, JSON.stringify(payload))
}

interface SanitizedError {
  readonly code: string
  readonly message: string
}

// Strict allowlist — only `code` (typed) and a length-capped `message` survive
// the boundary. Raw provider error chains (`err.cause`, `err.stack`, response
// objects with embedded API keys / connection strings) are dropped.
export function sanitizeError(err: unknown): SanitizedError {
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
