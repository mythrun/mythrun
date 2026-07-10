import { describe, expect, it } from 'vitest'
import {
  PREP_STAGES,
  WATCHED_STAGES,
  WORLD_GEN_STAGES,
  type StageProgress,
} from '@mythrun/contract/events'
import type { StageTiming } from '@mythrun/contract/rest'
import { remainingPrepWaitMs, remainingWaitMs } from '../stage-eta.ts'

// remainingWaitMs is the pure COUNTDOWN math (MYT-89 audit ③ + reveal timing +
// the waiting-feedback upgrade): the remaining visible wait at `nowMs`, derived
// from the historical per-stage averages intersected with the live stage
// statuses — the sum of the un-completed WATCHED stages' averages, MINUS the
// elapsed time inside the currently-RUNNING stage (that stage's contribution
// clamps at 0, so an overrunning stage HOLDS the count at the remaining-future
// floor instead of going negative; the count drops again at the next stage
// event — jumps are explicitly fine). The visible wait ends at the wiki-reveal
// boundary (entity_relationships), so the silent tail never counts. These pin
// the graceful-degrade rules (cold-start / null → no estimate; missing timing →
// 0; negative avgMs clamped), the completed-subtraction, the tail exclusion,
// the elapsed-in-stage subtraction + overrun clamp, and the defensive
// startedAt parsing (null / unparseable / future → treated as just-started).

const stage = (
  id: string,
  status: StageProgress['status'],
  startedAt: string | null = null,
): StageProgress => ({
  stage: id,
  status,
  userId: null,
  costUsd: 0,
  startedAt,
  completedAt: null,
})

/** A timing for every canonical stage at a uniform `avgMs`. */
const uniformTimings = (avgMs: number): StageTiming[] =>
  WORLD_GEN_STAGES.map((s) => ({ stage: s, avgMs }))

/** A fixed "now" — the derivation is pure, so any epoch works. */
const NOW = Date.parse('2026-07-07T12:00:00.000Z')

/** An ISO instant `ms` before NOW (the running stage's startedAt). */
const startedAgo = (ms: number): string => new Date(NOW - ms).toISOString()

describe('remainingWaitMs — no usable history degrades to no estimate', () => {
  it('returns null for cold-start (empty timings)', () => {
    expect(remainingWaitMs([], [stage('concept_intake', 'running')], NOW)).toBeNull()
  })

  it('returns null when the fetch failed (null timings)', () => {
    expect(remainingWaitMs(null, [stage('concept_intake', 'running')], NOW)).toBeNull()
  })
})

describe('remainingWaitMs — total remaining over the un-completed WATCHED stages', () => {
  it('sums avgMs for the watched stages NOT yet completed (none done → the whole wait)', () => {
    // 6 watched stages × 10_000ms, nothing completed → the whole visible wait
    // remains. The 5 silent tail stages carry timings too — they never count.
    expect(remainingWaitMs(uniformTimings(10_000), [], NOW)).toBe(WATCHED_STAGES.length * 10_000)
  })

  it('excludes completed stages from the total', () => {
    const stages = [stage('concept_intake', 'completed'), stage('world_color', 'running')]
    // 6 watched × 10_000, minus the one completed stage → 5 × 10_000 (the
    // running stage carries no startedAt → treated as just-started, full avg).
    expect(remainingWaitMs(uniformTimings(10_000), stages, NOW)).toBe(
      (WATCHED_STAGES.length - 1) * 10_000,
    )
  })

  it('reaches 0 exactly at the reveal boundary — the tail promises no further wait', () => {
    // Every watched stage completed, the tail not even started, tail timings
    // present: the estimate is DONE (0 → no lingering countdown at the moment
    // the reveal fires).
    const allWatched = WATCHED_STAGES.map((s) => stage(s, 'completed'))
    expect(remainingWaitMs(uniformTimings(60_000), allWatched, NOW)).toBe(0)
  })

  it('ignores a tail-stage timing entirely (coherence_pass etc. are nobody’s wait)', () => {
    const timings: StageTiming[] = [
      { stage: 'entity_relationships', avgMs: 20_000 },
      { stage: 'coherence_pass', avgMs: 999_999 }, // tail — excluded
      { stage: 'embed_world', avgMs: 999_999 }, // tail — excluded
    ]
    expect(remainingWaitMs(timings, [], NOW)).toBe(20_000)
  })

  it('counts a stage with no timing as 0 (never crashes)', () => {
    // Only world_color has a timing; every other un-completed stage contributes 0.
    const timings: StageTiming[] = [{ stage: 'world_color', avgMs: 120_000 }]
    const stages = [stage('concept_intake', 'completed')]
    expect(remainingWaitMs(timings, stages, NOW)).toBe(120_000)
  })

  it('ignores a stray non-worldgen stage in the un-filtered response', () => {
    const timings: StageTiming[] = [
      { stage: 'world_color', avgMs: 30_000 },
      { stage: 'character_creation', avgMs: 999_999 }, // not a WORLD_GEN_STAGE
    ]
    expect(remainingWaitMs(timings, [], NOW)).toBe(30_000)
  })
})

describe('remainingWaitMs — elapsed-in-the-running-stage (the per-second countdown)', () => {
  it('subtracts the running stage’s elapsed time from its average', () => {
    // world_color has been running 30s of its 90s average → it contributes 60s;
    // concept_intake is done; the remaining watched stages have no timing → 0.
    const timings: StageTiming[] = [{ stage: 'world_color', avgMs: 90_000 }]
    const stages = [
      stage('concept_intake', 'completed'),
      stage('world_color', 'running', startedAgo(30_000)),
    ]
    expect(remainingWaitMs(timings, stages, NOW)).toBe(60_000)
  })

  it('walks down as now advances (the tick re-derives, one second per second)', () => {
    const timings: StageTiming[] = [{ stage: 'world_color', avgMs: 90_000 }]
    const stages = [stage('world_color', 'running', startedAgo(30_000))]
    const atNow = remainingWaitMs(timings, stages, NOW)
    const oneSecondLater = remainingWaitMs(timings, stages, NOW + 1_000)
    expect(atNow).toBe(60_000)
    expect(oneSecondLater).toBe(59_000)
  })

  it('CLAMPS an overrunning stage at 0 — the count HOLDS at the remaining-future floor', () => {
    // world_color has overrun its 60s average by 40s. Its contribution clamps to
    // 0 (never negative), so the total holds at the floor: the future stages'
    // averages (world_and_factions 30s + the rest 0). The count resumes at the
    // next stage event.
    const timings: StageTiming[] = [
      { stage: 'world_color', avgMs: 60_000 },
      { stage: 'world_and_factions', avgMs: 30_000 },
    ]
    const stages = [
      stage('concept_intake', 'completed'),
      stage('world_color', 'running', startedAgo(100_000)),
    ]
    expect(remainingWaitMs(timings, stages, NOW)).toBe(30_000)
    // Still holding, not sinking, as the overrun grows.
    expect(remainingWaitMs(timings, stages, NOW + 60_000)).toBe(30_000)
  })

  it('treats a running stage with NO startedAt as just-started (full average)', () => {
    const timings: StageTiming[] = [{ stage: 'world_color', avgMs: 90_000 }]
    const stages = [stage('world_color', 'running', null)]
    expect(remainingWaitMs(timings, stages, NOW)).toBe(90_000)
  })

  it('treats an UNPARSEABLE startedAt as just-started (defensive, never NaN)', () => {
    const timings: StageTiming[] = [{ stage: 'world_color', avgMs: 90_000 }]
    const stages = [stage('world_color', 'running', 'not-a-timestamp')]
    expect(remainingWaitMs(timings, stages, NOW)).toBe(90_000)
  })

  it('treats a FUTURE startedAt as just-started (clock skew never inflates the wait)', () => {
    const timings: StageTiming[] = [{ stage: 'world_color', avgMs: 90_000 }]
    const stages = [stage('world_color', 'running', startedAgo(-45_000))]
    expect(remainingWaitMs(timings, stages, NOW)).toBe(90_000)
  })

  it('subtracts elapsed ONLY from running stages — a failed (will-retry) stage counts in full', () => {
    // A failed stage will re-run: its whole average is still ahead of the
    // player, whatever its recorded startedAt says.
    const timings: StageTiming[] = [{ stage: 'world_color', avgMs: 90_000 }]
    const stages = [stage('world_color', 'failed', startedAgo(30_000))]
    expect(remainingWaitMs(timings, stages, NOW)).toBe(90_000)
  })

  it('clamps each running stage independently (defensive against a double-running stream)', () => {
    // The pipeline is serial, but the fold is defensive: two running entries
    // each subtract their own elapsed with their own floor.
    const timings: StageTiming[] = [
      { stage: 'world_color', avgMs: 60_000 },
      { stage: 'world_and_factions', avgMs: 60_000 },
    ]
    const stages = [
      stage('world_color', 'running', startedAgo(100_000)), // overrun → 0
      stage('world_and_factions', 'running', startedAgo(15_000)), // → 45s
    ]
    expect(remainingWaitMs(timings, stages, NOW)).toBe(45_000)
  })
})

describe('remainingWaitMs — defensive against odd data', () => {
  it('clamps a negative avgMs to 0 (clock skew safety)', () => {
    const timings: StageTiming[] = [
      { stage: 'concept_intake', avgMs: -5_000 },
      { stage: 'world_color', avgMs: 40_000 },
    ]
    // The negative clamps to 0, so only world_color's 40_000 counts.
    expect(remainingWaitMs(timings, [], NOW)).toBe(40_000)
  })
})

// remainingPrepWaitMs is the ACT-ONE countdown (myth-tudy1): the same math as
// remainingWaitMs, but summed over the PREP_STAGES slice ONLY — so the loading
// screen counts down to ARRIVING ON THE GRAPH (the first entity-emitting stage's
// start, the watch-button beat), NOT to the wiki reveal. The prep slice is
// concept_intake / world_color / vocabulary_intake — derived from the canonical
// taxonomy at the first-entity-emitter boundary, so a reorder can't drift it.
describe('remainingPrepWaitMs — the prep-slice countdown (arrive on the graph)', () => {
  it('sums avgMs for the prep stages NOT yet completed (none done → the whole prep wait)', () => {
    // 3 prep stages × 10_000, nothing completed → the whole prep wait remains.
    // Entity/tail stages carry timings too but never count toward the prep slice.
    expect(remainingPrepWaitMs(uniformTimings(10_000), [], NOW)).toBe(PREP_STAGES.length * 10_000)
  })

  it('counts ONLY the prep stages — the first entity stage and beyond never count', () => {
    // world_and_factions (the first entity emitter) is OUTSIDE the prep slice, so
    // its (huge) timing is ignored — the loading wait ends when entities START.
    const timings: StageTiming[] = [
      { stage: 'concept_intake', avgMs: 20_000 },
      { stage: 'world_color', avgMs: 15_000 },
      { stage: 'vocabulary_intake', avgMs: 25_000 },
      { stage: 'world_and_factions', avgMs: 600_000 }, // first entity stage — excluded
      { stage: 'world_introduction', avgMs: 999_999 }, // watched but not prep — excluded
    ]
    expect(remainingPrepWaitMs(timings, [], NOW)).toBe(60_000)
  })

  it('excludes completed prep stages from the total', () => {
    const stages = [stage('concept_intake', 'completed'), stage('world_color', 'running')]
    // 3 prep × 10_000, minus the one completed → 2 × 10_000 (the running stage has
    // no startedAt → treated as just-started, full avg).
    expect(remainingPrepWaitMs(uniformTimings(10_000), stages, NOW)).toBe(
      (PREP_STAGES.length - 1) * 10_000,
    )
  })

  it('hits 0 exactly when the first entity stage starts (all prep complete)', () => {
    // Every prep stage completed, world_and_factions running: arriving on the
    // graph — the loading countdown reads 0:00 as the watch button appears.
    const stages = [
      ...PREP_STAGES.map((s) => stage(s, 'completed')),
      stage('world_and_factions', 'running', startedAgo(5_000)),
    ]
    expect(remainingPrepWaitMs(uniformTimings(30_000), stages, NOW)).toBe(0)
  })

  it('subtracts elapsed-in-the-running prep stage, and CLAMPS an overrun at the floor', () => {
    const timings: StageTiming[] = [
      { stage: 'concept_intake', avgMs: 60_000 },
      { stage: 'vocabulary_intake', avgMs: 20_000 },
    ]
    // concept_intake 30s into its 60s avg → 30s left; world_color has no timing
    // → 0; vocabulary_intake whole 20s ahead → 50s total.
    const running = [stage('concept_intake', 'running', startedAgo(30_000))]
    expect(remainingPrepWaitMs(timings, running, NOW)).toBe(50_000)
    // Overrun: concept_intake 90s into its 60s avg → clamps to 0, holding at the
    // future floor (vocabulary_intake's 20s), never negative.
    const overrun = [stage('concept_intake', 'running', startedAgo(90_000))]
    expect(remainingPrepWaitMs(timings, overrun, NOW)).toBe(20_000)
  })

  it('returns null for cold-start / failed-fetch (no estimate, same as the reveal countdown)', () => {
    expect(remainingPrepWaitMs([], [stage('concept_intake', 'running')], NOW)).toBeNull()
    expect(remainingPrepWaitMs(null, [stage('concept_intake', 'running')], NOW)).toBeNull()
  })
})
