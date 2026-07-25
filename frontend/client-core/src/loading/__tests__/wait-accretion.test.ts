import { describe, expect, it } from 'vitest'
import { MIN_EXPECTED_ENTITIES } from '../../worldgen/entity-floor.ts'
import { WATCHED_STAGES, type StageProgress } from '@mythrun/contract/events'
import { worldGenAccretion } from '../wait-accretion.ts'

// worldGenAccretion (ux-run2 myth-i2pdo) — the REAL-EVENT accretion level behind
// the calm wait's dither mark: stillness means stillness, motion means work. The
// level counts only things that actually happened — completed watched stages +
// arrived entities — against the expected total (the watched slice + the
// DB-derived entity floor), so the mark structurally resolves as the pipeline
// works and holds still when nothing lands. Monotone in its inputs, 0..1, and
// NEVER driven by wall-clock time.

const stage = (id: string, status: StageProgress['status']): StageProgress => ({
  stage: id,
  status,
  userId: null,
  costUsd: 0,
  startedAt: null,
  completedAt: null,
})

const EXPECTED_TOTAL = WATCHED_STAGES.length + MIN_EXPECTED_ENTITIES

describe('worldGenAccretion — real events over expected events', () => {
  it('is 0 at the very start (nothing completed, nothing arrived)', () => {
    expect(worldGenAccretion([], 0)).toBe(0)
    expect(worldGenAccretion([stage('concept_intake', 'running')], 0)).toBe(0)
  })

  it('steps up on each completed watched stage (the prep stretch is 3 real events)', () => {
    const one = worldGenAccretion([stage('concept_intake', 'completed')], 0)
    const two = worldGenAccretion(
      [stage('concept_intake', 'completed'), stage('world_color', 'completed')],
      0,
    )
    expect(one).toBeCloseTo(1 / EXPECTED_TOTAL)
    expect(two).toBeCloseTo(2 / EXPECTED_TOTAL)
    expect(two).toBeGreaterThan(one)
  })

  it('steps up as entities arrive (the graph act streams dozens of real events)', () => {
    const base = worldGenAccretion([], 0)
    const some = worldGenAccretion([], 10)
    expect(some).toBeCloseTo(10 / EXPECTED_TOTAL)
    expect(some).toBeGreaterThan(base)
  })

  it('ignores running/failed/pending stages — only a COMPLETION is an event', () => {
    const stages = [
      stage('concept_intake', 'completed'),
      stage('world_color', 'running'),
      stage('vocabulary_intake', 'failed'),
      stage('world_and_factions', 'pending'),
    ]
    expect(worldGenAccretion(stages, 0)).toBeCloseTo(1 / EXPECTED_TOTAL)
  })

  it('ignores silent-tail completions — the tail is nobody’s wait', () => {
    const stages = [stage('concept_intake', 'completed'), stage('embed_world', 'completed')]
    expect(worldGenAccretion(stages, 0)).toBeCloseTo(1 / EXPECTED_TOTAL)
  })

  it('caps the entity numerator at the floor and the whole level at 1', () => {
    const allWatched = WATCHED_STAGES.map((s) => stage(s, 'completed'))
    expect(worldGenAccretion(allWatched, MIN_EXPECTED_ENTITIES * 3)).toBe(1)
  })

  it('never exceeds 1 even with surplus entities alone', () => {
    expect(worldGenAccretion([], MIN_EXPECTED_ENTITIES * 2)).toBeLessThanOrEqual(1)
  })
})
