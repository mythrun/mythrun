// backend/src/llm/schemas/entity-consolidation.ts
//
// Stage 4b (entity_consolidation) schema. Each ghost entity has the
// same depth as stage 2-3 entities: prose (40-2400 chars), 2-12 facts,
// access_level, optional parent_location_id for locations.

import { z } from 'zod'
import { placeholderIdSchema } from './entity-relationships.js'

const ACCESS_LEVEL = z.enum(['known', 'discoverable', 'secret'])

const factSchema = z.object({
  topic: z.string().min(1).max(120),
  content: z.string().min(20).max(800),
  access_level: ACCESS_LEVEL,
})

export const ghostEntitySchema = z.object({
  placeholder_id: placeholderIdSchema,
  name: z.string().min(1).max(200),
  entity_type: z.enum(['faction', 'location', 'npc']),
  access_level: ACCESS_LEVEL,
  parent_location_id: z.uuid().nullable(),
  prose: z.string().min(40).max(2400),
  facts: z.array(factSchema).min(2).max(12),
})

export const EntityConsolidationSchema = z.object({
  ghost_entities: z.array(ghostEntitySchema).max(15),
})

export type GhostEntity = z.infer<typeof ghostEntitySchema>
export type EntityConsolidationOutput = z.infer<typeof EntityConsolidationSchema>
