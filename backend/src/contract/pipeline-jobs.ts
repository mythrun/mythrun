// Declarative list of prep-pipeline BullMQ job type names processed by
// the worker (backend/src/worker.ts). The ship-gate check requires every
// entry to have corresponding dev-tool coverage — exempt entries are
// permitted for jobs that fire transitively (e.g., barriers).
//
// Seeds empty. Jobs accumulate as MYT-49 (worker wiring) and MYT-50+
// (real processors) land them.
export const PIPELINE_BULLMQ_JOBS: readonly string[] = [] as const

export type PipelineBullmqJob = (typeof PIPELINE_BULLMQ_JOBS)[number]
