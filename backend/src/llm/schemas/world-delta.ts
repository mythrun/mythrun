import { z } from 'zod'

/**
 * One proposed change emitted by the Fast Thinker's per-turn world delta.
 *
 * Enforced ignorance: the FT is public-by-construction, so the delta carries
 * NO tier — the parser stamps `tier:'known'` downstream. Any `tier` the model
 * tries to emit is silently ignored (Zod strips unknown keys by default).
 *
 * Flat root, no `.refine`, `.min(1)` floors on free-prose fields, no `.max()`.
 */
const WorldDeltaItemSchema = z.object({
  subject: z.string().min(1),
  content: z.string().min(1),
  kind: z.enum(['fact', 'entity', 'relationship']),
})

export const WorldDeltaSchema = z.object({ facts: z.array(WorldDeltaItemSchema) })

export type WorldDelta = z.infer<typeof WorldDeltaSchema>
