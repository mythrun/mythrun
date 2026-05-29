// backend/src/llm/prep/stages/concept-intake.ts
//
// Per MYT-51 D6 + parent spec §3.1. Stage 1 of world gen.
// Generates a structured WorldConcept and persists to worlds columns.
// Wrapped in the paint-job-validator loop (D6) — the validator owns retries
// and aggregates generator + judge usage into a single totalUsage tally.
//
// Cost is computed against Sonnet pricing because the validator drives
// Sonnet (T5). When parent spec §3.1 model assignment shifts to Opus at
// runtime, this constant flips — for the non-streaming launch the
// validator is fixed on Sonnet.

import type { PoolClient } from 'pg'
import { withTransaction } from '../../../db/transaction.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { z } from 'zod'
import { validateAndGenerateConcept } from '../paint-job-validator.js'
import type { SynthesizerOutput } from '../synthesize-concept.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/concept-intake.txt'),
  'utf8',
)

export const WorldConceptSchema = z.object({
  name: z.string().min(2).max(120),
  tone: z.string().min(10).max(400),
  themes: z.string().min(10).max(400),
  geography_summary: z.string().min(20).max(1200),
  political_summary: z.string().min(20).max(1200),
  era: z.string().min(2).max(400),
  key_tensions: z.string().min(20).max(1200),
  follow_up_questions: z.string().min(10).max(800),
})
export type WorldConcept = z.infer<typeof WorldConceptSchema>

export interface ConceptIntakeArgs {
  readonly worldId: string
  readonly conceptText: string
  readonly intentSummary: SynthesizerOutput['intentSummary'] | null
}

// Per-stage cost result shape — duplicated by each stage handler so a future
// model-tier change (e.g. concept_intake → Opus) doesn't drag the other
// stages along. The processor reads these into `pipeline_runs.cost_usd`.
export interface StageCostResult {
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
}

// Anthropic Sonnet 4.6 pricing per https://www.anthropic.com/pricing
// (verify quarterly). $3/MTok input, $15/MTok output. Held local to the
// stage so a per-stage tier change is one-file scoped; promoting to a
// shared module is deferred until a stage actually wants per-tier knobs.
const SONNET_INPUT_PER_MTOK = 3.0
const SONNET_OUTPUT_PER_MTOK = 15.0

function computeCostUsd(usage: { inputTokens: number; outputTokens: number }): number {
  return (
    (usage.inputTokens / 1_000_000) * SONNET_INPUT_PER_MTOK +
    (usage.outputTokens / 1_000_000) * SONNET_OUTPUT_PER_MTOK
  )
}

export async function runConceptIntakeStage(
  client: PoolClient,
  args: ConceptIntakeArgs,
): Promise<StageCostResult> {
  const intentBlock =
    args.intentSummary === null
      ? '(none — freeform mode)'
      : `aesthetics: ${args.intentSummary.aesthetics.join(', ')}\nthemes: ${args.intentSummary.themes.join(', ')}`
  const prompt = PROMPT_TEMPLATE.replace('{{concept}}', args.conceptText).replace(
    '{{intent}}',
    intentBlock,
  )

  const result = await validateAndGenerateConcept({
    basePrompt: prompt,
    schema: WorldConceptSchema,
    schemaName: 'WorldConceptSchema',
  })

  // Persist in a short transaction (LLM call is already done — see
  // backend/src/db/transaction.ts for why the BEGIN/COMMIT scope is
  // post-LLM only).
  await withTransaction(client, async () => {
    await client.query(
      `UPDATE worlds SET
         name = $2, tone = $3, themes = $4, geography_summary = $5,
         political_summary = $6, era = $7, key_tensions = $8, follow_up_questions = $9
       WHERE id = $1`,
      [
        args.worldId,
        result.draft.name,
        result.draft.tone,
        result.draft.themes,
        result.draft.geography_summary,
        result.draft.political_summary,
        result.draft.era,
        result.draft.key_tensions,
        result.draft.follow_up_questions,
      ],
    )
    // myth-4lhr: also propagate the LLM-synthesized name to the campaign
    // that owns this world. The campaigns.name was inserted as 'Untitled'
    // at create-time; this is where it gets its real name. Users can
    // subsequently rename via PATCH /api/campaigns/:campaignId/name.
    await client.query(
      `UPDATE campaigns SET name = $2 WHERE world_id = $1 AND name = 'Untitled'`,
      [args.worldId, result.draft.name],
    )
  })

  return {
    costUsd: computeCostUsd({
      inputTokens: result.totalUsage.inputTokens,
      outputTokens: result.totalUsage.outputTokens,
    }),
    inputTokens: result.totalUsage.inputTokens,
    outputTokens: result.totalUsage.outputTokens,
  }
}
