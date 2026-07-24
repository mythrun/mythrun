import { describe, expect, it } from 'vitest'
import type { StageTiming } from '@mythrun/contract/rest'
import { remainingSessionPrepWaitMs, SESSION_PREP_STAGE_PREFIX } from '../session-prep-eta.ts'

// remainingSessionPrepWaitMs (MYT-102 loading revamp, session-prep surface) — the
// coarse wall-clock estimate behind the between-sessions "the DM is preparing"
// hold. Session prep is a SINGLE pipeline stage (`session-prep:<n>`) with NO
// per-stage client signals, so unlike world-gen/character there is nothing to
// re-estimate adaptively against — the honest fallback (research path b) is a
// coarse countdown from the HISTORICAL prep-duration baseline (the average of the
// per-session-number `session-prep:*` timing rows) minus elapsed, handed to the
// same `waitDisplay` brain for the coarse label + the stalled handoff.

const NOW = Date.parse('2026-07-23T12:00:00.000Z')
const timing = (stage: string, avgMs: number): StageTiming => ({ stage, avgMs })

describe('remainingSessionPrepWaitMs', () => {
  it('returns null when timings are unavailable (fetch failed / not resolved)', () => {
    expect(remainingSessionPrepWaitMs(null, NOW, NOW)).toBeNull()
  })

  it('returns null on cold-start (no session-prep history)', () => {
    expect(remainingSessionPrepWaitMs([], NOW, NOW)).toBeNull()
    // World-gen / character rows present but no session-prep row → still null
    // (the surface shows no fake estimate, degrades to the calm detail line).
    const other = [timing('concept_intake', 60_000), timing('character_sheet', 90_000)]
    expect(remainingSessionPrepWaitMs(other, NOW, NOW)).toBeNull()
  })

  it('averages the per-session-number session-prep rows into one baseline', () => {
    // The stage string embeds the session number, so the aggregate is fragmented
    // across `session-prep:1`, `session-prep:2`, … — average them into a single
    // typical prep duration. (100+140+120)/3 = 120s.
    const timings = [
      timing(`${SESSION_PREP_STAGE_PREFIX}1`, 100_000),
      timing(`${SESSION_PREP_STAGE_PREFIX}2`, 140_000),
      timing(`${SESSION_PREP_STAGE_PREFIX}3`, 120_000),
      timing('entity_relationships', 500_000), // ignored (not a prep row)
    ]
    // At the very start (elapsed 0) the whole baseline remains.
    expect(remainingSessionPrepWaitMs(timings, NOW, NOW)).toBe(120_000)
  })

  it('counts the baseline down by elapsed wall-clock since prep began', () => {
    const timings = [timing(`${SESSION_PREP_STAGE_PREFIX}1`, 120_000)]
    const startedAt = NOW - 30_000 // 30s elapsed
    expect(remainingSessionPrepWaitMs(timings, startedAt, NOW)).toBe(90_000)
  })

  it('clamps at 0 once elapsed passes the baseline (never negative — the stall boundary)', () => {
    const timings = [timing(`${SESSION_PREP_STAGE_PREFIX}1`, 120_000)]
    const startedAt = NOW - 200_000 // 200s elapsed, past the 120s baseline
    expect(remainingSessionPrepWaitMs(timings, startedAt, NOW)).toBe(0)
  })

  it('ignores degenerate 0-average prep rows (no real duration recorded)', () => {
    expect(remainingSessionPrepWaitMs([timing(`${SESSION_PREP_STAGE_PREFIX}1`, 0)], NOW, NOW)).toBeNull()
  })
})
