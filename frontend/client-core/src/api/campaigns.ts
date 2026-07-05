import { useSuspenseQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { MyCampaignsResponseSchema, type MyCampaignsResponse } from '@mythrun/contract/rest'
import { defineEndpoint, type ApiContext } from './endpoint.ts'
import { useApiContext } from './client-context.tsx'

// The campaign-scoped slice of the data layer. `getMyCampaigns` is the
// declarative endpoint (GET /api/campaigns/mine, response validated against the
// contract's `MyCampaignsResponseSchema`); `useMyCampaigns` is the thin
// TanStack-suspense hook the home hub renders against — same wiring shape as
// `useMe`: read the `ApiContext`, hand the endpoint to `useSuspenseQuery`.

export const getMyCampaigns = defineEndpoint<MyCampaignsResponse>({
  method: 'GET',
  path: () => '/api/campaigns/mine',
  response: MyCampaignsResponseSchema,
})

export function useMyCampaigns() {
  const ctx = useApiContext()
  return useSuspenseQuery({
    queryKey: ['campaigns', 'mine'],
    queryFn: () => getMyCampaigns(undefined, ctx),
  })
}

// -----------------------------------------------------------------------------
// World-gen graph rehydration + resume (MYT-89 Phase C, C5).
//
// Two imperative endpoints the `useWorldGenStream` hook calls OUTSIDE
// react-query: the point-in-time world snapshot (seeds the graph on a
// mid-generation mount) and the resume trigger (the failure-recovery branch).
//
// The snapshot schema is a FOCUSED projection — the graph only consumes
// entities + relationships. Zod's `object()` strips unknown keys, so the
// endpoint's richer payload (world summary, facts, prose kernels, stat blocks,
// hierarchy) passes validation and drops away without a schema churn every time
// the backend view grows a column.
// -----------------------------------------------------------------------------

/** The graph-relevant slice of GET /api/campaigns/:campaignId/world-snapshot. */
const WorldGenSnapshotSchema = z.object({
  entities: z.array(
    z.object({
      id: z.string(),
      entityType: z.string(),
      name: z.string(),
    }),
  ),
  relationships: z.array(
    z.object({
      sourceEntityId: z.string(),
      targetEntityId: z.string(),
      relationshipType: z.string(),
    }),
  ),
})

export type WorldGenSnapshot = z.infer<typeof WorldGenSnapshotSchema>

const getWorldSnapshotEndpoint = defineEndpoint<WorldGenSnapshot, { campaignId: string }>({
  method: 'GET',
  path: (input) => `/api/campaigns/${encodeURIComponent(input.campaignId)}/world-snapshot`,
  response: WorldGenSnapshotSchema,
})

/** Owner-only. 409 `snapshot_not_ready` until stage 4 (entity_relationships)
 *  commits → the caller (`useWorldGenStream`) gates the fetch on
 *  `phase >= world_snapshot_ready` and swallows a race-window 409. */
export function getWorldSnapshot(ctx: ApiContext, campaignId: string): Promise<WorldGenSnapshot> {
  return getWorldSnapshotEndpoint({ campaignId }, ctx)
}

/** The POST /api/campaigns/:campaignId/resume 202 body. A terminal code (409
 *  `world_gen_capped` / `phase_not_yet_implementable`) throws `HttpError`
 *  instead — the hook branches on resolve-vs-throw. */
const ResumeResultSchema = z.object({
  campaignId: z.string(),
  action: z.string(),
})

export type ResumeResult = z.infer<typeof ResumeResultSchema>

const resumeGenerationEndpoint = defineEndpoint<ResumeResult, { campaignId: string }>({
  method: 'POST',
  path: (input) => `/api/campaigns/${encodeURIComponent(input.campaignId)}/resume`,
  response: ResumeResultSchema,
})

/** Owner-only. Re-enqueues a failed world-gen job (202) or throws `HttpError`
 *  on a terminal / non-resumable state. */
export function resumeGeneration(ctx: ApiContext, campaignId: string): Promise<ResumeResult> {
  return resumeGenerationEndpoint({ campaignId }, ctx)
}
