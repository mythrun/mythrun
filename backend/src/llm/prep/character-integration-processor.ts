// backend/src/llm/prep/character-integration-processor.ts
//
// MYT-54 T11: BullMQ processor for the campaign-scoped character-integration
// job. One job per (campaign_id) — fan-in dispatched by the owner once every
// player's character-creation row is 'completed'. Wraps T10's pure handler
// (`runCharacterIntegrationStage`) with the per-stage lifecycle bookkeeping:
//
//   1. atomicClaimStage on (campaign_id, 'character_integration') — INSERT-
//      with-ON-CONFLICT against pipeline_runs (user_id IS NULL). 'completed'
//      → no-op (idempotent re-entry: BullMQ retried an already-done job);
//      'lost-race' → another worker won, return cleanly.
//   2. Run the handler.
//   3. On success: UPDATE pipeline_runs → 'completed' with cost_usd + publish
//      stage-completed event.
//   4. On failure: classify via `isTerminalError`. Mark pipeline_runs 'failed'
//      with the error message either way. Publish stage-failed with the
//      terminal flag. Re-throw if NON-terminal so BullMQ retries; terminal
//      errors return cleanly (no BullMQ retry — would just re-produce the
//      same outcome).
//
// Column names confirmed against migration 001: pipeline_runs uses `error`
// (not `error_message`) and `completed_at` (not `finished_at`). updated_at
// does NOT exist on this table.

import type { Job } from 'bullmq'
import type { Pool } from 'pg'
import { isTerminalError } from '../errors.js'
import { logger } from '../logger.js'
import { atomicClaimStage } from './world-gen-processor.js'
import { runCharacterIntegrationStage } from './stages/character-integration.js'
import { createRepo, type Repo } from '../../repo/index.js'
import { embedWorld } from '../../world/retrieval/index.js'
import { createVoyageEmbedder } from '../embed.js'

export interface CharacterIntegrationJobPayload {
  readonly campaignId: string
  readonly ownerUserId: string
}

export interface CharacterIntegrationProcessorDeps {
  readonly pool: Pool
  readonly publishEvent: (
    campaignId: string,
    event: Record<string, unknown>,
  ) => Promise<void>
  // MYT-71 §4.3: the Voyage key for the post-success embed post-pass. The
  // embedder is built lazily inside the success block, only when there are
  // NULL-embedded integration facts to embed.
  readonly voyageApiKey: string
}

const STAGE = 'character_integration'

// MYT-71 §4.3: TERMINAL embed post-pass. character-integration inserts new
// PC-backstory facts on existing world NPCs AFTER world-gen's embed stage ran,
// so those rows ship NULL-embedded. This re-embeds the world's NULL rows (no
// force) so the world stays searchable. TOTAL: the integration is ALREADY
// committed + markStageCompleted'd + stage-completed-published by the time this
// runs, so a Voyage/DB error here must NOT fail the job — it catches its own
// errors and logs (never rethrows into the processor's outer catch, which would
// wrongly flip the completed stage to 'failed').
async function runIntegrationEmbedPostPass(
  repo: Repo,
  campaignId: string,
  voyageApiKey: string,
): Promise<void> {
  try {
    const worldId = await repo.campaigns.getWorldId(campaignId)
    if (worldId !== null) {
      const embedder = createVoyageEmbedder({ apiKey: voyageApiKey })
      const summary = await embedWorld({ embedder, repo }, worldId)
      // Triage exactly as the world-gen embed stage does: a CONFIG-class Voyage
      // failure (wrong key/model/dim) breaks EVERY world and never self-heals →
      // escalate LOUDLY at ERROR (alarmable); a transient degrade → WARN; a
      // clean run → the routine INFO log. Stays non-fatal either way.
      if (summary.configErrorKind !== undefined) {
        logger.error(
          { event: 'character_integration.embed_misconfigured', campaignId, worldId, ...summary },
          'voyage MISCONFIGURED during integration embed — every world affected until the key/model/dim is fixed',
        )
      } else if (summary.voyageErrors > 0) {
        logger.warn(
          { event: 'character_integration.embed_degraded', campaignId, worldId, ...summary },
          'voyage transient failure during integration embed — rows left NULL, backfill will recover',
        )
      } else {
        logger.info(
          { event: 'character_integration.embed', campaignId, worldId, ...summary },
          'integration embed post-pass',
        )
      }
    } else {
      logger.warn(
        { event: 'character_integration.embed_skipped', campaignId },
        'no world_id for campaign; skipping integration embed post-pass',
      )
    }
  } catch (err) {
    logger.warn(
      { event: 'character_integration.embed_failed', campaignId, err },
      'integration embed post-pass failed (non-fatal)',
    )
  }
}

// Top-level orchestration: claim → run → mark → publish → embed. Kept linear
// (only the embed post-pass is extracted, to stay under the line budget) so the
// per-stage invariant (claim/run/mark/classify-error) is grep-friendly.
export async function processCharacterIntegrationJob(
  deps: CharacterIntegrationProcessorDeps,
  job: Pick<Job<CharacterIntegrationJobPayload>, 'data'>,
): Promise<void> {
  const { campaignId, ownerUserId } = job.data

  logger.info(
    { event: 'character_integration.job_received', campaignId, ownerUserId },
    'character-integration job received',
  )

  const claim = await atomicClaimStage(deps.pool, {
    kind: 'campaign',
    campaignId,
    stage: STAGE,
  })
  // Idempotent re-entry: BullMQ retried but the row is already done.
  if (claim === 'completed') {
    logger.info(
      { event: 'character_integration.idempotent_skip', campaignId },
      'character-integration already completed; no-op',
    )
    return
  }
  // 'lost-race' arm only triggers when two workers race on the same
  // (campaign, stage); concurrency 5 makes this possible if a duplicate
  // job is enqueued. Return cleanly — the winner will publish completion.
  /* c8 ignore next 4 */
  if (claim === 'lost-race') {
    logger.info({ event: 'character_integration.lost_race', campaignId }, 'lost claim race')
    return
  }

  // myth-gp2c Cluster C: the integration stage persists through the unified
  // repo surface (reads + Opus call outside `repo.transaction`, the 7-table
  // write inside it). Build the repo from the same pool the processor threads
  // everywhere else; the per-stage bookkeeping writes go through it too.
  const repo = createRepo(deps.pool)

  try {
    const result = await runCharacterIntegrationStage(repo, {
      campaignId,
      ownerUserId,
    })
    await repo.pipelineRuns.markStageCompleted({
      kind: 'campaign',
      campaignId,
      stage: STAGE,
      costUsd: result.llmCostUsd,
    })
    await deps.publishEvent(campaignId, {
      type: 'stage-completed',
      stage: STAGE,
      costUsd: result.llmCostUsd,
    })
    logger.info(
      {
        event: 'character_integration.completed',
        campaignId,
        costUsd: result.llmCostUsd,
      },
      'character-integration completed',
    )

    await runIntegrationEmbedPostPass(repo, campaignId, deps.voyageApiKey)
  } catch (err) {
    const terminal = isTerminalError(err)
    // Non-Error throw branch defense; the handler throws Error subclasses
    // (LlmStructuredOutputError, CostCapExceededError, pg errors, etc.).
    /* c8 ignore next */
    const message = err instanceof Error ? err.message : String(err)
    await repo.pipelineRuns.markStageFailed({
      kind: 'campaign',
      campaignId,
      stage: STAGE,
      error: message,
    })
    // MYT-56: on TERMINAL failure (no point retrying), flip campaigns.status
    // to 'failed' so the bare GET /api/campaigns row + the SSE-derived phase
    // both surface the terminal state. Without this, the campaign would sit
    // in 'setup' indefinitely with no observable terminal state. On
    // NON-terminal failure we leave the campaign at 'setup' — BullMQ will
    // retry with backoff and a later attempt may succeed.
    if (terminal) {
      await repo.campaigns.setFailed(campaignId)
    }
    await deps.publishEvent(campaignId, {
      type: 'stage-failed',
      stage: STAGE,
      message,
      terminal,
    })
    logger.warn(
      {
        event: 'character_integration.failed',
        campaignId,
        terminal,
        err: message,
      },
      `character-integration ${terminal ? 'terminally ' : ''}failed`,
    )
    // Non-terminal → BullMQ retries with backoff; terminal → return cleanly
    // so BullMQ marks the job 'completed' (retrying wouldn't help).
    if (!terminal) throw err
  }
}

export function createCharacterIntegrationProcessor(
  deps: CharacterIntegrationProcessorDeps,
): (job: Job<CharacterIntegrationJobPayload>) => Promise<void> {
  return async (job) => {
    await processCharacterIntegrationJob(deps, job)
  }
}
