// myth-nu0hm — the MECHANICAL session-progress signal.
//
// Before this, the session bound was a hard cliff: turn-worker summed the
// cumulative usage each turn and called `endSession` the moment it crossed
// SESSION_TOKEN_BUDGET. Nothing told the player how close they were, so an
// evening ended without warning. This module is the graduated number that
// rides `turn_end` / `session_ready` so a table can plan around the ceiling.
//
// ENFORCED IGNORANCE: this is the PLAYER-FACING number and it is purely
// mechanical — two token counters over two configured ceilings. It carries no
// plot state, no ST rationale, no narrative judgment of any kind. Nothing in
// here may ever become a function of what is *happening* in the fiction; the
// narrative side of converging on an ending is the ST's, on the secret side.
//
// ZFC-exempt: mechanical computation over configured budgets (dice-math class),
// not classification or judgment.
//
// Pure + I/O-free by design. The monotonic floor is session-scoped state the
// CALLER owns (Redis `session:{cId}:progress`) — see `raiseProgressMonotonic`.

import { SESSION_FT_CONTEXT_BUDGET } from './ft-config.js'

/**
 * The display quantum. A combat-heavy turn burns tokens several times faster
 * than a quiet one, and a number that lurches turn-to-turn reads as broken
 * rather than informative — so the fraction is bucketed rather than exact.
 */
export const PROGRESS_STEP = 0.05

/** The mechanical counter the fraction is derived from.
 *
 *  myth-zd6pn — ONE term, not two. The cumulative-spend term was removed: it
 *  metered gross tokens (cache reads included) against a ceiling calibrated
 *  before prompt caching existed, so it saturated roughly ten times too fast
 *  and ended sessions with the window ~4% full. Spend is a billing question
 *  and belongs on the billing surface, not on the session-length signal. */
export interface ProgressInputs {
  /** The LATEST turn's FT input tokens — the final tool-loop step's prompt,
   *  which is the largest one and therefore the honest context-fill measure.
   *  NOT monotonic: a terse turn after a combat burst legitimately reports
   *  fewer than the turn before it. The monotonic guarantee is applied
   *  downstream, over the published fraction. */
  readonly contextTokens: number
}

/** One ceiling's share, clamped to [0, 1]. A non-finite or negative counter
 *  reads as 0 rather than propagating NaN onto the wire. */
function ratio(used: number, ceiling: number): number {
  if (!Number.isFinite(used) || used <= 0) return 0
  return Math.min(used / ceiling, 1)
}

/**
 * The raw progress fraction: FT context fill over the session's context
 * ceiling, bucketed to PROGRESS_STEP.
 *
 * One term, because there is one bound. The FT re-sends the whole transcript
 * with no compaction, so the session ends when the window can no longer take
 * another turn, and how full the window is IS how much session is left.
 *
 * NOT monotonic on its own: the context term falls on a terse turn. Fold the
 * result through `raiseProgressMonotonic` against the session's stored floor
 * before it ships.
 */
export function computeProgressFraction(inputs: ProgressInputs): number {
  const raw = ratio(inputs.contextTokens, SESSION_FT_CONTEXT_BUDGET)
  // `Math.round(raw * 20) / 20`, NOT `Math.round(raw / STEP) * STEP` — the
  // latter lands on 0.35000000000000003 for bucket 7 and ships that as JSON.
  // Dividing by the integer bucket count yields the canonical double.
  return Math.round(raw / PROGRESS_STEP) / (1 / PROGRESS_STEP)
}

/**
 * The monotonic fold: the fraction to show now, given the fresh candidate and
 * the session's floor. `max` of the two — a progress bar that walks backwards
 * destroys trust in the number, and once a player has been told the session is
 * 60% spent, telling them 35% next turn is worse than telling them nothing.
 *
 * The mirror image of `clampEtaMonotonic` in
 * frontend/client-core/src/loading/monotonic-eta.ts, which pins a FALLING
 * countdown with `min`. Same discipline, inverted: this value rises.
 *
 * A non-finite floor (a corrupt Redis value) is treated as no floor, so one bad
 * write can't pin the series at NaN for the rest of the session.
 */
export function raiseProgressMonotonic(candidate: number, lastShown: number): number {
  if (!Number.isFinite(lastShown)) return candidate
  return Math.max(candidate, lastShown)
}
