import {
  SynthesizePreviewRequestSchema,
  SynthesizePreviewResponseSchema,
  type SynthesizePreviewRequest,
  type SynthesizePreviewResponse,
  ReworkRequestSchema,
  ReworkResponseSchema,
  type ReworkRequest,
  type ReworkResponse,
  CreateCampaignRequestSchema,
  CreateCampaignResponseSchema,
  type CreateCampaignRequest,
  type CreateCampaignResponse,
} from '@mythrun/contract/rest'
import { defineEndpoint, type ApiContext } from './endpoint.ts'

// The campaign-create slice of the data layer — the R5 backend seam for the
// guided + freeform create flow (MYT-89). Phase B (the create UI) calls ONLY
// these three imperative functions, never `fetch`: each compiles to a
// `defineEndpoint` (method + typed path + Zod request/response), so the wire
// body is contract-validated before it leaves and the response is validated on
// arrival. Mutations in this codebase are imperative (no `useX`) — like
// `register`/`createSession` — so these follow that shape, not the suspense-hook
// shape. On a non-2xx, `defineEndpoint` throws an `HttpError` carrying `.status`,
// `.code`, and the raw `.body`; this layer NEVER swallows or remaps it. The
// create UI branches on `.code` (`concept_rejected` 422 → `.body.synthesizedConcept`,
// `rework_exhausted` 409, `preview_expired` 410, `insufficient_credits` 403).

/** POST /api/campaigns/synthesize-preview — guided synthesis of the three media-picks. */
const synthesizePreviewEndpoint = defineEndpoint<
  SynthesizePreviewResponse,
  SynthesizePreviewRequest
>({
  method: 'POST',
  path: () => '/api/campaigns/synthesize-preview',
  request: SynthesizePreviewRequestSchema,
  response: SynthesizePreviewResponseSchema,
})

export function synthesizePreview(
  ctx: ApiContext,
  body: SynthesizePreviewRequest,
): Promise<SynthesizePreviewResponse> {
  return synthesizePreviewEndpoint(body, ctx)
}

// Rework needs BOTH the `previewId` (for the path) and the change-note (for the
// body). The endpoint input carries both; `ReworkRequestSchema` strips the
// `previewId` back out at serialization, so it travels in the path only.
type ReworkEndpointInput = ReworkRequest & { previewId: string }

/** POST /api/campaigns/preview/:previewId/rework — single-shot revision of a parked preview. */
const reworkPreviewEndpoint = defineEndpoint<ReworkResponse, ReworkEndpointInput>({
  method: 'POST',
  path: (input) => `/api/campaigns/preview/${encodeURIComponent(input.previewId)}/rework`,
  request: ReworkRequestSchema,
  response: ReworkResponseSchema,
})

export function reworkPreview(
  ctx: ApiContext,
  previewId: string,
  body: ReworkRequest,
): Promise<ReworkResponse> {
  return reworkPreviewEndpoint({ ...body, previewId }, ctx)
}

/** POST /api/campaigns — commit a preview (guided) or a freeform concept into a real campaign. */
const createCampaignEndpoint = defineEndpoint<CreateCampaignResponse, CreateCampaignRequest>({
  method: 'POST',
  path: () => '/api/campaigns',
  request: CreateCampaignRequestSchema,
  response: CreateCampaignResponseSchema,
})

export function createCampaign(
  ctx: ApiContext,
  body: CreateCampaignRequest,
): Promise<CreateCampaignResponse> {
  return createCampaignEndpoint(body, ctx)
}
