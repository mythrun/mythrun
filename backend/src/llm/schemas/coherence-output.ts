// backend/src/llm/schemas/coherence-output.ts
//
// Per MYT-52 design §3.6. Stage 7 (coherence_pass) output schema.
//
// The LLM is given a full world dump (~10-14k tokens) and emits an array of
// patches keyed by real UUID. The patch list is bounded to 40 to keep the
// per-stage spend tractable; the LLM is instructed to emit only the patches
// it has high confidence in (auto-fix only, no `warnings` arm).
//
// Patch kinds are tagged via the `kind` discriminator (D6 / §3.6):
//   - fix_fact          UPDATE facts.content
//   - fix_prose         UPDATE prose_kernels.content
//   - fix_relationship  UPDATE relationships.relationship_type / description
//   - rename_entity     UPDATE entities.name
//   - delete_relationship  DELETE FROM relationships
//
// Auto-fix only — no `warnings` arm. Things the LLM can't confidently fix
// remain whatever they were; if they matter, the eval harness surfaces
// them later. Building a `world_warnings` table without a consumer is
// premature (per §3.6).

import { z } from 'zod'

const fixFactPatch = z.object({
  kind: z.literal('fix_fact'),
  factId: z.uuid(),
  newContent: z.string().min(10).max(2000),
  rationale: z.string().min(20).max(400),
})

const fixProsePatch = z.object({
  kind: z.literal('fix_prose'),
  entityId: z.uuid(),
  newProse: z.string().min(40).max(2400),
  rationale: z.string().min(20).max(400),
})

const fixRelationshipPatch = z.object({
  kind: z.literal('fix_relationship'),
  relationshipId: z.uuid(),
  newType: z.string().min(2).max(60).optional(),
  newDescription: z.string().min(10).max(600).optional(),
  rationale: z.string().min(20).max(400),
})

const renameEntityPatch = z.object({
  kind: z.literal('rename_entity'),
  entityId: z.uuid(),
  newName: z.string().min(1).max(200),
  rationale: z.string().min(20).max(400),
})

const deleteRelationshipPatch = z.object({
  kind: z.literal('delete_relationship'),
  relationshipId: z.uuid(),
  rationale: z.string().min(20).max(400),
})

export const CoherencePatchSchema = z.discriminatedUnion('kind', [
  fixFactPatch,
  fixProsePatch,
  fixRelationshipPatch,
  renameEntityPatch,
  deleteRelationshipPatch,
])

export type CoherencePatch = z.infer<typeof CoherencePatchSchema>

export const CoherenceOutputSchema = z.object({
  patches: z.array(CoherencePatchSchema).max(40),
})

export type CoherenceOutput = z.infer<typeof CoherenceOutputSchema>
