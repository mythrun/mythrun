// backend/src/llm/prep/stages/concept-intake.ts
//
// Per MYT-51 D6 + parent spec §3.1. Stage 1 of world gen.
// Generates a structured WorldConcept and persists to worlds columns.
// Wrapped in the paint-job-validator loop (D6) — the validator owns retries
// and aggregates generator + judge usage.
//
// myth-rg09: the run is now MIXED-TIER — the foundational-synthesis generator
// runs on Opus, the IP-mirror judge stays on Sonnet. Cost is therefore priced
// PER-TIER inside the validator (Opus rates for generator usage, Sonnet rates
// for judge usage) and surfaced as `result.costUsd`; this stage forwards that
// verbatim and no longer prices anything itself. The returned token totals are
// still combined counts (generator + judge) for the pipeline_runs columns.

import type { Repo } from '../../../repo/index.js'
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

const WorldConceptSchema = z.object({
  name: z.string().min(2).max(120),
  tone: z.string().min(10).max(400),
  themes: z.string().min(10).max(400),
  geography_summary: z.string().min(20).max(1200),
  political_summary: z.string().min(20).max(1200),
  era: z.string().min(2).max(400),
  key_tensions: z.string().min(20).max(1200),
  follow_up_questions: z.string().min(10).max(800),
})

export interface ConceptIntakeArgs {
  readonly worldId: string
  readonly conceptText: string
  readonly intentSummary: SynthesizerOutput['intentSummary'] | null
}

// Per-stage cost result shape — duplicated by each stage handler so a
// model-tier change doesn't drag the other stages along. The processor reads
// these into `pipeline_runs.cost_usd`. myth-rg09: concept_intake is now
// Opus (mixed-tier — Opus generator + Sonnet judge); its cost arrives
// pre-priced from the validator as `result.costUsd`.
export interface StageCostResult {
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
}

export async function runConceptIntakeStage(
  repo: Repo,
  args: ConceptIntakeArgs,
): Promise<StageCostResult> {
  const intentBlock =
    args.intentSummary === null
      ? '(none — freeform mode)'
      : `aesthetics: ${args.intentSummary.aesthetics.join(', ')}\nthemes: ${args.intentSummary.themes.join(', ')}`
  // Function replacers: the concept is user input and the intent block is
  // derived from it, so a `$&`/`$'`-style sequence must splice in literally.
  const prompt = PROMPT_TEMPLATE.replace('{{concept}}', () => args.conceptText).replace(
    '{{intent}}',
    () => intentBlock,
  )

  const result = await validateAndGenerateConcept({
    basePrompt: prompt,
    schema: WorldConceptSchema,
    schemaName: 'WorldConceptSchema',
  })

  // Persist in a short transaction (LLM call is already done — the
  // repo.transaction callback holds writes only, so the connection is never
  // idle-in-transaction while the model runs; MYT-55). SQL is byte-identical
  // to the prior inline statements — relocated into the repo binders.
  await repo.transaction(async (tx) => {
    await tx.worlds.applyConcept(args.worldId, {
      name: result.draft.name,
      tone: result.draft.tone,
      themes: result.draft.themes,
      geographySummary: result.draft.geography_summary,
      politicalSummary: result.draft.political_summary,
      era: result.draft.era,
      keyTensions: result.draft.key_tensions,
      followUpQuestions: result.draft.follow_up_questions,
    })
    // myth-4lhr: also propagate the LLM-synthesized name to the campaign
    // that owns this world. The campaigns.name was inserted as 'Untitled'
    // at create-time; this is where it gets its real name. Users can
    // subsequently rename via PATCH /api/campaigns/:campaignId/name.
    await tx.campaigns.setNameFromUntitled(args.worldId, result.draft.name)
  })

  return {
    // myth-rg09: per-tier cost (Opus generator + Sonnet judge), priced by
    // the validator. The token fields stay combined counts for pipeline_runs.
    costUsd: result.costUsd,
    inputTokens: result.totalUsage.inputTokens,
    outputTokens: result.totalUsage.outputTokens,
  }
}
