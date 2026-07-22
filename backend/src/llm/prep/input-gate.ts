// Per MYT-51 D5 (revised after Wyvern-C3 aggregate rule + Roc-Imp7
// intentSummary inclusion). One Sonnet call; structured 3-axis output;
// verdict logic computed in code (deterministic, easy to test) from the
// model's per-axis confidences.
//
// Routes through the canonical `generateObject` wrapper (myth-t1qz):
// schema-repair fallback + structured diagnostic logging on failure.

import { generateObject, type LanguageModelUsage } from '../ai.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { z } from 'zod'
import { SONNET } from '../models.js'
import type { SynthesizerOutput } from './synthesize-concept.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../prompts/prep/input-gate.txt'),
  'utf8',
)

const InputGateSchema = z.object({
  srd_compat: z.object({
    fits: z.boolean(),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().max(800),
  }),
  clone_intent: z.object({
    flagged: z.boolean(),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().max(800),
  }),
  inappropriate: z.object({
    flagged: z.boolean(),
    reasoning: z.string().max(800),
  }),
  rejectionMessage: z.string().max(400).nullable(),
})

type GateReason = 'srd_incompat' | 'clone_intent' | 'inappropriate'

export interface InputGateVerdict {
  readonly verdict: 'allow' | 'reject'
  readonly reason: GateReason | null
  readonly rejectionMessage: string | null
  // Server-side log only, NOT in HTTP response (Roc-Imp6).
  readonly reasoning: string
  // AI SDK v6 native usage shape: { inputTokens, outputTokens, totalTokens, ... }
  // (all token counts are `number | undefined`). Matches T3/T5 conventions.
  readonly usage: LanguageModelUsage
}

export interface InputGateArgs {
  readonly concept: string
  readonly intentSummary: SynthesizerOutput['intentSummary'] | null
  /** External cancellation (e.g. the SSE client disconnected) — combined with
   *  the call timeout inside generateObject. Absent = timeout-only, unchanged. */
  readonly abortSignal?: AbortSignal
}

const PRIMARY_THRESHOLD = 0.85
const AGGREGATE_THRESHOLD = 0.7

export async function runInputGate(args: InputGateArgs): Promise<InputGateVerdict> {
  const intentSummaryBlock =
    args.intentSummary === null
      ? '(none — freeform mode)'
      : JSON.stringify(args.intentSummary, null, 2)
  // Function replacers: the concept is user input and the intentSummary block
  // is LLM-derived — a `$&`/`$'`-style sequence in either must splice in
  // literally rather than being read as a replacement pattern.
  const prompt = PROMPT_TEMPLATE.replace('{{concept}}', () => args.concept).replace(
    '{{intentSummary}}',
    () => intentSummaryBlock,
  )
  const result = await generateObject({
    model: SONNET,
    schema: InputGateSchema,
    prompt,
    temperature: 0.2,
    maxRetries: 3,
    callSite: 'input-gate',
    schemaName: 'InputGateSchema',
    // exactOptionalPropertyTypes: only pass the key when a signal exists.
    ...(args.abortSignal !== undefined ? { abortSignal: args.abortSignal } : {}),
  })
  return computeVerdict(result.output, result.usage)
}

function computeVerdict(
  axes: z.infer<typeof InputGateSchema>,
  usage: LanguageModelUsage,
): InputGateVerdict {
  const srdFlags = !axes.srd_compat.fits && axes.srd_compat.confidence > PRIMARY_THRESHOLD
  const cloneFlags = axes.clone_intent.flagged && axes.clone_intent.confidence > PRIMARY_THRESHOLD
  const inappropriateFlags = axes.inappropriate.flagged

  const srdNearMiss = !axes.srd_compat.fits && axes.srd_compat.confidence >= AGGREGATE_THRESHOLD
  const cloneNearMiss =
    axes.clone_intent.flagged && axes.clone_intent.confidence >= AGGREGATE_THRESHOLD
  const aggregateFires = srdNearMiss && cloneNearMiss

  let reason: GateReason | null = null
  if (srdFlags || (aggregateFires && !cloneFlags && !inappropriateFlags)) {
    reason = 'srd_incompat'
  } else if (cloneFlags) {
    reason = 'clone_intent'
  } else if (inappropriateFlags) {
    reason = 'inappropriate'
  }

  const verdict: 'allow' | 'reject' = reason === null ? 'allow' : 'reject'
  const reasoningText =
    reason === 'srd_incompat'
      ? axes.srd_compat.reasoning
      : reason === 'clone_intent'
        ? axes.clone_intent.reasoning
        : reason === 'inappropriate'
          ? axes.inappropriate.reasoning
          : ''
  return {
    verdict,
    reason,
    rejectionMessage: verdict === 'reject' ? axes.rejectionMessage : null,
    /* c8 ignore start — `reason ?? ''` falsy arm is structurally unreachable:
       verdict === 'reject' implies `reason` is one of the three reject
       strings (set in the earlier ternary chain), never null. */
    reasoning: verdict === 'reject' ? `${reason ?? ''}: ${reasoningText}` : '',
    /* c8 ignore stop */
    usage,
  }
}
