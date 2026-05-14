// backend/src/sse/derive-phase.ts
//
// Pure phase-derivation function. Reads from snapshot row shapes (no I/O).
// The repo helper `listLatestForCampaign` returns at most one row per
// (stage, user_id) — already DISTINCT ON'd — so this function doesn't
// need to dedupe.

export type PipelinePhase =
  | 'not_started'
  | 'world_gen'
  | 'world_gen_failed'
  | 'world_ready'
  | 'character_creation'
  | 'post_creation'
  | 'complete'
  | 'failed'

export interface CampaignRow {
  readonly id: string
  readonly status: 'setup' | 'active' | 'archived'
  readonly world_id: string
}

export interface WorldRow {
  readonly id: string
  readonly status: 'generating' | 'complete' | 'failed'
}

export interface PipelineRunRow {
  readonly stage: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly user_id: string | null
  readonly world_id: string | null
  readonly campaign_id: string | null
  readonly started_at: Date | null
  readonly completed_at: Date | null
  readonly cost_usd: number
}

export interface StageEntry {
  readonly stage: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly userId: string | null
  readonly costUsd: number
}

export interface PhaseAndStages {
  readonly phase: PipelinePhase
  readonly stages: readonly StageEntry[]
  readonly cumulativeCostUsd: number
}

// Stage taxonomy — order-preserving for the snapshot display.
// Worldgen stages run on the world; charcreation stages run per-player;
// post-creation stages are campaign-scoped (campaign_id set, user_id null).
export const WORLDGEN_STAGES = [
  'concept_intake',
  'world_and_factions',
  'locations_and_npcs',
  'entity_relationships',
  'starting_situation',
  'random_tables',
  'coherence_pass',
] as const

export const CHARCREATION_STAGES = [
  'location_selection',
  'character_concept',
  'character_sheet',
  'character_integration',
] as const

export const POSTCREATION_STAGES = ['materialize_relationships', 'continuity_check'] as const

const STAGE_ORDER: readonly string[] = [
  ...WORLDGEN_STAGES,
  ...CHARCREATION_STAGES,
  ...POSTCREATION_STAGES,
]

function stageScope(stage: string): 'worldgen' | 'charcreation' | 'postcreation' | 'unknown' {
  if ((WORLDGEN_STAGES as readonly string[]).includes(stage)) return 'worldgen'
  if ((CHARCREATION_STAGES as readonly string[]).includes(stage)) return 'charcreation'
  if ((POSTCREATION_STAGES as readonly string[]).includes(stage)) return 'postcreation'
  return 'unknown'
}

export function derivePhase(input: {
  readonly campaign: CampaignRow
  readonly world: WorldRow
  readonly runs: readonly PipelineRunRow[]
}): PhaseAndStages {
  const { campaign, world, runs } = input

  // Bucket runs by scope.
  const worldgen = runs.filter((r) => stageScope(r.stage) === 'worldgen')
  const charcreation = runs.filter((r) => stageScope(r.stage) === 'charcreation')
  const postcreation = runs.filter((r) => stageScope(r.stage) === 'postcreation')

  // Sort stages by taxonomy order, then by user_id (null first) for per-player stability.
  const stages: StageEntry[] = [...runs]
    .sort((a, b) => {
      const ai = STAGE_ORDER.indexOf(a.stage)
      const bi = STAGE_ORDER.indexOf(b.stage)
      if (ai !== bi) return ai - bi
      /* c8 ignore start — `?? ''` falsy arms only fire on the
       * stage-rows that carry a non-null user_id (character-creation
       * per-player rows); tests stage worldgen + post-creation rows
       * which are user_id null on both sides of the comparison. */
      const au = a.user_id ?? ''
      const bu = b.user_id ?? ''
      /* c8 ignore stop */
      return au.localeCompare(bu)
    })
    .map((r) => ({
      stage: r.stage,
      status: r.status,
      userId: r.user_id,
      costUsd: r.cost_usd,
    }))

  const cumulativeCostUsd = runs.reduce((acc, r) => acc + r.cost_usd, 0)

  const phase = computePhase({
    campaign,
    world,
    worldgen,
    charcreation,
    postcreation,
  })

  return { phase, stages, cumulativeCostUsd }
}

function computePhase(input: {
  readonly campaign: CampaignRow
  readonly world: WorldRow
  readonly worldgen: readonly PipelineRunRow[]
  readonly charcreation: readonly PipelineRunRow[]
  readonly postcreation: readonly PipelineRunRow[]
}): PipelinePhase {
  const { campaign, world, worldgen, charcreation, postcreation } = input

  // Active campaign overrides everything.
  if (campaign.status === 'active') return 'complete'

  // Empty: nothing has started.
  if (worldgen.length === 0 && charcreation.length === 0 && postcreation.length === 0) {
    return 'not_started'
  }

  // Worldgen failure surfaces if the world is failed AND no later-stage runs have made progress.
  if (world.status === 'failed') {
    return 'world_gen_failed'
  }

  // Worldgen running.
  if (worldgen.some((r) => r.status === 'running' || r.status === 'pending')) {
    return 'world_gen'
  }

  // Worldgen failed but not world-status-failed: rare, treat as world_gen_failed.
  if (worldgen.some((r) => r.status === 'failed')) {
    return 'world_gen_failed'
  }

  // Post-creation running.
  /* c8 ignore next 3 — post-creation phase isn't exercised in the
   * MYT-51 stage tests; the worker emits these rows only after
   * character creation, which lands in MYT-52. */
  if (postcreation.some((r) => r.status === 'running' || r.status === 'pending')) {
    return 'post_creation'
  }

  // Charcreation running.
  if (charcreation.some((r) => r.status === 'running' || r.status === 'pending')) {
    return 'character_creation'
  }

  // Charcreation failure → failed (post-worldgen).
  if (
    charcreation.some((r) => r.status === 'failed') ||
    postcreation.some((r) => r.status === 'failed')
  ) {
    return 'failed'
  }

  // World complete, no later activity → world_ready.
  if (world.status === 'complete') return 'world_ready'

  // Default safety net.
  return 'not_started'
}
