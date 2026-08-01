// backend/src/llm/session-reconciler.ts
//
// MYT-74a — the Opus end-of-session reconciler. ONE Opus call that folds a
// session's improvised working set into durable canon. It takes a rendered
// working-set block + a rendered candidates block + the world tone and returns
// a structured ReconcilePlan (entity match/mint ops, fact appends with optional
// supersede, relationship edges).
//
// CRITICAL — enforced ignorance is preserved on WRITE. This call reasons over
// secret-tier working-set items so it can canonize them AT THEIR TIER (never
// down-tier a secret). `redactRawText: true` keeps a malformed-JSON response
// from spilling a secret into the repair WARN log / the rethrown error's
// `.diagnostic` (rawTextSnippet + zodIssues both nulled) / SSE. Modeled on
// secret-tripwire.ts / retcon-author.ts, the Mythrun LLM calls whose raw output
// reasons over secrets.

import { generateObject, type LanguageModelUsage } from './ai.js'
import { OPUS } from './models.js'
import { loadPrompt } from './prompts.js'
import { ReconcilePlanSchema, type ReconcilePlan } from './schemas/session-reconcile.js'

// Wall-clock budget + output ceiling for the Opus reconcile call. Hardcoded
// here so this LLM-boundary task ships self-contained; a later config task may
// move these alongside the other Scribe-tier tunables. The reconciler can emit
// a large plan (every working-set subject's entity + facts), so the ceiling is
// generous.
const RECONCILE_TIMEOUT_MS = 120_000
const RECONCILE_MAX_OUTPUT_TOKENS = 8_000

export interface SessionReconcilerInput {
  /** Pre-rendered working-set block (each item stamped with name + tier). */
  readonly workingSet: string
  /** Pre-rendered candidates block (canon entities + their live facts, by id). */
  readonly candidates: string
  /** The world's tone, threaded so canonized prose stays in register. */
  readonly worldTone: string
  /** myth-8mom0 — the farewell turn's closing narration (the end-of-session
   *  send-off prose). AUTHORITATIVE for the session's END state, and the ONLY
   *  place the closing beats live (the player-less farewell is Scribe-skipped, so
   *  they never entered the working set). Optional — '' when the session had no
   *  farewell; the `{{closingNarration}}` slot then renders empty. */
  readonly closingNarration?: string
  /** Cost-harness scope id (cost wave 1 §1.0) — rides providerOptions.mythrun
   *  only, NEVER the prompt. */
  readonly sessionId: string
  readonly abortSignal?: AbortSignal
}

export interface SessionReconcilerOutput {
  readonly result: ReconcilePlan
  readonly usage: LanguageModelUsage
  readonly repairAttempted: boolean
}

export async function runSessionReconciler(
  input: SessionReconcilerInput,
): Promise<SessionReconcilerOutput> {
  const r = await generateObject({
    model: OPUS,
    schema: ReconcilePlanSchema,
    schemaName: 'ReconcilePlanSchema',
    prompt: loadPrompt('session', 'session-reconciler', {
      workingSet: input.workingSet,
      candidates: input.candidates,
      worldTone: input.worldTone,
      closingNarration: input.closingNarration ?? '',
    }),
    callSite: 'session-reconciler',
    providerOptions: { mythrun: { stage: 'session_reconcile', sessionId: input.sessionId } },
    repairStrategy: 'sonnet',
    timeoutMs: RECONCILE_TIMEOUT_MS,
    maxOutputTokens: RECONCILE_MAX_OUTPUT_TOKENS,
    redactRawText: true,
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
  })
  return { result: r.output, usage: r.usage, repairAttempted: r.repairAttempted }
}
