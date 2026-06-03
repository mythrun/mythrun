// backend/src/llm/schemas/character-integration.ts
//
// MYT-54: whole-party character-integration shape. A single Opus pass over
// the entire party emits one structured response covering every PC's entity,
// facts, and relationships — including PC↔PC edges.
//
// Target-kind discriminated union resolves the asymmetric edge shape:
//   - PC↔PC edges reference the other player by `targetUserId` (a UUID
//     pointing at users.id). The worker writes the PC entity rows first
//     (one entity per PC), then resolves targetUserId → that PC's entity id
//     when materializing the relationship row. This indirection keeps the
//     prompt model-friendly: the LLM names other PCs by player identity,
//     not by an entity id it has not yet seen.
//   - PC↔NPC / PC↔faction / PC↔location edges reference the existing world
//     entity directly by `targetId` (UUID into entities.id). These ids are
//     already present in the world-dump the prompt sees.
//
// `newFacts` is the optional "incidental facts" channel: facts the LLM
// emits about non-PC entities (NPCs, factions, locations) where attaching
// the fact to a specific PC would be wrong. The worker writes these with
// the entity's owner_user_id (i.e. the world's owner), not a PC's.

import { z } from 'zod'

const pcEntitySchema = z.object({
  name: z.string().min(2).max(80),
  // min-only: no max on free LLM prose — see feedback_no_max_on_llm_prose_fields /
  // myth-vimk. The tokens are spent at generation; rejecting valid-but-long prose
  // for length is wasteful, and the haiku→sonnet repair pass only fixes malformed
  // JSON, not over-length-but-valid prose, so a max() terminal-fails the stage.
  // (max(1200) — and the later max(2000) stopgap — terminal-failed
  // character_integration on real ~1400-char Opus output. Surfaced by MYT-64.)
  proseKernel: z.string().min(80),
})

const factSchema = z.object({
  content: z.string().min(20),
  tags: z.array(z.string().min(1).max(40)).min(1).max(5),
  aboutEntityId: z.uuid().nullable(),
})

const npcRelationshipSchema = z.object({
  targetKind: z.literal('npc'),
  targetId: z.uuid(),
  type: z.string().min(2).max(60),
  description: z.string().min(20),
})
const factionRelationshipSchema = z.object({
  targetKind: z.literal('faction'),
  targetId: z.uuid(),
  type: z.string().min(2).max(60),
  description: z.string().min(20),
})
const locationRelationshipSchema = z.object({
  targetKind: z.literal('location'),
  targetId: z.uuid(),
  type: z.string().min(2).max(60),
  description: z.string().min(20),
})
const pcRelationshipSchema = z.object({
  targetKind: z.literal('pc'),
  targetUserId: z.uuid(),
  type: z.string().min(2).max(60),
  description: z.string().min(20),
})

const relationshipSchema = z.discriminatedUnion('targetKind', [
  npcRelationshipSchema,
  factionRelationshipSchema,
  locationRelationshipSchema,
  pcRelationshipSchema,
])

const pcIntegrationSchema = z.object({
  userId: z.uuid(),
  displayName: z.string().min(1).max(100),
  entity: pcEntitySchema,
  facts: z.array(factSchema).min(1).max(10),
  relationships: z.array(relationshipSchema).min(0).max(10),
})

const newFactSchema = z.object({
  entityId: z.uuid(),
  content: z.string().min(20),
  tags: z.array(z.string().min(1).max(40)).min(1).max(5),
})

export const IntegrationResultSchema = z.object({
  characters: z.array(pcIntegrationSchema).min(1).max(8),
  newFacts: z.array(newFactSchema).optional(),
})

export type IntegrationResult = z.infer<typeof IntegrationResultSchema>
export type PCIntegration = z.infer<typeof pcIntegrationSchema>
export type IntegrationRelationship = z.infer<typeof relationshipSchema>
