import { WATCHED_STAGES, type StageProgress } from '@mythrun/contract/events'
import type { StageTiming } from '@mythrun/contract/rest'

// The data-driven world-gen COUNTDOWN (MYT-89 audit ③ + the waiting-feedback
// upgrade): the remaining visible wait at `nowMs`, computed from the historical
// per-stage averages (`getStageTimings`) intersected with the live stage
// statuses. Pure + DOM-free (the brain owns the math; the web view owns the
// 1-second tick and formats the ms into an i18n'd `~M:SS` label).

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
  if (timings === null || timings.length === 0) return null
  const avgByStage = new Map(timings.map((tm) => [tm.stage, Math.max(0, tm.avgMs)]))
  const liveByStage = new Map(stages.map((s) => [s.stage, s]))
  let remaining = 0
  for (const stage of WATCHED_STAGES) {
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
