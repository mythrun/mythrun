import { WORLD_GEN_STAGES, type StageProgress } from '@mythrun/contract/events'
import type { StageTiming } from '@mythrun/contract/rest'

// The data-driven world-gen ETA (MYT-89 audit ③): a rough "time left" the
// loading bar shows, computed from the historical per-stage averages
// (`getStageTimings`) intersected with the live stage statuses. Pure + DOM-free
// (the brain owns the math; the web view formats the ms into an i18n label).

/**
 * The rough remaining generation time (ms): the sum of historical average
 * durations for the canonical stages NOT yet completed. Returns `null` when
 * there is no usable history — cold-start (`[]`) or a failed fetch (`null`) —
 * so the UI shows the bars WITHOUT an estimate rather than a fake ~0.
 *
 * Defensive by construction (the contract already parses `avgMs` as a
 * non-negative int, but this stays honest against raw / clock-skewed input):
 *   - a negative `avgMs` clamps to 0 (never subtracts from the total);
 *   - a stage with no timing contributes 0 (excluded, never crashes);
 *   - only the 11 canonical `WORLD_GEN_STAGES` count, so a stray non-worldgen
 *     row in the un-filtered response is ignored.
 */
export function remainingStageMs(
  timings: readonly StageTiming[] | null,
  stages: readonly StageProgress[],
): number | null {
  if (timings === null || timings.length === 0) return null
  const avgByStage = new Map(timings.map((tm) => [tm.stage, Math.max(0, tm.avgMs)]))
  const completed = new Set(
    stages.filter((s) => s.status === 'completed').map((s) => s.stage),
  )
  let remaining = 0
  for (const stage of WORLD_GEN_STAGES) {
    if (completed.has(stage)) continue
    remaining += avgByStage.get(stage) ?? 0
  }
  return remaining
}
