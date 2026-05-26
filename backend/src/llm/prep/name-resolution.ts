// backend/src/llm/prep/name-resolution.ts
//
// myth-2ob3: pure-functional name resolver shared by entity_relationships
// and coherence_pass stages. Maps LLM-emitted names to canonical UUIDs
// against a per-pass inventory snapshot.

/**
 * Normalize a name for lookup. Pure hygiene:
 *  - NFC-normalize Unicode (composed form)
 *  - trim leading/trailing whitespace
 *  - collapse internal whitespace runs (including tabs/newlines) to one space
 *
 * Case-sensitive. NO fuzzy matching, NO Levenshtein. If the LLM emits
 * "the Drowned Quarter" for an entity "The Drowned Quarter", resolution
 * still misses — that's a real model error to surface, not paper over.
 */
export function normalizeName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ')
}
