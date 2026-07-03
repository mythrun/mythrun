// MYT-89 Task A1 — the rework primitive. Given a synthesized world CONCEPT
// and a player's CHANGE NOTE, produce a REVISED original concept that honors
// the note while keeping what worked. The rework endpoint (Task A4) calls this.
//
// Mirrors synthesize-concept.ts: one Sonnet call through the canonical
// `generateObject` wrapper (schema-repair fallback + structured diagnostics),
// same output contract (`SynthesizerOutput` — concept + intentSummary), same
// temperature 0.9 for creative variance. The prompt is a `.txt` template
// (LLM prompts are never inline strings) with {priorConcept}/{changeNote}
// placeholders. The wrapper's return is re-validated against the schema so
// the primitive fails loud on a malformed tree rather than leaking it upward.

import { generateObject } from '../ai.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { SONNET } from '../models.js'
import { SynthesizerOutput } from './synthesize-concept.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../prompts/prep/revise-concept.txt'),
  'utf8',
)

// Function replacers so a `$` in the concept / note is inserted literally
// (String.prototype.replace treats `$&`, `$1`, etc. as special in a string
// replacement — a replacer function bypasses that).
function buildPrompt(priorConcept: string, changeNote: string): string {
  return PROMPT_TEMPLATE.replace('{priorConcept}', () => priorConcept).replace(
    '{changeNote}',
    () => changeNote,
  )
}

export async function reviseConcept(
  priorConcept: string,
  changeNote: string,
): Promise<SynthesizerOutput> {
  const result = await generateObject({
    model: SONNET,
    schema: SynthesizerOutput,
    prompt: buildPrompt(priorConcept, changeNote),
    temperature: 0.9,
    maxRetries: 3,
    callSite: 'revise-concept',
    schemaName: 'SynthesizerOutput',
  })
  return SynthesizerOutput.parse(result.output)
}
