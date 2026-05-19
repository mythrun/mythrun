// backend/src/llm/schemas/character-integration.ts
//
// MYT-53 stage 4: PC entity + PC↔world relationships + PC-tagged facts.
// Relationships reference target entities by NAME; the handler resolves
// to ids the same way starting-situation does (case-insensitive lookup
// against entities). Unmatched names trigger one retry then a terminal
// LlmStructuredOutputError.

import { z } from 'zod'

export const pcEntitySchema = z.object({
  name: z.string().min(2).max(80),
  short_description: z.string().min(40).max(400),
})

export const relationshipSchema = z.object({
  target_entity_name: z.string().min(2).max(120),
  relationship_type: z.string().min(2).max(60),
  description: z.string().min(20).max(800),
})

export const factSchema = z.object({
  content: z.string().min(10).max(800),
  tags: z.array(z.string().min(2).max(40)).max(8),
})

export const CharacterIntegrationOutputSchema = z.object({
  pc_entity: pcEntitySchema,
  relationships: z.array(relationshipSchema).min(1).max(10),
  facts: z.array(factSchema).min(1).max(8),
})

export type CharacterIntegrationOutput = z.infer<typeof CharacterIntegrationOutputSchema>
export type PcEntity = z.infer<typeof pcEntitySchema>
export type Relationship = z.infer<typeof relationshipSchema>
export type Fact = z.infer<typeof factSchema>
