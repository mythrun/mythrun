// backend/src/llm/schemas/world-and-factions.ts
//
// Stage 2 (world_and_factions) Zod schema. Per design §3.1.
//
// Bounds are tighter than the prototype defaults: min(3).max(8) regions
// and factions, aimed at "rich enough world to play in, not so many
// entities that prose budget runs out."
//
// narrative_status is NOT in the fact schema — the persister stamps
// 'undelivered' as a constant on every fact row at INSERT time
// (play-runtime owns the transitions to 'delivered' / 'developed' /
// 'resolved'). source='prep' is also stamped via the column default.
//
// myth-exac: access_level vocabulary is ['known','discoverable','secret']
// (replacing the older ['public','private','secret']). access_level is
// REQUIRED at field position 2 on every entity (region, faction) —
// immediately after `name`, before `prose`/`facts`. No default; the LLM
// must emit it explicitly so enforced-ignorance gating at runtime is
// driven by author intent, not by a fallback.

import { z } from 'zod'

const ACCESS_LEVEL = z.enum(['known', 'discoverable', 'secret'])

export const factSchema = z.object({
  topic: z.string().min(2).max(80),
  content: z.string().min(20).max(800),
  access_level: ACCESS_LEVEL,
})

const regionSchema = z.object({
  // FIELD ORDER MATTERS: name first, access_level second.
  name: z.string().min(1).max(200),
  access_level: ACCESS_LEVEL,
  prose: z.string().min(40).max(2400),
  facts: z.array(factSchema).min(2).max(12),
})

const factionSchema = z.object({
  name: z.string().min(1).max(200),
  access_level: ACCESS_LEVEL,
  prose: z.string().min(40).max(2400),
  facts: z.array(factSchema).min(2).max(12),
})

export const WorldAndFactionsSchema = z.object({
  world_overview: z.string().min(60).max(2400),
  regions: z.array(regionSchema).min(3).max(8),
  factions: z.array(factionSchema).min(3).max(8),
})

export type WorldAndFactionsTree = z.infer<typeof WorldAndFactionsSchema>
