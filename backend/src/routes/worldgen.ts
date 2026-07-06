// backend/src/routes/worldgen.ts
//
// MYT-89 audit ③ — GET /api/worldgen/stage-timings.
//
// A global, non-campaign-scoped read: the historical average duration (ms) per
// world-gen pipeline stage, aggregated across ALL completed pipeline_runs. The
// generation status card fetches this ONCE at generation start to render a
// data-driven "time left" on the fixed-count loading bar; it intersects the
// response with the WORLD_GEN_STAGES taxonomy (@mythrun/contract/events).
//
// Response: `StageTiming[]` (= `{ stage: string; avgMs: number }[]`, the
// @mythrun/contract/rest wire shape). Cold-start (no completed history) → `[]`;
// the card degrades gracefully and shows no estimate.
//
// Auth: DEFAULT chain (JWT + requireOnboarded). No `config.auth` opt-out and no
// per-campaign preHandler — it's non-sensitive aggregate telemetry with no user
// or campaign scope, but still requires an onboarded caller like every other
// /api/* app read. The ETA query goes through the repository layer
// (repo.pipelineRuns.avgDurationPerStage) — no raw SQL in this handler.

import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'
import type { StageTimingsResponse } from '@mythrun/contract/rest'
import { createPipelineRunsRepo } from '../repo/pipeline-runs.js'

export interface WorldgenRoutesOpts {
  readonly pool: Pool
}

// FastifyPluginAsync requires an async function shape; the body is synchronous
// (a single app.get registration), matching the precedent in dev-api-cost.ts.
// eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync shape; no top-level await.
export const worldgenRoutes: FastifyPluginAsync<WorldgenRoutesOpts> = async (app, opts) => {
  const pipelineRuns = createPipelineRunsRepo(opts.pool)

  app.get(
    '/api/worldgen/stage-timings',
    {
      config: {
        // Fetched once per generation (not polled); 60/min is generous headroom
        // per authenticated caller (inherits the global per-sub keyGenerator).
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (_request, reply): Promise<StageTimingsResponse> => {
      const timings = await pipelineRuns.avgDurationPerStage()
      return reply.send(timings)
    },
  )
}
