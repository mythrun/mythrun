// backend/src/sse/__tests__/derive-phase.test.ts
import { describe, expect, it } from 'vitest'
import {
  CHARCREATION_STAGES,
  POSTCREATION_STAGES,
  deriveCardPhase,
  derivePhase,
  type CampaignRow,
  type CardPhase,
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

  it('returns failed when campaigns.status=failed (MYT-56 terminal integration failure)', () => {
    // The character-integration processor's terminal-failure arm sets
    // campaigns.status='failed' so the derived phase agrees with the
    // bare GET response. computePhase short-circuits on the column value.
    const result = derivePhase({
      campaign: { ...baseCampaign, status: 'failed' },
      world: { ...baseWorld, status: 'complete' },
      runs: [run({ stage: 'character_integration', status: 'failed', completed_at: null })],
    })
    expect(result.phase).toBe('failed')
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

  it('returns post_creation when character_integration is running', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'complete' },
      runs: [
        run({
          stage: 'character_integration',
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
      runs: [run({ stage: 'character_integration', status: 'completed' })],
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

  it('returns world_snapshot_ready when worldStatus is generating AND entity_relationships completed', () => {
    // myth-exac T17: stage-4 (entity_relationships) has committed the snapshot
    // and the world is fetchable, but stages 5-7 are still running so
    // worlds.status remains 'generating'. The SSE initial frame must
    // surface this so mid-window subscribers learn the snapshot is ready.
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'generating' },
      runs: [
        run({ stage: 'concept_intake', status: 'completed' }),
        run({ stage: 'world_and_factions', status: 'completed' }),
        run({ stage: 'locations_and_npcs', status: 'completed' }),
        run({ stage: 'entity_relationships', status: 'completed' }),
        run({ stage: 'starting_situation', status: 'running', completed_at: null }),
      ],
    })
    expect(result.phase).toBe('world_snapshot_ready')
  })

  it('still returns world_gen when entity_relationships is not yet completed', () => {
    // Counterpoint to the snapshot_ready case: entity_relationships hasn't
    // committed yet, so the snapshot isn't fetchable. Phase stays world_gen.
    const inProgress = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'generating' },
      runs: [
        run({ stage: 'concept_intake', status: 'completed' }),
        run({ stage: 'world_and_factions', status: 'completed' }),
        run({ stage: 'locations_and_npcs', status: 'completed' }),
        run({ stage: 'entity_relationships', status: 'running', completed_at: null }),
      ],
    })
    expect(inProgress.phase).toBe('world_gen')

    const absent = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'generating' },
      runs: [
        run({ stage: 'concept_intake', status: 'completed' }),
        run({ stage: 'world_and_factions', status: 'running', completed_at: null }),
      ],
    })
    expect(absent.phase).toBe('world_gen')
  })

  it('returns world_ready when worldStatus is complete (new branch does not override later phases)', () => {
    // Once worlds.status flips to 'complete' the snapshot_ready branch
    // must not fire — world_ready (or downstream phases) take over.
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'complete' },
      runs: [
        run({ stage: 'concept_intake', status: 'completed' }),
        run({ stage: 'world_and_factions', status: 'completed' }),
        run({ stage: 'locations_and_npcs', status: 'completed' }),
        run({ stage: 'entity_relationships', status: 'completed' }),
        run({ stage: 'starting_situation', status: 'completed' }),
        run({ stage: 'random_tables', status: 'completed' }),
        run({ stage: 'coherence_pass', status: 'completed' }),
      ],
    })
    expect(result.phase).toBe('world_ready')
  })

  // MYT-71 T10 lockstep: WORLDGEN_STAGES must include 'embed_world' (after
  // coherence_pass) so derivePhase classifies the terminal embed row as
  // 'worldgen' rather than dropping it to 'unknown'. With a running embed_world
  // row and the world still 'generating' (and NO entity_relationships row so
  // the earlier world_snapshot_ready branch can't shadow this), the phase must
  // stay 'world_gen' — which fires ONLY because the running embed row lands in
  // the worldgen bucket. If it were 'unknown' the bucket would have no
  // running/pending row and the phase would fall through past world_gen.
  it("classifies embed_world as 'worldgen' (running embed keeps phase world_gen)", () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'generating' },
      runs: [
        run({ stage: 'concept_intake', status: 'completed' }),
        run({ stage: 'coherence_pass', status: 'completed' }),
        run({ stage: 'embed_world', status: 'running', completed_at: null }),
      ],
    })
    expect(result.phase).toBe('world_gen')
    // The embed_world stage surfaces in the ordered stage list, sorted LAST in
    // the worldgen taxonomy — not dropped or sorted to the front as 'unknown'.
    const stageNames = result.stages.map((s) => s.stage)
    expect(stageNames).toContain('embed_world')
    expect(stageNames[stageNames.length - 1]).toBe('embed_world')
  })

  it('sort comparator handles null user_id alongside non-null values stably', () => {
    // Same-stage rows where one has user_id=null and one is a real user;
    // exercises the `a.user_id ?? ''` falsy arm in the per-player sort.
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'complete' },
      runs: [
        run({
          stage: 'character_concept',
          status: 'running',
          campaign_id: 'cmp-1',
          world_id: null,
          user_id: 'usr-2',
          completed_at: null,
        }),
        run({
          stage: 'character_concept',
          status: 'running',
          campaign_id: 'cmp-1',
          world_id: null,
          user_id: null,
          completed_at: null,
        }),
      ],
    })
    const ordered = result.stages
      .filter((s) => s.stage === 'character_concept')
      .map((s) => s.userId)
    // localeCompare('', 'usr-2') < 0 → null entry sorts first.
    expect(ordered).toEqual([null, 'usr-2'])
  })
})

describe('post-MYT-54 stage taxonomy', () => {
  it("CHARCREATION_STAGES does not include 'character_integration'", () => {
    expect((CHARCREATION_STAGES as readonly string[]).includes('character_integration')).toBe(false)
  })

  it("POSTCREATION_STAGES is exactly ['character_integration']", () => {
    expect(POSTCREATION_STAGES).toEqual(['character_integration'])
  })

  it("computePhase returns 'post_creation' when campaign-scoped character_integration is running", () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'complete' },
      runs: [
        run({
          stage: 'character_integration',
          status: 'running',
          campaign_id: 'cmp-1',
          world_id: null,
          user_id: null,
          completed_at: null,
        }),
      ],
    })
    expect(result.phase).toBe('post_creation')
  })
})

// ---------------------------------------------------------------------------
// MYT-87 T10: viewer-relative hub `cardPhase`. Pure, no I/O. Drives the
// campaign-hub card's implicit-status line. `derivePhase` (above) stays the
// global pipeline phase; this is the per-viewer card projection.
//
// Lifecycle note: the character-creation window is campaign.status === 'setup'.
// A campaign flips to 'active' only as the FINAL write of character-integration,
// once every PC is woven in (repo/campaigns.ts:302 setActive), so the
// viewer-relative states (needs-character / waiting-for-players) fire during
// 'setup', NOT 'active'.
// ---------------------------------------------------------------------------
describe('deriveCardPhase', () => {
  interface CardCase {
    readonly name: string
    readonly world: WorldRow['status']
    readonly campaign: CampaignRow['status']
    readonly viewerHasCharacter: boolean
    readonly partyAllReady: boolean
    readonly sessionCount: number
    readonly expected: CardPhase
  }

  const cases: readonly CardCase[] = [
    // Terminal/in-flight gates win first.
    {
      name: 'world failed -> failed',
      world: 'failed',
      campaign: 'setup',
      viewerHasCharacter: false,
      partyAllReady: false,
      sessionCount: 0,
      expected: 'failed',
    },
    {
      name: 'world generating -> generating',
      world: 'generating',
      campaign: 'setup',
      viewerHasCharacter: false,
      partyAllReady: false,
      sessionCount: 0,
      expected: 'generating',
    },
    {
      name: 'campaign failed + world complete -> failed (MYT-56 integration exhausted)',
      world: 'complete',
      campaign: 'failed',
      viewerHasCharacter: true,
      partyAllReady: true,
      sessionCount: 2,
      expected: 'failed',
    },
    // world complete + campaign 'setup' (the character-creation window):
    // project against the viewer + party.
    {
      name: 'setup + complete + viewer lacks a character -> needs-character',
      world: 'complete',
      campaign: 'setup',
      viewerHasCharacter: false,
      partyAllReady: false,
      sessionCount: 0,
      expected: 'needs-character',
    },
    {
      name: 'setup + complete + viewer ready, party not all ready -> waiting-for-players',
      world: 'complete',
      campaign: 'setup',
      viewerHasCharacter: true,
      partyAllReady: false,
      sessionCount: 0,
      expected: 'waiting-for-players',
    },
    {
      name: 'setup + complete + party all ready -> not-played (pre-active transient)',
      world: 'complete',
      campaign: 'setup',
      viewerHasCharacter: true,
      partyAllReady: true,
      sessionCount: 0,
      expected: 'not-played',
    },
    // campaign 'active' — every PC integrated, world playable.
    {
      name: 'active + complete + no sessions yet -> not-played',
      world: 'complete',
      campaign: 'active',
      viewerHasCharacter: true,
      partyAllReady: true,
      sessionCount: 0,
      expected: 'not-played',
    },
    {
      name: 'active + complete + has played -> played',
      world: 'complete',
      campaign: 'active',
      viewerHasCharacter: true,
      partyAllReady: true,
      sessionCount: 2,
      expected: 'played',
    },
    // Precedence: a failed world wins over an otherwise-playable active campaign
    // (the active + ready + sessionCount fields here would yield 'played').
    {
      name: 'precedence: world failed wins over an active, played campaign',
      world: 'failed',
      campaign: 'active',
      viewerHasCharacter: true,
      partyAllReady: true,
      sessionCount: 2,
      expected: 'failed',
    },
  ]

  it.each(cases)('$name', ({ world, campaign, viewerHasCharacter, partyAllReady, sessionCount, expected }) => {
    const result = deriveCardPhase({
      campaign: { status: campaign, sessionCount },
      world: { status: world },
      viewerHasCharacter,
      partyAllReady,
    })
    expect(result).toBe(expected)
  })
})
