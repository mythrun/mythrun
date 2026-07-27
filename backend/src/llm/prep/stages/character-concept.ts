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
  type Pronouns,
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

// myth-gdycq: the token → written-value map. The VALUE is what gets pinned into
// the concept and read by every later prompt, so it is short and canonical; the
// prompt line beside it (below) carries the instruction. `name_only` is a real
// answer, not an absence: the character is referred to by name, never by a
// pronoun.
const PRONOUN_VALUE: Record<Pronouns, string> = {
  she_her: 'she/her',
  he_him: 'he/him',
  they_them: 'they/them',
  name_only: 'name only',
}

// Render the {{guidedChoices}} prompt block: one `field: value` line per
// present pick, or the explicit none-marker so the template's framing text
// reads coherently on submissions that carry no picks at all.
function renderGuidedChoices(picks: GuidedChoices): string {
  const lines = [
    picks.class !== undefined ? `class: ${picks.class}` : null,
    picks.subclass !== undefined ? `subclass: ${picks.subclass}` : null,
    picks.species !== undefined ? `species: ${picks.species}` : null,
    picks.background !== undefined ? `background: ${picks.background}` : null,
    // Spelled out rather than echoed as a bare token: the model has to WRITE in
    // these terms, not just copy them into a field.
    picks.pronouns !== undefined
      ? picks.pronouns === 'name_only'
        ? 'pronouns: name only — never use a pronoun for this character; use their name, or rewrite the sentence'
        : `pronouns: ${PRONOUN_VALUE[picks.pronouns]} — use these in every sentence you write about this character`
      : null,
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
  //
  // myth-gdycq pins the player's PRONOUNS the same way and for the same reason:
  // run 3 answered "he/his" for a character whose description never specified a
  // gender, and a player who states how they want to be referred to must not
  // depend on prompt compliance to be heard. No pick → the model's own value
  // stands (the prompt's they/them default governs the unspecified case).
  const concept: CharacterConceptOutput = {
    ...result.output,
    ...(picks.subclass !== undefined ? { subclass: picks.subclass } : {}),
    ...(picks.pronouns !== undefined ? { pronouns: PRONOUN_VALUE[picks.pronouns] } : {}),
  }

  return {
    concept,
    costUsd:
      (inputTokens / 1_000_000) * SONNET_INPUT_PER_MTOK +
      (outputTokens / 1_000_000) * SONNET_OUTPUT_PER_MTOK,
    inputTokens,
    outputTokens,
  }
}
