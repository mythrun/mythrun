// The cross-view monotonic-ETA fold (ux-run2 myth-uz1bn — the run-1 carryover
// the per-view coarse buckets did not cure). A time-remaining number has exactly
// one job: to be monotonically non-increasing. The raw adaptive estimate
// (`remainingOverSlice` and kin) can legitimately RISE — a failed stage
// re-enters `running` and its average re-joins the sum, clock skew shrinks the
// elapsed-in-stage subtraction, a remount re-derives against a fresher snapshot
// — and run 2 proved what a rising countdown does: it tells the player,
// correctly, that the number is fictional ("Under a minute" → view swap →
// "8 min remaining").
//
// The fold pins the display: shown = min(newEstimate, lastShown), full stop.
// Pure + DOM-free; the consuming surface holds `lastShown` (a ref) for the LIFE
// OF THE WAIT — across internal view transitions like the calm-wait → live-map
// swap — and feeds every rendering of the countdown from the same folded value,
// so no phase boundary can reset the number upward. Holding flat is fine (an
// overrun reads as a hold, and `waitDisplay` degrades an exhausted estimate to
// the stalled presentation); climbing is the one forbidden move.

/**
 * One fold step: the value to show now, given the fresh raw estimate and the
 * value last shown. `min` of the two when both exist; the candidate alone on
 * the first usable estimate; `null` when there is no usable estimate — a dead
 * history never resurrects a stale number (the surface hides the line or shows
 * its stalled state instead).
 */
export function clampEtaMonotonic(
  candidateMs: number | null,
  lastShownMs: number | null,
): number | null {
  if (candidateMs === null) return null
  if (lastShownMs === null) return candidateMs
  return Math.min(candidateMs, lastShownMs)
}
