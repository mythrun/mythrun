// REST request/response contract for the guided + freeform CAMPAIGN-CREATE
// flow (MYT-89). These are the frontend-facing wire schemas that the create UI
// (Phase B) and client-core (A7) build/validate against. Every bound here is
// copied verbatim from the backend Zod so the client pre-validates exactly what
// the server will accept:
//
//   - synthesize-preview + rework: `backend/src/routes/campaign-preview.ts`
//   - create:                      `backend/src/routes/campaigns.ts`
//   - the 422 rejection payload:   `backend/src/routes/concept-gate.ts`
//     (`reason` / `rejectionMessage` mirror `InputGateVerdict` in
//      `backend/src/llm/prep/input-gate.ts`).
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Synthesize-preview (POST /api/campaigns/synthesize-preview)
// ---------------------------------------------------------------------------

/**
 * One media-pick the player supplies for guided synthesis. Bounds mirror the
 * backend `SynthesizerPick` (`backend/src/llm/prep/synthesize-concept.ts`):
 * a short title and a sentence-or-two of why they like it.
 */
export const SynthesizerPickSchema = z.object({
  title: z.string().min(1).max(200),
  whyILikeIt: z.string().min(1).max(800),
})
export type SynthesizerPick = z.infer<typeof SynthesizerPickSchema>

/**
 * The synthesize-preview body: EXACTLY 3 media-picks (the guided flow always
 * carries three). A wrong count is a 400 at the backend Zod.
 */
export const SynthesizePreviewRequestSchema = z.object({
  picks: z.array(SynthesizerPickSchema).length(3),
})
export type SynthesizePreviewRequest = z.infer<typeof SynthesizePreviewRequestSchema>

/** 201 body: the opaque previewId the concept is parked under + the concept. */
export const SynthesizePreviewResponseSchema = z.object({
  previewId: z.string(),
  concept: z.string(),
})
export type SynthesizePreviewResponse = z.infer<typeof SynthesizePreviewResponseSchema>

// ---------------------------------------------------------------------------
// Rework (POST /api/campaigns/preview/:previewId/rework)
// ---------------------------------------------------------------------------

/**
 * The single-shot rework body: one freeform change note. `.max(800)` mirrors
 * the backend `ReworkBodySchema` (a change note is a sentence or two).
 */
export const ReworkRequestSchema = z.object({
  change: z.string().min(1).max(800),
})
export type ReworkRequest = z.infer<typeof ReworkRequestSchema>

/** 200 body: same shape as synthesize-preview — the (unchanged) previewId + the revised concept. */
export const ReworkResponseSchema = z.object({
  previewId: z.string(),
  concept: z.string(),
})
export type ReworkResponse = z.infer<typeof ReworkResponseSchema>

// ---------------------------------------------------------------------------
// Concept rejection (422 from synthesize-preview / rework / freeform create)
// ---------------------------------------------------------------------------

/**
 * The input-gate reject reasons — the closed set the backend `GateReason`
 * union carries (`backend/src/llm/prep/input-gate.ts`). Mirrored here so the
 * create UI can branch on the reason without a backend import.
 */
export const GATE_REASONS = ['srd_incompat', 'clone_intent', 'inappropriate'] as const
export const GateReasonSchema = z.enum(GATE_REASONS)
export type GateReason = z.infer<typeof GateReasonSchema>

/**
 * The 422 `concept_rejected` payload (`handleGateRejection` in
 * `backend/src/routes/concept-gate.ts`). Nullability matches the backend's
 * declared response type: `rejectionMessage` may be null (the model can
 * decline to author a player-facing message), and `synthesizedConcept` is
 * present ONLY on guided-mode rejections (so the player can see what was
 * judged) — freeform rejections omit it.
 */
export const ConceptRejectionSchema = z.object({
  code: z.literal('concept_rejected'),
  reason: GateReasonSchema,
  rejectionMessage: z.string().nullable(),
  synthesizedConcept: z.string().optional(),
})
export type ConceptRejection = z.infer<typeof ConceptRejectionSchema>

// ---------------------------------------------------------------------------
// Create (POST /api/campaigns)
// ---------------------------------------------------------------------------

/**
 * The freeform concept source — the player's own concept, gated at create.
 * `min(20)` keeps trivially-empty inputs out (an empty concept is a body-shape
 * bug, not a gate concern); `max(4000)` is the backend length cap.
 */
export const FreeformSourceSchema = z.object({
  mode: z.literal('freeform'),
  concept: z.string().min(20).max(4000),
})

/**
 * The guided concept source — an already-gated preview committed by its opaque
 * previewId. `z.string()` (not a uuid) keeps the backend's 400-vs-410 split
 * clean: a malformed body 400s at Zod; a well-formed-but-absent/expired
 * previewId 410s at the preview-store load.
 */
export const GuidedSourceSchema = z.object({
  mode: z.literal('guided'),
  previewId: z.string(),
})

/** The create body's `world` field: a `'new'` world from a freeform or guided source. */
export const NewWorldSchema = z.object({
  kind: z.literal('new'),
  source: z.discriminatedUnion('mode', [FreeformSourceSchema, GuidedSourceSchema]),
})

/**
 * The POST /api/campaigns request body. Mirrors the backend
 * `CreateCampaignBodySchema` (`backend/src/routes/campaigns.ts`): the world is
 * a `kind`-discriminated union (only `'new'` is functional at launch), and the
 * source is `mode`-discriminated (freeform vs guided). `devBypassAccessFilter`
 * is a dev-tool-only opt-in (gated server-side to bypass-auth ∩ dev/test); a
 * production caller never sets it.
 */
export const CreateCampaignRequestSchema = z.object({
  world: z.discriminatedUnion('kind', [NewWorldSchema]),
  devBypassAccessFilter: z.boolean().optional(),
})
export type CreateCampaignRequest = z.infer<typeof CreateCampaignRequestSchema>

/** 201 body: the created campaign's id (worldId is not a user-facing identifier). */
export const CreateCampaignResponseSchema = z.object({
  campaignId: z.string(),
})
export type CreateCampaignResponse = z.infer<typeof CreateCampaignResponseSchema>
