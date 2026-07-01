// backend/src/llm/prep/stages/world-color.ts
//
// MYT-87 T8 (reworked 2026-07-01): the world-gen colour stage. Picks the
// world's two-stop `WorldColor` dither identity (the per-world cover pair the
// campaign hub renders) from the world's vibe (name / concept / tone / themes).
//
// A single non-streaming SONNET `generateObject` call, structurally constrained
// to the widened per-hue ramp palette by `WorldColorPairSchema` — the LLM cannot
// emit an off-brand colour. Sonnet (not Haiku) because a blind taste-off showed
// Sonnet's restrained, often-monochromatic colour taste wins decisively; the
// once-per-world tier bump is negligible.
//
// The proposed pair is RUNG-guarded: `rungsApart(from, to) >= MIN_RUNGS`, where
// the ≥6-rung rule guarantees ~3.0+ WCAG contrast in the worst hue combo
// (enumeration-proven), so the two dither ends always read as distinct. On a
// miss the stage RE-ROLLS, feeding the rejected pair back into the prompt so the
// model avoids it. No luminance-snap — the aesthetic choice stays with the LLM
// the whole way (ZFC). The passing pair persists via `repo.worlds.setColorPair`
// (an idempotent SET).
//
// Placed AFTER concept_intake in the stage list so tone/themes are loaded.

import type { Repo } from '../../../repo/index.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { generateObject } from '../../ai.js'
import { SONNET } from '../../models.js'
import { logger } from '../../logger.js'
import {
  WorldColorPairSchema,
  WORLD_COLOR_RAMPS,
  WORLD_COLOR_STEPS,
  rungsApart,
  type WorldColorPair,
} from '@mythrun/contract'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/world-color.txt'),
  'utf8',
)

// The palette rendered into the prompt: the available hues (ramps) + the ladder
// steps. Sourced from the contract's canonical lists so a future palette change
// can't drift the prompt out of sync with the schema the call is constrained to.
const PALETTE_LIST = [
  `Hues (each available at all 10 steps): ${WORLD_COLOR_RAMPS.join(', ')}`,
  `Steps (light → dark): ${WORLD_COLOR_STEPS.join(', ')}`,
].join('\n')

// The minimum ladder distance between the two ends. Enumeration proved ≥6 rungs
// clears ~3.0:1 WCAG in the worst hue combo (5 or fewer can dip to ~2.5), so the
// dither reads as two distinct fields. This is the mechanical floor the stage
// enforces — the model keeps the aesthetic choice.
const MIN_RUNGS = 6

// Bounded re-roll budget. Both models obeyed the rung rule ~100% in testing, so
// a passing pair lands on the first attempt in practice; the budget guards a
// pathological run without letting a decorative pick fail world-gen.
const MAX_COLOR_ATTEMPTS = 3

// Anthropic Sonnet 4.6 pricing per https://www.anthropic.com/pricing
// (verify quarterly). $3/MTok input, $15/MTok output. Held local to the stage —
// see concept-intake.ts for why each stage owns its own constants.
const SONNET_INPUT_PER_MTOK = 3.0
const SONNET_OUTPUT_PER_MTOK = 15.0

function computeCostUsd(usage: { inputTokens: number; outputTokens: number }): number {
  return (
    (usage.inputTokens / 1_000_000) * SONNET_INPUT_PER_MTOK +
    (usage.outputTokens / 1_000_000) * SONNET_OUTPUT_PER_MTOK
  )
}

export interface WorldColorArgs {
  readonly worldId: string
  readonly worldName: string
  readonly concept: string
  readonly tone: string
  readonly themes: string
}

export interface StageCostResult {
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
}

function renderRejectedFeedback(rejected: readonly WorldColorPair[]): string {
  if (rejected.length === 0) return ''
  const lines = rejected.map((p) => `- from=${p.from}, to=${p.to}`).join('\n')
  return (
    'These pairs were already rejected — the two steps were fewer than 6 rungs ' +
    'apart on the 10-step ladder, so the ends do not read as distinct. Do NOT ' +
    `repeat them; pick two steps at least 6 rungs apart:\n${lines}\n\n`
  )
}

function buildPrompt(args: WorldColorArgs, rejected: readonly WorldColorPair[]): string {
  return PROMPT_TEMPLATE.replace('{{worldName}}', args.worldName)
    .replace('{{concept}}', args.concept)
    .replace('{{tone}}', args.tone)
    .replace('{{themes}}', args.themes)
    .replace('{{paletteList}}', PALETTE_LIST)
    .replace('{{rejectedFeedback}}', renderRejectedFeedback(rejected))
}

export async function runWorldColorStage(
  repo: Repo,
  args: WorldColorArgs,
): Promise<StageCostResult> {
  const rejected: WorldColorPair[] = []
  let inputTokens = 0
  let outputTokens = 0
  let chosen: WorldColorPair | undefined
  // Best-of fallback: the widest-separation pair seen so far, used only if every
  // attempt misses the rung floor (near-impossible given how reliably the models
  // obey it). Persisting the most-separated of the LLM's OWN proposals is
  // mechanical selection among its choices, not a luminance snap — so a
  // decorative pick can never fail world-gen.
  let fallback: WorldColorPair | undefined
  let fallbackRungs = -Infinity

  for (let attempt = 0; attempt < MAX_COLOR_ATTEMPTS && chosen === undefined; attempt++) {
    const result = await generateObject({
      model: SONNET,
      schema: WorldColorPairSchema,
      schemaName: 'WorldColorPairSchema',
      callSite: 'world-color',
      prompt: buildPrompt(args, rejected),
      temperature: 0.8,
      maxRetries: 3,
    })
    inputTokens += result.usage.inputTokens ?? 0
    outputTokens += result.usage.outputTokens ?? 0

    const pair = result.output
    const rungs = rungsApart(pair.from, pair.to)
    if (rungs >= MIN_RUNGS) {
      chosen = pair
    } else {
      rejected.push(pair)
      if (rungs > fallbackRungs) {
        fallback = pair
        fallbackRungs = rungs
      }
    }
  }

  const finalPair = chosen ?? fallback
  /* c8 ignore start — finalPair is undefined only if MAX_COLOR_ATTEMPTS < 1,
   * which the constant forbids: the loop always assigns `chosen` or `fallback`
   * on its first iteration. Defensive narrow for the type checker. */
  if (finalPair === undefined) {
    throw new Error('world-color: no colour pair produced')
  }
  /* c8 ignore stop */

  if (chosen === undefined) {
    logger.warn(
      {
        event: 'world_color.rung_floor_exhausted',
        worldId: args.worldId,
        attempts: MAX_COLOR_ATTEMPTS,
        rungs: fallbackRungs,
      },
      'world-color: no pair cleared the rung floor; persisting the most-separated proposal',
    )
  }

  // Persist in a short transaction (writes only — LLM calls already done;
  // MYT-55). Idempotent SET via the worlds binder.
  await repo.transaction((tx) => tx.worlds.setColorPair(args.worldId, finalPair))

  return {
    costUsd: computeCostUsd({ inputTokens, outputTokens }),
    inputTokens,
    outputTokens,
  }
}
