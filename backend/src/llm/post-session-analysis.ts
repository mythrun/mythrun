// backend/src/llm/post-session-analysis.ts
//
// MYT-74b — the Opus post-session analysis call. ONE Opus call that closes out
// a live session: it reads the bounded transcript tail, the ST running summary,
// the prep `sd_playbook`, and the PC roster, and emits a PostSessionAnalysis
// ({ summary, emergingThreads, handoff }).
//
// CRITICAL — this call reasons over SECRETS (the `sd_playbook` + the ST running
// summary), so `redactRawText: true` keeps a malformed-JSON response from
// spilling a secret into the repair WARN log / the rethrown error's
// `.diagnostic` (rawTextSnippet + zodIssues both nulled). The `summary` /
// `emergingThreads` surfaces it emits are themselves SECRET-FREE (player-
// witnessed only); the `handoff` MAY be secret-aware (it feeds the next
// session's prep pipeline, not the player-facing recap). Modeled on
// session-reconciler.ts.

import { generateObject, type LanguageModelUsage } from './ai.js'
import { OPUS } from './models.js'
import { loadPrompt } from './prompts.js'
import { PostSessionAnalysisSchema, type PostSessionAnalysis } from './schemas/post-session-analysis.js'

// Pinned (§2): an Opus call over a bounded transcript tail is multi-second; the
// worst-case handoff (many NPCs × voice arrays) needs a high output ceiling.
const ANALYSIS_TIMEOUT_MS = 120_000
const ANALYSIS_MAX_OUTPUT_TOKENS = 8_000

export interface PostSessionAnalysisInput {
  readonly transcript: string
  readonly runningSummary: string
  readonly sdPlaybook: string
  readonly participants: string
  /** myth-8mom0 — the farewell turn's closing narration (the session's final
   *  wind-down beats). AUTHORITATIVE for where the session ENDED. Optional — ''
   *  when the session had no farewell; the `{{closingNarration}}` slot then
   *  renders empty. */
  readonly closingNarration?: string
  readonly abortSignal?: AbortSignal
}

export interface PostSessionAnalysisOutput {
  readonly result: PostSessionAnalysis
  readonly usage: LanguageModelUsage
  readonly repairAttempted: boolean
}

export async function runPostSessionAnalysis(
  input: PostSessionAnalysisInput,
): Promise<PostSessionAnalysisOutput> {
  const r = await generateObject({
    model: OPUS,
    schema: PostSessionAnalysisSchema,
    schemaName: 'PostSessionAnalysisSchema',
    prompt: loadPrompt('session', 'post-session-analysis', {
      transcript: input.transcript,
      runningSummary: input.runningSummary,
      sdPlaybook: input.sdPlaybook,
      participants: input.participants,
      closingNarration: input.closingNarration ?? '',
    }),
    callSite: 'post-session-analysis',
    repairStrategy: 'sonnet',
    timeoutMs: ANALYSIS_TIMEOUT_MS,
    maxOutputTokens: ANALYSIS_MAX_OUTPUT_TOKENS,
    redactRawText: true,
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
  })
  return { result: r.output, usage: r.usage, repairAttempted: r.repairAttempted }
}
