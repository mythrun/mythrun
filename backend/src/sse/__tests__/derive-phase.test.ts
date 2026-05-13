// backend/src/sse/__tests__/derive-phase.test.ts
import { describe, expect, it } from 'vitest'
import {
  derivePhase,
  type CampaignRow,
  type WorldRow,
  type PipelineRunRow,
} from '../derive-phase.js'

const baseCampaign: CampaignRow = {
  id: 'cmp-1',
  status: 'setup',
  world_id: 'wld-1',
}

const baseWorld: WorldRow = {
  id: 'wld-1',
  status: 'generating',
}

function run(partial: Partial<PipelineRunRow>): PipelineRunRow {
  return {
    stage: 'concept_intake',
    status: 'completed',
    user_id: null,
    world_id: 'wld-1',
    campaign_id: null,
    started_at: new Date('2026-05-12T00:00:00Z'),
    completed_at: new Date('2026-05-12T00:01:00Z'),
    cost_usd: 0.5,
    ...partial,
  }
}

describe('derivePhase', () => {
  it('returns not_started when there are no runs', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: baseWorld,
      runs: [],
    })
    expect(result.phase).toBe('not_started')
    expect(result.stages).toEqual([])
    expect(result.cumulativeCostUsd).toBe(0)
  })

  it('returns world_gen when a worldgen stage is running', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: baseWorld,
      runs: [run({ stage: 'world_and_factions', status: 'running', completed_at: null })],
    })
    expect(result.phase).toBe('world_gen')
  })

  it('returns world_gen_failed when a worldgen stage failed and no retry is running', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'failed' },
      runs: [
        run({ stage: 'concept_intake', status: 'completed' }),
        run({ stage: 'world_and_factions', status: 'failed', completed_at: null }),
      ],
    })
    expect(result.phase).toBe('world_gen_failed')
  })

  it('treats failed-then-retried-completed as completed for that stage', () => {
    // listLatestForCampaign returns one row per stage (the latest), so derivePhase
    // never sees two rows for the same stage simultaneously. Verify behavior on the
    // post-DISTINCT-ON view: the "latest" row is the completed retry.
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'complete' },
      runs: [
        run({ stage: 'concept_intake', status: 'completed' }),
        run({ stage: 'world_and_factions', status: 'completed' }),
        run({ stage: 'locations_and_npcs', status: 'completed' }),
        run({ stage: 'starting_situation', status: 'completed' }),
        run({ stage: 'random_tables', status: 'completed' }),
      ],
    })
    expect(result.phase).toBe('world_ready')
  })

  it('returns world_ready when worlds.status=complete and no charcreation runs yet', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'complete' },
      runs: [
        run({ stage: 'concept_intake', status: 'completed' }),
        run({ stage: 'world_and_factions', status: 'completed' }),
        run({ stage: 'locations_and_npcs', status: 'completed' }),
        run({ stage: 'starting_situation', status: 'completed' }),
        run({ stage: 'random_tables', status: 'completed' }),
      ],
    })
    expect(result.phase).toBe('world_ready')
  })

  it('returns character_creation when a charcreation stage is running', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'complete' },
      runs: [
        run({ stage: 'concept_intake', status: 'completed' }),
        run({
          stage: 'character_concept',
          status: 'running',
          campaign_id: 'cmp-1',
          world_id: null,
          user_id: 'usr-1',
          completed_at: null,
        }),
      ],
    })
    expect(result.phase).toBe('character_creation')
  })

  it('returns post_creation when materialize_relationships is running', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'complete' },
      runs: [
        run({
          stage: 'materialize_relationships',
          status: 'running',
          campaign_id: 'cmp-1',
          world_id: null,
          completed_at: null,
        }),
      ],
    })
    expect(result.phase).toBe('post_creation')
  })

  it('returns complete when campaigns.status=active', () => {
    const result = derivePhase({
      campaign: { ...baseCampaign, status: 'active' },
      world: { ...baseWorld, status: 'complete' },
      runs: [run({ stage: 'continuity_check', status: 'completed' })],
    })
    expect(result.phase).toBe('complete')
  })

  it('returns failed when a non-worldgen stage failed with no retry running', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'complete' },
      runs: [
        run({
          stage: 'character_sheet',
          status: 'failed',
          campaign_id: 'cmp-1',
          world_id: null,
          user_id: 'usr-1',
          completed_at: null,
        }),
      ],
    })
    expect(result.phase).toBe('failed')
  })

  it('sums cumulative cost across all rows', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: baseWorld,
      runs: [
        run({ stage: 'concept_intake', cost_usd: 0.25 }),
        run({ stage: 'world_and_factions', cost_usd: 1.5 }),
        run({ stage: 'locations_and_npcs', cost_usd: 2.0 }),
      ],
    })
    expect(result.cumulativeCostUsd).toBeCloseTo(3.75)
  })

  it('emits a stage list ordered by stage taxonomy', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: baseWorld,
      // input order shuffled
      runs: [
        run({ stage: 'random_tables', status: 'completed' }),
        run({ stage: 'concept_intake', status: 'completed' }),
        run({ stage: 'world_and_factions', status: 'completed' }),
      ],
    })
    expect(result.stages.map((s) => s.stage)).toEqual([
      'concept_intake',
      'world_and_factions',
      'random_tables',
    ])
  })

  it('classifies unknown stage names into the "unknown" bucket without crashing', () => {
    // Exercises stageScope's `return 'unknown'` fall-through (derive-phase.ts:83-84).
    // An unknown stage doesn't land in any of the three scoped buckets,
    // so it shouldn't influence phase computation; the stage list still
    // includes it (sorted last because STAGE_ORDER.indexOf returns -1).
    const result = derivePhase({
      campaign: baseCampaign,
      world: baseWorld,
      runs: [
        run({ stage: 'unknown_future_stage', status: 'running', completed_at: null }),
      ],
    })
    // No bucketed runs → not_started despite the unknown row existing.
    expect(result.phase).toBe('not_started')
    expect(result.stages.map((s) => s.stage)).toContain('unknown_future_stage')
  })

  it('returns world_gen_failed when a worldgen stage failed but world.status is not yet failed', () => {
    // Exercises the second-pass `worldgen.some(failed)` guard at
    // derive-phase.ts:156-158. The earlier `world.status === 'failed'`
    // guard doesn't fire (the row hasn't been updated yet), so the
    // stage-level failed status is what flips the phase.
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'generating' },
      runs: [
        run({ stage: 'concept_intake', status: 'completed' }),
        run({ stage: 'world_and_factions', status: 'failed', completed_at: null }),
      ],
    })
    expect(result.phase).toBe('world_gen_failed')
  })

  it('preserves per-player rows in the stage list', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'complete' },
      runs: [
        run({
          stage: 'character_concept',
          status: 'completed',
          campaign_id: 'cmp-1',
          world_id: null,
          user_id: 'usr-1',
        }),
        run({
          stage: 'character_concept',
          status: 'running',
          campaign_id: 'cmp-1',
          world_id: null,
          user_id: 'usr-2',
          completed_at: null,
        }),
      ],
    })
    const charConceptStages = result.stages.filter((s) => s.stage === 'character_concept')
    expect(charConceptStages).toHaveLength(2)
    expect(charConceptStages.map((s) => s.userId).sort()).toEqual(['usr-1', 'usr-2'])
  })
})
