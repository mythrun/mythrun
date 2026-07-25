// backend/src/llm/schemas/character-concept.ts
//
// MYT-53 stage 2: narrative half of the character. Matches the
// portable-characters fields from MYT-48 for the narrative columns.
// The mechanical fields (str/dex/con/.../hit_points/armor_class) come
// from stage 3's CharacterSheetOutputSchema.

import { z } from 'zod'

// myth-gdycq: the pronoun choice, as a closed token set rather than free text.
// An enum (not a string) because the value is PINNED deterministically over the
// model's echo — a pin is only meaningful against a value the server itself
// controls. `name_only` means "never use a pronoun for this character; use the
// name". The absence of the field is its own answer: let the description decide
// (and the chargen prompt's default takes over from there).
export const PRONOUN_TOKENS = ['she_her', 'he_him', 'they_them', 'name_only'] as const
export const PronounsSchema = z.enum(PRONOUN_TOKENS)
export type Pronouns = z.infer<typeof PronounsSchema>

// myth-4jhrk: the guided builder's structured picks, as POSTed by the client
// and persisted verbatim into character_concepts.guided_choices. This is the
// SHARED wire contract with the frontend (client-core's SubmitCharacterBody
// mirrors it) — every field optional, short labels only (not prose, so max()
// is legal per the no-max-on-LLM-prose rule; these are player picks, not LLM
// output). The concept stage renders present picks into the prompt as
// COMMITTED choices and deterministically pins `subclass` over the LLM echo.
//
// myth-gdycq: `pronouns` rides the same channel from BOTH creation paths — the
// guided builder's NOTES step and the freeform concept step — so a freeform
// submission can carry one pick without a second wire field or a migration.
// "Guided choices" is therefore the name of the STRUCTURED-PICK channel, not a
// claim that the guided builder produced them.
export const GuidedChoicesSchema = z.object({
  class: z.string().min(1).max(60).optional(),
  subclass: z.string().min(1).max(60).optional(),
  species: z.string().min(1).max(60).optional(),
  background: z.string().min(1).max(60).optional(),
  pronouns: PronounsSchema.optional(),
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
  // myth-gdycq: how the DM refers to this character in prose. Distinct from
  // `gender` (which describes the character; this governs the WORDS every later
  // stage uses). Optional in the schema, exactly as `subclass` is: the field is
  // emitted from what the player committed or from what their description
  // implies. When the player picked, the stage OVERRIDES the echo — the run-3
  // failure was a model that answered "he/his" for a description that never
  // specified a gender, and a pin makes that structurally impossible. A short
  // label, not prose, so max() is legal here.
  pronouns: z.string().min(2).max(40).optional(),
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
