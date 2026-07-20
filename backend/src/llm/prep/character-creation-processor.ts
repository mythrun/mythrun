// backend/src/llm/prep/character-creation-processor.ts
//
// MYT-53 / myth-0eji T11: BullMQ processor for the character-creation job.
// One job per (campaign_id, user_id) — fan-out by POST /start-character-
// creation. Parallels world-gen-processor.ts in structure: outer scope
// owns the per-stage transaction lifecycle indirectly via the stage
// handlers; atomicClaimStage guards each stage; isTerminalError
// classifies failures; SSE events stream on the campaign-scoped channel
// keyed by user_id (passed in every event payload).
//
// Per-stage invariant (mirrors world-gen-processor):
//   1. Pre-flight cost-cap check (read cap + sum prior completed costs
//      for the same campaign; if over cap, mark concept failed +
//      stage-failed event, return cleanly).
//   2. atomicClaimStage on (campaign_id, user_id, stage) — INSERT-with-
//      ON-CONFLICT against pipeline_runs; 'completed' means already done;
//      'lost-race' means another worker won; 'claimed' means we proceed.
//   3. Publish stage-started → run handler → mark pipeline_runs.completed
//      with cost + token totals → publish stage-completed.
//   4. On handler failure, classify via isTerminalError. Terminal errors
//      mark pipeline_runs failed + character_concepts failed + publish
//      stage-failed (willRetry: false) + return cleanly (no BullMQ
//      retry). Non-terminal errors rethrow so BullMQ's retry policy
//      fires.

import type { Job } from 'bullmq'
import type { Pool } from 'pg'
import { isTerminalError } from '../errors.js'
import { withJobTimeout } from '../../queue/job-containment.js'
import { atomicClaimStage, sanitizeError } from './world-gen-processor.js'
import { sumCharacterCreationStageCosts } from './cost-cap.js'
import { runLocationSelectionStage } from './stages/location-selection.js'
import { runCharacterConceptStage } from './stages/character-concept.js'
import { runCharacterSheetStage } from './stages/character-sheet.js'
import { createRepo, type Repo } from '../../repo/index.js'
import type { CharacterConceptOutput } from '../schemas/character-concept.js'
import {
  VocabularyRegistrySchema,
  type VocabularyRegistry,
} from '../schemas/vocabulary-registry.js'

export interface CharacterCreationJobPayload {
  readonly campaignId: string
  readonly userId: string
}

export type CharacterCreationStage =
  | 'location_selection'
  | 'character_concept'
  | 'character_sheet'

// MYT-54 T3: 'character_integration' is now a campaign-scoped stage owned
// by MYT-54's character-integration-processor; see
// backend/src/llm/prep/character-integration-processor.ts (to be created
// in T11). The constant is exported (and named STAGES_IN_ORDER) so tests
// can pin the per-player pipeline shape against silent re-introductions.
export const STAGES_IN_ORDER: readonly CharacterCreationStage[] = [
  'location_selection',
  'character_concept',
  'character_sheet',
]

// MYT-102 A1 / myth-3u4a0: hard wall-clock cap on ONE stage execution. Staging
// evidence (2026-07): a character-creation job completed both Sonnet calls and
// then awaited SOMETHING forever — worker task alive, BullMQ lock renewing, zero
// further logs — stranding the player's concept at 'processing' indefinitely.
// 5 minutes is ~5x the slowest observed stage (concept + sheet each finish well
// under a minute including the structured-output repair chain), so a trip is
// overwhelmingly a genuine hang, not a slow-but-healthy call.
//
// myth-3u4a0 REVERSES MYT-102 A1's non-terminal choice: the trip now throws the
// shared `{ terminal: true }` shape (via withJobTimeout), so the standard
// terminal path flips the concept to 'failed' immediately — the player sees the
// failure and resubmits at once, instead of waiting out a futile BullMQ retry of
// a hang that (at a 5-minute threshold) is overwhelmingly genuine and will only
// hang again. Retrying a hang and resubmitting after a fast fail both re-run the
// same pipeline; failing fast is the better player experience, and it matches
// the cross-workstream contract that an unrecoverable job error is terminal.
export const CHARACTER_CREATION_STAGE_TIMEOUT_MS = 5 * 60_000

// myth-3u4a0: whole-JOB wall-clock backstop, applied at the processor factory.
// The per-stage watchdog above bounds each `runStage` (the LLM-bearing part),
// but the orchestration loop has external awaits OUTSIDE runStage — atomicClaim,
// the pipeline_runs / character_concepts writes, publishEvent — and a stall in
// ANY of those (a wedged DB/Redis await) would still renew the BullMQ lock
// forever. This total-job cap guarantees no await anywhere in the job can hang
// the worker slot indefinitely. It is deliberately > 3× the per-stage cap so an
// in-stage hang always trips the tighter per-stage watchdog FIRST (which fails
// the concept in-loop); this backstop only fires when the SUM of otherwise
// under-cap awaits wedges the job, in which case the stale-'processing' reset
// (character-concepts.ts resetConcept) is the player's recovery.
export const CHARACTER_CREATION_JOB_TIMEOUT_MS = 16 * 60_000

export interface CharacterCreationDeps {
  readonly pool: Pool
  readonly publishEvent: (
    campaignId: string,
    event: Record<string, unknown>,
  ) => Promise<void>
  /** Per-job character-creation cost cap (USD). Read once from settings
   *  at server boot and injected here so workers stay stateless re.
   *  global config; operators changing settings need a worker restart
   *  to take effect. */
  readonly costCapUsd: number
  /** Watchdog override for tests. Production callers omit it and get
   *  CHARACTER_CREATION_STAGE_TIMEOUT_MS. */
  readonly stageTimeoutMs?: number
}

export type CharacterCreationJobLike = Pick<
  Job<CharacterCreationJobPayload>,
  'data' | 'updateProgress' | 'name'
>

// Top-level orchestration loop. Exceeds the 50-line max-lines-per-function
// budget because it owns the per-stage lifecycle (claim / publish / run /
// mark / classify-error) inline. Splitting any of those steps into a helper
// would force threading the campaignId+userId+stage tuple through nested
// function boundaries and lose the linear-read property that makes the
// per-stage invariant grep-friendly.
// eslint-disable-next-line max-lines-per-function
export async function runCharacterCreationJob(
  deps: CharacterCreationDeps,
  job: CharacterCreationJobLike,
): Promise<void> {
  const { campaignId, userId } = job.data
  const repo = createRepo(deps.pool)

  // 1. Cost-cap precheck. Sums all prior completed character-creation
  //    stage costs for this campaign (across all players) and compares to
  //    the global cap. If over, mark the concept failed + emit stage-
  //    failed for cost_cap. Return cleanly (no BullMQ retry).
  //
  //    capUsd is injected once at server boot (see server.ts); workers
  //    stay stateless re. the settings table. Operators changing the
  //    settings row need a worker restart to take effect — by design
  //    (predictable cap per process lifetime; no per-job DB read).
  const capUsd = deps.costCapUsd
  const spent = await sumCharacterCreationStageCosts(deps.pool, campaignId)
  if (spent > capUsd) {
    await repo.characterConcepts.markFailed(campaignId, userId, {
      code: 'character_creation_cost_cap_exceeded',
      spent,
      capUsd,
    })
    await deps.publishEvent(campaignId, {
      type: 'stage-failed',
      stage: 'cost_cap',
      userId,
      willRetry: false,
      // MYT-102 A4: `errorCode` per the PipelineEvent contract (was a
      // drifted `reason` field no consumer read).
      errorCode: 'character_creation_cost_cap_exceeded',
    })
    return
  }

  // 2. Resolve worldId + the party's starting level once. Every stage needs
  //    worldId; the concept override (step 3) needs starting_level.
  //    campaigns.world_id is NOT NULL + FK ON DELETE CASCADE, so a row from
  //    campaigns is guaranteed to have world_id set. The fan-out route's
  //    preHandler proves the campaign exists.
  const campaign = await repo.campaigns.getWorldAndSituationIndex(campaignId)
  /* c8 ignore next 3 — invariant per preHandler + FK NOT NULL */
  if (campaign === null) {
    throw new Error(`campaign ${campaignId} not found — preHandler invariant violated`)
  }
  const worldId = campaign.world_id
  // MYT-90 A4/A8: the party-wide starting level (1–5, migration 033) is a KNOWN
  // input, not an LLM judgment (ZFC). The owner picks it between the situation
  // pick and character creation, and the A3 submit gate REQUIRES it non-null
  // before any character job is enqueued. A null here is therefore a broken
  // invariant, not a degraded-but-playable path: silently substituting level 1
  // would violate `persisted character.level == campaign.starting_level` and
  // ship a wrong-level character. Fail loud so the bug surfaces instead.
  if (campaign.starting_level == null) {
    throw new Error(
      `character-creation: campaign ${campaignId} has no starting_level (submit gate should guarantee it)`,
    )
  }
  const startingLevel = campaign.starting_level

  // 3. Reuse stage outputs across stages where the next stage needs them.
  //    On re-entry (idempotent), conceptOutput / characterId start null
  //    and are reloaded from persisted state by the runStage dispatcher
  //    only when actually needed (i.e., the stage was NOT already
  //    completed).
  let conceptOutput: CharacterConceptOutput | null = null
  let characterId: string | null = null

  for (const stage of STAGES_IN_ORDER) {
    const claim = await atomicClaimStage(deps.pool, {
      kind: 'campaign-user',
      campaignId,
      userId,
      stage,
    })
    if (claim === 'completed') continue
    // 'lost-race' arm only triggers when two workers race on the same
    // (campaign, user, stage); tests stage a single worker so this branch
    // isn't exercised. atomicClaimStage is unit-tested separately.
    /* c8 ignore next */
    if (claim === 'lost-race') return

    await deps.publishEvent(campaignId, {
      type: 'stage-started',
      stage,
      userId,
      startedAt: new Date().toISOString(),
    })
    await job.updateProgress({ stage, userId })

    const startedAt = Date.now()
    try {
      // myth-3u4a0: the watchdog bounds the WHOLE stage execution (LLM calls
      // + stage persistence), because the staging hang happened after the
      // Sonnet calls completed — inside the stage, not inside the model call.
      // withJobTimeout throws the terminal `{ terminal: true }` shape on trip,
      // so the catch below routes it to the inline markFailed (concept →
      // 'failed', no futile BullMQ retry). (Explicit annotation: the generic
      // would otherwise infer through conceptOutput/characterId, which are
      // assigned from `result` below — a circular-inference TS7022.)
      const result: RunStageResult = await withJobTimeout(
        runStage(repo, deps, stage, {
          campaignId,
          userId,
          worldId,
          conceptOutput,
          characterId,
        }),
        deps.stageTimeoutMs ?? CHARACTER_CREATION_STAGE_TIMEOUT_MS,
        `character-creation stage '${stage}'`,
      )
      // Thread fresh state forward for the next stage; the runStage
      // dispatcher reloads from persisted state if these are null on
      // re-entry, so it's safe to only set them on a fresh claim path.
      if (stage === 'character_concept' && result.concept !== undefined) {
        // MYT-90 A4: OVERRIDE the LLM's echoed level with the campaign's
        // deterministic starting_level BEFORE persisting (ZFC — the level is a
        // known input, never the model's call; do NOT trust the echo). Every
        // downstream consumer reads narrative.level (characters.level, hit dice,
        // spellSlotsFor, validateCoherence), so this single override carries them
        // all. Spread (not mutate) so the stage result stays untouched.
        conceptOutput = { ...result.concept, level: startingLevel }
        // myth-y7xt T2: persist the structured narrative so MYT-54's campaign-
        // scoped character_integration worker can read it.
        await repo.characterConcepts.setConceptOutput(
          campaignId,
          userId,
          JSON.stringify(conceptOutput),
        )
      }
      if (stage === 'character_sheet' && result.characterId !== undefined) {
        characterId = result.characterId
      }

      await repo.pipelineRuns.markStageCompleted({
        kind: 'campaign-user',
        campaignId,
        userId,
        stage,
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      })
      await deps.publishEvent(campaignId, {
        type: 'stage-completed',
        stage,
        userId,
        durationMs: Date.now() - startedAt,
        costUsd: result.costUsd,
      })
    } catch (err) {
      const terminal = isTerminalError(err)
      // Non-Error throw branch defense; stage handlers propagate Error
      // subclasses (LlmStructuredOutputError, pg errors, etc.).
      /* c8 ignore next */
      const message = err instanceof Error ? err.message : String(err)
      // MYT-102 A4: the SSE identifier is the sanitized `.code` on the
      // `errorCode` field — the PipelineEvent contract shape world-gen and
      // the dev-tool live-events panel already speak. The processor used to
      // publish the raw message on a drifted `reason` field, which no
      // consumer read.
      const errorCode = sanitizeError(err).code
      await repo.pipelineRuns.markStageFailed({
        kind: 'campaign-user',
        campaignId,
        userId,
        stage,
        error: message,
      })
      if (terminal) {
        await repo.characterConcepts.markFailed(campaignId, userId, { stage, message })
        await deps.publishEvent(campaignId, {
          type: 'stage-failed',
          stage,
          userId,
          willRetry: false,
          errorCode,
        })
        return
      }
      // Non-terminal: publish willRetry:true and rethrow so BullMQ's
      // attempts:2 policy fires. Exercised by the transient-LLM-error tests
      // (rate-limit / overload, terminal:false). A watchdog trip is now
      // TERMINAL (myth-3u4a0), so it takes the terminal branch above, not this.
      await deps.publishEvent(campaignId, {
        type: 'stage-failed',
        stage,
        userId,
        willRetry: true,
        errorCode,
      })
      throw err
    }
  }

  // 4. All per-player stages completed — flip the concept row to
  //    'completed' and emit the typed, per-user completion event. The FE
  //    loading beat filters this by `userId` to swap to the character reveal
  //    (MYT-90 A8; replaces the old untyped `phase:'character_creation_complete'`
  //    emit, which the PipelineEvent contract never modelled and which carried
  //    no per-user discriminator). The campaign-scoped character_integration
  //    stage (MYT-54) runs separately, owner-triggered, after all members
  //    reach this state.
  await repo.characterConcepts.markCompleted(campaignId, userId)
  await deps.publishEvent(campaignId, {
    type: 'character_creation_complete',
    userId,
  })
}

// -- per-stage dispatch -----------------------------------------------------

interface RunStageCtx {
  readonly campaignId: string
  readonly userId: string
  readonly worldId: string
  readonly conceptOutput: CharacterConceptOutput | null
  readonly characterId: string | null
}

interface RunStageResult {
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly concept?: CharacterConceptOutput
  readonly characterId?: string
}

async function runStage(
  repo: Repo,
  deps: CharacterCreationDeps,
  stage: CharacterCreationStage,
  ctx: RunStageCtx,
): Promise<RunStageResult> {
  if (stage === 'location_selection') {
    return runLocationSelectionStage(repo, {
      campaignId: ctx.campaignId,
      worldId: ctx.worldId,
    })
  }
  if (stage === 'character_concept') {
    const args = await buildConceptArgs(repo, ctx)
    const r = await runCharacterConceptStage(args)
    return {
      costUsd: r.costUsd,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      concept: r.concept,
    }
  }
  // character_sheet is the terminal per-player stage. stage 3 has no
  // re-entry recovery: the stage 2 output (narrative) is in-memory only
  // (not persisted between stage 2's run and stage 3's INSERT into
  // characters). If a worker crashes after stage 2's pipeline_runs
  // marker commits but before stage 3 enters, BullMQ retry hits a
  // 'completed' stage 2 claim → skips → ctx.conceptOutput is undefined
  // here. That's a terminal failure; player resubmits.
  //
  // MYT-54 T3: 'character_integration' is now a campaign-scoped stage
  // owned by MYT-54's character-integration-processor; see
  // backend/src/llm/prep/character-integration-processor.ts (to be created
  // in T11). It does NOT appear in this per-player switch.
  if (ctx.conceptOutput === null) {
    // TERMINAL, not transient: stage-2 output is unrecoverable, so retrying
    // the job only re-hits this same guard while the concept sits 'processing'
    // forever (a character stuck on the loading beat — found live in a
    // 3-player playtest 2026-07-18). Flag `.terminal` so isTerminalError routes
    // it to the inline markFailed → the concept flips to 'failed' and the
    // player can resubmit, instead of a futile BullMQ retry loop.
    throw Object.assign(
      new Error(
        'character_sheet: re-entry without ctx.conceptOutput; stage 2 output cannot be recovered. Player must resubmit.',
      ),
      { terminal: true },
    )
  }
  const narrative = ctx.conceptOutput
  const w = await loadWorldContext(repo, ctx.worldId)
  // myth-gp2c Cluster C: stage 3 persists through the unified repo surface
  // (`repo.transaction(tx => tx.characters.replaceSubTables(...))`). The LLM
  // call stays outside that tx inside the stage.
  const r = await runCharacterSheetStage(repo, {
    campaignId: ctx.campaignId,
    userId: ctx.userId,
    worldId: ctx.worldId,
    narrative,
    worldTone: w.tone,
    worldEra: w.era,
  })
  return {
    costUsd: r.costUsd,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    characterId: r.characterId,
  }
}

// -- arg builders -----------------------------------------------------------

async function buildConceptArgs(
  repo: Repo,
  ctx: RunStageCtx,
): Promise<Parameters<typeof runCharacterConceptStage>[0]> {
  const conceptRow = await repo.characterConcepts.getConceptInputs(ctx.campaignId, ctx.userId)
  // ctx.worldId came from campaigns.world_id (FK to worlds.id) so this
  // row is guaranteed to exist; no defensive arm needed.
  const w = await repo.worlds.getCharacterConceptContext(ctx.worldId)
  /* c8 ignore next 6 — invariant: world FK NOT NULL + character_concepts flip-to-processing */
  if (w === null || conceptRow === null) {
    throw new Error(
      `world or character_concepts missing — world=${ctx.worldId} campaign=${ctx.campaignId} user=${ctx.userId}`,
    )
  }
  const vocab: VocabularyRegistry = VocabularyRegistrySchema.parse(
    w.vocabulary_registry,
  )
  return {
    campaignId: ctx.campaignId,
    userId: ctx.userId,
    worldId: ctx.worldId,
    worldName: w.name,
    tone: w.tone ?? '',
    themes: w.themes ?? '',
    era: w.era ?? '',
    geographySummary: w.geography_summary ?? '',
    politicalSummary: w.political_summary ?? '',
    keyTensions: w.key_tensions ?? '',
    vocabularyRegistry: vocab,
    // character_concepts row was flipped to 'processing' by the fan-out
    // route, which only matches rows that exist + have concept_text per
    // the v1 freeform-required Zod schema. row[0] guaranteed; concept_text
    // could be NULL on resubmit-after-failure paths in older worlds.
    conceptText: conceptRow.concept_text ?? '',
    guidedChoices: conceptRow.guided_choices,
  }
}

async function loadWorldContext(
  repo: Repo,
  worldId: string,
): Promise<{ tone: string; era: string }> {
  const r = await repo.worlds.getToneAndEra(worldId)
  return { tone: r?.tone ?? '', era: r?.era ?? '' }
}

// -- BullMQ processor factory ----------------------------------------------
//
// myth-epo4 T22: thin closure that adapts `runCharacterCreationJob` to
// BullMQ's `(job) => Promise<void>` shape. Mirrors createWorldGenProcessor
// in world-gen-processor.ts. Deps are closed over once at boot; the
// returned function is what `new Worker('campaign-setup', fn, ...)` calls
// per job.

/** Deps closed over by the BullMQ processor for character-creation jobs.
 *  `publishEvent` is supplied by server.ts and writes JSON-encoded events
 *  to `${redisKeyPrefix}pipeline:campaign:${campaignId}` on the realtime
 *  Redis client — same channel the pipeline subscriber PSUBSCRIBE's on. */
export interface CreateCharacterCreationProcessorDeps {
  readonly pool: Pool
  readonly publishEvent: (
    campaignId: string,
    event: Record<string, unknown>,
  ) => Promise<void>
  /** Per-job cost cap (USD), read once at boot — see CharacterCreationDeps. */
  readonly costCapUsd: number
  /** Whole-job watchdog override for tests. Production omits it and gets
   *  CHARACTER_CREATION_JOB_TIMEOUT_MS. */
  readonly jobTotalTimeoutMs?: number
}

export function createCharacterCreationProcessor(
  deps: CreateCharacterCreationProcessorDeps,
): (job: Job<CharacterCreationJobPayload>) => Promise<void> {
  return async (job) => {
    // myth-3u4a0: the whole-job backstop. Bounds EVERY external await in the
    // job — including the orchestration-loop DB/Redis awaits the per-stage
    // watchdog does not cover — so no await can renew the BullMQ lock forever.
    // On trip it throws the terminal `{ terminal: true }` shape: BullMQ's
    // attempts:2 exhausts and the on('failed') handler flips the concept to
    // 'failed' (handleCharacterCreationJobFailure); the stale-'processing'
    // reset is the earlier player-side recovery.
    await withJobTimeout(
      runCharacterCreationJob(deps, job),
      deps.jobTotalTimeoutMs ?? CHARACTER_CREATION_JOB_TIMEOUT_MS,
      `character-creation job ${job.data.campaignId}/${job.data.userId}`,
    )
  }
}

// -- exhausted-transient surfacing (MYT-102 A2) -----------------------------
//
// A transient stage failure rethrows so BullMQ retries (attempts:2 on the
// campaign-setup queue). Before MYT-102, the FINAL failed attempt left the
// character_concepts row at 'processing' forever: markFailed only ran on
// terminal errors, and no producer existed for a job-level failure event.
// The worker's `on('failed')` listener routes into this handler, which acts
// ONLY on exhaustion (attemptsMade >= attempts): flip the concept to
// 'failed', publish a terminal stage-failed on the pipeline channel, and log
// loud. Retry-pending failures (attemptsMade < attempts) already published
// willRetry:true from the processor's catch block, so they are skipped here.

/** Structural slice of BullMQ's Job that the failure handler reads.
 *  `Job<any>` satisfies it, so worker.ts passes the listener arg straight
 *  through; tests hand-roll the shape. */
export interface CharacterCreationFailedJobLike {
  readonly name: string
  readonly data: unknown
  readonly attemptsMade: number
  readonly opts: { readonly attempts?: number | undefined }
  readonly progress: unknown
}

export interface CharacterCreationFailureDeps {
  readonly pool: Pool
  readonly publishEvent: (
    campaignId: string,
    event: Record<string, unknown>,
  ) => Promise<void>
  /** Structural pino slice — the handler only logs at error level. */
  readonly logger: { error: (obj: Record<string, unknown>, msg?: string) => void }
}

/** Stage label for the terminal event when the job died before the first
 *  updateProgress call (BullMQ default progress is 0, not an object). */
const JOB_LEVEL_STAGE_LABEL = 'character_creation'

export async function handleCharacterCreationJobFailure(
  deps: CharacterCreationFailureDeps,
  job: CharacterCreationFailedJobLike | undefined,
  err: unknown,
): Promise<void> {
  // The campaign-setup queue is a router: 'character-integration' jobs have
  // their own campaign-scoped failure semantics (MYT-56) — not ours. An
  // undefined job (BullMQ can emit 'failed' with no job) also exits here.
  if (job?.name !== 'character-creation') return
  // BullMQ's worker-level 'failed' event fires on EVERY failed attempt; a
  // retry is still pending while attemptsMade < attempts. Only exhaustion
  // is terminal for the concept.
  const attempts = job.opts.attempts ?? 1
  if (job.attemptsMade < attempts) return

  const sanitized = sanitizeError(err)
  try {
    const data = job.data as { campaignId?: unknown; userId?: unknown } | null
    const campaignId = data?.campaignId
    const userId = data?.userId
    if (typeof campaignId !== 'string' || typeof userId !== 'string') {
      deps.logger.error(
        { event: 'character_creation.job_failed_bad_payload', data: job.data },
        'character-creation job exhausted retries but its payload is malformed; cannot mark the concept failed',
      )
      return
    }
    // BullMQ default progress is 0 (a number); the processor's updateProgress
    // writes { stage, userId }. A runtime number safely yields undefined via
    // the optional chain (primitive property access autoboxes).
    const progress = job.progress as { stage?: unknown } | null
    const stage =
      typeof progress?.stage === 'string' ? progress.stage : JOB_LEVEL_STAGE_LABEL

    const repo = createRepo(deps.pool)
    // Never unwind a 'completed' concept: a stale failure event (e.g. a
    // zombie attempt racing a successful resume-driven re-run) must not
    // clobber a player's finished character. Flipping an already-'failed'
    // row again is the idempotent no-op case.
    const concept = await repo.characterConcepts.getByCampaignAndUser(campaignId, userId)
    if (concept === null || concept.status === 'completed') return

    await repo.characterConcepts.markFailed(campaignId, userId, {
      stage,
      code: sanitized.code,
      message: sanitized.message,
      attemptsMade: job.attemptsMade,
    })
    await deps.publishEvent(campaignId, {
      type: 'stage-failed',
      stage,
      userId,
      willRetry: false,
      errorCode: sanitized.code,
    })
    deps.logger.error(
      {
        event: 'character_creation.job_exhausted',
        campaignId,
        userId,
        stage,
        errorCode: sanitized.code,
        attemptsMade: job.attemptsMade,
      },
      'character-creation job exhausted BullMQ retries; concept marked failed',
    )
  } catch (handlerErr) {
    // The listener must never throw into BullMQ's event emitter — a broken
    // surfacing path should be loud in logs, not crash the worker.
    deps.logger.error(
      {
        event: 'character_creation.job_failed_handler_error',
        err: handlerErr,
        originalErrorCode: sanitized.code,
      },
      'failed to surface an exhausted character-creation job',
    )
  }
}
