// backend/src/llm/prep/session-prep-processor.ts
//
// MYT-61 T4: BullMQ processor for the session-prep job. One job per
// (campaign_id, session_number) — enqueued by MYT-63 with
// jobId = `sp-${campaignId}-${sessionNumber}`. Wraps MYT-59 T4's pure
// `generateSessionPrep` stage with the per-stage pipeline_runs lifecycle:
//
//   1. atomicClaimStage on (campaign_id, `session-prep:${sessionNumber}`) —
//      INSERT-with-ON-CONFLICT against pipeline_runs (user_id IS NULL).
//      pipeline_runs keys on (campaign, stage); embedding the session number
//      in the stage string gives each session its own claim/mark row.
//      'completed' → no-op (idempotent re-entry: BullMQ retried an already-
//      done job); 'lost-race' → another worker won, return cleanly.
//   2. Resolve the campaign's world_id, run the stage (streams two prose
//      docs through Opus).
//   3. On success: persist the two artifacts to session_preps (ON CONFLICT
//      DO NOTHING — the first persisted row wins), UPDATE pipeline_runs →
//      'completed' with cost_usd, publish stage-completed.
//   4. On failure: classify via `isTerminalError`. Mark pipeline_runs 'failed'
//      either way; publish stage-failed with the terminal flag. Re-throw if
//      NON-terminal so BullMQ retries; terminal errors return cleanly.
//
// CRITICAL (differs from character-integration-processor): a session-prep
// failure — terminal or not — does NOT flip campaigns.status to 'failed'. A
// prep failure is session-scoped: the campaign stays active and a later
// session attempt can succeed. We intentionally do NOT call
// `repo.campaigns.setFailed`.
//
// Cost: priced on Opus rates via `computeCostUsd('claude-opus-4-7', …)`,
// mirroring paint-job-validator.ts. The stage runs entirely on Opus
// (session-prep.ts uses the OPUS model constant), so a single-tier price is
// correct here.

import type { Job } from 'bullmq'
import type { Pool } from 'pg'
import { isTerminalError } from '../errors.js'
import { logger } from '../logger.js'
import { atomicClaimStage } from './world-gen-processor.js'
import { generateSessionPrep } from './stages/session-prep.js'
import { createRepo } from '../../repo/index.js'
import { computeCostUsd } from '../../billing/model-pricing.js'

export interface SessionPrepJobPayload {
  readonly campaignId: string
  readonly sessionNumber: number
}

export interface SessionPrepProcessorDeps {
  readonly pool: Pool
  readonly publishEvent: (
    campaignId: string,
    event: Record<string, unknown>,
  ) => Promise<void>
}

// Top-level orchestration: claim → resolve world → generate → persist → mark
// → publish. Kept linear (no helper extraction) so the per-stage invariant is
// grep-friendly in one read; under the 50-line budget.
export async function processSessionPrepJob(
  deps: SessionPrepProcessorDeps,
  job: Pick<Job<SessionPrepJobPayload>, 'data'>,
): Promise<void> {
  const { campaignId, sessionNumber } = job.data
  const stage = `session-prep:${String(sessionNumber)}`

  logger.info(
    { event: 'session_prep.job_received', campaignId, sessionNumber },
    'session-prep job received',
  )

  const claim = await atomicClaimStage(deps.pool, {
    kind: 'campaign',
    campaignId,
    stage,
  })
  // Idempotent re-entry: BullMQ retried but the row is already done.
  if (claim === 'completed') {
    logger.info(
      { event: 'session_prep.idempotent_skip', campaignId, sessionNumber },
      'session-prep already completed; no-op',
    )
    return
  }
  // 'lost-race' only triggers when two workers race on the same (campaign,
  // stage); concurrency >1 makes this possible if a duplicate job is
  // enqueued. Return cleanly — the winner will publish completion.
  /* c8 ignore next 7 */
  if (claim === 'lost-race') {
    logger.info(
      { event: 'session_prep.lost_race', campaignId, sessionNumber },
      'lost claim race',
    )
    return
  }

  const repo = createRepo(deps.pool)

  try {
    const worldId = await repo.campaigns.getWorldId(campaignId)
    // Unreachable in practice: campaigns.world_id is NOT NULL (migration 001) and
    // atomicClaimStage's pipeline_runs INSERT FK-references campaigns(id), so a
    // campaign that reaches here always has a world. Guard kept for type-narrowing.
    /* c8 ignore next 3 */
    if (worldId === null) {
      throw new Error(`session-prep: no world for campaign ${campaignId}`)
    }
    const result = await generateSessionPrep(repo, { campaignId, worldId, sessionNumber })
    await repo.sessionPreps.insert({
      campaignId,
      sessionNumber,
      ftContext: result.ft_context,
      sdPlaybook: result.sd_playbook,
    })
    // The `?? 0` arms are defense-in-depth: the Anthropic SDK always populates
    // token counts (same rationale as paint-job-validator's addUsage), so the
    // undefined arms never fire in practice — exclude them from branch coverage.
    /* c8 ignore start */
    const costUsd = computeCostUsd('claude-opus-4-7', {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    })
    /* c8 ignore stop */
    await repo.pipelineRuns.markStageCompleted({
      kind: 'campaign',
      campaignId,
      stage,
      costUsd,
    })
    await deps.publishEvent(campaignId, { type: 'stage-completed', stage, costUsd })
    logger.info(
      { event: 'session_prep.completed', campaignId, sessionNumber, costUsd },
      'session-prep completed',
    )
  } catch (err) {
    const terminal = isTerminalError(err)
    // Non-Error throw branch defense; the stage throws Error subclasses
    // (LlmStructuredOutputError, LlmRateLimitedError, pg errors, etc.).
    /* c8 ignore next */
    const message = err instanceof Error ? err.message : String(err)
    await repo.pipelineRuns.markStageFailed({
      kind: 'campaign',
      campaignId,
      stage,
      error: message,
    })
    // Deliberately NOT calling repo.campaigns.setFailed: a session-prep
    // failure is session-scoped, not campaign-fatal. The campaign stays at its
    // current status; a later session attempt can still succeed.
    await deps.publishEvent(campaignId, {
      type: 'stage-failed',
      stage,
      message,
      terminal,
    })
    logger.warn(
      { event: 'session_prep.failed', campaignId, sessionNumber, terminal, err: message },
      `session-prep ${terminal ? 'terminally ' : ''}failed`,
    )
    // Non-terminal → BullMQ retries with backoff; terminal → return cleanly so
    // BullMQ marks the job 'completed' (retrying wouldn't help).
    if (!terminal) throw err
  }
}

export function createSessionPrepProcessor(
  deps: SessionPrepProcessorDeps,
): (job: Job<SessionPrepJobPayload>) => Promise<void> {
  return async (job) => {
    await processSessionPrepJob(deps, job)
  }
}
