import { useSuspenseQuery } from '@tanstack/react-query'
import { z } from 'zod'
import {
  MyCampaignsResponseSchema,
  type MyCampaignsResponse,
  WorldSnapshotSchema,
} from '@mythrun/contract/rest'
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
// World-snapshot fetch + resume (MYT-89 Phase C, C5 / Phase D, D3).
//
// Two imperative endpoints the world-gen flow calls OUTSIDE react-query: the
// point-in-time world snapshot (seeds the graph on a mid-generation mount; feeds
// the post-gen wiki reveal) and the resume trigger (the failure-recovery branch).
//
// ONE endpoint, TWO consumers. The schema is the contract's known-tier
// `WorldSnapshotSchema` (entities + facts + entityHierarchy — the D1 wiki view
// model) WIDENED with the graph's `relationships` edges. `snapshotToSeed` (the
// graph, C5) reads entities + relationships; `toWikiViewModel` (the wiki, D3)
// reads entities + facts + entityHierarchy. The union type is a SUPERSET of the
// contract `WorldSnapshot`, so it drops straight into `toWikiViewModel`. Zod's
// `object()` strips the richer payload (world summary, prose kernels, stat
// blocks) so extra columns fall away without a schema churn. The backend view
// always emits facts + entityHierarchy as arrays (empty pre-facts), and the
// endpoint 409s until stage 4 commits, so both the mid-gen seed fetch and the
// post-gen wiki fetch validate against this shape.
// -----------------------------------------------------------------------------

/** The graph edges — the one collection the contract `WorldSnapshot` omits (it is
 *  the wiki's projection); the graph seed folds these into rendered relationships. */
const WorldGenRelationshipSchema = z.object({
  sourceEntityId: z.string(),
  targetEntityId: z.string(),
  relationshipType: z.string(),
})

/** GET /api/campaigns/:campaignId/world-snapshot as the frontend consumes it —
 *  the contract known-tier projection widened with the graph's `relationships`. */
const WorldGenSnapshotSchema = WorldSnapshotSchema.extend({
  relationships: z.array(WorldGenRelationshipSchema),
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
