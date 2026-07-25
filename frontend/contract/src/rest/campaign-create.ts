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
 * The BRAINSTORM proposal body: EXACTLY 3 media-picks (that path always carries
 * three). A wrong count is a 400 at the backend Zod.
 */
export const SynthesizePicksRequestSchema = z.object({
  picks: z.array(SynthesizerPickSchema).length(3),
})

/**
 * The FREEFORM proposal body (myth-6t06f): the player's own world description.
 * Bounds mirror `FreeformSourceSchema` below — the same text that used to go
 * straight to create now buys a proposal checkpoint first.
 */
export const SynthesizeConceptRequestSchema = z.object({
  concept: z.string().min(20).max(4000),
})

/**
 * The synthesize-preview body: one of the funnel's two inputs. Both synthesize
 * into the same proposal, so the response, the SSE frames, and the proposal UI
 * are shape-identical on either path.
 */
export const SynthesizePreviewRequestSchema = z.union([
  SynthesizePicksRequestSchema,
  SynthesizeConceptRequestSchema,
])
export type SynthesizePreviewRequest = z.infer<typeof SynthesizePreviewRequestSchema>

/** 201 body: the opaque previewId the concept is parked under, the world's name
 *  (myth-z3icr — the proposal page headlines it), and the concept. */
export const SynthesizePreviewResponseSchema = z.object({
  previewId: z.string(),
  title: z.string(),
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

/** 200 body: same shape as synthesize-preview — the (unchanged) previewId + the
 *  revised title + the revised concept. */
export const ReworkResponseSchema = z.object({
  previewId: z.string(),
  title: z.string(),
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
 * present whenever the rejection lands on the standalone rejection SCREEN,
 * which needs it to show what was judged and to seed "adjust it yourself" —
 * i.e. every proposal-checkpoint rejection, on both funnel paths. The create
 * route's freeform 422 omits it: it answers the very screen the concept was
 * typed on, which still holds the text.
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
 *
 * myth-6t06f: the WEB funnel no longer commits through this arm — the freeform
 * path now synthesizes a proposal first and commits the parked preview, like
 * the brainstorm path. The arm stays for the dev tool and for any client that
 * wants to commit a concept without a checkpoint.
 */
export const FreeformSourceSchema = z.object({
  mode: z.literal('freeform'),
  concept: z.string().min(20).max(4000),
})

/**
 * The PARKED-PREVIEW source — an already-gated proposal committed by its opaque
 * previewId. `z.string()` (not a uuid) keeps the backend's 400-vs-410 split
 * clean: a malformed body 400s at Zod; a well-formed-but-absent/expired
 * previewId 410s at the preview-store load.
 *
 * The `'guided'` literal is the WIRE NAME of "commit what the checkpoint
 * parked", not a claim about which path produced it: since myth-6t06f a
 * freeform-originated proposal commits through this arm too. Renaming it is a
 * five-surface ripple with no behavioural gain, so the name stayed and this
 * note carries the meaning.
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
