import {
  REVEAL_BOUNDARY_STAGE,
  TAIL_STAGES,
  type StageProgress,
} from '@mythrun/contract/events'

// The wiki-reveal timing brain (MYT-89 reveal timing) — pure, DOM-free
// predicates over the stream's folded `stages[]` (see `useWorldGenStream`).
//
// Miklos's spec: "the reveal moment happens immediately after the connections
// are made" — the reveal fires when connection-weaving (`entity_relationships`,
// the REVEAL_BOUNDARY_STAGE) completes, NOT when the whole pipeline finishes.
// The remaining stages (`TAIL_STAGES`: consolidation → embed) run silently
// while the player explores the wiki; their completions surface as quiet data
// refreshes, never as a wait.

/** TRUE once connection-weaving (the reveal-boundary stage) has COMPLETED —
 *  the generating → wiki-reveal transition signal. Keys on the folded stage
 *  status, not the SSE `phase` event, so a live `stage-completed` and a
 *  reconnect-time snapshot frame both flip it at the same moment. The worker
 *  commits the pipeline_runs row BEFORE publishing the completion event, so the
 *  world-snapshot endpoint's 409 gate (same boundary stage) has always passed
 *  by the time this returns true. */
export function connectionsDone(stages: readonly StageProgress[]): boolean {
  return stages.some((s) => s.stage === REVEAL_BOUNDARY_STAGE && s.status === 'completed')
}

const TAIL_STAGE_SET: ReadonlySet<string> = new Set(TAIL_STAGES)

/** How many silent tail stages have COMPLETED — the reveal's quiet
 *  wiki-refetch token. Monotonic over a run (stages only advance), so each
 *  tail completion bumps it exactly once and the reveal refetches its snapshot
 *  on the bump — reconciled facts (consolidated ghosts, coherence patches)
 *  appear quietly, with no spinner takeover. */
export function completedTailStageCount(stages: readonly StageProgress[]): number {
  return stages.filter((s) => TAIL_STAGE_SET.has(s.stage) && s.status === 'completed').length
}
