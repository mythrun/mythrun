// backend/src/llm/llm-health-probe.ts
//
// llm-outage-resilience Task 7 — the recovery probe cycle (design §2.2) and
// the §3.2 recovery fast-path promote scan. A BullMQ job scheduler (registered
// idempotently by worker.ts via upsertJobScheduler) fires one cycle every 60s:
//
//   healthy  → one Redis GET, no probes — then the safety scan, gated by the
//              `promote-pending` flag (spec amendment, controller-ruled):
//              while the flag is up (a clearing cycle armed it and no scan has
//              completed since — the probe worker died mid-window, or the scan
//              hit a Postgres blip after the state cleared) the cycle re-runs
//              the FULL 'all' scan and drops the flag on success, so a
//              recovery fires its wake exactly once fleet-wide. With no flag,
//              the scan promotes PAST-DUE stamps only — lost-job recovery. A
//              future-dated stamp (a solo-world park riding its §3.1 ladder
//              while the site is healthy) keeps its scheduled delay instead of
//              being hot-cycled every 60s into budget exhaustion. The scan is
//              one Postgres SELECT when nothing is armed.
//   degraded → probe every implicated model in parallel; all succeed → INCR
//              (at 3 the Lua clear fires and the promote scan runs over ALL
//              armed stamps — the immediate post-recovery wake is intended:
//              those wakes hit a healthy API and either complete or re-park,
//              consuming their scheduled rung once); any failure → reset the
//              counter, refresh the state TTL.
//
// Single-flight is the TIMING invariant, not a concurrency setting: a full
// cycle (30s probe wall clock + scan) always finishes inside the 60s interval.
//
// The promote scan maps armed resume stamps to their queues' DELAYED jobs and
// `promote()`s them — never `add` (D9: a held jobId makes add a silent no-op).
// Stamp → jobId identity (the contract the §3.1 parking sites persist):
//
//   world_gen          entityId = campaignId          jobId `${campaignId}`
//   session_prep       entityId = campaignId          jobId `sp-${campaignId}-${n}`
//   character_creation entityId = character_concepts.id  jobId `cc-${campaignId}-${userId}`
//
// sp-/cc- counterpart fields are recovered from the delayed job's OWN id,
// parsed at fixed UUID widths (uuids embed hyphens — never split('-')), then
// matched back to the stamp (cc via characterConcepts.getByCampaignAndUser,
// the one lookup the repo supports). Catch-and-continue per job: promoting an
// already-waiting/active job throws — the natural wake may have raced.

import type pino from 'pino'
import { generateText, type LanguageModel } from './ai.js'
import type { LlmHealthTracker } from './llm-health.js'
import { logger as moduleLogger } from './logger.js'
import { HAIKU, OPUS, SONNET } from './models.js'
import { describeErrorForLog } from '../queue/job-containment.js'
import type { ResumeStamp, ResumeStampsRepo } from '../repo/resume-stamps.js'

export const QUEUE_LLM_HEALTH_PROBE = 'llm-health-probe' as const
/** Stable scheduler id — upsertJobScheduler keyed on it is idempotent across
 *  worker boots and rolling deploys. */
export const LLM_HEALTH_PROBE_SCHEDULER_ID = 'llm-health-probe-cycle'
export const LLM_HEALTH_PROBE_EVERY_MS = 60_000
/** Per-probe wall clock (§2.2). 30s × parallel probes keeps the whole cycle
 *  well under the 60s interval — THE single-flight guarantee. */
export const PROBE_TIMEOUT_MS = 30_000

/** Empty/absent models SET is NEVER a vacuous success (§2.2): fall back to
 *  probing all three tier constants. Derived from the wrapped models' own ids
 *  so no model-name string is hardcoded outside models.ts (the pin). */
export const PROBE_FALLBACK_MODEL_IDS: readonly string[] = [
  HAIKU.modelId,
  SONNET.modelId,
  OPUS.modelId,
]

const PROBE_MODELS: ReadonlyMap<string, LanguageModel> = new Map<string, LanguageModel>([
  [HAIKU.modelId, HAIKU],
  [SONNET.modelId, SONNET],
  [OPUS.modelId, OPUS],
])

/** Reserved system label for probe calls. Probe spend cannot bill a user by
 *  construction — there is no bucketed cost-attribution mechanism (the dev
 *  cost tracker is one process-level counter); this label reaches the llm.call
 *  log line (via the mythrun stage binding and the §1.2 callSite) ONLY, so
 *  probe traffic is identifiable in logs rather than billed anywhere. */
const PROBE_CALLSITE = 'llm-health-probe'
const PROBE_PROMPT = 'Reply with only the word: ok'

export type ProbeCycleResult = 'healthy-noop' | 'still-degraded' | 'cleared'

export interface ProbeCycleDeps {
  readonly tracker: Pick<
    LlmHealthTracker,
    | 'read'
    | 'readModels'
    | 'probeSuccess'
    | 'probeFailure'
    | 'markPromotePending'
    | 'clearPromotePending'
    | 'hasPromotePending'
  >
  readonly models: {
    /** One single-attempt minimal call; resolution = the model answered
     *  (regardless of finishReason), rejection = still down. */
    readonly probe: (modelId: string) => Promise<void>
  }
  /** The §3.2 armed-stamp promote scan (createArmedStampPromoter). */
  readonly promoteArmed: (scope: PromoteScope) => Promise<void>
  readonly logger: pino.Logger
}

/** Which armed stamps a promote scan may wake.
 *  - 'all'      — the clearing cycle: every armed stamp wakes immediately on
 *                 recovery (each wake consumes its scheduled rung once).
 *  - 'past-due' — healthy cycles: lost-job recovery only. A stamp whose
 *                 nextResumeAt is still in the future is a ladder delay in
 *                 progress, not a stranded job — promoting it would bypass the
 *                 §3.1 ladder and burn the park budget at 60s cadence. */
export type PromoteScope = 'all' | 'past-due'

/** One probe cycle. Runs as the repeatable job's processor; a throw here is
 *  contained by containProcessor and the next 60s cycle retries naturally. */
export async function runProbeCycle(deps: ProbeCycleDeps): Promise<ProbeCycleResult> {
  const state = await deps.tracker.read()
  if (state.state === 'ok') {
    // Fire-once recovery net: while promote-pending is up, some clearing
    // cycle's 'all' scan never completed — re-run it and drop the flag only
    // after THIS scan succeeds (a throw leaves it armed for the next cycle).
    if (await deps.tracker.hasPromotePending()) {
      await deps.promoteArmed('all')
      await deps.tracker.clearPromotePending()
    } else {
      await deps.promoteArmed('past-due')
    }
    return 'healthy-noop'
  }

  const implicated = await deps.tracker.readModels()
  const targets = implicated.length > 0 ? implicated : PROBE_FALLBACK_MODEL_IDS
  const outcomes = await Promise.allSettled(targets.map((id) => deps.models.probe(id)))
  const failures = targets.flatMap((modelId, i) => {
    const outcome = outcomes[i]
    return outcome !== undefined && outcome.status === 'rejected'
      ? [{ modelId, err: describeErrorForLog(outcome.reason) }]
      : []
  })

  if (failures.length > 0) {
    await deps.tracker.probeFailure()
    deps.logger.warn(
      {
        event: 'llm_health.probe_cycle_failed',
        targets,
        failedModels: failures.map((f) => f.modelId),
        failures,
      },
      'llm health probe cycle failed — counter reset, state TTL refreshed',
    )
    return 'still-degraded'
  }

  const verdict = await deps.tracker.probeSuccess()
  if (verdict === 'cleared') {
    // Arm the net BEFORE the scan: if the scan (or this worker) dies here,
    // the flag survives and the next healthy cycle re-runs the full scan.
    await deps.tracker.markPromotePending()
    await deps.promoteArmed('all')
    await deps.tracker.clearPromotePending()
    return 'cleared'
  }
  deps.logger.info(
    { event: 'llm_health.probe_cycle_succeeded', targets },
    'llm health probe cycle succeeded — counting toward clear',
  )
  return 'still-degraded'
}

/** One minimal single-attempt call (§2.2): SDK maxRetries 0 (outside the §1.3
 *  attempt loop), 30s wall clock via timeoutMs. Success = the call RESOLVED —
 *  finishReason is irrelevant. Two suppressions are load-bearing:
 *
 *   - `thinking: disabled` — the 5-line thinks adaptively by default, and an
 *     unsuppressed probe that thinks past the 30s wall clock reads as a probe
 *     FAILURE against a healthy API, fail-closing the strip indefinitely.
 *   - `skipHealthReport` — a probe failure must feed probeFailure() only;
 *     reported into the arming window it would supply exactly the callsite
 *     diversity the arm threshold needs, letting the probe manufacture a
 *     spurious sitewide outage from one struggling model.
 *
 *  An id the current build doesn't serve (a stale models-SET entry after a
 *  mid-outage tier bump) soft-succeeds: failing it would pin the degraded
 *  state forever on a model that no longer exists, while a premature clear
 *  self-corrects (any new connectivity report re-arms and resets the counter).
 *  Follow-up (tracked, do not add here): a tight maxOutputTokens once ai.ts
 *  exposes the opt on generateText. */
export async function probeModelOnce(modelId: string): Promise<void> {
  const model = PROBE_MODELS.get(modelId)
  if (model === undefined) {
    moduleLogger.warn(
      { event: 'llm_health.probe_unknown_model', modelId },
      'llm health probe target is not a served tier id — skipping (soft success)',
    )
    return
  }
  await generateText({
    model,
    prompt: PROBE_PROMPT,
    maxRetries: 0,
    timeoutMs: PROBE_TIMEOUT_MS,
    callSite: PROBE_CALLSITE,
    skipHealthReport: true,
    providerOptions: {
      anthropic: { thinking: { type: 'disabled' } },
      mythrun: { stage: PROBE_CALLSITE },
    },
  })
}

/** The slice of a BullMQ Job the scan needs. */
export interface PromotableJobLike {
  readonly id?: string | undefined
  promote(): Promise<void>
}

/** The slice of a BullMQ Queue the scan needs — delayed jobs only; the scan
 *  never touches waiting/active jobs (§3.2: promote, never add). */
export interface DelayedScanQueueLike {
  getDelayed(): Promise<PromotableJobLike[]>
}

export interface ArmedStampPromoterDeps {
  readonly stamps: Pick<ResumeStampsRepo, 'listArmed'>
  readonly concepts: {
    readonly getByCampaignAndUser: (
      campaignId: string,
      userId: string,
    ) => Promise<{ readonly id: string } | null>
  }
  readonly queues: {
    readonly worldGen: DelayedScanQueueLike
    readonly sessionPrep: DelayedScanQueueLike
    readonly characterCreation: DelayedScanQueueLike
  }
  readonly logger: pino.Logger
}

const UUID_LEN = 36

/** Parse `sp-${campaignId}-${sessionNumber}` at fixed UUID widths. */
export function parseSessionPrepJobId(
  jobId: string,
): { campaignId: string; sessionNumber: number } | null {
  if (!jobId.startsWith('sp-')) return null
  const campaignId = jobId.slice(3, 3 + UUID_LEN)
  const rest = jobId.slice(3 + UUID_LEN)
  if (campaignId.length !== UUID_LEN || !rest.startsWith('-')) return null
  const tail = rest.slice(1)
  if (!/^\d+$/.test(tail)) return null
  return { campaignId, sessionNumber: Number(tail) }
}

/** Parse `cc-${campaignId}-${userId}` at fixed UUID widths. */
export function parseCharacterCreationJobId(
  jobId: string,
): { campaignId: string; userId: string } | null {
  if (!jobId.startsWith('cc-')) return null
  if (jobId.length !== 3 + UUID_LEN + 1 + UUID_LEN) return null
  if (jobId[3 + UUID_LEN] !== '-') return null
  return {
    campaignId: jobId.slice(3, 3 + UUID_LEN),
    userId: jobId.slice(3 + UUID_LEN + 1),
  }
}

/** Scan one queue's delayed jobs and promote every match. Catch-and-continue
 *  at BOTH granularities: a failed getDelayed abandons this pipeline only; a
 *  failed match/promote abandons that job only (§3.2 — a promote on a job the
 *  natural wake already moved throws, and that race is expected). */
async function promoteMatching(
  pipeline: ResumeStamp['pipeline'],
  queue: DelayedScanQueueLike,
  matches: (jobId: string) => Promise<boolean>,
  logger: pino.Logger,
): Promise<void> {
  let delayed: PromotableJobLike[]
  try {
    delayed = await queue.getDelayed()
  } catch (err) {
    logger.warn(
      { event: 'llm_health.resume_scan_failed', pipeline, err },
      'recovery fast-path could not list delayed jobs for pipeline — skipping it this cycle',
    )
    return
  }
  for (const job of delayed) {
    const jobId = job.id
    if (jobId === undefined) continue
    try {
      if (!(await matches(jobId))) continue
      await job.promote()
      logger.info(
        { event: 'llm_health.resume_promoted', pipeline, jobId },
        'recovery fast-path promoted a parked job',
      )
    } catch (err) {
      logger.warn(
        { event: 'llm_health.resume_promote_failed', pipeline, jobId, err },
        'recovery fast-path could not promote a parked job — continuing (natural wake may have raced)',
      )
    }
  }
}

/** Build the §3.2 recovery fast-path scan. Returns the promoteArmed closure
 *  runProbeCycle takes as a dep: list armed stamps, narrow to the scope's
 *  eligible set ('past-due' drops stamps whose ladder delay is still running),
 *  and for each pipeline that has any, promote the matching delayed jobs on
 *  its queue. */
export function createArmedStampPromoter(
  deps: ArmedStampPromoterDeps,
): (scope: PromoteScope) => Promise<void> {
  return async (scope: PromoteScope): Promise<void> => {
    const armed = await deps.stamps.listArmed()
    // Stamp times come from Postgres now(); the skew against this local clock
    // is negligible at the ladder's 30s+ rung scale.
    const now = Date.now()
    const eligible =
      scope === 'all'
        ? armed
        : armed.filter((s) => s.nextResumeAt !== null && s.nextResumeAt.getTime() <= now)
    if (eligible.length === 0) return

    const entityIds = (pipeline: ResumeStamp['pipeline']): Set<string> =>
      new Set(eligible.filter((s) => s.pipeline === pipeline).map((s) => s.entityId))

    const worldGen = entityIds('world_gen')
    if (worldGen.size > 0) {
      await promoteMatching(
        'world_gen',
        deps.queues.worldGen,
        (jobId) => Promise.resolve(worldGen.has(jobId)),
        deps.logger,
      )
    }

    const sessionPrep = entityIds('session_prep')
    if (sessionPrep.size > 0) {
      await promoteMatching(
        'session_prep',
        deps.queues.sessionPrep,
        (jobId) => {
          const parsed = parseSessionPrepJobId(jobId)
          return Promise.resolve(parsed !== null && sessionPrep.has(parsed.campaignId))
        },
        deps.logger,
      )
    }

    const characterCreation = entityIds('character_creation')
    if (characterCreation.size > 0) {
      await promoteMatching(
        'character_creation',
        deps.queues.characterCreation,
        async (jobId) => {
          const parsed = parseCharacterCreationJobId(jobId)
          if (parsed === null) return false
          const concept = await deps.concepts.getByCampaignAndUser(
            parsed.campaignId,
            parsed.userId,
          )
          return concept !== null && characterCreation.has(concept.id)
        },
        deps.logger,
      )
    }
  }
}
