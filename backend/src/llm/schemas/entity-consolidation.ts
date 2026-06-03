// backend/src/llm/schemas/entity-consolidation.ts
//
// Stage 4b (entity_consolidation) schema. Each ghost entity has the
// same depth as stage 2-3 entities: prose (40-2400 chars), 2-12 facts,
// access_level, optional parent_location_id for locations.
//
// myth-2ob3 T8/T9: placeholder_id is now SERVER-MINTED in stage 4
// (format `new-NNN`, persisted into the worlds.entity_consolidation_pending
// declarations array). Stage 4b's LLM echoes those IDs back when emitting
// ghost entities, so the schema validates the same `new-NNN` shape inline
// here (no longer re-exported from entity-relationships.ts which dropped
// the LLM-side placeholder_id field in T5).

import { z } from 'zod'

const PLACEHOLDER_ID_PATTERN = /^new-\d{3}$/

const placeholderIdSchema = z.string().regex(PLACEHOLDER_ID_PATTERN)

const ACCESS_LEVEL = z.enum(['known', 'discoverable', 'secret'])

const factSchema = z.object({
  topic: z.string().min(1).max(120),
  // min-only: no max on free LLM prose — see feedback_no_max_on_llm_prose_fields /
  // myth-vimk. content + prose land in TEXT columns; the haiku→sonnet repair pass
  // only fixes malformed JSON, so a max() terminal-fails the stage on valid output.
  content: z.string().min(20),
  access_level: ACCESS_LEVEL,
})

export const ghostEntitySchema = z.object({
  placeholder_id: placeholderIdSchema,
  name: z.string().min(1).max(200),
  entity_type: z.enum(['faction', 'location', 'npc']),
  access_level: ACCESS_LEVEL,
  parent_location_id: z.uuid().nullable(),
  prose: z.string().min(40),
  facts: z.array(factSchema).min(2).max(12),
})

export const EntityConsolidationSchema = z.object({
  ghost_entities: z.array(ghostEntitySchema).max(15),
})

export type GhostEntity = z.infer<typeof ghostEntitySchema>
export type EntityConsolidationOutput = z.infer<typeof EntityConsolidationSchema>
