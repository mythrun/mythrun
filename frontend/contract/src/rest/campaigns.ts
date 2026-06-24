// REST response contract for the campaign-list home-hub-smoke endpoint.
//
// `CampaignSummarySchema` models the WIRE shape of one campaign in the
// GET /api/campaigns/mine list. Same two design points as the /me schema:
//
//  1. WIRE shape ≠ domain type. `createdAt` / `updatedAt` are `Date` on the
//     backend `Campaign` row but serialize to ISO strings over JSON, so the
//     schema types them `z.iso.datetime()` (a raw `Date` is REJECTED).
//
//  2. Projection. The summary OMITS `sourceWorldId` and `createdBy` — the home
//     hub doesn't need them. Add them later if a flow does, rather than leaking
//     them by default. The backend handler maps each row to this narrowed shape
//     explicitly (typed against `MyCampaignsResponse`).
import { z } from 'zod'

export const CampaignSummarySchema = z.object({
  id: z.string(),
  worldId: z.string(),
  name: z.string(),
  status: z.enum(['setup', 'active', 'archived', 'failed']),
  language: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export type CampaignSummary = z.infer<typeof CampaignSummarySchema>

export const MyCampaignsResponseSchema = z.object({
  campaigns: z.array(CampaignSummarySchema),
})

export type MyCampaignsResponse = z.infer<typeof MyCampaignsResponseSchema>
