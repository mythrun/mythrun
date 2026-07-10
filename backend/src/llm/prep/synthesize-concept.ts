// Per MYT-51 D4 (guided mode): one Sonnet call, picks → original
// concept + intentSummary. Output schema is intentionally tight so
// the SDK's structured-output retry handles validation drift.
// Temperature 0.9 for creative variance (per D6 commentary on temperature).
//
// The `sourcesInternal` field is opaque downstream — never echoed to
// the user, never appended to concept_intake's prompt. The input gate
// DOES receive it (D5 + Roc-Imp7) to close the prompt-injection path.
//
// Routes through the canonical `generateObject` wrapper (myth-t1qz):
// schema-repair fallback + structured diagnostic logging on failure.

import { generateObject, streamObject, type LanguageModelUsage } from '../ai.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { z } from 'zod'
import { SONNET } from '../models.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../prompts/prep/synthesize-concept.txt'),
  'utf8',
)

export const SynthesizerPick = z.object({
  title: z.string().min(1).max(200),
  whyILikeIt: z.string().min(1).max(800),
})
export type SynthesizerPick = z.infer<typeof SynthesizerPick>

export const SynthesizerOutput = z.object({
  concept: z.string().min(50).max(4000),
  intentSummary: z.object({
    aesthetics: z.array(z.string().min(1).max(100)).min(1).max(8),
    themes: z.array(z.string().min(1).max(100)).min(1).max(8),
    sourcesInternal: z.array(z.string().min(1).max(200)).min(1).max(5),
  }),
})
export type SynthesizerOutput = z.infer<typeof SynthesizerOutput>

export interface SynthesizerResult extends SynthesizerOutput {
  // AI SDK v6 native usage shape: { inputTokens, outputTokens, totalTokens, ... }
  // (all token counts are `number | undefined`). The plan was authored
  // against an older SDK whose shape was `{ promptTokens, completionTokens,
  // totalTokens }`; we keep the SDK's canonical type here so downstream
  // cost aggregation reads the canonical names without a translation layer.
  readonly usage: LanguageModelUsage
}

function buildPrompt(picks: readonly SynthesizerPick[]): string {
  const picksBlock = picks
    .map((p) => `- Title: ${p.title}\n  Why they like it: ${p.whyILikeIt}`)
    .join('\n')
  return PROMPT_TEMPLATE.replace(/\{\{#picks\}\}[\s\S]*?\{\{\/picks\}\}/, picksBlock)
}

export async function synthesizeConcept(
  picks: readonly SynthesizerPick[],
): Promise<SynthesizerResult> {
  /* c8 ignore start — caller-side invariant: the route handler always
   * passes exactly 3 picks (concept-intake stage emits 3). This is a
   * defense-in-depth assertion. */
  if (picks.length !== 3) {
    throw new Error(`synthesizeConcept requires exactly 3 picks, got ${String(picks.length)}`)
  }
  /* c8 ignore stop */
  const result = await generateObject({
    model: SONNET,
    schema: SynthesizerOutput,
    prompt: buildPrompt(picks),
    temperature: 0.9,
    maxRetries: 3,
    callSite: 'synthesize-concept',
    schemaName: 'SynthesizerOutput',
  })
  return { ...result.output, usage: result.usage }
}

// myth-umggn: wall-clock budget for the streamed synthesis — covers the whole
// stream (first byte through final token), not just connect. A ≤4000-char
// Sonnet brief streams in well under a minute; 3 min leaves headroom for SDK
// connect retries without letting a stalled socket hang the player's screen.
const STREAM_TIMEOUT_MS = 3 * 60 * 1000

/**
 * The streamed synthesis, as the SSE route consumes it. `deltas` yields the
 * concept prose in arrival order (derived from the growing `concept` field of
 * the partial-object stream); `output` resolves to the full VALIDATED tree —
 * same schema, same repair chain as `synthesizeConcept` — and is authoritative
 * (a post-stream schema repair can diverge from the streamed text).
 */
export interface SynthesizerStream {
  /** Concept prose deltas in arrival order. Ends when the underlying stream
   *  ends — a terminal failure surfaces on `output`, never as a throw here. */
  readonly deltas: AsyncIterable<string>
  /** The validated output. Rejects with the mapped Mythrun error on terminal
   *  failure (after the wrapper's repair chain). */
  readonly output: Promise<SynthesizerOutput>
}

/**
 * Streaming twin of `synthesizeConcept` (myth-umggn): identical prompt,
 * schema, temperature, and repair semantics, but the concept prose is
 * observable as it generates so the guided create flow can render the world
 * brief writing itself. `abortSignal` threads the SSE client-disconnect so a
 * closed tab stops the Sonnet burn.
 */
export function streamSynthesizeConcept(
  picks: readonly SynthesizerPick[],
  opts?: { readonly abortSignal?: AbortSignal },
): SynthesizerStream {
  /* c8 ignore start — caller-side invariant, mirrors synthesizeConcept. */
  if (picks.length !== 3) {
    throw new Error(`streamSynthesizeConcept requires exactly 3 picks, got ${String(picks.length)}`)
  }
  /* c8 ignore stop */
  const result = streamObject({
    model: SONNET,
    schema: SynthesizerOutput,
    prompt: buildPrompt(picks),
    temperature: 0.9,
    maxRetries: 3,
    callSite: 'synthesize-concept-stream',
    schemaName: 'SynthesizerOutput',
    timeoutMs: STREAM_TIMEOUT_MS,
    ...(opts?.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
  })

  // Derive prose deltas from the growing `concept` string. Non-string /
  // non-growing partials (the pre-concept `{}`, the intentSummary fill-in
  // after the concept settles, a defensive shrink) emit nothing.
  async function* conceptDeltas(): AsyncGenerator<string> {
    let sent = ''
    for await (const partial of result.partialObjectStream) {
      const concept = (partial as { concept?: unknown }).concept
      if (typeof concept !== 'string' || concept.length <= sent.length) continue
      const delta = concept.slice(sent.length)
      sent = concept
      yield delta
    }
  }

  return { deltas: conceptDeltas(), output: result.object }
}
