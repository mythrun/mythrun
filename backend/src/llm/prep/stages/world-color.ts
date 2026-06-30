// backend/src/llm/prep/stages/world-color.ts
//
// MYT-87 T8: the world-gen colour stage. Picks the world's two-stop
// `WorldColor` dither identity (the per-world pigment pair the campaign hub
// renders) from the world's vibe (name / concept / tone / themes).
//
// A single non-streaming Haiku `generateObject` call, structurally constrained
// to the curated palette by `WorldColorPairSchema` — the LLM cannot emit an
// off-brand colour. The proposed pair is contrast-guarded
// (`contrastRatio(from, to) >= CONTRAST_FLOOR`); on a miss the stage RE-ROLLS,
// feeding the rejected pair back into the prompt so the model avoids it. The
// aesthetic choice stays with the LLM the whole way (ZFC) — the stage never
// snaps a colour deterministically. The passing pair persists via
// `repo.worlds.setColorPair` (an idempotent SET).
//
// Placed AFTER concept_intake in the stage list so tone/themes are loaded.

import type { Repo } from '../../../repo/index.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { generateObject } from '../../ai.js'
import { HAIKU } from '../../models.js'
import { logger } from '../../logger.js'
import {
  WorldColorPairSchema,
  WORLD_COLOR_PIGMENTS,
  WORLD_COLOR_RAMP_STEPS,
  type WorldColorPair,
} from '@mythrun/contract'
import { contrastRatio, CONTRAST_FLOOR } from '../world-color-palette.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/world-color.txt'),
  'utf8',
)

// The palette names rendered into the prompt, grouped by namespace. Sourced
// from the contract's curated lists so a future palette change can't drift the
// prompt out of sync with the schema the call is constrained to.
const PALETTE_LIST = [
  `Pigments: ${WORLD_COLOR_PIGMENTS.join(', ')}`,
  `Paper & ember ramp steps: ${WORLD_COLOR_RAMP_STEPS.join(', ')}`,
].join('\n')

// Bounded re-roll budget. The curated palette has many high-contrast pairs
// (every pale-paper ↔ pigment cover clears ~3.8:1), so a passing pair lands
// well within three Haiku attempts in practice.
const MAX_COLOR_ATTEMPTS = 3

// Anthropic Haiku 4.5 pricing per https://www.anthropic.com/pricing
// (verify quarterly). $1/MTok input, $5/MTok output. Held local to the stage —
// see concept-intake.ts for why each stage owns its own constants.
const HAIKU_INPUT_PER_MTOK = 1.0
const HAIKU_OUTPUT_PER_MTOK = 5.0

function computeCostUsd(usage: { inputTokens: number; outputTokens: number }): number {
  return (
    (usage.inputTokens / 1_000_000) * HAIKU_INPUT_PER_MTOK +
    (usage.outputTokens / 1_000_000) * HAIKU_OUTPUT_PER_MTOK
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
    'These pairs were already rejected — the two colours sat too close in ' +
    'contrast to read as distinct. Do NOT repeat them; pick a pair with a ' +
    `clearer light/dark split:\n${lines}\n\n`
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
  // Best-of fallback: the highest-contrast pair seen so far, used only if every
  // attempt misses the floor (near-impossible given the palette). Persisting
  // the most-legible of the LLM's OWN proposals is mechanical selection, not a
  // deterministic colour snap — so a decorative choice can never fail world-gen.
  let fallback: WorldColorPair | undefined
  let fallbackContrast = -Infinity

  for (let attempt = 0; attempt < MAX_COLOR_ATTEMPTS && chosen === undefined; attempt++) {
    const result = await generateObject({
      model: HAIKU,
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
    const ratio = contrastRatio(pair.from, pair.to)
    if (ratio >= CONTRAST_FLOOR) {
      chosen = pair
    } else {
      rejected.push(pair)
      if (ratio > fallbackContrast) {
        fallback = pair
        fallbackContrast = ratio
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
        event: 'world_color.contrast_floor_exhausted',
        worldId: args.worldId,
        attempts: MAX_COLOR_ATTEMPTS,
        contrast: fallbackContrast,
      },
      'world-color: no pair cleared the contrast floor; persisting the most-legible proposal',
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
