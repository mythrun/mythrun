// backend/src/llm/prep/vocabulary-renderer.ts
//
// myth-pfke: pure deterministic renderer for the per-world vocabulary
// registry. Pure function; no I/O, no LLM cost. Called by downstream
// stage handlers (and by FT/ST/Scribe when those land) to turn the
// stored jsonb document into a prose paragraph that gets injected into
// the system prompt at the {{vocabularyRegistry}} placeholder.

import type { VocabularyRegistry } from '../schemas/vocabulary-registry.js'

export function renderVocabularyRegistry(registry: VocabularyRegistry): string {
  if (registry.entries.length === 0 && registry.adjacent_franchises.length === 0) {
    return 'No registered vocabulary for this world.'
  }
  const lines: string[] = []
  if (registry.adjacent_franchises.length > 0) {
    lines.push(
      `Adjacent franchises whose iconic vocabulary you must AVOID in your output: ${registry.adjacent_franchises.join(', ')}.`,
    )
  }
  if (registry.entries.length > 0) {
    lines.push("This world's distinctive vocabulary:")
    for (const entry of registry.entries) {
      const avoidance = entry.avoids ? ` (use instead of "${entry.avoids}")` : ''
      const usage = entry.usage_notes ? ` — ${entry.usage_notes}` : ''
      lines.push(`- "${entry.term}"${avoidance}: ${entry.definition}${usage}`)
    }
  }
  return lines.join('\n')
}
