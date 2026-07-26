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

import { FT_USABLE_CONTEXT_TOKENS } from './ft-config.js'
import { SESSION_TOKEN_BUDGET } from './st-config.js'

/**
 * The display quantum. A combat-heavy turn burns tokens several times faster
 * than a quiet one, and a number that lurches turn-to-turn reads as broken
 * rather than informative — so the fraction is bucketed rather than exact.
 */
export const PROGRESS_STEP = 0.05

/** The two mechanical counters the fraction is derived from. */
export interface ProgressInputs {
  /** Cumulative session token spend (every tier, whole session). Monotonic by
   *  construction — the counters only ever accumulate. */
  readonly cumulativeTokens: number
  /** The LATEST turn's FT input tokens — the final tool-loop step's prompt,
   *  which is the largest one and therefore the honest context-fill measure.
   *  NOT monotonic: a terse turn after a combat burst legitimately reports
   *  fewer than the turn before it. */
  readonly contextTokens: number
}

/** One ceiling's share, clamped to [0, 1]. A non-finite or negative counter
 *  reads as 0 rather than propagating NaN onto the wire. */
function ratio(used: number, ceiling: number): number {
  if (!Number.isFinite(used) || used <= 0) return 0
  return Math.min(used / ceiling, 1)
}

/**
 * The raw progress fraction: the MAX of the mechanical ceilings, bucketed to
 * PROGRESS_STEP.
 *
 * Max, not sum or average, because the session ends when ANY ceiling is
 * reached — whichever is nearer is the one the player is actually up against:
 *
 *   - token budget: cumulative spend / SESSION_TOKEN_BUDGET (the §3.11 bound
 *     proxy, the one the cliff enforces today)
 *   - context fill: the latest turn's FT input / FT_USABLE_CONTEXT_TOKENS (the
 *     real bound — the FT re-sends the whole transcript with no compaction, so
 *     a long session runs out of window whatever the spend says)
 *
 * NOT monotonic on its own: the context term can fall. Fold the result through
 * `raiseProgressMonotonic` against the session's stored floor before it ships.
 */
export function computeProgressFraction(inputs: ProgressInputs): number {
  const raw = Math.max(
    ratio(inputs.cumulativeTokens, SESSION_TOKEN_BUDGET),
    ratio(inputs.contextTokens, FT_USABLE_CONTEXT_TOKENS),
  )
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
