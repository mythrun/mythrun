// backend/src/llm/prep/stages/starting-situation.ts
//
// Per MYT-51 D6 + parent spec §3.4. Stage 4 of world gen.
// Generates 3 location hooks and persists the JSON-encoded list to
// `worlds.starting_situations` (TEXT column — schema 001).
//
// Single Sonnet call via `generateText` + `Output.object({ schema })`
// (AI SDK v6 canonical pattern). No paint-job validator — the gating
// concern (mirroring a copyrighted work) is concept-intake's job;
// starting-situation only references existing world state.

import type { PoolClient } from 'pg'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { generateText, Output } from 'ai'
import { z } from 'zod'
import { SONNET } from '../../models.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/starting-situation.txt'),
  'utf8',
)

const locationHookSchema = z.object({
  location_name: z.string().min(1).max(200),
  why_interesting: z.string().min(10).max(600),
})

export const StartingSituationsSchema = z.object({
  location_hooks: z.array(locationHookSchema).length(3),
})
export type StartingSituations = z.infer<typeof StartingSituationsSchema>
export type LocationHook = z.infer<typeof locationHookSchema>

// Inputs the worker assembles from prior-stage outputs. In non-streaming
// launch the stages-2-and-3 summary fields will arrive as
// "(stage not implemented yet)" — see the prompt's header comment.
export interface StartingSituationArgs {
  readonly worldId: string
  readonly worldName: string
  readonly tone: string
  readonly themes: string
  readonly keyTensions: string
  readonly locationsSummary: string
  readonly npcsSummary: string
  readonly factionsSummary: string
  readonly canonicalNames: string
}

export interface StageCostResult {
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
}

const SONNET_INPUT_PER_MTOK = 3.0
const SONNET_OUTPUT_PER_MTOK = 15.0

function computeCostUsd(usage: { inputTokens: number; outputTokens: number }): number {
  return (
    (usage.inputTokens / 1_000_000) * SONNET_INPUT_PER_MTOK +
    (usage.outputTokens / 1_000_000) * SONNET_OUTPUT_PER_MTOK
  )
}

export async function runStartingSituationStage(
  client: PoolClient,
  args: StartingSituationArgs,
): Promise<StageCostResult> {
  const prompt = PROMPT_TEMPLATE.replace('{{name}}', args.worldName)
    .replace('{{tone}}', args.tone)
    .replace('{{themes}}', args.themes)
    .replace('{{key_tensions}}', args.keyTensions)
    .replace('{{locations_summary}}', args.locationsSummary)
    .replace('{{npcs_summary}}', args.npcsSummary)
    .replace('{{factions_summary}}', args.factionsSummary)
    .replace('{{canonical_names}}', args.canonicalNames)

  const result = await generateText({
    model: SONNET,
    output: Output.object({ schema: StartingSituationsSchema }),
    prompt,
    temperature: 0.7,
    maxRetries: 3,
  })

  await client.query(`UPDATE worlds SET starting_situations = $2 WHERE id = $1`, [
    args.worldId,
    JSON.stringify(result.output),
  ])

  /* c8 ignore start — `?? 0` fallbacks: the Anthropic SDK always
   * populates inputTokens/outputTokens on the final usage emission;
   * the optional-chain narrowing is defense-in-depth. */
  return {
    costUsd: computeCostUsd({
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    }),
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
  }
  /* c8 ignore stop */
}
