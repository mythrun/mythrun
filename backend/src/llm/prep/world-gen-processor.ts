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
import {
  stageNotImplementedHandler,
  StageNotImplementedError,
} from './stages/stage-not-implemented.js'
import { uuidv7 } from '../../repo/uuidv7.js'

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
  'starting_situation',
  'random_tables',
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

interface StageCost {
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
}

type ClaimResult = 'claimed' | 'completed' | 'lost-race'

export function createWorldGenProcessor(
  deps: WorldGenDeps,
): (job: Job<WorldGenJobPayload>) => Promise<void> {
  return async function processWorldGen(job: Job<WorldGenJobPayload>): Promise<void> {
    const { campaignId } = job.data
    const ctx = await loadCampaignContext(deps.pool, campaignId)
    if (ctx === null) {
      deps.logger.warn({ campaignId }, 'world-gen: campaign not found; job dropped')
      return
    }

    await publishEvent(deps, campaignId, { type: 'phase', phase: 'world_gen' })

    const capUsd = await readCostCap(deps.pool)

    for (const stage of WORLD_GEN_STAGES) {
      const claim = await atomicClaimStage(deps.pool, ctx.world.id, stage)
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
        const cost = await runStage(deps.pool, refreshed, stage)
        await markStageCompleted(deps.pool, refreshed.world.id, stage, cost)
        await publishEvent(deps, campaignId, {
          type: 'stage-completed',
          stage,
          userId: null,
          durationMs: Date.now() - startedAt,
          costUsd: cost.costUsd,
        })

        const cumulative = await sumCompletedStageCosts(deps.pool, refreshed.world.id)
        if (cumulative > capUsd) {
          await markStageCappedAndRefund(deps, refreshed, stage, cumulative, capUsd)
          return
        }
        await publishEvent(deps, campaignId, {
          type: 'cost-update',
          cumulativeUsd: cumulative,
        })
      } catch (err) {
        const handled = await handleStageError(deps, ctx, stage, err)
        if (handled === 'stop') return
        throw err
      }
    }

    await markWorldComplete(deps.pool, ctx.world.id)
    await publishEvent(deps, campaignId, { type: 'phase', phase: 'world_ready' })
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
  if (row === undefined) return null
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
  return reloaded ?? ctx
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
  if (row === undefined) return 'lost-race'
  if (row.status === 'completed') return 'completed'
  if (row.status !== 'running') return 'lost-race'

  const stuckReset = await pool.query<{ id: string }>(
    `UPDATE pipeline_runs
        SET status = 'running', started_at = now(), error = NULL
      WHERE world_id = $1 AND stage = $2 AND user_id IS NULL
        AND status = 'running'
        AND started_at < now() - INTERVAL '5 minutes'
      RETURNING id`,
    [worldId, stage],
  )
  if (stuckReset.rowCount !== null && stuckReset.rowCount > 0) return 'claimed'
  return 'lost-race'
}

async function runStage(
  pool: Pool,
  ctx: CampaignContext,
  stage: WorldGenStage,
): Promise<StageCost> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const cost = await dispatchStage(client, ctx, stage)
    await client.query('COMMIT')
    return cost
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

async function dispatchStage(
  client: PoolClient,
  ctx: CampaignContext,
  stage: WorldGenStage,
): Promise<StageCost> {
  if (stage === 'concept_intake') {
    return runConceptIntakeStage(client, {
      worldId: ctx.world.id,
      conceptText: ctx.world.concept,
      intentSummary: null,
    })
  }
  if (stage === 'starting_situation') {
    return runStartingSituationStage(client, {
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
  }
  if (stage === 'random_tables') {
    return runRandomTablesStage(client, {
      worldId: ctx.world.id,
      worldName: ctx.world.name,
      tone: ctx.world.tone ?? '',
      themes: ctx.world.themes ?? '',
      era: ctx.world.era ?? '',
      geographySummary: ctx.world.geographySummary ?? '',
      seedTablesBlock: SEED_TABLES_PLACEHOLDER,
    })
  }
  // stages 2 + 3 — placeholder failure per D7. The handler always rejects.
  return stageNotImplementedHandler(stage)()
}

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

async function markWorldComplete(pool: Pool, worldId: string): Promise<void> {
  await pool.query(`UPDATE worlds SET status = 'complete' WHERE id = $1`, [worldId])
}

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
    await publishEvent(deps, ctx.campaign.id, { type: 'phase', phase: 'world_gen_failed' })
    return 'stop'
  }
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
