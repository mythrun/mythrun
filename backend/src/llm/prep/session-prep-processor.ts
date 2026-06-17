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
//   2. Publish `prep-started` (player-facing pipeline:campaign: channel),
//      resolve the campaign's world_id, run the stage (streams two prose docs
//      through Opus). Prose deltas ride the SEPARATE prep:campaign: channel via
//      publishProse — never the player-facing channel (sd_playbook may carry
//      secrets; enforced ignorance is type-enforced by the Deps split).
//   3. On success: persist the two artifacts to session_preps (ON CONFLICT
//      DO NOTHING — the first persisted row wins), UPDATE pipeline_runs →
//      'completed' with cost_usd, publish `prep-ready` with cost_usd.
//   4. On failure: classify via `isTerminalError`. Mark pipeline_runs 'failed'
//      either way; publish `prep-failed` with the terminal flag. Re-throw if
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
import type { PipelineEvent, ProseEvent } from '../../contract/pipeline-events.js'
import { isTerminalError } from '../errors.js'
import { logger } from '../logger.js'
import { atomicClaimStage } from './world-gen-processor.js'
import { generateSessionPrep } from './stages/session-prep.js'
import { buildPriorSessionContext } from './prior-session-context.js'
import { createRepo } from '../../repo/index.js'
import { computeCostUsd } from '../../billing/model-pricing.js'
import type { SessionHandoff } from '../schemas/post-session-analysis.js'

// Caps the prep's prior-summary fan-in (and the handoff lookback window). The
// repo read returns NEWEST-first, so the cap bounds how far back the prep
// prompt reaches.
const PRIOR_SUMMARY_CAP = 20

/** §6 deterministic verbatim injection. Builds the fixed "Returning characters /
 *  places" section from the handoff's voice + atmosphere excerpts. Returns '' when
 *  nothing to inject. NEVER paraphrased — concatenated verbatim. */
export function buildReturningVoicesSection(handoff: SessionHandoff | undefined): string {
  if (!handoff) return ''
  const lines: string[] = []
  for (const npc of handoff.npcs) {
    if (npc.voice.length === 0) continue
    lines.push(`${npc.name}:`)
    for (const v of npc.voice) lines.push(`- "${v}"`)
  }
  const locLines: string[] = []
  for (const loc of handoff.keyLocations) locLines.push(`- ${loc.name}: "${loc.atmosphere}"`)
  if (lines.length === 0 && locLines.length === 0) return ''
  const out: string[] = [
    '',
    '## Returning characters and places — keep these voices and atmospheres consistent',
    'These are verbatim moments from the previous session. Stay true to how these',
    'characters speak and how these places feel.',
    '',
  ]
  if (lines.length > 0) out.push('Voices:', ...lines, '')
  if (locLines.length > 0) out.push('Places:', ...locLines)
  return out.join('\n')
}

export interface SessionPrepJobPayload {
  readonly campaignId: string
  readonly sessionNumber: number
}

export interface SessionPrepProcessorDeps {
  readonly pool: Pool
  // Player-facing phase events ride the `pipeline:campaign:` channel. Typed to
  // PipelineEvent so the prose-carrying `prep-delta` (a ProseEvent) is a
  // compile error here — enforced ignorance at the type level.
  readonly publishEvent: (campaignId: string, event: PipelineEvent) => Promise<void>
  // Dev-only prose deltas ride the SEPARATE `prep:campaign:` channel. The
  // sd_playbook prose may contain secrets, so it must never type-check onto
  // publishEvent.
  readonly publishProse: (campaignId: string, event: ProseEvent) => Promise<void>
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

  // Claim won → announce the prep is starting on the player-facing channel
  // before any generation work.
  await deps.publishEvent(campaignId, { type: 'prep-started', sessionNumber })

  try {
    const worldId = await repo.campaigns.getWorldId(campaignId)
    // Unreachable in practice: campaigns.world_id is NOT NULL (migration 001) and
    // atomicClaimStage's pipeline_runs INSERT FK-references campaigns(id), so a
    // campaign that reaches here always has a world. Guard kept for type-narrowing.
    /* c8 ignore next 3 */
    if (worldId === null) {
      throw new Error(`session-prep: no world for campaign ${campaignId}`)
    }
    // §4 — fetch the prior ended-session context (NEWEST-first), parse it into
    // the prep's PriorSessionContext (chronological summaries + latest handoff).
    const priorRows = await repo.sessions.getPriorContextForPrep(campaignId, PRIOR_SUMMARY_CAP)
    const priorSessionContext = buildPriorSessionContext(priorRows)
    const result = await generateSessionPrep(repo, {
      campaignId,
      worldId,
      sessionNumber,
      priorSessionContext,
      // Progressive prose rides the dev-only `prep:campaign:` channel.
      // Fire-and-forget: a publish failure must never abort generation.
      onProseDelta: (field, text) => {
        void deps.publishProse(campaignId, { type: 'prep-delta', field, text }).catch(() => undefined)
      },
    })
    // §6 — deterministically append the verbatim voice / atmosphere excerpts to
    // ft_context AFTER generation. NEVER paraphrased through the prep LLM.
    const ftContext = result.ft_context + buildReturningVoicesSection(priorSessionContext.latestHandoff)
    await repo.sessionPreps.insert({
      campaignId,
      sessionNumber,
      ftContext,
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
    await deps.publishEvent(campaignId, { type: 'prep-ready', sessionNumber, costUsd })
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
      type: 'prep-failed',
      sessionNumber,
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
