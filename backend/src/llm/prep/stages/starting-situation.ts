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
import { generateObject } from '../../ai.js'
import { LlmStructuredOutputError } from '../../errors.js'
import { z } from 'zod'
import { SONNET } from '../../models.js'
import { renderVocabularyRegistry } from '../vocabulary-renderer.js'
import type { VocabularyRegistry } from '../../schemas/vocabulary-registry.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/starting-situation.txt'),
  'utf8',
)

const locationHookSchema = z.object({
  // myth-k1ee: short evocative scene title surfaced by the starting-
  // situations picker. The LLM emits this; the worker passes it through
  // verbatim into starting_situation_entries[].title.
  title: z.string().min(5).max(60),
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
  readonly vocabularyRegistry: VocabularyRegistry
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
  const prompt = renderPrompt(args)

  let result = await generateObject({
    model: SONNET,
    schema: StartingSituationsSchema,
    prompt,
    temperature: 0.7,
    maxRetries: 3,
    callSite: 'starting-situation',
    schemaName: 'StartingSituationsSchema',
  })
  /* c8 ignore next 2 */
  let inputTokens = result.usage.inputTokens ?? 0
  let outputTokens = result.usage.outputTokens ?? 0

  let resolved = await resolveLocationEntries(client, args.worldId, result.output.location_hooks)
  if (resolved === null) {
    // myth-xg6p T3: one constrained-names retry before surfacing as a
    // structural failure. The wrapper's repair pipeline only fires on
    // schema-shape errors; a name-miss is application-level and handled here.
    const validNames = await listLocationNames(client, args.worldId)
    const retryPrompt = `${prompt}\n\nIMPORTANT: choose location_name values EXACTLY from this list of existing locations: ${validNames.join(', ')}.`
    result = await generateObject({
      model: SONNET,
      schema: StartingSituationsSchema,
      prompt: retryPrompt,
      temperature: 0.7,
      maxRetries: 3,
      callSite: 'starting-situation',
      schemaName: 'StartingSituationsSchema',
    })
    /* c8 ignore next 2 */
    inputTokens += result.usage.inputTokens ?? 0
    outputTokens += result.usage.outputTokens ?? 0
    resolved = await resolveLocationEntries(client, args.worldId, result.output.location_hooks)
    if (resolved === null) {
      throw new LlmStructuredOutputError(
        'starting-situation: location_name values cannot be resolved to entities after one retry',
      )
    }
  }

  await client.query(`UPDATE worlds SET starting_situations = $2 WHERE id = $1`, [
    args.worldId,
    JSON.stringify(result.output),
  ])

  const entries = resolved.map((r, index) => ({
    index,
    title: r.title,
    locationEntityId: r.locationEntityId,
    locationName: r.locationName,
    prose: r.prose,
  }))
  await client.query(`UPDATE worlds SET starting_situation_entries = $2::jsonb WHERE id = $1`, [
    args.worldId,
    JSON.stringify(entries),
  ])

  return {
    costUsd: computeCostUsd({ inputTokens, outputTokens }),
    inputTokens,
    outputTokens,
  }
}

function renderPrompt(args: StartingSituationArgs): string {
  return PROMPT_TEMPLATE.replace('{{name}}', args.worldName)
    .replace('{{tone}}', args.tone)
    .replace('{{themes}}', args.themes)
    .replace('{{key_tensions}}', args.keyTensions)
    .replace('{{locations_summary}}', args.locationsSummary)
    .replace('{{npcs_summary}}', args.npcsSummary)
    .replace('{{factions_summary}}', args.factionsSummary)
    .replace('{{canonical_names}}', args.canonicalNames)
    .replace('{{vocabularyRegistry}}', renderVocabularyRegistry(args.vocabularyRegistry))
}

interface ResolvedEntry {
  readonly title: string
  readonly locationEntityId: string
  readonly locationName: string
  readonly prose: string
}

async function resolveLocationEntries(
  client: PoolClient,
  worldId: string,
  hooks: readonly LocationHook[],
): Promise<readonly ResolvedEntry[] | null> {
  const r = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM entities WHERE world_id = $1 AND entity_type = 'location'`,
    [worldId],
  )
  // Map lower-cased name -> { id, name } so we can resolve the LLM's
  // case-insensitive match back to the canonical entity name (used for
  // entries[].locationName so the dev-tool surfaces what the seed row
  // actually stores, not a re-cased copy of the LLM's emission).
  const byLowerName = new Map<string, { id: string; name: string }>()
  for (const row of r.rows) byLowerName.set(row.name.toLowerCase(), row)
  const out: ResolvedEntry[] = []
  for (const hook of hooks) {
    const match = byLowerName.get(hook.location_name.toLowerCase())
    if (match === undefined) return null
    out.push({
      title: hook.title,
      locationEntityId: match.id,
      locationName: match.name,
      prose: hook.why_interesting,
    })
  }
  return out
}

async function listLocationNames(
  client: PoolClient,
  worldId: string,
): Promise<readonly string[]> {
  const r = await client.query<{ name: string }>(
    `SELECT name FROM entities WHERE world_id = $1 AND entity_type = 'location'`,
    [worldId],
  )
  return r.rows.map((row) => row.name)
}
