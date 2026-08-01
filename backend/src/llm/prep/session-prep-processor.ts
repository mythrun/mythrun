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
// Cost: priced on Opus rates via `computeCostUsd(OPUS_ID, …)`,
// mirroring paint-job-validator.ts. The stage runs entirely on Opus
// (session-prep.ts uses the OPUS model constant), so a single-tier price is
// correct here.

import { DelayedError, type Job } from 'bullmq'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { PipelineEvent, ProseEvent } from '../../contract/pipeline-events.js'
import { isTerminalError } from '../errors.js'
import { logger } from '../logger.js'
import { createLlmHealthTracker } from '../llm-health.js'
import { isParkExhausted, nextParkDelayMs } from '../../repo/resume-stamps.js'
import { atomicClaimStage, parkEligibleClass } from './world-gen-processor.js'
import { generateSessionPrep } from './stages/session-prep.js'
import { runSecretTripwire } from '../secret-tripwire.js'
import { buildPriorSessionContext } from './prior-session-context.js'
import { createRepo, type Repo } from '../../repo/index.js'
import { computeCostUsd } from '../../billing/model-pricing.js'
import { OPUS_ID } from '../models.js'
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
  // llm-outage-resilience §3.1: the park path reads the sitewide health state
  // (one Redis GET per job, BEFORE the claim) to decide whether a park
  // consumes budget. Same primitives the world-gen processor builds its
  // tracker from.
  readonly redisRealtime: Redis
  readonly redisKeyPrefix: string
  // Player-facing phase events ride the `pipeline:campaign:` channel. Typed to
  // PipelineEvent so the prose-carrying `prep-delta` (a ProseEvent) is a
  // compile error here — enforced ignorance at the type level.
  readonly publishEvent: (campaignId: string, event: PipelineEvent) => Promise<void>
  // Dev-only prose deltas ride the SEPARATE `prep:campaign:` channel. The
  // sd_playbook prose may contain secrets, so it must never type-check onto
  // publishEvent.
  readonly publishProse: (campaignId: string, event: ProseEvent) => Promise<void>
}

/** The Job slice the processor reads. `moveToDelayed` + `token` serve the
 *  §3.1 self-delay; the containment wrapper forwards only the job, so
 *  `job.token` (stamped by the Worker before invoking) is the path the lock
 *  token actually arrives by in production. */
export type SessionPrepJobLike = Pick<
  Job<SessionPrepJobPayload>,
  'data' | 'moveToDelayed' | 'token'
>

// Top-level orchestration: health-read → claim → resolve world → generate →
// persist → mark → publish, with the §3.1 park containment on the failure
// path. Kept linear (no helper extraction beyond maybeParkPrep) so the
// per-stage invariant is grep-friendly in one read. Exceeds the 50-line
// budget for the same reason the character-creation loop does: splitting the
// claim/publish/mark/classify steps would thread the campaign+session tuple
// through nested boundaries and lose the linear-read property.
// eslint-disable-next-line max-lines-per-function
export async function processSessionPrepJob(
  deps: SessionPrepProcessorDeps,
  job: SessionPrepJobLike,
  token?: string,
): Promise<void> {
  const { campaignId, sessionNumber } = job.data
  const stage = `session-prep:${String(sessionNumber)}`
  const lockToken = token ?? job.token

  logger.info(
    { event: 'session_prep.job_received', campaignId, sessionNumber },
    'session-prep job received',
  )

  // §3.1 pinned ordering: health GET, then claim, then attempt. The pre-claim
  // reading decides consume on a later park — a waking attempt during a known
  // sitewide outage must re-park without burning the solo 6h budget.
  const llmHealth = createLlmHealthTracker(deps.redisRealtime, deps.redisKeyPrefix, logger)
  const preClaimHealth = await llmHealth.read()

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
  // §3.2: a running-not-stuck row is a LIVE stage on another worker. Stop
  // with a retryable throw — BullMQ re-drives later, when the stuck-reset can
  // fire. Proceeding past it would double-run the prep.
  if (claim === 'in-flight') {
    throw Object.assign(
      new Error(`session-prep stage ${stage} is in-flight on another worker; retrying later`),
      { code: 'stage_in_flight' },
    )
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

  // §3.1 stamp lifecycle: claim success disarms the resume (the overdue
  // predicate goes false at stage-start); the rung + budget fields survive so
  // a re-park continues the ladder. Pinned ordering: immediately after claim.
  await repo.resumeStamps.clearNextResumeAt('session_prep', campaignId)

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
    const tripwire = await vetOpening(result.opening, result.sd_playbook, ftContext, campaignId)
    await repo.sessionPreps.insert({
      campaignId,
      sessionNumber,
      ftContext,
      sdPlaybook: result.sd_playbook,
      opening: result.opening,
    })
    // The `?? 0` arms are defense-in-depth: the Anthropic SDK always populates
    // token counts (same rationale as paint-job-validator's addUsage), so the
    // undefined arms never fire in practice — exclude them from branch coverage.
    /* c8 ignore start */
    const costUsd =
      computeCostUsd(OPUS_ID, {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      }) +
      // MYT-101: the opening tripwire's Haiku spend rides the same stage cost.
      computeCostUsd('claude-haiku-4-5-20251001', {
        inputTokens: tripwire.usage.inputTokens ?? 0,
        outputTokens: tripwire.usage.outputTokens ?? 0,
      })
    /* c8 ignore stop */
    await repo.pipelineRuns.markStageCompleted({
      kind: 'campaign',
      campaignId,
      stage,
      costUsd,
    })
    // §3.1 stamp lifecycle: a COMPLETED stage ends the park episode — the
    // outage passed, so the ladder rung and budget reset with the row. No-op
    // when no stamp exists.
    await repo.resumeStamps.clearStamp('session_prep', campaignId)
    await deps.publishEvent(campaignId, { type: 'prep-ready', sessionNumber, costUsd })
    logger.info(
      { event: 'session_prep.completed', campaignId, sessionNumber, costUsd },
      'session-prep completed',
    )
  } catch (err) {
    // llm-outage-resilience §3.1: park-eligible, non-terminal, budget
    // remaining → the job delays ITSELF (the DelayedError throw is BullMQ's
    // sanctioned self-delay, not a failure — attempts stay untouched).
    // Everything else keeps today's exact behavior.
    const parked = await maybeParkPrep(deps, repo, { campaignId, sessionNumber, stage }, err, {
      job,
      token: lockToken,
      degraded: preClaimHealth.state === 'degraded',
    })
    if (parked) throw new DelayedError()
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

/**
 * llm-outage-resilience §3.1 — the containment path, mirroring the world-gen
 * reference (maybeParkStage). On a park-eligible (connectivity | rate-limit),
 * NON-TERMINAL failure with park budget remaining:
 *
 *   1. Mark the stage row failed AS TODAY — the row must be claimable on
 *      wake. The STAMP, not the row, distinguishes parked from failed.
 *   2. Upsert the resume stamp (pipeline 'session_prep', entity_id =
 *      campaignId — the BINDING identity the §3.2 promote scan recovers from
 *      the `sp-<campaignId>-<n>` jobId). Degraded parks consume no budget.
 *   3. Publish prep-failed{terminal:false, failureClass}, THEN self-delay the
 *      SAME job (`moveToDelayed` + the caller's DelayedError throw) — no add,
 *      no dedup interaction, single-flight by construction.
 *
 * Returns false (→ today's exact behavior) for other classes, terminal
 * errors, and an exhausted budget (which lands on the retryable surface).
 */
async function maybeParkPrep(
  deps: SessionPrepProcessorDeps,
  repo: Repo,
  ids: { campaignId: string; sessionNumber: number; stage: string },
  err: unknown,
  opts: {
    readonly job: SessionPrepJobLike
    readonly token: string | undefined
    readonly degraded: boolean
  },
): Promise<boolean> {
  const errorClass = parkEligibleClass(err)
  if (errorClass === null || isTerminalError(err)) return false
  const prior = await repo.resumeStamps.get('session_prep', ids.campaignId)
  if (prior !== null && isParkExhausted(prior)) return false

  /* c8 ignore next — non-Error throw defense, mirroring the catch above. */
  const message = err instanceof Error ? err.message : String(err)
  await repo.pipelineRuns.markStageFailed({
    kind: 'campaign',
    campaignId: ids.campaignId,
    stage: ids.stage,
    error: message,
  })

  const delayMs = nextParkDelayMs(prior?.resumeAttempt ?? 0)
  const stamp = await repo.resumeStamps.upsertPark({
    pipeline: 'session_prep',
    entityId: ids.campaignId,
    delayMs,
    consume: !opts.degraded,
    errorClass,
  })
  logger.warn(
    {
      event: 'session_prep.stage_parked',
      campaignId: ids.campaignId,
      sessionNumber: ids.sessionNumber,
      errorClass,
      resumeAttempt: stamp.resumeAttempt,
      parkConsumedMs: stamp.parkConsumedMs,
      delayMs,
      degraded: opts.degraded,
    },
    'session-prep parked for auto-resume',
  )

  // The parked event stays terminal:false (a park is a retrying state); the
  // additive failureClass is the live hint for the parked hold copy —
  // authoritative delivery is the prep-status snapshot derivation.
  await deps.publishEvent(ids.campaignId, {
    type: 'prep-failed',
    sessionNumber: ids.sessionNumber,
    terminal: false,
    failureClass: errorClass,
  })
  await opts.job.moveToDelayed(Date.now() + delayMs, opts.token)
  return true
}

// The returned processor takes the narrow SessionPrepJobLike (parameter
// contravariance makes it assignable where BullMQ's `(job: Job, token?)`
// processor shape is expected), so tests and the Worker share one signature.
export function createSessionPrepProcessor(
  deps: SessionPrepProcessorDeps,
): (job: SessionPrepJobLike, token?: string) => Promise<void> {
  return async (job, token) => {
    await processSessionPrepJob(deps, job, token)
  }
}

// MYT-101: vet the player-facing opening against this generation's OWN
// playbook (the session's complete secret surface). The opening is generated
// ONCE, so this gate stays STRICT: ANY non-clean severity (soft_consistency OR
// hard_reveal) fails the stage (retryable; a regeneration may pass). Rationale
// (myth-retprop): the proportionality problem the severity split fixes is the
// per-turn PUBLIC retcon — a live open correction over an in-character detail.
// The opening has no such cost: a soft-brushy opening is simply regenerated
// before any player sees it, so there is no reason to ship one. A tripped
// opening is NEVER persisted, and neither is the rest of the prep (the row is
// all-or-nothing). Returns the tripwire output so its Haiku usage rides the
// stage cost.
async function vetOpening(
  opening: string,
  sdPlaybook: string,
  ftContext: string,
  campaignId: string,
): Promise<Awaited<ReturnType<typeof runSecretTripwire>>> {
  // The opening is the FIRST player-facing prose, so its grounding floor is the
  // very briefing (ft_context) it was generated alongside — a detail the opening
  // shares with the briefing is public, not a leak (myth-retprop).
  // No sessionId: this is the PREP leg (the session doesn't exist yet);
  // campaignId is the cost-harness attribution (cost wave 1 §1.0).
  const tripwire = await runSecretTripwire({
    prose: opening,
    secrets: sdPlaybook,
    publicContext: ftContext,
    campaignId,
  })
  if (tripwire.result.severity !== 'none') {
    throw new Error(
      `session-prep: opening tripped the secret tripwire (severity ${tripwire.result.severity}, confidence ${String(tripwire.result.confidence)}, ref ${tripwire.result.secretRef ?? 'none'})`,
    )
  }
  return tripwire
}
