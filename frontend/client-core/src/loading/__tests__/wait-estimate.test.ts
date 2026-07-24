import { describe, expect, it } from 'vitest'
import { coarseWaitBucket, waitDisplay } from '../wait-estimate.ts'

// wait-estimate (MYT-102 loading revamp) — the SHARED display decision behind the
// waiting surfaces (character-loading + world-gen). It sits on top of the adaptive
// `remainingOverSlice` ms estimate (worldgen/stage-eta.ts) and answers the two
// questions the old per-second `~M:SS` countdown got wrong:
//   1. HOW to show a live estimate — coarsely (minute-granular, never a ticking
//      `0:24`; false precision + the per-second churn are the anti-patterns).
//   2. WHEN to STOP showing a number — the instant the estimate exhausts (the
//      running stage overran, remaining clamped to 0) the surface must transition
//      to an indeterminate "still working" state, never sit at a dead `0:00`.
// Pure + DOM-free (no i18n, no clock) — the web layer owns the tick, the copy, and
// which of the three display kinds each surface renders.

const MIN = 60_000

describe('coarseWaitBucket — minute-granular, no false-precision seconds', () => {
  it('buckets sub-minute waits to "under a minute" (no ticking seconds)', () => {
    expect(coarseWaitBucket(1)).toEqual({ kind: 'under-minute' })
    expect(coarseWaitBucket(30_000)).toEqual({ kind: 'under-minute' })
    expect(coarseWaitBucket(59_999)).toEqual({ kind: 'under-minute' })
  })

  it('buckets a full minute and up to whole-minute counts', () => {
    expect(coarseWaitBucket(MIN)).toEqual({ kind: 'minutes', count: 1 })
    expect(coarseWaitBucket(2 * MIN)).toEqual({ kind: 'minutes', count: 2 })
    expect(coarseWaitBucket(9 * MIN)).toEqual({ kind: 'minutes', count: 9 })
  })

  it('rounds to the nearest whole minute (biasing the boundary up = safe over-promise)', () => {
    expect(coarseWaitBucket(89_000)).toEqual({ kind: 'minutes', count: 1 }) // 1.48 → 1
    expect(coarseWaitBucket(90_000)).toEqual({ kind: 'minutes', count: 2 }) // 1.5 → 2
    expect(coarseWaitBucket(150_000)).toEqual({ kind: 'minutes', count: 3 }) // 2.5 → 3
  })

  it('never reports 0 min — the floor is 1 min once past the sub-minute bucket', () => {
    // 60_000 rounds to 1, not 0; a defensive floor keeps any edge input honest.
    expect(coarseWaitBucket(MIN)).toEqual({ kind: 'minutes', count: 1 })
  })
})

describe('waitDisplay — estimate vs stalled vs hidden', () => {
  const base = { elapsedMs: 0, noHistoryStallMs: 120_000 }

  it('shows a coarse estimate while the wait is comfortably positive', () => {
    expect(waitDisplay({ ...base, remainingMs: 3 * MIN })).toEqual({
      kind: 'estimate',
      bucket: { kind: 'minutes', count: 3 },
    })
    expect(waitDisplay({ ...base, remainingMs: 20_000 })).toEqual({
      kind: 'estimate',
      bucket: { kind: 'under-minute' },
    })
  })

  it('transitions to STALLED the instant the estimate exhausts (never a dead 0:00)', () => {
    // The overrunning running stage clamps `remainingMs` to 0 — the exact
    // dead-zero the old countdown sat on. It must read as indeterminate instead.
    expect(waitDisplay({ ...base, remainingMs: 0 })).toEqual({ kind: 'stalled' })
    expect(waitDisplay({ ...base, remainingMs: -5_000 })).toEqual({ kind: 'stalled' })
  })

  it('HIDES (shows nothing) on cold-start with no usable history, before the stall window', () => {
    expect(waitDisplay({ ...base, remainingMs: null, elapsedMs: 0 })).toEqual({ kind: 'hidden' })
    expect(waitDisplay({ ...base, remainingMs: null, elapsedMs: 119_000 })).toEqual({
      kind: 'hidden',
    })
  })

  it('with no history, stalls once elapsed passes the no-history window (reassurance without a fake number)', () => {
    expect(waitDisplay({ ...base, remainingMs: null, elapsedMs: 120_000 })).toEqual({
      kind: 'stalled',
    })
    expect(waitDisplay({ ...base, remainingMs: null, elapsedMs: 300_000 })).toEqual({
      kind: 'stalled',
    })
  })

  it('never stalls on no-history when the window is Infinity (world-gen: the flavor cycle carries liveness)', () => {
    // World-gen degrades a null/exhausted estimate to "omit the countdown" — its
    // spinner + flavor cycle is already the indeterminate presentation — so it
    // passes an infinite no-history window and never asks for a stall line.
    expect(
      waitDisplay({ remainingMs: null, elapsedMs: 600_000, noHistoryStallMs: Number.POSITIVE_INFINITY }),
    ).toEqual({ kind: 'hidden' })
  })

  it('stalls when wall-clock blows past the initial-estimate multiple (a wedged pending stage keeps remaining positive forever)', () => {
    // A stage stuck `pending` never subtracts elapsed, so `remainingMs` holds
    // positive indefinitely — the exhaustion rule alone would never fire. The
    // wall-clock backstop (elapsed ≥ initial × multiplier) catches the hang.
    expect(
      waitDisplay({
        remainingMs: 30_000,
        elapsedMs: 200_000,
        noHistoryStallMs: 120_000,
        initialEstimateMs: 60_000,
        stallMultiplier: 3,
      }),
    ).toEqual({ kind: 'stalled' })
  })

  it('does not trip the wall-clock backstop before the multiple is reached', () => {
    expect(
      waitDisplay({
        remainingMs: 30_000,
        elapsedMs: 150_000,
        noHistoryStallMs: 120_000,
        initialEstimateMs: 60_000,
        stallMultiplier: 3,
      }),
    ).toEqual({ kind: 'estimate', bucket: { kind: 'under-minute' } })
  })

  it('ignores the wall-clock backstop when no initial estimate is supplied (world-gen)', () => {
    // World-gen never tracks an initial estimate; the backstop must be inert then.
    expect(
      waitDisplay({ remainingMs: 30_000, elapsedMs: 10_000_000, noHistoryStallMs: Number.POSITIVE_INFINITY }),
    ).toEqual({ kind: 'estimate', bucket: { kind: 'under-minute' } })
  })
})
