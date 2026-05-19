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
import {
  readCharacterCreationCostCap,
  sumCharacterCreationStageCosts,
} from './cost-cap.js'
import { runLocationSelectionStage } from './stages/location-selection.js'
import { runCharacterConceptStage } from './stages/character-concept.js'
import { runCharacterSheetStage } from './stages/character-sheet.js'
import { runCharacterIntegrationStage } from './stages/character-integration.js'
import { createCharacterConceptsRepo } from '../../repo/character-concepts.js'
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
  | 'character_integration'

const STAGES: readonly CharacterCreationStage[] = [
  'location_selection',
  'character_concept',
  'character_sheet',
  'character_integration',
]

export interface CharacterCreationDeps {
  readonly pool: Pool
  readonly publishEvent: (
    campaignId: string,
    event: Record<string, unknown>,
  ) => Promise<void>
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
  //    Wrapped in try/catch because readCharacterCreationCostCap throws
  //    CostCapParseError when the settings row is missing or malformed —
  //    that's an operator-config failure, not a per-job retry condition.
  //    Without this catch, the throw bubbles to BullMQ which retries via
  //    backoff (attempts=2), then permanently fails the job with
  //    removeOnFail dropping it — leaving character_concepts stuck in
  //    'processing' with no visible signal. Smoke uncovered this:
  //    resetData truncated the settings table, the precheck threw on
  //    every retry attempt, the queue silently drained.
  try {
    const capUsd = await readCharacterCreationCostCap(deps.pool)
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
  } catch (err) {
    // Non-Error throw branch defense; in practice readCharacterCreationCostCap
    // / sumCharacterCreationStageCosts throw CostCapParseError or pg errors.
    /* c8 ignore next */
    const message = err instanceof Error ? err.message : String(err)
    await conceptsRepo.markFailed(campaignId, userId, {
      code: 'character_creation_cost_cap_precheck_failed',
      message,
    })
    await deps.publishEvent(campaignId, {
      type: 'stage-failed',
      stage: 'cost_cap',
      userId,
      willRetry: false,
      reason: `cost_cap_precheck_failed: ${message}`,
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

  for (const stage of STAGES) {
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

  // 4. All four stages completed — flip the concept row to 'completed'
  //    and emit the terminal phase event.
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
  if (stage === 'character_sheet') {
    // stage 3 has no re-entry recovery: the stage 2 output (narrative)
    // is in-memory only (not persisted between stage 2's run and stage
    // 3's INSERT into characters). If a worker crashes after stage 2's
    // pipeline_runs marker commits but before stage 3 enters, BullMQ
    // retry hits a 'completed' stage 2 claim → skips → ctx.conceptOutput
    // is undefined here. That's a terminal failure; player resubmits.
    if (ctx.conceptOutput === null) {
      throw new Error(
        'character_sheet: re-entry without ctx.conceptOutput; stage 2 output cannot be recovered. Player must resubmit.',
      )
    }
    const narrative = ctx.conceptOutput
    const w = await loadWorldContext(deps.pool, ctx.worldId)
    const r = await runCharacterSheetStage(deps.pool, {
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
  // character_integration. Same re-entry semantic as stage 3: requires
  // ctx threading from the prior stages in THIS worker invocation. A
  // crash between stage 3's commit and stage 4 marks the row failed
  // (player resubmits). Avoids the placeholder-narrative reload path
  // that returned bogus values for fields not persisted on `characters`.
  if (ctx.characterId === null || ctx.conceptOutput === null) {
    throw new Error(
      'character_integration: re-entry without in-process state (characterId or conceptOutput); cannot recover. Player must resubmit.',
    )
  }
  const integrationCharacterId = ctx.characterId
  const integrationNarrative = ctx.conceptOutput
  const groundingRes = await deps.pool.query<{
    situation_grounding_text: string
  }>(
    `SELECT situation_grounding_text FROM character_concepts
       WHERE campaign_id = $1 AND user_id = $2`,
    [ctx.campaignId, ctx.userId],
  )
  // character_concepts row was flipped to 'processing' by the route's
  // flipAllSubmittedToProcessing, which only matches rows that POST
  // /characters validated + persisted with situation_grounding_text
  // populated (Zod min(20) + DB NOT NULL CHECK length 20..2000).
  const grounding = groundingRes.rows[0]?.situation_grounding_text
  /* c8 ignore next 5 — invariant per flipAllSubmittedToProcessing */
  if (grounding === undefined) {
    throw new Error(
      `character_concepts row missing for campaign=${ctx.campaignId} user=${ctx.userId} — flip invariant violated`,
    )
  }
  const r = await runCharacterIntegrationStage(deps.pool, {
    campaignId: ctx.campaignId,
    userId: ctx.userId,
    worldId: ctx.worldId,
    characterId: integrationCharacterId,
    narrative: integrationNarrative,
    situationGroundingText: grounding,
    publishEvent: (e) => deps.publishEvent(ctx.campaignId, e),
  })
  return {
    costUsd: r.costUsd,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
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
}

export function createCharacterCreationProcessor(
  deps: CreateCharacterCreationProcessorDeps,
): (job: Job<CharacterCreationJobPayload>) => Promise<void> {
  return async (job) => {
    await runCharacterCreationJob(deps, job)
  }
}
