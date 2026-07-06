import { describe, expect, it } from 'vitest'
import { WORLD_GEN_STAGES, type StageProgress } from '@mythrun/contract/events'
import type { StageTiming } from '@mythrun/contract/rest'
import { remainingStageMs } from '../stage-eta.ts'

// remainingStageMs is the pure ETA math (MYT-89 audit ③): sum the historical
// average durations for the canonical stages NOT yet completed. These pin the
// graceful-degrade rules (cold-start / null → no estimate; missing timing → 0;
// negative avgMs clamped) + the completed-subtraction over the 11 taxonomy stages.

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

describe('remainingStageMs — total remaining over the un-completed stages', () => {
  it('sums avgMs for the stages NOT yet completed (all 11, none done)', () => {
    // 11 stages × 10_000ms, nothing completed → the whole run remains.
    expect(remainingStageMs(uniformTimings(10_000), [])).toBe(WORLD_GEN_STAGES.length * 10_000)
  })

  it('excludes completed stages from the total', () => {
    const stages = [stage('concept_intake', 'completed'), stage('world_color', 'running')]
    // 11 stages × 10_000, minus the one completed stage → 10 × 10_000.
    expect(remainingStageMs(uniformTimings(10_000), stages)).toBe(
      (WORLD_GEN_STAGES.length - 1) * 10_000,
    )
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
