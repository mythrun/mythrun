import { describe, expect, it } from 'vitest'
import { WATCHED_STAGES, WORLD_GEN_STAGES, type StageProgress } from '@mythrun/contract/events'
import type { StageTiming } from '@mythrun/contract/rest'
import { remainingStageMs } from '../stage-eta.ts'

// remainingStageMs is the pure ETA math (MYT-89 audit ③ + reveal timing): sum
// the historical average durations for the WATCHED stages NOT yet completed —
// the visible wait ends at the wiki-reveal boundary (entity_relationships), so
// the silent tail never counts (an ETA that included the tail would promise
// minutes past the moment the reveal fires). These pin the graceful-degrade
// rules (cold-start / null → no estimate; missing timing → 0; negative avgMs
// clamped), the completed-subtraction, and the tail exclusion.

const stage = (id: string, status: StageProgress['status']): StageProgress => ({
  stage: id,
  status,
  userId: null,
  costUsd: 0,
  startedAt: null,
  completedAt: null,
})

/** A timing for every canonical stage at a uniform `avgMs`. */
const uniformTimings = (avgMs: number): StageTiming[] =>
  WORLD_GEN_STAGES.map((s) => ({ stage: s, avgMs }))

describe('remainingStageMs — no usable history degrades to no estimate', () => {
  it('returns null for cold-start (empty timings)', () => {
    expect(remainingStageMs([], [stage('concept_intake', 'running')])).toBeNull()
  })

  it('returns null when the fetch failed (null timings)', () => {
    expect(remainingStageMs(null, [stage('concept_intake', 'running')])).toBeNull()
  })
})

describe('remainingStageMs — total remaining over the un-completed WATCHED stages', () => {
  it('sums avgMs for the watched stages NOT yet completed (none done → the whole wait)', () => {
    // 6 watched stages × 10_000ms, nothing completed → the whole visible wait
    // remains. The 5 silent tail stages carry timings too — they never count.
    expect(remainingStageMs(uniformTimings(10_000), [])).toBe(WATCHED_STAGES.length * 10_000)
  })

  it('excludes completed stages from the total', () => {
    const stages = [stage('concept_intake', 'completed'), stage('world_color', 'running')]
    // 6 watched × 10_000, minus the one completed stage → 5 × 10_000.
    expect(remainingStageMs(uniformTimings(10_000), stages)).toBe(
      (WATCHED_STAGES.length - 1) * 10_000,
    )
  })

  it('reaches 0 exactly at the reveal boundary — the tail promises no further wait', () => {
    // Every watched stage completed, the tail not even started, tail timings
    // present: the estimate is DONE (0 → the card shows no lingering "~Xm left"
    // at the moment the reveal fires).
    const allWatched = WATCHED_STAGES.map((s) => stage(s, 'completed'))
    expect(remainingStageMs(uniformTimings(60_000), allWatched)).toBe(0)
  })

  it('ignores a tail-stage timing entirely (coherence_pass etc. are nobody’s wait)', () => {
    const timings: StageTiming[] = [
      { stage: 'entity_relationships', avgMs: 20_000 },
      { stage: 'coherence_pass', avgMs: 999_999 }, // tail — excluded
      { stage: 'embed_world', avgMs: 999_999 }, // tail — excluded
    ]
    expect(remainingStageMs(timings, [])).toBe(20_000)
  })

  it('counts a stage with no timing as 0 (never crashes)', () => {
    // Only world_color has a timing; every other un-completed stage contributes 0.
    const timings: StageTiming[] = [{ stage: 'world_color', avgMs: 120_000 }]
    const stages = [stage('concept_intake', 'completed')]
    expect(remainingStageMs(timings, stages)).toBe(120_000)
  })

  it('ignores a stray non-worldgen stage in the un-filtered response', () => {
    const timings: StageTiming[] = [
      { stage: 'world_color', avgMs: 30_000 },
      { stage: 'character_creation', avgMs: 999_999 }, // not a WORLD_GEN_STAGE
    ]
    expect(remainingStageMs(timings, [])).toBe(30_000)
  })
})

describe('remainingStageMs — defensive against odd data', () => {
  it('clamps a negative avgMs to 0 (clock skew safety)', () => {
    const timings: StageTiming[] = [
      { stage: 'concept_intake', avgMs: -5_000 },
      { stage: 'world_color', avgMs: 40_000 },
    ]
    // The negative clamps to 0, so only world_color's 40_000 counts.
    expect(remainingStageMs(timings, [])).toBe(40_000)
  })
})
