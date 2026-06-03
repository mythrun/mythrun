// backend/src/llm/schemas/vocabulary-registry.ts
//
// myth-pfke: per-world vocabulary registry schemas. Three shapes:
//   - VocabularyEntrySchema:   the canonical stored entry (with source + access_level)
//   - VocabularyRegistrySchema: the column-shape document
//   - VocabularyIntakeOutputSchema: what stage 1.5's LLM call must emit
//                                    (source + access_level are handler-stamped)
//
// All entries are application-validated at insertion time; the DB
// CHECK constraint only enforces top-level object shape.

import { z } from 'zod'

export const VocabularyEntrySchema = z.object({
  term: z.string().min(1).max(80),
  // myth-pfke smoke surfaced: real Sonnet emits both terse (10-30 char)
  // and expansive (400+ char) definitions depending on the world's
  // complexity. Floor at 10.
  // min-only: no max on free LLM prose — see feedback_no_max_on_llm_prose_fields /
  // myth-vimk. definition + usage_notes are free prose; the haiku→sonnet repair
  // only fixes malformed JSON, so a max() terminal-fails the stage on valid output.
  definition: z.string().min(10),
  avoids: z.string().min(1).max(80).optional(),
  usage_notes: z.string().min(1).optional(),
  source: z.enum(['stage_1_5', 'consolidation', 'scribe_runtime']),
  access_level: z.enum(['known', 'discoverable', 'secret']).default('known'),
})
export type VocabularyEntry = z.infer<typeof VocabularyEntrySchema>

export const VocabularyRegistrySchema = z.object({
  entries: z.array(VocabularyEntrySchema).max(60),
  adjacent_franchises: z.array(z.string().min(1).max(80)).max(8),
})
export type VocabularyRegistry = z.infer<typeof VocabularyRegistrySchema>

// Stage 1.5 model output: model emits ONLY `entries` (no source,
// access_level, avoids, or adjacent_franchises). The handler stamps
// source='stage_1_5' + access_level='known' per-entry and stamps an
// empty adjacent_franchises array on the registry document.
//
// IP-mirror detection lives in the paint-job-validator at concept_intake,
// not here. The vocabulary-intake A/B experiments in myth-pfke surfaced
// that naming franchises in this prompt was net-harmful: it caused
// paranoid substitutions including SRD-class outlawings (cleric →
// "Voidpriest", adventuring party → "Company"), missed actual adjacencies
// (Star Wars-coded prompt got 0 franchises identified), and had spotty
// signal (fired hard on genre LABELS, silent on franchise CONTENTS).
// The model's intrinsic IP-instincts handle franchise-vocabulary avoidance
// without explicit prompting.
//
// The `avoids` field on VocabularyEntrySchema is retained for future
// Scribe-runtime use (a runtime caller might mark an entry as replacing
// a specific IP word). Stage 1.5 does not populate it.
export const VocabularyIntakeOutputSchema = z.object({
  entries: z
    .array(
      VocabularyEntrySchema.omit({
        source: true,
        access_level: true,
        avoids: true,
      }),
    )
    .min(0)
    .max(30),
})
export type VocabularyIntakeOutput = z.infer<typeof VocabularyIntakeOutputSchema>
