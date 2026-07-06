import { StageTimingsResponseSchema, type StageTimingsResponse } from '@mythrun/contract/rest'
import { defineEndpoint, type ApiContext } from './endpoint.ts'

// World-gen ETA timings (MYT-89 audit ③) — the historical per-stage average
// durations the generation loading bar turns into a data-driven "time left".
// GET /api/worldgen/stage-timings returns `{ stage, avgMs }[]` aggregated across
// ALL completed world-gen runs; it is NOT campaign-scoped (a global history) and
// NOT stage-filtered (the caller intersects with WORLD_GEN_STAGES). Cold-start
// (no completed history) → `[]`, and the caller degrades to no estimate.

const getStageTimingsEndpoint = defineEndpoint<StageTimingsResponse>({
  method: 'GET',
  path: () => '/api/worldgen/stage-timings',
  response: StageTimingsResponseSchema,
})

/** Fetch the historical per-stage average durations (ms). `[]` on cold-start;
 *  the world-gen loading bar computes a rough remaining time from this + the
 *  live stage statuses (see `remainingStageMs`). */
export function getStageTimings(ctx: ApiContext): Promise<StageTimingsResponse> {
  return getStageTimingsEndpoint(undefined, ctx)
}
