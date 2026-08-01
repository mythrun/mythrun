// Per MYT-51 D6 (revised after Wyvern-C1 + Wyvern-C2):
//   - Inner generator call uses maxRetries: 1 (validator is sole retry
//     authority; without this the SDK's internal 3-retry policy and the
//     validator's 3-attempt loop multiply into 12 worst-case Sonnet calls).
//   - Distinct judge prompt (fresh Sonnet call, not a self-check).
//   - On flag: discard the rejected draft entirely; retry with a
//     fresh-direction amendment (mirroredWork + specificDriftAxes from the
//     judge's structured output). No temperature lever — the generator runs
//     on Opus (myth-rg09), which ignores `temperature`; retry variation comes
//     from the amendment + the model's inherent sampling (myth-v3rq).
//   - Max 3 attempts total (1 original + 2 retries).
//   - Generator usage and judge usage accumulate SEPARATELY so cost can be
//     priced per-tier (myth-rg09); the combined token counts are still
//     surfaced for the stage's pipeline_runs input/output token columns.
//
// myth-rg09: the world-concept SYNTHESIS generator runs on OPUS for higher
// foundational-synthesis quality. The IP-mirror JUDGE stays on SONNET — it's
// a cheapest-capable classification guardrail (tiered-inference principle),
// not a synthesis call. Because the run is now mixed-tier, cost is computed
// PER-TIER via the shared `computeCostUsd` (Opus rates for generator usage,
// Sonnet rates for judge usage) and summed — NOT priced Sonnet-flat.
//
// Routes through the canonical `generateObject` wrapper (myth-t1qz):
// generator + judge both gain Sonnet-tier schema-repair fallback and
// structured diagnostic logging on failure. The previous bespoke
// `callWithRepairFallback` helper was subsumed by the wrapper.

import { z } from 'zod'
import { generateObject } from '../ai.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { OPUS, SONNET, OPUS_ID, SONNET_ID } from '../models.js'
import { computeCostUsd } from '../../billing/model-pricing.js'

const JUDGE_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../prompts/prep/paint-job-validator.txt'),
  'utf8',
)

// myth-3e4y: the judge scores TWO IP-mirror axes now, not one.
//   - structural mirroring (plot/characters/factions/setting reads as a
//     re-skin of a known work) — the original check.
//   - vocabulary mirroring (the concept invokes a single franchise so
//     directly that the world's natural vocabulary will lean into that
//     franchise's *invented* neologisms downstream: "muggle", "Statute of
//     Secrecy", "Floo", "midi-chlorian", "mithril", "Mystra", "Faerûn").
// A concept with structurally original bones can still fail on vocabulary
// (Veil & Chalk did: original Section-14 / Hedgewise / Founders'-Vault
// world-building, but the magical/mundane interface vocabulary leaked
// verbatim JKR-coined terms downstream). `failureKind` records WHICH axis
// (or both) drove the flag so the retry can steer off it precisely.
//
// `adjacentFranchise` is a soft signal independent of the flag: even a
// concept that clears the gate can be franchise-adjacent. It's surfaced on
// the result so downstream UI (world inspector / world-snapshot) can show
// "this world sits near <franchise>" without re-deriving it. Null when the
// concept invokes no single dominant franchise.
const PaintJobJudgementSchema = z.object({
  flagged: z.boolean(),
  confidence: z.number().min(0).max(1),
  mirroredWork: z.string().nullable(),
  specificDriftAxes: z.array(z.string().min(1).max(400)).max(8),
  failureKind: z.enum(['structural', 'vocabulary', 'both', 'none']),
  adjacentFranchise: z.string().min(1).max(120).nullable(),
})
export type PaintJobJudgement = z.infer<typeof PaintJobJudgementSchema>

const FLAG_THRESHOLD = 0.85
const MAX_ATTEMPTS = 3

class PaintJobLoopExhaustedError extends Error {
  readonly code = 'concept_intake_paint_job_loop_exhausted'
  // myth-uppw: terminal — the concept fundamentally mirrors a copyrighted
  // work and the judge has rejected 3 attempts at pivoting. Re-running
  // the same prompt = same flag. User must adjust the concept text.
  readonly terminal = true
  constructor(readonly lastJudgement: PaintJobJudgement) {
    super(
      /* c8 ignore start — `?? 'unknown'` arm fires only when the
       * judgement schema marks mirroredWork as undefined; tests always
       * populate it. */
      `concept_intake_paint_job_loop_exhausted (last: ${lastJudgement.mirroredWork ?? 'unknown'})`,
      /* c8 ignore stop */
    )
    this.name = 'PaintJobLoopExhaustedError'
  }
}

export interface ValidateAndGenerateArgs<TDraft> {
  readonly basePrompt: string
  readonly schema: z.ZodType<TDraft>
  // Optional human-readable schema name surfaced in wrapper diagnostic
  // logs (myth-t1qz). Defaults to 'WorldConceptDraft' when the caller
  // doesn't supply one.
  readonly schemaName?: string
  /** Cost-harness scope ids (cost wave 1 §1.0) — ride providerOptions.mythrun
   *  on BOTH legs (generator + judge) only, never the prompts. */
  readonly worldId: string
  readonly campaignId: string
}

// `totalUsage` is normalized to the SDK's canonical names
// (inputTokens/outputTokens/totalTokens) but materialized as plain `number`
// (the SDK reports each as `number | undefined`; we coalesce undefined to 0
// during accumulation so downstream callers can sum without nullable math).
// Matches `synthesize-concept.ts` (T3) conventions.
export interface ValidateAndGenerateResult<TDraft> {
  readonly draft: TDraft
  readonly attempts: number
  // myth-3e4y: the franchise this world sits closest to, as judged at the
  // attempt that cleared the gate. Null when the judge saw no single
  // dominant franchise. A soft signal for downstream UI — does NOT gate.
  readonly adjacentFranchise: string | null
  // Combined token COUNTS (generator + judge) for the pipeline_runs
  // input/output token columns. These are counts, not prices.
  readonly totalUsage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
  // myth-rg09: USD cost priced PER-TIER — Opus rates for the generator
  // usage, Sonnet rates for the judge usage — and summed. The stage forwards
  // this verbatim into pipeline_runs.cost_usd; it no longer prices anything
  // itself (a single Sonnet-flat rate would under-price the Opus generator).
  readonly costUsd: number
}

export async function validateAndGenerateConcept<TDraft>(
  args: ValidateAndGenerateArgs<TDraft>,
): Promise<ValidateAndGenerateResult<TDraft>> {
  const generatorSchemaName = args.schemaName ?? 'WorldConceptDraft'
  // myth-rg09: generator (Opus) and judge (Sonnet) usage are tracked
  // SEPARATELY so cost can be priced per-tier. The combined total surfaced
  // on the result is just the sum of the two (token counts, not prices).
  let generatorUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let judgeUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let lastJudgement: PaintJobJudgement | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const prompt: string =
      attempt === 1 ? args.basePrompt : buildRetryPrompt(args.basePrompt, lastJudgement)

    const genResult = await generateObject<TDraft>({
      model: OPUS,
      schema: args.schema,
      prompt,
      maxRetries: 1,
      callSite: 'paint-job-validator/generator',
      providerOptions: {
        mythrun: { stage: 'concept_intake', worldId: args.worldId, campaignId: args.campaignId },
      },
      schemaName: generatorSchemaName,
      repairStrategy: 'sonnet',
    })
    generatorUsage = addUsage(generatorUsage, genResult.usage)

    const judgeResult = await generateObject({
      model: SONNET,
      schema: PaintJobJudgementSchema,
      // Function replacer: the draft is LLM output (JSON.stringify does not
      // escape `$`), so a `$&`/`$'` sequence in it must splice in literally.
      prompt: JUDGE_TEMPLATE.replace('{{draft}}', () => JSON.stringify(genResult.output, null, 2)),
      maxRetries: 3,
      callSite: 'paint-job-validator/judge',
      providerOptions: {
        mythrun: { stage: 'concept_intake', worldId: args.worldId, campaignId: args.campaignId },
      },
      schemaName: 'PaintJobJudgementSchema',
    })
    judgeUsage = addUsage(judgeUsage, judgeResult.usage)
    lastJudgement = judgeResult.output

    if (!judgeResult.output.flagged || judgeResult.output.confidence <= FLAG_THRESHOLD) {
      return {
        draft: genResult.output,
        attempts: attempt,
        adjacentFranchise: judgeResult.output.adjacentFranchise,
        totalUsage: addUsage(generatorUsage, judgeUsage),
        costUsd:
          computeCostUsd(OPUS_ID, generatorUsage) +
          computeCostUsd(SONNET_ID, judgeUsage),
      }
    }
  }

  // Loop exhausted: lastJudgement is guaranteed non-null (we always
  // assign it inside the loop and we only fall through after MAX_ATTEMPTS).
  /* c8 ignore start — invariant assert: the loop runs MAX_ATTEMPTS
   * times and always assigns lastJudgement before any break/continue;
   * this is defense-in-depth narrowing. */
  if (lastJudgement === null) {
    throw new Error('paint_job_validator_invariant_violated')
  }
  /* c8 ignore stop */
  throw new PaintJobLoopExhaustedError(lastJudgement)
}

function buildRetryPrompt(basePrompt: string, lastJudgement: PaintJobJudgement | null): string {
  /* c8 ignore start — `?? ''` / `?? 'a recognizable copyrighted work'`
   * fallbacks fire only when buildRetryPrompt is called with
   * lastJudgement === null, which only happens on the FIRST attempt
   * before any judgement is recorded. Tests retry from a non-null
   * lastJudgement; the null arm is the seed for the first build. */
  const driftAxes = lastJudgement?.specificDriftAxes.join(', ') ?? ''
  const mirroredWork = lastJudgement?.mirroredWork ?? 'a recognizable copyrighted work'
  const failureKind = lastJudgement?.failureKind ?? 'structural'
  /* c8 ignore stop */
  // myth-3e4y: when the flag was (partly) a vocabulary mirror, the structural
  // amendment alone isn't enough — the regeneration can keep the same bones
  // and still slide back into the franchise's invented neologisms. Append an
  // explicit vocabulary-steer clause so the retry moves off BOTH the
  // structure and the franchise-iconic vocabulary.
  const vocabularySteer =
    failureKind === 'vocabulary' || failureKind === 'both'
      ? ` This world also leaned so hard into ${mirroredWork} that its natural vocabulary would pull in that franchise's franchise-iconic invented terms downstream. Move the concept far enough from ${mirroredWork} that no reader would reach for those signature neologisms; invent the world's own distinctive vocabulary instead.`
      : ''
  return (
    basePrompt +
    '\n\n---\n\n' +
    `IMPORTANT (retry pass): an earlier draft of this world mirrored ${mirroredWork} along these axes: ${driftAxes}. ` +
    `Do NOT iterate on that direction. Explore a fundamentally different aesthetic register, ` +
    `different faction archetype, different plot shape. The output must read as a fresh original world, ` +
    `not a corrected version of the prior attempt.` +
    vocabularySteer
  )
}

// `b` accepts both the SDK's `LanguageModelUsage` (token fields typed
// `number | undefined`) and a plain narrow numeric sum — the body coalesces
// undefined to 0, so the optional-field shape is the common supertype. This
// lets us reuse one accumulator for both per-call SDK usage AND the final
// generator+judge merge (myth-rg09).
function addUsage(
  a: { inputTokens: number; outputTokens: number; totalTokens: number },
  b: {
    inputTokens?: number | undefined
    outputTokens?: number | undefined
    totalTokens?: number | undefined
  },
): { inputTokens: number; outputTokens: number; totalTokens: number } {
  /* c8 ignore start — `?? 0` fallbacks: the Anthropic SDK always
   * populates token counts; the optional chains are defense-in-depth. */
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    totalTokens: a.totalTokens + (b.totalTokens ?? 0),
  }
  /* c8 ignore stop */
}
