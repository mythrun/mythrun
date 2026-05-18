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
  // myth-pfke smoke surfaced: real Sonnet sometimes emits terse glossary
  // definitions (10-30 char). Floor at 10 — anything shorter is a model
  // error, not a stylistic choice. Upper bound stays at 400.
  definition: z.string().min(10).max(400),
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

// Stage 1.5 model output: model OMITS source + access_level (handler
// stamps both). Originally `.strict()` rejected extras to surface model
// drift. Removed after the myth-pfke smoke showed Sonnet sometimes
// emits a passthrough `source` field or extra metadata keys even when
// the prompt says not to. Default Zod behavior (strip extras silently)
// is safer — the handler's stamp-pass overwrites anything the model
// emitted in those slots anyway. The wrapper's repair-fallback only
// fires for LlmStructuredOutputError, and AI_NoObjectGeneratedError
// from Output.object validation bypasses middleware mapping (a known
// latent bug in the wrapper — see follow-up bead), so we keep the
// schema lenient enough that the first-pass Zod parse succeeds.
export const VocabularyIntakeOutputSchema = z.object({
  entries: z
    .array(VocabularyEntrySchema.omit({ source: true, access_level: true }))
    .min(0)
    .max(30),
  adjacent_franchises: z.array(z.string().min(1).max(80)).max(8),
})
export type VocabularyIntakeOutput = z.infer<typeof VocabularyIntakeOutputSchema>
