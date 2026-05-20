// backend/src/llm/schemas/entity-relationships.ts
//
// Stage 4 (`entity_relationships`) Zod schema. Per MYT-52 design §3.3.
//
// Field names (`from`, `to`, `relationship`) match the streaming-extractor's
// `role: 'edge'` predicate (`backend/src/llm/prep/streaming-extractor.ts`)
// + the SSE event-payload contract (`{ type: 'edge-added'; synthKey; from;
// to; relationship; description? }`). The persister maps these to
// `relationships.source_entity_id` / `target_entity_id` / `relationship_type`
// at INSERT time.
//
// `relationship_type` is a CLOSED enum (design §3.3): downstream Scribe /
// Session-Runtime consumers can `switch` on it without natural-language
// interpretation. Adding a new type requires a deliberate prompt + schema
// edit; the LLM is forced to map novel relationships to the closest
// existing type or skip them.
//
// `relationships.min(5)`: asserts the LLM produced something. A world with
// 30+ entities (typical after stages 2+3) but zero structured relationships
// is a quality failure — min(5) makes that fail Zod and trigger the
// repair-chain.

import { z } from 'zod'

export const RELATIONSHIP_TYPES = [
  'serves',
  'opposed_to',
  'allied_with',
  'rival_of',
  'controls',
  'family_member',
  'mentors',
  'employed_by',
  'located_in',
  'leads',
  'member_of',
  'rules',
  'former_servant_of',
  'pursues',
  'protects',
  'betrayed_by',
] as const

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number]

const PLACEHOLDER_ID_PATTERN = /^new-\d{3}$/

export const placeholderIdSchema = z.string().regex(PLACEHOLDER_ID_PATTERN)

export const endpointSchema = z.union([z.uuid(), placeholderIdSchema])

export const declarationItemSchema = z.object({
  placeholder_id: placeholderIdSchema,
  name: z.string().min(1).max(200),
  entity_type: z.enum(['faction', 'location', 'npc']),
})

export const relationshipItemSchema = z.object({
  from: endpointSchema,
  to: endpointSchema,
  relationship: z.enum(RELATIONSHIP_TYPES),
  description: z.string().min(10).max(600),
})

export const hierarchyStragglerItemSchema = z.object({
  parent_entity_id: endpointSchema,
  child_entity_id: endpointSchema,
})

export const EntityRelationshipsSchema = z.object({
  relationships: z.array(relationshipItemSchema).min(5).max(80),
  hierarchy_stragglers: z.array(hierarchyStragglerItemSchema).max(20),
  new_entity_declarations: z.array(declarationItemSchema).max(15),
})

export type EntityRelationshipsOutput = z.infer<typeof EntityRelationshipsSchema>
export type RelationshipEntry = EntityRelationshipsOutput['relationships'][number]
export type HierarchyStraggler = EntityRelationshipsOutput['hierarchy_stragglers'][number]
export type RelationshipItem = z.infer<typeof relationshipItemSchema>
export type HierarchyStragglerItem = z.infer<typeof hierarchyStragglerItemSchema>
export type DeclarationItem = z.infer<typeof declarationItemSchema>
