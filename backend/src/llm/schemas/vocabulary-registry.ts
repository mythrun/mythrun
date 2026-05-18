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
  definition: z.string().min(30).max(400),
  avoids: z.string().min(1).max(80).optional(),
  usage_notes: z.string().min(1).max(200).optional(),
  source: z.enum(['stage_1_5', 'consolidation', 'scribe_runtime']),
  access_level: z.enum(['known', 'discoverable', 'secret']).default('known'),
})
export type VocabularyEntry = z.infer<typeof VocabularyEntrySchema>

export const VocabularyRegistrySchema = z.object({
  entries: z.array(VocabularyEntrySchema).max(60),
  adjacent_franchises: z.array(z.string().min(1).max(80)).max(8),
})
export type VocabularyRegistry = z.infer<typeof VocabularyRegistrySchema>

// Stage 1.5 model output: must NOT include source or access_level.
// The handler stamps both fields. .strict() rejects extra keys so the
// model can't sneak source through.
export const VocabularyIntakeOutputSchema = z.object({
  entries: z
    .array(
      VocabularyEntrySchema.omit({ source: true, access_level: true }).strict(),
    )
    .min(0)
    .max(30),
  adjacent_franchises: z.array(z.string().min(1).max(80)).max(8),
})
export type VocabularyIntakeOutput = z.infer<typeof VocabularyIntakeOutputSchema>
