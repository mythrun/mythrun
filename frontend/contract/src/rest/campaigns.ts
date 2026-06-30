// REST response contract for the campaign-hub (`GET /api/campaigns/mine`)
// endpoint.
//
// `CampaignSummarySchema` models the WIRE shape of one campaign card on the
// home hub. MYT-87 T11 widened it from the bare campaign row to the full
// hub-card payload the frontend renders (world identity, party roster, the
// per-viewer `cardPhase`, session activity). Two design points carry over from
// the /me schema:
//
//  1. WIRE shape ≠ domain type. `createdAt` / `updatedAt` / `lastPlayedAt` are
//     `Date` on the backend rows but serialize to ISO strings over JSON, so the
//     schema types them `z.iso.datetime()` (a raw `Date` is REJECTED).
//
//  2. Projection. The summary OMITS `sourceWorldId` and `createdBy`, and never
//     carries the avatar pigment (the frontend derives that from the world id
//     via `avatarColorFor`). The backend handler maps each row to this narrowed
//     shape explicitly (typed against `MyCampaignsResponse`).
import { z } from 'zod'
import { WorldColorPairSchema } from './world-color.js'

// The viewer-relative hub-card state. A *per-viewer* projection (distinct from
// the global pipeline phase): it answers "what does THIS player's card say
// right now?", which depends on whether the viewer has a character and whether
// the whole party is ready. Mirror of the backend `CardPhase` union in
// `backend/src/sse/derive-phase.ts` (the two are structurally identical so the
// backend's `deriveCardPhase` output maps straight onto this field). Defined
// here in the zod-only contract so the frontend hub renders against it without
// a backend import.
export const CARD_PHASES = [
  'generating',
  'failed',
  'needs-character',
  'waiting-for-players',
  'not-played',
  'played',
] as const

export const CardPhaseSchema = z.enum(CARD_PHASES)
export type CardPhase = z.infer<typeof CardPhaseSchema>

// One roster entry on a hub card. `hasCharacter` is the per-member readiness
// bit (a `campaign_characters` row exists for the member) the card uses to
// render the party's "who's still building" state.
export const HubPartyMemberSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  hasCharacter: z.boolean(),
})
export type HubPartyMember = z.infer<typeof HubPartyMemberSchema>

export const CampaignSummarySchema = z.object({
  id: z.string(),
  worldId: z.string(),
  name: z.string(),
  status: z.enum(['setup', 'active', 'archived', 'failed']),
  language: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  // MYT-87 T11 hub-card fields.
  worldName: z.string(),
  // The world's two-stop dither identity, or null when the world hasn't been
  // colored yet (frontend renders a neutral ghost band). A persisted pair is
  // validated against the curated WorldColor set — an excluded/unknown color
  // collapses to null at the read boundary.
  worldColors: WorldColorPairSchema.nullable(),
  // The world creator's display name when the viewer did NOT create it (a
  // shared/joined campaign), else null (the viewer owns it).
  creator: z.string().nullable(),
  party: z.array(HubPartyMemberSchema),
  sessionCount: z.number().int().nonnegative(),
  lastPlayedAt: z.iso.datetime().nullable(),
  cardPhase: CardPhaseSchema,
})

export type CampaignSummary = z.infer<typeof CampaignSummarySchema>

export const MyCampaignsResponseSchema = z.object({
  campaigns: z.array(CampaignSummarySchema),
})

export type MyCampaignsResponse = z.infer<typeof MyCampaignsResponseSchema>
