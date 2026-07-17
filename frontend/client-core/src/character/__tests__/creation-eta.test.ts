import { describe, expect, it } from 'vitest'
import type { StageProgress } from '@mythrun/contract/events'
import type { StageTiming } from '@mythrun/contract/rest'
import { CHARACTER_CREATION_STAGES, remainingCreationWaitMs } from '../creation-eta.ts'

// remainingCreationWaitMs (MYT-102 Track B) — the character-creation countdown:
// the SAME slice-summing math as the world-gen ETA (`remainingOverSlice`, the
// shared core exported from worldgen/stage-eta.ts), summed over the canonical
// per-player CHARACTER_CREATION_STAGES slice. Integration is deliberately
// EXCLUDED — the viewer's visible wait ends when their own sheet completes (the
// reveal moment), and the campaign-scoped integration runs later behind the
// party-staging surface. These pin the honesty semantics the loading surface
// leans on: cold-start FOR THE SLICE → null (a warm world-gen history with no
// character history must NOT read as a fake instant estimate), completed stages
// excluded, the running stage subtracting elapsed with the overrun clamp, and
// non-slice timing rows (world-gen stages, character_integration) ignored.

const VIEWER = 'user-viewer'

const stage = (
  id: string,
  status: StageProgress['status'],
  startedAt: string | null = null,
): StageProgress => ({
  stage: id,
  status,
  userId: VIEWER,
  costUsd: 0,
  startedAt,
  completedAt: null,
})

const timing = (id: string, avgMs: number): StageTiming => ({ stage: id, avgMs })

/** A timing row for every creation stage at a uniform `avgMs`. */
const creationTimings = (avgMs: number): StageTiming[] =>
  CHARACTER_CREATION_STAGES.map((s) => timing(s, avgMs))

/** A fixed "now" — the derivation is pure, so any epoch works. */
const NOW = Date.parse('2026-07-17T12:00:00.000Z')

/** An ISO instant `ms` before NOW (the running stage's startedAt). */
const startedAgo = (ms: number): string => new Date(NOW - ms).toISOString()

describe('CHARACTER_CREATION_STAGES — the canonical per-player slice', () => {
  it('mirrors the backend STAGES_IN_ORDER exactly (order + names)', () => {
    // MIRROR PIN (the SUBCLASS_LEVEL precedent): a string copy of
    // backend/src/llm/prep/character-creation-processor.ts `STAGES_IN_ORDER`,
    // NOT a cross-boundary import (the contract layer never reaches into llm/).
    // If the backend taxonomy changes, update BOTH sides deliberately.
    const BACKEND_STAGES_IN_ORDER = [
      'location_selection',
      'character_concept',
      'character_sheet',
    ] as const
    expect(CHARACTER_CREATION_STAGES).toEqual(BACKEND_STAGES_IN_ORDER)
  })
})

describe('remainingCreationWaitMs — no usable history degrades to no estimate', () => {
  it('returns null when the fetch failed (null timings)', () => {
    expect(remainingCreationWaitMs(null, [], NOW)).toBeNull()
  })

  it('returns null for cold-start (empty timings)', () => {
    expect(remainingCreationWaitMs([], [], NOW)).toBeNull()
  })

  it('returns null when the history has NO creation-stage rows (warm world-gen, first character ever)', () => {
    // The stage-timings endpoint is un-filtered: a deployment that has generated
    // worlds but never a character returns world-gen rows only. The core's
    // "missing timing contributes 0" semantics would read that as a fake ~0:00 —
    // the slice-level cold-start check returns null instead (no countdown).
    const worldGenOnly = [timing('concept_intake', 60_000), timing('world_and_factions', 120_000)]
    expect(remainingCreationWaitMs(worldGenOnly, [], NOW)).toBeNull()
  })

  it('returns null when every creation-stage row is a degenerate 0 average', () => {
    expect(remainingCreationWaitMs(creationTimings(0), [], NOW)).toBeNull()
  })
})

describe('remainingCreationWaitMs — the slice-summed wait', () => {
  it('sums the three creation-stage averages when nothing has started', () => {
    expect(remainingCreationWaitMs(creationTimings(10_000), [], NOW)).toBe(30_000)
  })

  it('ignores non-slice timing rows (world-gen stages, character_integration)', () => {
    // The viewer's visible wait ends at THEIR sheet — integration (and any
    // world-gen row in the un-filtered aggregate) never counts.
    const rows = [
      ...creationTimings(10_000),
      timing('character_integration', 500_000),
      timing('entity_relationships', 500_000),
    ]
    expect(remainingCreationWaitMs(rows, [], NOW)).toBe(30_000)
  })

  it('excludes completed stages from the total', () => {
    const stages = [stage('location_selection', 'completed'), stage('character_concept', 'completed')]
    expect(remainingCreationWaitMs(creationTimings(10_000), stages, NOW)).toBe(10_000)
  })

  it('subtracts the elapsed time inside the running stage', () => {
    const stages = [
      stage('location_selection', 'completed'),
      stage('character_concept', 'running', startedAgo(4_000)),
    ]
    // concept: 10s avg − 4s elapsed = 6s; sheet: full 10s. → 16s.
    expect(remainingCreationWaitMs(creationTimings(10_000), stages, NOW)).toBe(16_000)
  })

  it('holds at the remaining-future floor when the running stage overruns', () => {
    const stages = [
      stage('location_selection', 'completed'),
      stage('character_concept', 'running', startedAgo(60_000)),
    ]
    // The overrunning concept clamps to 0 — never negative; the sheet's 10s remains.
    expect(remainingCreationWaitMs(creationTimings(10_000), stages, NOW)).toBe(10_000)
  })

  it('a slice stage with no timing row contributes 0 when other creation rows exist', () => {
    // Partial history (e.g. the near-instant location_selection has no row yet):
    // the core's "missing → 0" semantics apply once the slice has ANY real history.
    const rows = [timing('character_concept', 10_000), timing('character_sheet', 10_000)]
    expect(remainingCreationWaitMs(rows, [], NOW)).toBe(20_000)
  })

  it('reaches 0 exactly when every creation stage is complete (the reveal moment)', () => {
    const allDone = CHARACTER_CREATION_STAGES.map((s) => stage(s, 'completed'))
    expect(remainingCreationWaitMs(creationTimings(10_000), allDone, NOW)).toBe(0)
  })
})
