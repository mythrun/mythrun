import { describe, expect, it } from 'vitest'
import { coarseWaitBucket } from '../wait-estimate.ts'
import { bucketMinutes, dampEta, dampedBucket, type DampedEta } from '../eta-damping.ts'

// The display damper over the coarse ETA bucket (ux-run3 myth-b965d). Run 3's
// finding: the estimate shed 2 minutes in 45 seconds — every re-estimate showed
// at once, so the number read as nervous guessing rather than something
// observed. The damper pins the DISPLAY cadence: the shown minute count adopts
// the first usable estimate, then only ever steps DOWN, by ONE whole minute at
// most, and no more often than the hold window (the whisper dwell) — never up
// (that stays the monotonic clamp's law, upstream). Honesty is preserved
// upstream too: exhaustion (stalled) bypasses the damper entirely, so damping
// never keeps a number on screen after the estimate dies.

const HOLD = 10_000

describe('bucketMinutes / dampedBucket', () => {
  it('round-trips the coarse bucket through the minute count (0 = under a minute)', () => {
    expect(bucketMinutes({ kind: 'under-minute' })).toBe(0)
    expect(bucketMinutes({ kind: 'minutes', count: 4 })).toBe(4)
    expect(dampedBucket({ minutes: 0, changedAtMs: 0 })).toEqual({ kind: 'under-minute' })
    expect(dampedBucket({ minutes: 3, changedAtMs: 0 })).toEqual({ kind: 'minutes', count: 3 })
  })
})

describe('dampEta', () => {
  it('passes a dead estimate through (null candidate → null; damping never resurrects a number)', () => {
    expect(dampEta(null, null, 1000, HOLD)).toBeNull()
    expect(dampEta(null, { minutes: 4, changedAtMs: 0 }, 1000, HOLD)).toBeNull()
  })

  it('adopts the FIRST usable estimate fully (no walk-down from nothing)', () => {
    const state = dampEta(coarseWaitBucket(8 * 60_000), null, 5000, HOLD)
    expect(state).toEqual({ minutes: 8, changedAtMs: 5000 })
  })

  it('HOLDS within the hold window even when the candidate has dropped', () => {
    const last: DampedEta = { minutes: 8, changedAtMs: 0 }
    expect(dampEta({ kind: 'minutes', count: 5 }, last, HOLD - 1, HOLD)).toBe(last)
  })

  it('steps DOWN one whole minute per hold window — a 3-minute deficit walks 8→7→6→5', () => {
    let state: DampedEta | null = { minutes: 8, changedAtMs: 0 }
    state = dampEta({ kind: 'minutes', count: 5 }, state, HOLD, HOLD)
    expect(state?.minutes).toBe(7)
    state = dampEta({ kind: 'minutes', count: 5 }, state, 2 * HOLD, HOLD)
    expect(state?.minutes).toBe(6)
    state = dampEta({ kind: 'minutes', count: 5 }, state, 3 * HOLD, HOLD)
    expect(state?.minutes).toBe(5)
    // At the candidate: rests (no further steps).
    state = dampEta({ kind: 'minutes', count: 5 }, state, 4 * HOLD, HOLD)
    expect(state?.minutes).toBe(5)
  })

  it('NEVER steps up — a risen candidate leaves the shown value untouched', () => {
    const last: DampedEta = { minutes: 2, changedAtMs: 0 }
    expect(dampEta({ kind: 'minutes', count: 6 }, last, 5 * HOLD, HOLD)).toBe(last)
  })

  it('walks through to the under-a-minute bucket as the final step', () => {
    let state: DampedEta | null = { minutes: 1, changedAtMs: 0 }
    state = dampEta({ kind: 'under-minute' }, state, HOLD, HOLD)
    expect(state).toEqual({ minutes: 0, changedAtMs: HOLD })
    expect(dampedBucket(state ?? { minutes: 0, changedAtMs: 0 })).toEqual({ kind: 'under-minute' })
  })

  it('is idempotent at a fixed instant (safe as a render-time ref fold under StrictMode)', () => {
    const first = dampEta({ kind: 'minutes', count: 5 }, { minutes: 8, changedAtMs: 0 }, HOLD, HOLD)
    const second = dampEta({ kind: 'minutes', count: 5 }, first, HOLD, HOLD)
    expect(second).toBe(first)
  })
})
