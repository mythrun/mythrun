// backend/src/llm/schemas/character-concept.ts
//
// MYT-53 stage 2: narrative half of the character. Matches the
// portable-characters fields from MYT-48 for the narrative columns.
// The mechanical fields (str/dex/con/.../hit_points/armor_class) come
// from stage 3's CharacterSheetOutputSchema.

import { z } from 'zod'

export const CharacterConceptOutputSchema = z.object({
  name: z.string().min(2).max(80),
  race: z.string().min(3).max(40),
  class: z.string().min(4).max(40),
  background: z.string().min(2).max(60),
  level: z.number().int().min(1).max(20),
  alignment: z.string().min(2).max(40),
  age: z.number().int().min(1).max(2000),
  gender: z.string().min(1).max(40),
  // min-only: no max on free LLM prose — see feedback_no_max_on_llm_prose_fields /
  // myth-vimk. physical_description, the trait/ideal/bond/flaw sentences, and
  // backstory are all free prose; the haiku→sonnet repair only fixes malformed
  // JSON, so a max() terminal-fails the stage on valid-but-long output. Array
  // element-COUNT caps (min/max on the arrays themselves) are retained — those
  // bound how many entries, not prose length.
  physical_description: z.string().min(80),
  personality_traits: z.array(z.string().min(5)).min(2).max(4),
  ideals: z.array(z.string().min(5)).min(1).max(2),
  bonds: z.array(z.string().min(5)).min(1).max(2),
  flaws: z.array(z.string().min(5)).min(1).max(2),
  backstory: z.string().min(300),
})

export type CharacterConceptOutput = z.infer<typeof CharacterConceptOutputSchema>
