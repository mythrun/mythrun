// REST response contract for the world-gen ETA endpoint
// (`GET /api/worldgen/stage-timings`). MYT-89 audit ③: the generation loading
// bar wants a data-driven "time left", so the endpoint returns the historical
// average duration (ms) per pipeline stage, aggregated across ALL completed
// world-gen runs (see repo.pipelineRuns.avgDurationPerStage).
//
// Shape: a bare JSON array of `{ stage, avgMs }`. `stage` is the raw
// pipeline_runs.stage name (a WorldGenStage for the loading bar's purposes, but
// typed `string` here because the query is not stage-filtered — the FE
// intersects the response with WORLD_GEN_STAGES). `avgMs` is a non-negative
// integer (Postgres `::int` cast; `avg(...)` over positive durations).
//
// Cold-start (no completed history) → `[]`; the FE degrades gracefully and
// shows no estimate. The endpoint never invents timings for unseen stages.
import { z } from 'zod'

export const StageTimingSchema = z.object({
  stage: z.string(),
  avgMs: z.number().int().nonnegative(),
})
export type StageTiming = z.infer<typeof StageTimingSchema>

export const StageTimingsResponseSchema = z.array(StageTimingSchema)
export type StageTimingsResponse = z.infer<typeof StageTimingsResponseSchema>
