// backend/src/llm/retcon-author.ts
//
// MYT-73 — the Opus retcon-author. On a detected core-secret break, this
// dedicated call writes a secret-preserving CORRECTION the narrator delivers
// OPENLY to the players ("earlier I said X — correction, it's actually Z").
// It emits { retconText, supersededContent, tier } where `retconText` is the
// player-facing correction prose surfaced VERBATIM.
//
// CRITICAL — enforced ignorance: this call reasons over a secret to author the
// correction. `retconText` MUST remove the contradiction WITHOUT revealing the
// secret, paraphrased or implied. `redactRawText: true` keeps a malformed-JSON
// response from spilling the secret into the repair WARN log / the rethrown
// error's `.diagnostic` / SSE. Modeled on st-lookup-vet.ts (the MYT-72 ST-vet),
// the one other Mythrun LLM call whose raw output reasons over secrets.

import { generateObject, type LanguageModelUsage } from './ai.js'
import { loadPrompt } from './prompts.js'
import { RetconResultSchema, type RetconResult } from './schemas/retcon-author.js'
import { OPUS } from './models.js'

export interface RetconAuthorInput {
  /** The player-visible prose that breaks the secret. */
  readonly prose: string
  /** The breached assertion / what went wrong. */
  readonly breach: string
  /** The secret to preserve (private knowledge; never surfaced). */
  readonly secret: string
  /** Recent narration so the correction flows from what was just said. */
  readonly recentNarrative: string
  readonly abortSignal?: AbortSignal
}

export interface RetconAuthorOutput {
  readonly result: RetconResult
  readonly usage: LanguageModelUsage
  readonly repairAttempted: boolean
}

export async function runRetconAuthor(input: RetconAuthorInput): Promise<RetconAuthorOutput> {
  const r = await generateObject({
    model: OPUS,
    schema: RetconResultSchema,
    schemaName: 'RetconResultSchema',
    prompt: loadPrompt('session', 'retcon-author', {
      prose: input.prose,
      breach: input.breach,
      secret: input.secret,
      recentNarrative: input.recentNarrative,
    }),
    callSite: 'retcon-author',
    repairStrategy: 'haiku-then-sonnet',
    // T10 moves these to scribe-config.ts (alongside the other Scribe-tier
    // tunables); hardcoded here so this LLM-boundary task ships self-contained.
    timeoutMs: 45_000,
    maxOutputTokens: 1_200,
    redactRawText: true,
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
  })
  return { result: r.output, usage: r.usage, repairAttempted: r.repairAttempted }
}
