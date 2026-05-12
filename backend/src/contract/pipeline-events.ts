// Declarative list of prep-pipeline SSE event types emitted by the
// worker via redisRealtime and forwarded to clients on the
// /api/campaigns/:campaignId/status/stream route. The ship-gate check
// requires every entry to have corresponding dev-tool coverage (or an
// explicit exempt entry pointing at the downstream issue that lands
// the rendering surface).
//
// MYT-50 lands the 6 lifecycle events (phase, stage-*, cost-update,
// job-failed). The 5 entity events are listed here so MYT-51+ worker
// emissions don't have to expand the contract piecemeal; dev-tool
// coverage marks them exempt with a MYT-52 pointer.

export const PIPELINE_SSE_EVENTS: readonly string[] = [
  // Lifecycle (MYT-50 — landed):
  'phase',
  'stage-started',
  'stage-completed',
  'stage-failed',
  'cost-update',
  'job-failed',
  // Entity events (MYT-51+ publishes; MYT-52 renders in dev tool):
  'stage-reset',
  'entity-added',
  'entity-updated',
  'edge-added',
  'finalized',
] as const

export type PipelineSseEvent = (typeof PIPELINE_SSE_EVENTS)[number]

export type PipelinePhase =
  | 'not_started'
  | 'world_gen'
  | 'world_gen_failed'
  | 'world_ready'
  | 'character_creation'
  | 'post_creation'
  | 'complete'
  | 'failed'

// Discriminated-union of event payload shapes. Field naming uses
// `T | null` (not `T?`) consistently so JSON round-trips don't muddle
// snapshot fields with event payload fields.
export type PipelineEvent =
  | { type: 'phase'; phase: PipelinePhase }
  | { type: 'stage-started'; stage: string; userId: string | null; startedAt: string }
  | {
      type: 'stage-completed'
      stage: string
      userId: string | null
      durationMs: number
      costUsd: number
    }
  | {
      type: 'stage-failed'
      stage: string
      userId: string | null
      errorCode: string
      willRetry: boolean
    }
  // cost-update is ABSOLUTE (not delta); emitted only post-COMMIT.
  | { type: 'cost-update'; cumulativeUsd: number }
  | {
      type: 'job-failed'
      jobType: 'world-gen' | 'character-creation' | 'post-creation'
      errorCode: string
    }
  // Entity-event arms — MYT-51+ publishes; MYT-52 renders.
  | { type: 'stage-reset'; stage: string }
  | { type: 'entity-added'; synthKey: string; entityKind: string; data: Record<string, unknown> }
  | { type: 'entity-updated'; synthKey: string; patch: Record<string, unknown> }
  | { type: 'edge-added'; synthKey: string; from: string; to: string; relationship: string }
  | { type: 'finalized'; synthKey: string; entityId: string }
