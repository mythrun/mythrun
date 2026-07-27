// backend/src/llm/prep/stages/vocabulary-intake.ts
//
// myth-pfke T5: stage 1.5 (vocabulary_intake) handler. Generates the
// world's distinctive vocabulary registry + identifies adjacent IP
// franchises. Single non-streaming Sonnet generateObject call via the
// canonical ai.ts wrapper (repair-fallback applies on schema-validation
// failure). Stamps source='stage_1_5' + access_level='known' on each
// returned entry, persists to worlds.vocabulary_registry, returns the
// aggregated cost.

import type { Repo } from '../../../repo/index.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { generateObject } from '../../ai.js'
import { SONNET } from '../../models.js'
import {
  VocabularyIntakeOutputSchema,
  type VocabularyRegistry,
} from '../../schemas/vocabulary-registry.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/vocabulary-intake.txt'),
  'utf8',
)

// Anthropic Sonnet pricing per https://www.anthropic.com/pricing.
// Held local to the stage so a per-stage tier change is one-file scoped.
const SONNET_INPUT_PER_MTOK = 3.0
const SONNET_OUTPUT_PER_MTOK = 15.0

function computeCostUsd(usage: { inputTokens: number; outputTokens: number }): number {
  return (
    (usage.inputTokens / 1_000_000) * SONNET_INPUT_PER_MTOK +
    (usage.outputTokens / 1_000_000) * SONNET_OUTPUT_PER_MTOK
  )
}

export interface VocabularyIntakeArgs {
  readonly worldId: string
  readonly worldName: string
  readonly concept: string
  readonly tone: string
  readonly themes: string
  readonly era: string
  readonly geographySummary: string
  readonly politicalSummary: string
  readonly keyTensions: string
}

export interface StageCostResult {
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
}

export async function runVocabularyIntakeStage(
  repo: Repo,
  args: VocabularyIntakeArgs,
): Promise<StageCostResult> {
  // Function replacers: every value is user/LLM-derived (the concept is user
  // input), so a `$&`/`$'`-style sequence must splice in literally rather than
  // being read as a special replacement pattern.
  const prompt = PROMPT_TEMPLATE
    .replace('{{worldName}}', () => args.worldName)
    .replace('{{concept}}', () => args.concept)
    .replace('{{tone}}', () => args.tone)
    .replace('{{themes}}', () => args.themes)
    .replace('{{era}}', () => args.era)
    .replace('{{geographySummary}}', () => args.geographySummary)
    .replace('{{politicalSummary}}', () => args.politicalSummary)
    .replace('{{keyTensions}}', () => args.keyTensions)

  const result = await generateObject({
    model: SONNET,
    schema: VocabularyIntakeOutputSchema,
    schemaName: 'VocabularyIntakeOutputSchema',
    callSite: 'vocabulary-intake',
    prompt,
    maxRetries: 3,
  })

  // Stamp source + access_level on each entry (the model omits both per
  // the IntakeOutput schema; the handler applies them so storage is
  // canonical). adjacent_franchises is always empty from stage 1.5 —
  // IP-mirror detection lives in the paint-job-validator at concept_intake.
  // See the schema's header comment for the design rationale.
  const registry: VocabularyRegistry = {
    entries: result.output.entries.map((e) => ({
      ...e,
      source: 'stage_1_5' as const,
      access_level: 'known' as const,
    })),
    adjacent_franchises: [],
  }

  // Persist in a short transaction (writes only — LLM call already done;
  // MYT-55). SQL byte-identical, relocated into the worlds binder.
  await repo.transaction((tx) =>
    tx.worlds.setVocabularyRegistry(args.worldId, JSON.stringify(registry)),
  )

  // LanguageModelUsage exposes token fields as `number | undefined`
  // (the SDK normalizes after streaming-finish). Default to 0 to keep the
  // downstream StageCostResult shape strict-number; matches the convention
  // used by paint-job-validator.addUsage().
  const inputTokens = result.usage.inputTokens ?? 0
  const outputTokens = result.usage.outputTokens ?? 0

  return {
    costUsd: computeCostUsd({ inputTokens, outputTokens }),
    inputTokens,
    outputTokens,
  }
}
