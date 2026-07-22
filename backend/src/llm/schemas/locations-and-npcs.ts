// backend/src/llm/schemas/locations-and-npcs.ts
//
// Per design §3.2 + §D8. Ported shape from prototype, adapted to the
// production schema. Bounds chosen for "rich enough to play in, not so
// many entities the prose budget runs out" — matches Stage 2 ranges.
//
// Each location carries `parent_location: string | null` — the NAME of
// the containing location (or null for region-root). The streaming
// extractor surfaces these names live; the persister runs a three-pass
// resolver (§D8) to map them to entity_ids and write entity_hierarchy
// rows. NPC `home_location` is a narrative reference only — not
// persisted to entity_hierarchy (per design §3.2).
//
// narrative_status is NOT in the fact schema — the persister stamps
// 'undelivered' as a constant on every fact row. `source='prep'` is
// stamped by the facts repo via the column default.

import { z } from 'zod'

const ACCESS_LEVEL = z.enum(['known', 'discoverable', 'secret'])

export const factSchema = z.object({
  topic: z.string().min(2).max(80),
  // min-only: no max on free LLM prose — see feedback_no_max_on_llm_prose_fields /
  // myth-vimk. content + prose land in TEXT columns; the haiku→sonnet repair only
  // fixes malformed JSON, so a max() terminal-fails the stage on valid output.
  content: z.string().min(20),
  access_level: ACCESS_LEVEL,
})

export const locationItemSchema = z.object({
  name: z.string().min(1).max(200),
  access_level: ACCESS_LEVEL,
  prose: z.string().min(40),
  facts: z.array(factSchema).min(2).max(12),
  parent_location: z.string().nullable(),
})

export const npcItemSchema = z.object({
  name: z.string().min(1).max(200),
  access_level: ACCESS_LEVEL,
  prose: z.string().min(40),
  facts: z.array(factSchema).min(2).max(12),
  home_location: z.string().nullable(),
})

export const LocationsAndNpcsSchema = z.object({
  locations: z.array(locationItemSchema).min(5).max(20),
  npcs: z.array(npcItemSchema).min(5).max(20),
})

export type LocationsAndNpcsTree = z.infer<typeof LocationsAndNpcsSchema>
type LocationItem = z.infer<typeof locationItemSchema>
type NpcItem = z.infer<typeof npcItemSchema>
// Back-compat aliases for stages/locations-and-npcs.ts consumers.
export type LocationEntry = LocationItem
export type NpcEntry = NpcItem
