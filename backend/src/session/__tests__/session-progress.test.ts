import { describe, expect, it } from 'vitest'

import { FT_USABLE_CONTEXT_TOKENS } from '../ft-config.js'
import { SESSION_TOKEN_BUDGET } from '../st-config.js'
import {
  PROGRESS_STEP,
  computeProgressFraction,
  raiseProgressMonotonic,
} from '../session-progress.js'

describe('computeProgressFraction — max of the mechanical ceilings', () => {
  it('is 0 for a session that has burned nothing', () => {
    expect(computeProgressFraction({ cumulativeTokens: 0, contextTokens: 0 })).toBe(0)
  })

  it('takes the TOKEN-BUDGET ceiling when it is the nearer one', () => {
    // Half the budget; context fill deliberately negligible.
    expect(
      computeProgressFraction({
        cumulativeTokens: SESSION_TOKEN_BUDGET / 2,
        contextTokens: 0,
      }),
    ).toBe(0.5)
  })

  it('takes the CONTEXT-FILL ceiling when it is the nearer one', () => {
    // A single enormous turn: 60% of the usable window, but almost no
    // cumulative spend. The session still ends when the window fills, so the
    // context term must win.
    expect(
      computeProgressFraction({
        cumulativeTokens: 0,
        contextTokens: FT_USABLE_CONTEXT_TOKENS * 0.6,
      }),
    ).toBe(0.6)
  })

  it('picks the MAX, not the sum, when both terms are live', () => {
    expect(
      computeProgressFraction({
        cumulativeTokens: SESSION_TOKEN_BUDGET * 0.4,
        contextTokens: FT_USABLE_CONTEXT_TOKENS * 0.75,
      }),
    ).toBe(0.75)
  })

  it('clamps at 1 when a ceiling is overshot', () => {
    expect(
      computeProgressFraction({
        cumulativeTokens: SESSION_TOKEN_BUDGET * 3,
        contextTokens: 0,
      }),
    ).toBe(1)
    expect(
      computeProgressFraction({
        cumulativeTokens: 0,
        contextTokens: FT_USABLE_CONTEXT_TOKENS * 9,
      }),
    ).toBe(1)
  })

  it('floors at 0 rather than emitting a negative fraction', () => {
    // Defensive: a garbage/negative counter must not read as "below empty".
    expect(computeProgressFraction({ cumulativeTokens: -5_000, contextTokens: -1 })).toBe(0)
  })

  it('treats a non-finite counter as EMPTY, not full', () => {
    // A corrupt counter is garbage, not a reading. It must floor at 0 rather
    // than saturate: the monotonic floor makes a spurious 1.0 PERMANENT for
    // the rest of the session, so over-reading is the unrecoverable failure
    // and under-reading self-heals on the next honest turn.
    expect(computeProgressFraction({ cumulativeTokens: Number.NaN, contextTokens: 0 })).toBe(0)
    expect(
      computeProgressFraction({ cumulativeTokens: 0, contextTokens: Number.POSITIVE_INFINITY }),
    ).toBe(0)
  })
})

describe('computeProgressFraction — COARSE (0.05 buckets)', () => {
  it('rounds to the nearest 0.05 bucket', () => {
    // 0.5199… of the budget rounds DOWN to 0.50; 0.53 rounds UP to 0.55.
    expect(
      computeProgressFraction({
        cumulativeTokens: Math.round(SESSION_TOKEN_BUDGET * 0.5199),
        contextTokens: 0,
      }),
    ).toBe(0.5)
    expect(
      computeProgressFraction({
        cumulativeTokens: Math.round(SESSION_TOKEN_BUDGET * 0.53),
        contextTokens: 0,
      }),
    ).toBe(0.55)
  })

  it('emits exact 0.05 multiples — no float dust on the wire', () => {
    // Math.round(x * 20) / 20 rather than Math.round(x / 0.05) * 0.05: the
    // latter yields 0.35000000000000003 and ships it as JSON.
    for (let bucket = 0; bucket <= 20; bucket++) {
      const fraction = computeProgressFraction({
        cumulativeTokens: Math.round(SESSION_TOKEN_BUDGET * (bucket / 20)),
        contextTokens: 0,
      })
      expect(JSON.stringify(fraction)).toBe(String(bucket / 20))
    }
  })

  it('never emits a value off the 0.05 grid', () => {
    for (let i = 0; i < 200; i++) {
      const fraction = computeProgressFraction({
        cumulativeTokens: Math.round(SESSION_TOKEN_BUDGET * (i / 199)),
        contextTokens: Math.round(FT_USABLE_CONTEXT_TOKENS * ((200 - i) / 199)),
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
    // The context term legitimately falls (a terse turn after a combat burst).
    // The max-of-both is therefore NOT monotonic on its own; the floor is.
    expect(raiseProgressMonotonic(0.35, 0.6)).toBe(0.6)
  })

  it('holds flat on an unchanged candidate', () => {
    expect(raiseProgressMonotonic(0.45, 0.45)).toBe(0.45)
  })

  it('never decreases across a falling-context sequence', () => {
    // A real shape: budget creeps up, context spikes then collapses.
    const candidates = [0.1, 0.15, 0.7, 0.2, 0.25, 0.65, 0.3]
    let shown = 0
    const shownSeries: number[] = []
    for (const c of candidates) {
      shown = raiseProgressMonotonic(c, shown)
      shownSeries.push(shown)
    }
    expect(shownSeries).toEqual([0.1, 0.15, 0.7, 0.7, 0.7, 0.7, 0.7])
    // Iterated (not indexed) so each element is a plain `number` — indexing
    // under noUncheckedIndexedAccess forces an assertion the lint config bans
    // in both of its spellings.
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
