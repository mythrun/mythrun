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
//
// myth-6t06f: the stage now has TWO inputs and one output. The brainstorm
// path feeds three media picks (`synthesizeConcept` / `streamSynthesizeConcept`);
// the FREEFORM path feeds the player's own concept text
// (`synthesizeFromConcept` / `streamSynthesizeFromConcept`) so it lands on the
// same proposal checkpoint before ~10 minutes of world generation. Different
// prompt template, identical schema/temperature/repair semantics — so the
// preview store, the SSE wire, and the proposal UI are shape-identical on
// both paths.

import { generateObject, streamObject, type LanguageModelUsage } from '../ai.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { z } from 'zod'
import { SONNET } from '../models.js'

const promptPath = (file: string): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), `../prompts/prep/${file}`)

const PROMPT_TEMPLATE = readFileSync(promptPath('synthesize-concept.txt'), 'utf8')
const FREEFORM_PROMPT_TEMPLATE = readFileSync(promptPath('synthesize-freeform.txt'), 'utf8')

export const SynthesizerPick = z.object({
  title: z.string().min(1).max(200),
  whyILikeIt: z.string().min(1).max(800),
})
export type SynthesizerPick = z.infer<typeof SynthesizerPick>

export const SynthesizerOutput = z.object({
  // myth-z3icr: the world's working NAME, so the proposal page can headline the
  // world instead of leaving its name buried in the first words of body prose
  // (extracting it client-side would be a ZFC violation). A short LABEL, not
  // prose — so a `.max()` is legal here per the no-max-on-prose rule, and 120
  // chars sits far above the 2-5 words the prompt asks for (the ceiling exists
  // to catch a model that answers with a sentence, not to clip a real title).
  title: z.string().min(1).max(120),
  // No .max() on the concept: it is LLM prose, and a max ceiling terminal-fails
  // an over-length generation instead of accepting it. The .min() floor stays
  // (a too-short brief is malformed). Its destination — worlds.concept — is a
  // bare TEXT column with no length CHECK, so nothing downstream needs a mirror.
  concept: z.string().min(50),
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
  // Function replacer so a `$&`/`$1`/`$'` sequence in a user-supplied title or
  // reason is spliced in literally (String.prototype.replace treats those as
  // special in a STRING replacement — a replacer function bypasses that).
  return PROMPT_TEMPLATE.replace(/\{\{#picks\}\}[\s\S]*?\{\{\/picks\}\}/, () => picksBlock)
}

/** myth-6t06f: the freeform prompt — the player's own concept text is the
 *  input. Same function-replacer discipline: the concept is raw user text. */
function buildFreeformPrompt(concept: string): string {
  return FREEFORM_PROMPT_TEMPLATE.replace('{{concept}}', () => concept)
}

/** The single generateObject call both input shapes run through — one model,
 *  one schema, one temperature, one repair chain; only the prompt and the
 *  diagnostic callSite differ. */
async function runSynthesis(prompt: string, callSite: string): Promise<SynthesizerResult> {
  const result = await generateObject({
    model: SONNET,
    schema: SynthesizerOutput,
    prompt,
    temperature: 0.9,
    maxRetries: 3,
    callSite,
    schemaName: 'SynthesizerOutput',
  })
  return { ...result.output, usage: result.usage }
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
  return runSynthesis(buildPrompt(picks), 'synthesize-concept')
}

/**
 * myth-6t06f: the FREEFORM twin of `synthesizeConcept`. The player's own world
 * description becomes the proposal the checkpoint screen shows — same output
 * contract, so the preview store and the proposal wire are unchanged.
 */
export async function synthesizeFromConcept(concept: string): Promise<SynthesizerResult> {
  return runSynthesis(buildFreeformPrompt(concept), 'synthesize-freeform')
}

// myth-umggn: wall-clock budget for the streamed synthesis — covers the whole
// stream (first byte through final token), not just connect. A few-thousand-char
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
  return runSynthesisStream(buildPrompt(picks), 'synthesize-concept-stream', opts)
}

/**
 * myth-6t06f: the FREEFORM twin of `streamSynthesizeConcept` — the player's own
 * concept text streams into the same proposal the brainstorm path produces, so
 * the SSE wire and the screen that renders it are unchanged.
 */
export function streamSynthesizeFromConcept(
  concept: string,
  opts?: { readonly abortSignal?: AbortSignal },
): SynthesizerStream {
  return runSynthesisStream(buildFreeformPrompt(concept), 'synthesize-freeform-stream', opts)
}

/** The single streamObject call both input shapes run through (mirrors
 *  `runSynthesis`): prose deltas off the growing `concept` field, plus the
 *  authoritative validated output. */
function runSynthesisStream(
  prompt: string,
  callSite: string,
  opts?: { readonly abortSignal?: AbortSignal },
): SynthesizerStream {
  const result = streamObject({
    model: SONNET,
    schema: SynthesizerOutput,
    prompt,
    temperature: 0.9,
    maxRetries: 3,
    callSite,
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
