import { PREP_STAGES, WATCHED_STAGES, type StageProgress } from '@mythrun/contract/events'
import type { StageTiming } from '@mythrun/contract/rest'

// The data-driven world-gen COUNTDOWN (MYT-89 audit ③ + the waiting-feedback
// upgrade): the remaining visible wait at `nowMs`, computed from the historical
// per-stage averages (`getStageTimings`) intersected with the live stage
// statuses. Pure + DOM-free (the brain owns the math; the web view owns the
// 1-second tick and formats the ms into an i18n'd `~M:SS` label).
//
// TWO targets, ONE math (myth-tudy1): the SAME slice-summing derivation over two
// canonical stage slices. `remainingWaitMs` sums the WATCHED_STAGES → counts to
// the wiki REVEAL (the act-two status card). `remainingPrepWaitMs` sums the
// PREP_STAGES → counts to ARRIVING ON THE GRAPH (the act-one loading screen: the
// first entity-emitting stage's start, the watch-button beat). Both slices are
// derived from the canonical WORLD_GEN_STAGES taxonomy, so a reorder can't drift
// either target.

/**
 * The remaining VISIBLE wait (ms) at `nowMs`: the sum of historical average
 * durations for the WATCHED stages NOT yet completed, minus the time already
 * spent inside the currently-RUNNING stage. The running stage's contribution
 * clamps at 0 — an overrunning stage HOLDS the countdown at the
 * remaining-future floor rather than sinking it negative; the count drops
 * again at the next stage-completion event (jumps are fine — the number must
 * feel like progress, not be a promise). The wait ends at the wiki-reveal
 * boundary (MYT-89 reveal timing) — the silent tail stages run behind the
 * reveal and are nobody's wait, so their timings never count; this hits 0
 * exactly as the bars hit 100%. Returns `null` when there is no usable
 * history — cold-start (`[]`) or a failed fetch (`null`) — so the UI shows
 * no countdown rather than a fake ~0:00.
 *
 * Defensive by construction (the contract already parses `avgMs` as a
 * non-negative int, but this stays honest against raw / clock-skewed input):
 *   - a negative `avgMs` clamps to 0 (never subtracts from the total);
 *   - a stage with no timing contributes 0 (excluded, never crashes);
 *   - only the canonical `WATCHED_STAGES` count, so a stray non-worldgen or
 *     tail-stage row in the un-filtered response is ignored;
 *   - a running stage whose `startedAt` is null / unparseable / in the future
 *     counts as JUST-started (full average — skew never inflates the wait);
 *   - only `running` stages subtract elapsed (a failed stage re-runs, so its
 *     whole average is still ahead).
 */
export function remainingWaitMs(
  timings: readonly StageTiming[] | null,
  stages: readonly StageProgress[],
  nowMs: number,
): number | null {
  return remainingOverSlice(timings, stages, nowMs, WATCHED_STAGES)
}

/**
 * The remaining wait (ms) until ARRIVING ON THE GRAPH — the act-one loading
 * screen's countdown (myth-tudy1). Identical math to `remainingWaitMs`, summed
 * over the PREP_STAGES slice ONLY (concept_intake / world_color /
 * vocabulary_intake), so it counts down to the first entity-emitting stage's
 * start (the watch-button beat) rather than to the wiki reveal. It reaches 0
 * exactly as the first entity stage begins (all prep complete). Same honest
 * clamp/degrade semantics (a null on no history; an overrunning prep stage HOLDS
 * at the remaining-prep floor rather than sinking negative).
 */
export function remainingPrepWaitMs(
  timings: readonly StageTiming[] | null,
  stages: readonly StageProgress[],
  nowMs: number,
): number | null {
  return remainingOverSlice(timings, stages, nowMs, PREP_STAGES)
}

/**
 * The shared slice-summing core: the sum of `slice`'s un-completed stage
 * averages, minus the elapsed time inside any currently-RUNNING stage (that
 * stage's contribution clamps at 0). `null` when there is no usable history.
 * The two public entry points above differ ONLY in which canonical stage slice
 * they pass — the reveal target (WATCHED_STAGES) vs the graph-arrival target
 * (PREP_STAGES). Exported (MYT-102) so the character-creation countdown
 * (`character/creation-eta.ts`) runs the SAME math over its own per-player
 * slice instead of forking the derivation.
 */
export function remainingOverSlice(
  timings: readonly StageTiming[] | null,
  stages: readonly StageProgress[],
  nowMs: number,
  slice: readonly string[],
): number | null {
  if (timings === null || timings.length === 0) return null
  const avgByStage = new Map(timings.map((tm) => [tm.stage, Math.max(0, tm.avgMs)]))
  const liveByStage = new Map(stages.map((s) => [s.stage, s]))
  let remaining = 0
  for (const stage of slice) {
    const live = liveByStage.get(stage)
    if (live?.status === 'completed') continue
    const avg = avgByStage.get(stage) ?? 0
    remaining +=
      live?.status === 'running' ? Math.max(0, avg - elapsedInStageMs(live.startedAt, nowMs)) : avg
  }
  return remaining
}

/** Time already spent inside a running stage. A null / unparseable / future
 *  `startedAt` reads as 0 — the stage is treated as just-started, never as a
 *  NaN or a negative that would INFLATE the remaining wait. */
function elapsedInStageMs(startedAt: string | null, nowMs: number): number {
  if (startedAt === null) return 0
  const started = Date.parse(startedAt)
  if (Number.isNaN(started)) return 0
  return Math.max(0, nowMs - started)
}
