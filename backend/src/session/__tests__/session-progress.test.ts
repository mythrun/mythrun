import { describe, expect, it } from 'vitest'

import { SESSION_FT_CONTEXT_BUDGET } from '../ft-config.js'
import {
  PROGRESS_STEP,
  computeProgressFraction,
  raiseProgressMonotonic,
} from '../session-progress.js'

// myth-zd6pn — the session bound is the FT's per-call CONTEXT FILL, not
// cumulative gross spend. The old cumulative axis counted cache reads 1:1
// against the ceiling; at a 91-96% cache-read rate that ended sessions at
// roughly one ninth of the sold unit while the window sat ~4% full.
describe('computeProgressFraction — FT context fill against the ceiling', () => {
  it('is 0 for a session whose FT has held nothing', () => {
    expect(computeProgressFraction({ contextTokens: 0 })).toBe(0)
  })

  it('is the context fill as a fraction of the budget', () => {
    expect(
      computeProgressFraction({ contextTokens: SESSION_FT_CONTEXT_BUDGET * 0.6 }),
    ).toBe(0.6)
  })

  it('does NOT respond to cumulative spend — only to what the FT holds', () => {
    // The defect being fixed: a session can burn an enormous number of gross
    // tokens (overwhelmingly cache reads) while the FT's context stays small.
    // Progress must track the window, so this reads as an EARLY session.
    expect(computeProgressFraction({ contextTokens: 35_600 })).toBeLessThanOrEqual(0.05)
  })

  it('clamps at 1 when the ceiling is overshot', () => {
    expect(computeProgressFraction({ contextTokens: SESSION_FT_CONTEXT_BUDGET * 9 })).toBe(1)
  })

  it('floors at 0 rather than emitting a negative fraction', () => {
    expect(computeProgressFraction({ contextTokens: -1 })).toBe(0)
  })

  it('treats a non-finite reading as EMPTY, not full', () => {
    // A corrupt reading is garbage, not a level. It must floor at 0: the
    // monotonic floor makes a spurious 1.0 PERMANENT for the rest of the
    // session, so over-reading is the unrecoverable failure and under-reading
    // self-heals on the next honest turn.
    expect(computeProgressFraction({ contextTokens: Number.NaN })).toBe(0)
    expect(computeProgressFraction({ contextTokens: Number.POSITIVE_INFINITY })).toBe(0)
  })
})

describe('computeProgressFraction — COARSE (0.05 buckets)', () => {
  it('rounds to the nearest 0.05 bucket', () => {
    expect(
      computeProgressFraction({
        contextTokens: Math.round(SESSION_FT_CONTEXT_BUDGET * 0.5199),
      }),
    ).toBe(0.5)
    expect(
      computeProgressFraction({
        contextTokens: Math.round(SESSION_FT_CONTEXT_BUDGET * 0.53),
      }),
    ).toBe(0.55)
  })

  it('emits exact 0.05 multiples — no float dust on the wire', () => {
    // Math.round(x * 20) / 20 rather than Math.round(x / 0.05) * 0.05: the
    // latter yields 0.35000000000000003 and ships it as JSON.
    for (let bucket = 0; bucket <= 20; bucket++) {
      const fraction = computeProgressFraction({
        contextTokens: Math.round(SESSION_FT_CONTEXT_BUDGET * (bucket / 20)),
      })
      expect(JSON.stringify(fraction)).toBe(String(bucket / 20))
    }
  })

  it('never emits a value off the 0.05 grid', () => {
    for (let i = 0; i < 200; i++) {
      const fraction = computeProgressFraction({
        contextTokens: Math.round(SESSION_FT_CONTEXT_BUDGET * (i / 199)),
      })
      expect(Math.round(fraction / PROGRESS_STEP) * PROGRESS_STEP).toBeCloseTo(fraction, 10)
    }
  })
})

describe('raiseProgressMonotonic — the rising-value clamp', () => {
  it('returns the candidate when there is no prior floor', () => {
    expect(raiseProgressMonotonic(0.35, 0)).toBe(0.35)
  })

  it('lets a rising fraction rise', () => {
    expect(raiseProgressMonotonic(0.6, 0.35)).toBe(0.6)
  })

  it('HOLDS when the candidate falls — a shorter turn must not walk it back', () => {
    // The context term legitimately falls (a terse turn after a combat burst),
    // and it is now the ONLY term, so the floor carries the whole monotonic
    // guarantee rather than sharing it with a by-construction-rising counter.
    expect(raiseProgressMonotonic(0.35, 0.6)).toBe(0.6)
  })

  it('holds flat on an unchanged candidate', () => {
    expect(raiseProgressMonotonic(0.45, 0.45)).toBe(0.45)
  })

  it('never decreases across a falling-context sequence', () => {
    const candidates = [0.1, 0.15, 0.7, 0.2, 0.25, 0.65, 0.3]
    let shown = 0
    const shownSeries: number[] = []
    for (const c of candidates) {
      shown = raiseProgressMonotonic(c, shown)
      shownSeries.push(shown)
    }
    expect(shownSeries).toEqual([0.1, 0.15, 0.7, 0.7, 0.7, 0.7, 0.7])
    let previous = 0
    for (const value of shownSeries) {
      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
  })

  it('treats a corrupt stored floor as no floor rather than poisoning the series', () => {
    expect(raiseProgressMonotonic(0.4, Number.NaN)).toBe(0.4)
  })
})
