// backend/src/contract/pipeline-jobs.ts
//
// Declarative list of BullMQ job names. Dev-tool coverage manifest
// requires every entry have a corresponding job processor + dev-tool
// driver (or an explicit exempt entry).

export const PIPELINE_JOBS: readonly string[] = [
  'world-gen',
  'character-creation',
  // MYT-54 T11: campaign-scoped character-integration job. One job per
  // campaign, owner-triggered after every player's character-creation row
  // reaches 'completed'. Processor: character-integration-processor.ts.
  'character-integration',
  // MYT-61 T3: session-prep job, enqueued by the play-runtime before a live
  // session. Processor + Worker wiring land in MYT-61 T4. No dev-tool driver
  // yet (that's MYT-62); covered via exempt entry in dev-tool/coverage.json.
  'session-prep',
] as const

export type PipelineJob = (typeof PIPELINE_JOBS)[number]
