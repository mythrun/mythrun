// Declarative list of prep-pipeline SSE event types emitted by the
// worker via redisRealtime and forwarded to clients on the
// /api/{worlds,campaigns}/:id/status/stream routes. The ship-gate check
// requires every entry to have corresponding dev-tool coverage.
//
// Seeds empty. Events accumulate as MYT-50 (status surface) and MYT-52
// (entity events) land them.
export const PIPELINE_SSE_EVENTS: readonly string[] = [] as const

export type PipelineSseEvent = (typeof PIPELINE_SSE_EVENTS)[number]
