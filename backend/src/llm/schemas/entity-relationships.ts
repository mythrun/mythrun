// backend/src/llm/schemas/entity-relationships.ts
//
// Stage 4 (`entity_relationships`) Zod schema. Per myth-2ob3 design.
//
// LLM I/O is name-based: `from_name` + `to_name` identify endpoints by
// their normalized name as listed in the worldDump. `relationship` is
// free-text (short verb-phrase predicate; verb-shape guidance lives in
// the prompt, not the schema). The server-side resolver maps names →
// UUIDs before INSERT; unresolvable rows are dropped with a WARN.
//
// `hierarchy_stragglers` uses parent/child names (same lookup).
// `new_entity_declarations` no longer carries placeholder_id — the
// SERVER mints `new-NNN` synthetic IDs for declared phantoms and binds
// them by normalized name.
//
// `relationships.min(5)`: asserts the LLM produced something. A world
// with 30+ entities (typical after stages 2+3) but zero structured
// relationships is a quality failure — min(5) makes that fail Zod and
// trigger the repair-chain.

import { z } from 'zod'

export const declarationItemSchema = z.object({
  name: z.string().min(1).max(200),
  entity_type: z.enum(['faction', 'location', 'npc']),
})

export const relationshipItemSchema = z.object({
  from_name: z.string().min(1).max(200),
  to_name: z.string().min(1).max(200),
  relationship: z.string().min(2).max(60),
  // min-only: no max on free LLM prose — see feedback_no_max_on_llm_prose_fields /
  // myth-vimk. description is a free-prose relationship summary in a TEXT column;
  // the haiku→sonnet repair only fixes malformed JSON, so a max() terminal-fails
  // the stage on valid output.
  description: z.string().min(10),
  // Per-relationship access tier (MYT-89 Phase A). Mirrors the fact-level tier
  // in entity-consolidation. REQUIRED so the prompt (A3) is forced to emit it
  // and the persist path (A4) can carry it into relationships.access_level.
  access_level: z.enum(['known', 'discoverable', 'secret']),
})

const hierarchyStragglerItemSchema = z.object({
  parent_name: z.string().min(1).max(200),
  child_name: z.string().min(1).max(200),
})

export const EntityRelationshipsSchema = z.object({
  // Field order matters: declarations BEFORE relationships so the
  // mid-stream resolver finds phantoms by the time relationships
  // reference them (design §5 JSON-key-ordering mitigation).
  new_entity_declarations: z.array(declarationItemSchema).max(15),
  relationships: z.array(relationshipItemSchema).min(5).max(80),
  hierarchy_stragglers: z.array(hierarchyStragglerItemSchema).max(20),
})

export type EntityRelationshipsOutput = z.infer<typeof EntityRelationshipsSchema>
