import { describe, expect, it } from 'vitest'
import { clampEtaMonotonic } from '../monotonic-eta.ts'

// clampEtaMonotonic (ux-run2 myth-uz1bn) — the cross-view monotonic-ETA fold. A
// time-remaining number has exactly one job: to be monotonically non-increasing.
// The raw adaptive estimate can rise — a failed stage re-enters `running` (its
// average re-joins the sum), clock skew shrinks elapsed-in-stage, or a surface
// swap re-derives against a different live snapshot — and every one of those
// rises told the run-2 player, correctly, that the number was fictional. The
// fold pins the display: shown = min(newEstimate, lastShown), full stop. The
// consumer holds `lastShown` across view transitions (the calm wait and the
// live map read the SAME folded value), so a phase boundary can never reset the
// countdown upward.

const MIN = 60_000

describe('clampEtaMonotonic — eta = min(newEstimate, lastShown)', () => {
  it('passes the candidate through on the first fold (no last shown yet)', () => {
    expect(clampEtaMonotonic(8 * MIN, null)).toBe(8 * MIN)
  })

  it('follows the estimate down', () => {
    expect(clampEtaMonotonic(3 * MIN, 4 * MIN)).toBe(3 * MIN)
  })

  it('HOLDS at the last shown value when the raw estimate rises (the phase-boundary jump)', () => {
    // The run-2 defect: "Under a minute remaining" → view swap → "8 min". The
    // fold caps the fresh 8-minute derivation at the sub-minute value already
    // shown; the display may hold, never climb.
    expect(clampEtaMonotonic(8 * MIN, 50_000)).toBe(50_000)
  })

  it('holds across a mid-wait recalibration bump (a re-running stage re-adds its average)', () => {
    expect(clampEtaMonotonic(5 * MIN, 2 * MIN)).toBe(2 * MIN)
  })

  it('lets exhaustion through (0 is non-increasing; the stalled handoff keys off it)', () => {
    expect(clampEtaMonotonic(0, 30_000)).toBe(0)
  })

  it('yields null while there is no usable estimate (cold start stays hidden, never a fake number)', () => {
    expect(clampEtaMonotonic(null, null)).toBeNull()
  })

  it('yields null when the estimate degrades to null even after a number was shown (never resurrects a stale number)', () => {
    expect(clampEtaMonotonic(null, 2 * MIN)).toBeNull()
  })
})
