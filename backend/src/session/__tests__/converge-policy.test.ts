// myth-3jna1 — the convergence steer's DETERMINISTIC policy arms.
//
// `converge-policy.ts` holds the mechanical half of the steer: turn cumulative
// token spend into a fraction, decide whether the (paid) narrative-progress
// probe is worth running at all, and compare the two fractions. All three are
// pure arithmetic over policy constants — mechanical policy, ZFC-exempt. The
// JUDGMENT half (how far through the arc the session actually is) is the Haiku
// call in llm/st-narrative-progress.ts; nothing here inspects prose.

import { describe, expect, it } from 'vitest'
import {
  isConverging,
  mechanicalProgress,
  shouldProbeNarrativeProgress,
} from '../converge-policy.js'
import {
  CONVERGE_LAG_MARGIN,
  CONVERGE_MECHANICAL_FLOOR,
  WIND_DOWN_FRACTION,
} from '../st-config.js'
import { SESSION_FT_CONTEXT_BUDGET } from '../ft-config.js'

describe('mechanicalProgress', () => {
  it('is cumulative spend over the session token budget', () => {
    expect(mechanicalProgress(SESSION_FT_CONTEXT_BUDGET / 4)).toBeCloseTo(0.25, 10)
    expect(mechanicalProgress(SESSION_FT_CONTEXT_BUDGET * 0.75)).toBeCloseTo(0.75, 10)
  })

  it('clamps to [0,1] — it is a fraction, not a ratio that runs away', () => {
    expect(mechanicalProgress(0)).toBe(0)
    expect(mechanicalProgress(-1)).toBe(0)
    expect(mechanicalProgress(SESSION_FT_CONTEXT_BUDGET * 3)).toBe(1)
  })
})

describe('shouldProbeNarrativeProgress', () => {
  it('does NOT probe below the convergence floor (zero added spend early)', () => {
    expect(shouldProbeNarrativeProgress(0, false)).toBe(false)
    expect(shouldProbeNarrativeProgress(CONVERGE_MECHANICAL_FLOOR - 0.01, false)).toBe(false)
  })

  it('probes at and above the floor', () => {
    expect(shouldProbeNarrativeProgress(CONVERGE_MECHANICAL_FLOOR, false)).toBe(true)
    expect(shouldProbeNarrativeProgress(CONVERGE_MECHANICAL_FLOOR + 0.05, false)).toBe(true)
  })

  it('does NOT probe once wind-down is active — that arm already steers to close', () => {
    expect(shouldProbeNarrativeProgress(WIND_DOWN_FRACTION, true)).toBe(false)
    expect(shouldProbeNarrativeProgress(1, true)).toBe(false)
  })

  it('opens a probe window strictly inside [floor, wind-down)', () => {
    expect(CONVERGE_MECHANICAL_FLOOR).toBeLessThan(WIND_DOWN_FRACTION)
  })
})

describe('isConverging', () => {
  it('fires when narrative progress lags mechanical by more than the margin', () => {
    expect(isConverging(0.8, 0.8 - CONVERGE_LAG_MARGIN - 0.01)).toBe(true)
    expect(isConverging(0.8, 0)).toBe(true)
  })

  it('does NOT fire when the arc is on pace', () => {
    expect(isConverging(0.8, 0.8)).toBe(false)
    expect(isConverging(0.8, 0.79)).toBe(false)
  })

  it('does NOT fire when the arc is AHEAD of the spend', () => {
    expect(isConverging(0.8, 0.95)).toBe(false)
  })

  it('treats a lag of exactly the margin as on-pace (the margin absorbs judgment noise)', () => {
    expect(isConverging(0.8, 0.8 - CONVERGE_LAG_MARGIN)).toBe(false)
  })
})
