// backend/src/contract/pipeline-jobs.ts
//
// Declarative list of BullMQ job names. Dev-tool coverage manifest
// requires every entry have a corresponding job processor + dev-tool
// driver (or an explicit exempt entry).

export const PIPELINE_JOBS: readonly string[] = ['world-gen'] as const

export type PipelineJob = (typeof PIPELINE_JOBS)[number]
