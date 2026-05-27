// backend/src/llm/schemas/coherence-output.ts
//
// Stage 7 (coherence_pass) output schema. Per myth-2ob3 design.
//
// All patch kinds identify their target rows by NAME. A deterministic
// server-side resolver maps names to UUIDs before applying patches.
// Unresolvable names are dropped with structured WARNs.
//
// Patch kinds:
//   - fix_fact_by_name          UPDATE facts.content
//   - fix_prose_by_name         UPDATE prose_kernels.content
//   - fix_relationship_by_name  UPDATE relationships.relationship_type / description
//   - add_relationship_by_name  INSERT INTO relationships
//   - rename_entity_by_name     UPDATE entities.name
//   - delete_relationship_by_name  DELETE FROM relationships
//
// Auto-fix only — no `warnings` arm. The LLM emits only patches it has
// high confidence in. The list is bounded to 40 to keep per-stage spend
// tractable.

import { z } from 'zod'

const fixFactPatch = z.object({
  kind: z.literal('fix_fact_by_name'),
  entity_name: z.string().min(1).max(200),
  fact_topic: z.string().min(1).max(120),
  new_content: z.string().min(10).max(2000),
  rationale: z.string().min(20).max(400),
})

const fixProsePatch = z.object({
  kind: z.literal('fix_prose_by_name'),
  entity_name: z.string().min(1).max(200),
  new_prose: z.string().min(40).max(2400),
  rationale: z.string().min(20).max(400),
})

const fixRelationshipPatch = z.object({
  kind: z.literal('fix_relationship_by_name'),
  source_name: z.string().min(1).max(200),
  target_name: z.string().min(1).max(200),
  current_type: z.string().min(2).max(60),
  newSource: z.string().min(1).max(200).optional(),
  newTarget: z.string().min(1).max(200).optional(),
  newType: z.string().min(2).max(60).optional(),
  newDescription: z.string().min(10).max(600).optional(),
  rationale: z.string().min(20).max(400),
}).refine(
  (p) => p.newSource !== undefined
    || p.newTarget !== undefined
    || p.newType !== undefined
    || p.newDescription !== undefined,
  { message: 'fix_relationship_by_name requires at least one of newSource, newTarget, newType, newDescription' },
)

const addRelationshipPatch = z.object({
  kind: z.literal('add_relationship_by_name'),
  source_name: z.string().min(1).max(200),
  target_name: z.string().min(1).max(200),
  relationship: z.string().min(2).max(60),
  description: z.string().min(10).max(600),
  rationale: z.string().min(20).max(400),
})

const renameEntityPatch = z.object({
  kind: z.literal('rename_entity_by_name'),
  old_name: z.string().min(1).max(200),
  new_name: z.string().min(1).max(200),
  rationale: z.string().min(20).max(400),
})

const deleteRelationshipPatch = z.object({
  kind: z.literal('delete_relationship_by_name'),
  source_name: z.string().min(1).max(200),
  target_name: z.string().min(1).max(200),
  current_type: z.string().min(2).max(60),
  rationale: z.string().min(20).max(400),
})

export const CoherencePatchSchema = z.discriminatedUnion('kind', [
  fixFactPatch,
  fixProsePatch,
  fixRelationshipPatch,
  addRelationshipPatch,
  renameEntityPatch,
  deleteRelationshipPatch,
])

export type CoherencePatch = z.infer<typeof CoherencePatchSchema>

export const CoherenceOutputSchema = z.object({
  patches: z.array(CoherencePatchSchema).max(40),
})

export type CoherenceOutput = z.infer<typeof CoherenceOutputSchema>
