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

export const ACCESS_LEVEL = z.enum(['known', 'discoverable', 'secret'])

export const factSchema = z.object({
  topic: z.string().min(2).max(80),
  content: z.string().min(20).max(800),
  access_level: ACCESS_LEVEL,
})

export const locationSchema = z.object({
  name: z.string().min(1).max(200),
  access_level: ACCESS_LEVEL,
  prose: z.string().min(40).max(2400),
  facts: z.array(factSchema).min(2).max(12),
  parent_location: z.string().nullable(),
})

export const npcSchema = z.object({
  name: z.string().min(1).max(200),
  access_level: ACCESS_LEVEL,
  prose: z.string().min(40).max(2400),
  facts: z.array(factSchema).min(2).max(12),
  home_location: z.string().nullable(),
})

export const LocationsAndNpcsSchema = z.object({
  locations: z.array(locationSchema).min(5).max(20),
  npcs: z.array(npcSchema).min(5).max(20),
})

export type LocationsAndNpcsTree = z.infer<typeof LocationsAndNpcsSchema>
export type LocationEntry = z.infer<typeof locationSchema>
export type NpcEntry = z.infer<typeof npcSchema>
