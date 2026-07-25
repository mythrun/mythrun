// backend/src/llm/prep/stages/character-concept.ts
//
// MYT-53 stage 2: Sonnet generateObject. Produces the narrative half of
// the character (name + race + class + background + traits + backstory).
// Does NOT persist to the characters table — stage 3 (character-sheet)
// owns the INSERT because characters.str/dex/.../hit_points/armor_class
// are NOT NULL and only stage 3 generates them. The processor threads
// stage 2's output into stage 3's input.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { generateObject } from '../../ai.js'
import { resolveIncludes } from '../../prompts.js'
import { SONNET } from '../../models.js'
import {
  CharacterConceptOutputSchema,
  GuidedChoicesSchema,
  type CharacterConceptOutput,
  type GuidedChoices,
} from '../../schemas/character-concept.js'
import { renderVocabularyRegistry } from '../vocabulary-renderer.js'
import type { VocabularyRegistry } from '../../schemas/vocabulary-registry.js'

const PROMPT_TEMPLATE = resolveIncludes(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../prompts/prep/character-concept.txt',
    ),
    'utf8',
  ),
)

// Anthropic Sonnet pricing per https://www.anthropic.com/pricing. Held
// local to the stage so a per-stage tier change is one-file scoped — same
// convention as vocabulary-intake.ts.
const SONNET_INPUT_PER_MTOK = 3.0
const SONNET_OUTPUT_PER_MTOK = 15.0

export interface CharacterConceptArgs {
  readonly campaignId: string
  readonly userId: string
  readonly worldId: string
  readonly worldName: string
  readonly tone: string
  readonly themes: string
  readonly era: string
  readonly geographySummary: string
  readonly politicalSummary: string
  readonly keyTensions: string
  readonly vocabularyRegistry: VocabularyRegistry
  readonly conceptText: string
  readonly guidedChoices: Record<string, unknown>
}

export interface CharacterConceptStageResult {
  readonly concept: CharacterConceptOutput
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
}

// myth-4jhrk: parse the persisted guided_choices JSONB into the typed wire
// shape. The route validated on write, so a parse miss is a legacy/foreign
// row — treated as "no picks" (freeform), never an error.
function parseGuidedChoices(raw: Record<string, unknown>): GuidedChoices {
  const parsed = GuidedChoicesSchema.safeParse(raw)
  return parsed.success ? parsed.data : {}
}

// Render the {{guidedChoices}} prompt block: one `field: value` line per
// present pick, or the explicit none-marker so the template's framing text
// reads coherently on freeform submissions.
function renderGuidedChoices(picks: GuidedChoices): string {
  const lines = [
    picks.class !== undefined ? `class: ${picks.class}` : null,
    picks.subclass !== undefined ? `subclass: ${picks.subclass}` : null,
    picks.species !== undefined ? `species: ${picks.species}` : null,
    picks.background !== undefined ? `background: ${picks.background}` : null,
  ].filter((line): line is string => line !== null)
  return lines.length > 0 ? lines.join('\n') : '(none — the player wrote a freeform concept)'
}

export async function runCharacterConceptStage(
  args: CharacterConceptArgs,
): Promise<CharacterConceptStageResult> {
  const picks = parseGuidedChoices(args.guidedChoices)

  // Function replacers: every value is user/LLM-derived (the concept text is
  // user input), so a `$&`/`$'`-style sequence must splice in literally rather
  // than being read as a special replacement pattern.
  const prompt = PROMPT_TEMPLATE.replace('{{worldName}}', () => args.worldName)
    .replace('{{tone}}', () => args.tone)
    .replace('{{themes}}', () => args.themes)
    .replace('{{era}}', () => args.era)
    .replace('{{geographySummary}}', () => args.geographySummary)
    .replace('{{politicalSummary}}', () => args.politicalSummary)
    .replace('{{keyTensions}}', () => args.keyTensions)
    .replace(
      '{{vocabularyRegistry}}',
      () => renderVocabularyRegistry(args.vocabularyRegistry),
    )
    .replace('{{conceptText}}', () => args.conceptText)
    .replace('{{guidedChoices}}', () => renderGuidedChoices(picks))

  const result = await generateObject({
    model: SONNET,
    schema: CharacterConceptOutputSchema,
    schemaName: 'CharacterConceptOutputSchema',
    callSite: 'character-concept',
    prompt,
    temperature: 0.7,
    maxRetries: 3,
  })

  // LanguageModelUsage exposes token fields as `number | undefined`; default
  // to 0 to keep StageCostResult strict-number. Matches vocabulary-intake.ts.
  /* c8 ignore start — Anthropic provider always populates these. */
  const inputTokens = result.usage.inputTokens ?? 0
  const outputTokens = result.usage.outputTokens ?? 0
  /* c8 ignore stop */

  // myth-4jhrk: the guided subclass is a KNOWN input, not the model's call —
  // OVERRIDE the echo deterministically (ZFC; mirrors the MYT-90 A4 level
  // override in the processor). The run-2 forensics showed the model dropping
  // the pick under the canonical-vocabulary framing; the pin makes the drop
  // structurally impossible regardless of prompt compliance.
  const concept: CharacterConceptOutput =
    picks.subclass !== undefined
      ? { ...result.output, subclass: picks.subclass }
      : result.output

  return {
    concept,
    costUsd:
      (inputTokens / 1_000_000) * SONNET_INPUT_PER_MTOK +
      (outputTokens / 1_000_000) * SONNET_OUTPUT_PER_MTOK,
    inputTokens,
    outputTokens,
  }
}
