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
import { createRepo } from '../../repo/index.js'

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
}

const STAGE = 'character_integration'

// Top-level orchestration: claim → run → mark → publish. Kept linear (no
// helper extraction) so the per-stage invariant (claim/run/mark/classify-
// error) is grep-friendly in one read; under the 50-line budget.
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

  try {
    // myth-gp2c Cluster C: the integration stage persists through the unified
    // repo surface (reads + Opus call outside `repo.transaction`, the 7-table
    // write inside it). Build the repo from the same pool the processor threads
    // everywhere else.
    const result = await runCharacterIntegrationStage(createRepo(deps.pool), {
      campaignId,
      ownerUserId,
    })
    await deps.pool.query(
      `UPDATE pipeline_runs
          SET status = 'completed', cost_usd = $1, completed_at = now()
        WHERE campaign_id = $2 AND stage = $3 AND user_id IS NULL`,
      [result.llmCostUsd, campaignId, STAGE],
    )
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
  } catch (err) {
    const terminal = isTerminalError(err)
    // Non-Error throw branch defense; the handler throws Error subclasses
    // (LlmStructuredOutputError, CostCapExceededError, pg errors, etc.).
    /* c8 ignore next */
    const message = err instanceof Error ? err.message : String(err)
    await deps.pool.query(
      `UPDATE pipeline_runs
          SET status = 'failed', error = $1, completed_at = now()
        WHERE campaign_id = $2 AND stage = $3 AND user_id IS NULL`,
      [message, campaignId, STAGE],
    )
    // MYT-56: on TERMINAL failure (no point retrying), flip campaigns.status
    // to 'failed' so the bare GET /api/campaigns row + the SSE-derived phase
    // both surface the terminal state. Without this, the campaign would sit
    // in 'setup' indefinitely with no observable terminal state. On
    // NON-terminal failure we leave the campaign at 'setup' — BullMQ will
    // retry with backoff and a later attempt may succeed.
    if (terminal) {
      await deps.pool.query(
        `UPDATE campaigns SET status = 'failed', updated_at = now() WHERE id = $1`,
        [campaignId],
      )
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
