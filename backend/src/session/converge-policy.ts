// backend/src/session/converge-policy.ts
//
// myth-3jna1 — the DETERMINISTIC half of the convergence steer. Today a session
// runs at full narrative throttle until cumulative spend crosses
// SESSION_TOKEN_BUDGET and a farewell is bolted onto whatever scene happened to
// be running. The steer gives the director a stage BEFORE that cliff: once
// three quarters of the budget is spent AND the story is behind the spend, the
// ST folds a "start drawing toward a resting point" steer into its standing
// directive, so the farewell lands on a beat.
//
// Everything here is arithmetic over st-config constants — mechanical policy
// (budget caps, thresholds), ZFC-exempt, the same class as the existing
// wind-down arm. The JUDGMENT it consumes (how far through the prep's intended
// arc the table actually is) is a Haiku call, llm/st-narrative-progress.ts.
// Nothing in this file reads prose.
//
// SECRET-SIDE. Narrative progress is a judgment ABOUT the sd_playbook, so the
// number and every decision derived from it live on the ST side of the
// enforced-ignorance boundary: they reach the Fast Thinker only as the ST's own
// craft-phrased stage direction, never as a value. Nothing here is exported to
// a route, a publisher, or an FT-facing context type. The player-facing
// progress number is the MECHANICAL one and is computed elsewhere.

import {
  CONVERGE_LAG_MARGIN,
  CONVERGE_MECHANICAL_FLOOR,
  SESSION_TOKEN_BUDGET,
} from './st-config.js'

/**
 * Mechanical progress: cumulative session token spend as a fraction of the
 * budget, clamped to [0,1]. This is the "how much session is left" axis — it
 * knows nothing about the story.
 */
export function mechanicalProgress(totalUsedTokens: number): number {
  return Math.min(1, Math.max(0, totalUsedTokens / SESSION_TOKEN_BUDGET))
}

/**
 * Whether this cycle should spend a Haiku call on the narrative-progress
 * judgment. Two bounds, both about not paying for an answer we cannot use:
 *
 *  - BELOW the floor there is too much session left for a converge steer to be
 *    anything but premature, so the probe never runs (three quarters of every
 *    session costs nothing extra).
 *  - ONCE WIND-DOWN IS ACTIVE the director is already being told to close, so
 *    a converge verdict could not change what happens. `windDownActive` is
 *    passed in rather than recomputed, so this shares the caller's single
 *    wind-down expression instead of forking a second float comparison.
 */
export function shouldProbeNarrativeProgress(
  mechanical: number,
  windDownActive: boolean,
): boolean {
  return !windDownActive && mechanical >= CONVERGE_MECHANICAL_FLOOR
}

/**
 * The steer verdict: the story is behind the spend by more than the margin.
 * Strictly `<` so a lag of exactly the margin still reads as on-pace — the
 * margin exists to absorb the coarseness of a 0-1 arc judgment, not to arm the
 * steer at the boundary.
 */
export function isConverging(mechanical: number, narrative: number): boolean {
  return narrative < mechanical - CONVERGE_LAG_MARGIN
}
