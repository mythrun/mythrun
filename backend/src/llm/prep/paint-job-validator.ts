// Per MYT-51 D6 (revised after Wyvern-C1 + Wyvern-C2):
//   - Inner generateText call uses maxRetries: 1 (validator is sole retry
//     authority; without this the SDK's internal 3-retry policy and the
//     validator's 3-attempt loop multiply into 12 worst-case Sonnet calls).
//   - Distinct judge prompt (fresh Sonnet call, not a self-check).
//   - On flag: discard the rejected draft entirely; retry with a
//     fresh-direction amendment (mirroredWork + specificDriftAxes from the
//     judge's structured output) + temperature bump to 1.0.
//   - Max 3 attempts total (1 original + 2 retries).
//   - All generator + judge usage accumulates into totalUsage so the
//     stage's cost cap correctly observes every call.
//
// Uses `generateText` + `Output.object({ schema })` — the AI SDK v6
// canonical pattern. `generateObject` is deprecated in v6.

import { generateText, Output, type LanguageModelUsage } from 'ai'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { z } from 'zod'
import { SONNET } from '../models.js'

const JUDGE_TEMPLATE = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../prompts/prep/paint-job-validator.txt',
  ),
  'utf8',
)

const PaintJobJudgementSchema = z.object({
  flagged: z.boolean(),
  confidence: z.number().min(0).max(1),
  mirroredWork: z.string().nullable(),
  specificDriftAxes: z.array(z.string().min(1).max(80)).max(8),
})
export type PaintJobJudgement = z.infer<typeof PaintJobJudgementSchema>

const FLAG_THRESHOLD = 0.85
const MAX_ATTEMPTS = 3

export class PaintJobLoopExhaustedError extends Error {
  readonly code = 'concept_intake_paint_job_loop_exhausted'
  constructor(readonly lastJudgement: PaintJobJudgement) {
    super(
      `concept_intake_paint_job_loop_exhausted (last: ${lastJudgement.mirroredWork ?? 'unknown'})`,
    )
    this.name = 'PaintJobLoopExhaustedError'
  }
}

export interface ValidateAndGenerateArgs<TDraft> {
  readonly basePrompt: string
  readonly schema: z.ZodType<TDraft>
}

// `totalUsage` is normalized to the SDK's canonical names
// (inputTokens/outputTokens/totalTokens) but materialized as plain `number`
// (the SDK reports each as `number | undefined`; we coalesce undefined to 0
// during accumulation so downstream callers can sum without nullable math).
// Matches `synthesize-concept.ts` (T3) conventions.
export interface ValidateAndGenerateResult<TDraft> {
  readonly draft: TDraft
  readonly attempts: number
  readonly totalUsage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
}

export async function validateAndGenerateConcept<TDraft>(
  args: ValidateAndGenerateArgs<TDraft>,
): Promise<ValidateAndGenerateResult<TDraft>> {
  let totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let lastJudgement: PaintJobJudgement | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const prompt: string =
      attempt === 1
        ? args.basePrompt
        : buildRetryPrompt(args.basePrompt, lastJudgement)
    const temperature = attempt === 1 ? 0.9 : 1.0

    const genResult = await generateText({
      model: SONNET,
      output: Output.object<TDraft>({ schema: args.schema }),
      prompt,
      temperature,
      maxRetries: 1, // validator loop is the sole retry authority (Wyvern-C1)
    })
    totalUsage = addUsage(totalUsage, genResult.usage)

    const judgeResult = await generateText({
      model: SONNET,
      output: Output.object({ schema: PaintJobJudgementSchema }),
      prompt: JUDGE_TEMPLATE.replace(
        '{{draft}}',
        JSON.stringify(genResult.output, null, 2),
      ),
      temperature: 0.1,
      maxRetries: 3,
    })
    totalUsage = addUsage(totalUsage, judgeResult.usage)
    lastJudgement = judgeResult.output

    if (
      !judgeResult.output.flagged ||
      judgeResult.output.confidence <= FLAG_THRESHOLD
    ) {
      return {
        draft: genResult.output,
        attempts: attempt,
        totalUsage,
      }
    }
  }

  // Loop exhausted: lastJudgement is guaranteed non-null (we always
  // assign it inside the loop and we only fall through after MAX_ATTEMPTS).
  if (lastJudgement === null) {
    throw new Error('paint_job_validator_invariant_violated')
  }
  throw new PaintJobLoopExhaustedError(lastJudgement)
}

function buildRetryPrompt(
  basePrompt: string,
  lastJudgement: PaintJobJudgement | null,
): string {
  const driftAxes = lastJudgement?.specificDriftAxes.join(', ') ?? ''
  const mirroredWork =
    lastJudgement?.mirroredWork ?? 'a recognizable copyrighted work'
  return (
    basePrompt +
    '\n\n---\n\n' +
    `IMPORTANT (retry pass): an earlier draft of this world mirrored ${mirroredWork} along these axes: ${driftAxes}. ` +
    `Do NOT iterate on that direction. Explore a fundamentally different aesthetic register, ` +
    `different faction archetype, different plot shape. The output must read as a fresh original world, ` +
    `not a corrected version of the prior attempt.`
  )
}

function addUsage(
  a: { inputTokens: number; outputTokens: number; totalTokens: number },
  b: LanguageModelUsage,
): { inputTokens: number; outputTokens: number; totalTokens: number } {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    totalTokens: a.totalTokens + (b.totalTokens ?? 0),
  }
}
