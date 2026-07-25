// backend/src/llm/schemas/character-concept.ts
//
// MYT-53 stage 2: narrative half of the character. Matches the
// portable-characters fields from MYT-48 for the narrative columns.
// The mechanical fields (str/dex/con/.../hit_points/armor_class) come
// from stage 3's CharacterSheetOutputSchema.

import { z } from 'zod'

// myth-4jhrk: the guided builder's structured picks, as POSTed by the client
// and persisted verbatim into character_concepts.guided_choices. This is the
// SHARED wire contract with the frontend (client-core's SubmitCharacterBody
// mirrors it) — every field optional, short labels only (not prose, so max()
// is legal per the no-max-on-LLM-prose rule; these are player picks, not LLM
// output). The concept stage renders present picks into the prompt as
// COMMITTED choices and deterministically pins `subclass` over the LLM echo.
export const GuidedChoicesSchema = z.object({
  class: z.string().min(1).max(60).optional(),
  subclass: z.string().min(1).max(60).optional(),
  species: z.string().min(1).max(60).optional(),
  background: z.string().min(1).max(60).optional(),
})

export type GuidedChoices = z.infer<typeof GuidedChoicesSchema>

export const CharacterConceptOutputSchema = z.object({
  name: z.string().min(2).max(80),
  race: z.string().min(3).max(40),
  class: z.string().min(4).max(40),
  // myth-4jhrk: optional — emitted ONLY when the player named a subclass (a
  // guided-builder pick, or one stated in freeform concept text). Never
  // invented by the model; the guided pick deterministically overrides the
  // echo in the stage, and the sheet stage pins it as a FIXED constraint.
  subclass: z.string().min(2).max(60).optional(),
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
