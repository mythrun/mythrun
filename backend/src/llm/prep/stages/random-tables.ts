// backend/src/llm/prep/stages/random-tables.ts
//
// Per MYT-51 D6 + parent spec §3.5. Stage 5 of world gen.
// Generates 2 d20 tables (20 entries each) and persists to
// `random_tables` + `random_table_entries`.
//
// Runs on HAIKU (spec §3.5). Random tables are structurally simple and
// high-volume entries; Haiku is the right tier for variance-without-spend.
// The cost helper here uses Haiku pricing, not Sonnet. This is the only
// stage in T6 that breaks from Sonnet pricing — see report-back for context.
//
// Single Haiku call via `generateText` + `Output.object({ schema })`
// (AI SDK v6 canonical pattern).
//
// `seedTablesBlock` is rendered upstream by the worker (which reads
// `data/tables/seed-tables.json` and formats it). Keeping the file I/O
// out of this module preserves the unit-test boundary (no fs reads here)
// and matches the test pattern from T3/T4/T5.

import type { Repo } from '../../../repo/index.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { generateObject } from '../../ai.js'
import { z } from 'zod'
import { HAIKU } from '../../models.js'
import { renderVocabularyRegistry } from '../vocabulary-renderer.js'
import type { VocabularyRegistry } from '../../schemas/vocabulary-registry.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/random-tables.txt'),
  'utf8',
)

const tableEntrySchema = z.object({
  roll_min: z.number().int().min(1).max(20),
  roll_max: z.number().int().min(1).max(20),
  content: z.string().min(1).max(600),
})

const randomTableSchema = z.object({
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(80),
  entries: z.array(tableEntrySchema).length(20),
})

const RandomTablesSchema = z.object({
  tables: z.array(randomTableSchema).length(2),
})

export interface RandomTablesArgs {
  readonly worldId: string
  readonly worldName: string
  readonly tone: string
  readonly themes: string
  readonly era: string
  readonly geographySummary: string
  readonly seedTablesBlock: string
  readonly vocabularyRegistry: VocabularyRegistry
}

export interface StageCostResult {
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
}

// Anthropic Haiku 4.5 pricing per https://www.anthropic.com/pricing
// (verify quarterly). $1/MTok input, $5/MTok output. Held local to the
// stage — see concept-intake.ts for why each stage owns its own constants
// rather than sharing a module.
const HAIKU_INPUT_PER_MTOK = 1.0
const HAIKU_OUTPUT_PER_MTOK = 5.0

function computeCostUsd(usage: { inputTokens: number; outputTokens: number }): number {
  return (
    (usage.inputTokens / 1_000_000) * HAIKU_INPUT_PER_MTOK +
    (usage.outputTokens / 1_000_000) * HAIKU_OUTPUT_PER_MTOK
  )
}

export async function runRandomTablesStage(
  repo: Repo,
  args: RandomTablesArgs,
): Promise<StageCostResult> {
  // Function replacers: every value is user/LLM-derived, so a `$&`/`$'`-style
  // sequence in it must splice in literally (a plain string replacement would
  // read those as special patterns).
  const prompt = PROMPT_TEMPLATE.replaceAll('{{name}}', () => args.worldName)
    .replace('{{tone}}', () => args.tone)
    .replace('{{themes}}', () => args.themes)
    .replace('{{era}}', () => args.era)
    .replace('{{geography_summary}}', () => args.geographySummary)
    .replace('{{seed_tables}}', () => args.seedTablesBlock)
    .replace('{{vocabularyRegistry}}', () => renderVocabularyRegistry(args.vocabularyRegistry))

  const result = await generateObject({
    model: HAIKU,
    schema: RandomTablesSchema,
    prompt,
    temperature: 0.8,
    maxRetries: 3,
    callSite: 'random-tables',
    schemaName: 'RandomTablesSchema',
  })

  // Idempotency: delete prior rows for this world before re-inserting.
  // Matches the §3 "idempotent persisters" rule — retried stages start
  // from a clean slate for their persistence scope. Writes only (LLM done —
  // MYT-55); SQL byte-identical, relocated into the randomTables binder.
  await repo.transaction(async (tx) => {
    await tx.randomTables.deleteByWorld(args.worldId)
    for (const table of result.output.tables) {
      const tableId = await tx.randomTables.insertTable({
        worldId: args.worldId,
        name: table.name,
        category: table.category,
      })
      await tx.randomTables.insertEntries(tableId, table.entries)
    }
  })

  return {
    costUsd: computeCostUsd({
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    }),
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
  }
}
