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

import { z } from 'zod'

export const factSchema = z.object({
  topic: z.string().min(2).max(80),
  content: z.string().min(20).max(800),
  access_level: z.enum(['public', 'private', 'secret']),
})

export const WorldAndFactionsSchema = z.object({
  world_overview: z.string().min(60).max(2400),
  regions: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        prose: z.string().min(40).max(2400),
        facts: z.array(factSchema).min(2).max(12),
      }),
    )
    .min(3)
    .max(8),
  factions: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        prose: z.string().min(40).max(2400),
        facts: z.array(factSchema).min(2).max(12),
      }),
    )
    .min(3)
    .max(8),
})

export type WorldAndFactionsTree = z.infer<typeof WorldAndFactionsSchema>
