import type { WaitBucket } from './wait-estimate.ts'

// The DISPLAY damper over the coarse ETA bucket (ux-run3 myth-b965d). Run 3's
// wait critic: the calm-wait estimate shed 2 minutes in 45 seconds — every
// re-estimate surfaced at once, so the number read as nervous guessing, not
// something observed. This fold pins the display's cadence on top of the
// monotonic clamp (which pins its DIRECTION — see monotonic-eta.ts):
//
//   - the first usable estimate is adopted in full;
//   - the shown minute count only ever steps DOWN, by ONE whole minute at a
//     time, and no more often than `holdMs` (the consumer passes the whisper
//     dwell, so the number moves at most once per whisper);
//   - a risen candidate changes nothing (never up — the clamp's law).
//
// HONESTY BOUNDARY: the damper shapes only a LIVE estimate's display. The
// stalled transition (an exhausted estimate) bypasses it entirely upstream —
// damping must never keep a number on screen after the estimate dies, and a
// dead history never resurrects one (null passes through). Pure + DOM-free;
// the consuming surface holds the state in a ref for the life of the wait
// (idempotent at a fixed instant, so a StrictMode double render is safe).

/** The damper's held display state. */
export interface DampedEta {
  /** The shown coarse minute count; 0 = the under-a-minute bucket. */
  readonly minutes: number
  /** When the shown value last changed (epoch ms) — the hold clock. */
  readonly changedAtMs: number
}

/** A coarse bucket's minute count on the damper's scale (under-a-minute = 0). */
export function bucketMinutes(bucket: WaitBucket): number {
  return bucket.kind === 'minutes' ? bucket.count : 0
}

/** The damper state rendered back as the coarse bucket the copy layer formats. */
export function dampedBucket(state: DampedEta): WaitBucket {
  return state.minutes <= 0 ? { kind: 'under-minute' } : { kind: 'minutes', count: state.minutes }
}

/**
 * One fold step: the state to show now, given the fresh candidate bucket and
 * the state last shown. Returns `last` BY REFERENCE when nothing changes (the
 * idempotence a render-time ref fold needs).
 */
export function dampEta(
  candidate: WaitBucket | null,
  last: DampedEta | null,
  nowMs: number,
  holdMs: number,
): DampedEta | null {
  if (candidate === null) return null
  if (last === null) return { minutes: bucketMinutes(candidate), changedAtMs: nowMs }
  if (bucketMinutes(candidate) >= last.minutes) return last
  if (nowMs - last.changedAtMs < holdMs) return last
  return { minutes: last.minutes - 1, changedAtMs: nowMs }
}
