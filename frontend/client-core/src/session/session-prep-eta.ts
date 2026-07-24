import type { StageTiming } from '@mythrun/contract/rest'

// The session-prep countdown baseline (MYT-102 loading revamp) — the coarse
// wall-clock estimate behind the between-sessions "the DM is preparing the next
// session" hold. It feeds the SAME `waitDisplay` brain as the world-gen and
// character surfaces, but the input is different by necessity:
//
// Session prep is a SINGLE pipeline stage (`session-prep:<sessionNumber>`; see
// backend/src/llm/prep/session-prep-processor.ts) and the prep-status channel
// only surfaces a coarse `generating → ready/failed` lifecycle to the client — NO
// per-stage completion signals. So there is nothing to re-estimate adaptively
// against (unlike `remainingOverSlice`, which subtracts elapsed per running
// stage). The honest fallback (research "path b") is a coarse countdown from the
// HISTORICAL prep-duration baseline minus elapsed wall-clock, degrading to no
// number (then the stalled handoff) when there is no history.
//
// The baseline: the stage string embeds the session number, so the global
// timings aggregate is fragmented across `session-prep:1`, `session-prep:2`, …
// (each a per-session-number average across campaigns). Averaging those rows
// gives a single "typical prep duration" — coarse by design, which is all the
// minute-granular display needs. Pure + DOM-free (the web surface owns the tick).

/** The pipeline stage-string prefix session prep writes (`session-prep:<n>`). A
 *  string mirror of `session-prep-processor.ts`, kept honest by the test above
 *  (the SUBCLASS_LEVEL precedent — the contract layer never imports from llm/). */
export const SESSION_PREP_STAGE_PREFIX = 'session-prep:'

/**
 * The remaining visible session-prep wait (ms) at `nowMs`, or `null` when there
 * is no usable history. The baseline is the average of the `session-prep:*`
 * timing rows with a positive average; the remaining wait is that baseline minus
 * the elapsed wall-clock since `startedAtMs` (clamped at 0 — an overrun HOLDS at
 * 0, which `waitDisplay` reads as the stalled/"taking longer than usual"
 * boundary, never a negative or a dead 0:00).
 *
 * `startedAtMs` is the surface's best origin for "prep began" — in practice the
 * moment the player enters the waiting hold. Prep may have started slightly
 * earlier server-side (no prep-started timestamp reaches the client), so the
 * estimate errs LONG — the safe direction (the wait finishes early).
 */
export function remainingSessionPrepWaitMs(
  timings: readonly StageTiming[] | null,
  startedAtMs: number,
  nowMs: number,
): number | null {
  if (timings === null) return null
  const preps = timings.filter(
    (tm) => tm.stage.startsWith(SESSION_PREP_STAGE_PREFIX) && tm.avgMs > 0,
  )
  if (preps.length === 0) return null
  const baseline = preps.reduce((sum, tm) => sum + tm.avgMs, 0) / preps.length
  const elapsed = Math.max(0, nowMs - startedAtMs)
  return Math.max(0, baseline - elapsed)
}
