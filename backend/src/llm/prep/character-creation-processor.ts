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
import { atomicClaimStage } from './world-gen-processor.js'
import { sumCharacterCreationStageCosts } from './cost-cap.js'
import { runLocationSelectionStage } from './stages/location-selection.js'
import { runCharacterConceptStage } from './stages/character-concept.js'
import { runCharacterSheetStage } from './stages/character-sheet.js'
import { createCharacterConceptsRepo } from '../../repo/character-concepts.js'
import { createRepo } from '../../repo/index.js'
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
  const conceptsRepo = createCharacterConceptsRepo(deps.pool)

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
    await conceptsRepo.markFailed(campaignId, userId, {
      code: 'character_creation_cost_cap_exceeded',
      spent,
      capUsd,
    })
    await deps.publishEvent(campaignId, {
      type: 'stage-failed',
      stage: 'cost_cap',
      userId,
      willRetry: false,
      reason: 'character_creation_cost_cap_exceeded',
    })
    return
  }

  // 2. Resolve worldId once — every stage needs it.
  const worldRow = await deps.pool.query<{ world_id: string }>(
    `SELECT world_id FROM campaigns WHERE id = $1`,
    [campaignId],
  )
  // campaigns.world_id is NOT NULL + FK ON DELETE CASCADE, so a row from
  // campaigns table is guaranteed to have world_id set. The fan-out
  // route's preHandler proves the campaign exists.
  const worldId = worldRow.rows[0]?.world_id
  /* c8 ignore next 3 — invariant per preHandler + FK NOT NULL */
  if (worldId === undefined) {
    throw new Error(`campaign ${campaignId} not found — preHandler invariant violated`)
  }

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
      const result = await runStage(deps, stage, {
        campaignId,
        userId,
        worldId,
        conceptOutput,
        characterId,
      })
      // Thread fresh state forward for the next stage; the runStage
      // dispatcher reloads from persisted state if these are null on
      // re-entry, so it's safe to only set them on a fresh claim path.
      if (stage === 'character_concept' && result.concept !== undefined) {
        conceptOutput = result.concept
        // myth-y7xt T2: persist the structured narrative so MYT-54's campaign-
        // scoped character_integration worker can read it.
        await deps.pool.query(
          `UPDATE character_concepts
              SET concept_output = $1::jsonb, updated_at = now()
            WHERE campaign_id = $2 AND user_id = $3`,
          [JSON.stringify(conceptOutput), campaignId, userId],
        )
      }
      if (stage === 'character_sheet' && result.characterId !== undefined) {
        characterId = result.characterId
      }

      await markStageCompleted(deps.pool, campaignId, userId, stage, {
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
      await markStageFailed(deps.pool, campaignId, userId, stage, message)
      if (terminal) {
        await conceptsRepo.markFailed(campaignId, userId, { stage, message })
        await deps.publishEvent(campaignId, {
          type: 'stage-failed',
          stage,
          userId,
          willRetry: false,
          reason: message,
        })
        return
      }
      /* c8 ignore start — non-terminal rethrow path: BullMQ retries
       * are exercised at integration boundaries (T16 smoke), not in the
       * unit suite. */
      await deps.publishEvent(campaignId, {
        type: 'stage-failed',
        stage,
        userId,
        willRetry: true,
        reason: message,
      })
      throw err
      /* c8 ignore stop */
    }
  }

  // 4. All per-player stages completed — flip the concept row to
  //    'completed' and emit the terminal phase event. The campaign-scoped
  //    character_integration stage (MYT-54) runs separately, owner-
  //    triggered, after all members reach this state.
  await conceptsRepo.markCompleted(campaignId, userId)
  await deps.publishEvent(campaignId, {
    type: 'phase',
    phase: 'character_creation_complete',
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
  deps: CharacterCreationDeps,
  stage: CharacterCreationStage,
  ctx: RunStageCtx,
): Promise<RunStageResult> {
  if (stage === 'location_selection') {
    return runLocationSelectionStage(deps.pool, {
      campaignId: ctx.campaignId,
      worldId: ctx.worldId,
    })
  }
  if (stage === 'character_concept') {
    const args = await buildConceptArgs(deps.pool, ctx)
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
    throw new Error(
      'character_sheet: re-entry without ctx.conceptOutput; stage 2 output cannot be recovered. Player must resubmit.',
    )
  }
  const narrative = ctx.conceptOutput
  const w = await loadWorldContext(deps.pool, ctx.worldId)
  // myth-gp2c Cluster C: stage 3 persists through the unified repo surface
  // (`repo.transaction(tx => tx.characters.replaceSubTables(...))`). The LLM
  // call stays outside that tx inside the stage. Build the repo from the same
  // pool the processor threads everywhere else.
  const r = await runCharacterSheetStage(createRepo(deps.pool), {
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
  pool: Pool,
  ctx: RunStageCtx,
): Promise<Parameters<typeof runCharacterConceptStage>[0]> {
  const concept = await pool.query<{
    concept_text: string | null
    guided_choices: Record<string, unknown>
  }>(
    `SELECT concept_text, guided_choices FROM character_concepts
       WHERE campaign_id = $1 AND user_id = $2`,
    [ctx.campaignId, ctx.userId],
  )
  const world = await pool.query<{
    name: string
    tone: string | null
    themes: string | null
    era: string | null
    geography_summary: string | null
    political_summary: string | null
    key_tensions: string | null
    vocabulary_registry: unknown
  }>(
    `SELECT name, tone, themes, era, geography_summary, political_summary,
            key_tensions, vocabulary_registry
       FROM worlds WHERE id = $1`,
    [ctx.worldId],
  )
  // ctx.worldId came from campaigns.world_id (FK to worlds.id) so this
  // row is guaranteed to exist; no defensive arm needed.
  const w = world.rows[0]
  const conceptRow = concept.rows[0]
  /* c8 ignore next 6 — invariant: world FK NOT NULL + character_concepts flip-to-processing */
  if (w === undefined || conceptRow === undefined) {
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
  pool: Pool,
  worldId: string,
): Promise<{ tone: string; era: string }> {
  const r = await pool.query<{ tone: string | null; era: string | null }>(
    `SELECT tone, era FROM worlds WHERE id = $1`,
    [worldId],
  )
  return { tone: r.rows[0]?.tone ?? '', era: r.rows[0]?.era ?? '' }
}

// -- pipeline_runs accounting -----------------------------------------------

async function markStageCompleted(
  pool: Pool,
  campaignId: string,
  userId: string,
  stage: CharacterCreationStage,
  costs: { costUsd: number; inputTokens: number; outputTokens: number },
): Promise<void> {
  await pool.query(
    `UPDATE pipeline_runs
        SET status = 'completed', completed_at = now(),
            cost_usd = $3, input_tokens = $4, output_tokens = $5, error = NULL
      WHERE campaign_id = $1 AND stage = $2 AND user_id = $6`,
    [
      campaignId,
      stage,
      costs.costUsd,
      costs.inputTokens,
      costs.outputTokens,
      userId,
    ],
  )
}

async function markStageFailed(
  pool: Pool,
  campaignId: string,
  userId: string,
  stage: CharacterCreationStage,
  message: string,
): Promise<void> {
  await pool.query(
    `UPDATE pipeline_runs
        SET status = 'failed', completed_at = now(), error = $3
      WHERE campaign_id = $1 AND stage = $2 AND user_id = $4`,
    [campaignId, stage, message, userId],
  )
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
}

export function createCharacterCreationProcessor(
  deps: CreateCharacterCreationProcessorDeps,
): (job: Job<CharacterCreationJobPayload>) => Promise<void> {
  return async (job) => {
    await runCharacterCreationJob(deps, job)
  }
}
