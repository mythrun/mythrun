// backend/src/llm/secret-tripwire.ts
//
// MYT-73 — the per-turn secret tripwire: a cheap Haiku generateObject call that
// checks the Fast Thinker's player-facing prose against the session's CORE
// SECRETS and emits an OPAQUE control signal { breached, confidence, secretRef }
// where `secretRef` is a HANDLE (e.g. [SECRET-1]), never secret-derived prose.
//
// This wrapper is playbook-AGNOSTIC: it takes pre-formatted `prose` + `secrets`
// strings. The CALLER (a later task) resolves the prep's sd_playbook into the
// handle-annotated `secrets` block and handles the fail-loud-on-empty case.
//
// CRITICAL — enforced ignorance: this is one of the few Mythrun LLM calls whose
// RAW output reasons over secrets. `redactRawText: true` keeps a malformed-JSON
// response from spilling a secret into the repair WARN log / the rethrown
// error's `.diagnostic` (rawTextSnippet + zodIssues both nulled) / SSE. Mirrors
// st-lookup-vet.ts.

import { generateObject, type LanguageModelUsage } from './ai.js'
import { loadPrompt } from './prompts.js'
import {
  SecretTripwireResultSchema,
  type SecretTripwireResult,
} from './schemas/secret-tripwire.js'
import { HAIKU } from './models.js'

// Wall-clock budget for the Haiku tripwire call. Hardcoded here for this task;
// T10 moves it to a shared scribe-config.ts alongside the other Scribe-tier
// timeouts/model constants.
const SCRIBE_TRIPWIRE_TIMEOUT_MS = 30_000

export interface SecretTripwireInput {
  /** The Fast Thinker's player-facing prose for this turn. */
  readonly prose: string
  /** Pre-formatted, handle-annotated core-secrets block (caller-resolved). */
  readonly secrets: string
  readonly abortSignal?: AbortSignal
}

export interface SecretTripwireOutput {
  readonly result: SecretTripwireResult
  readonly usage: LanguageModelUsage
  readonly repairAttempted: boolean
}

export async function runSecretTripwire(input: SecretTripwireInput): Promise<SecretTripwireOutput> {
  const r = await generateObject({
    model: HAIKU,
    schema: SecretTripwireResultSchema,
    schemaName: 'SecretTripwireResultSchema',
    prompt: loadPrompt('session', 'secret-tripwire', {
      prose: input.prose,
      secrets: input.secrets,
    }),
    callSite: 'secret-tripwire',
    repairStrategy: 'haiku-then-sonnet',
    timeoutMs: SCRIBE_TRIPWIRE_TIMEOUT_MS,
    redactRawText: true,
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
  })
  return { result: r.output, usage: r.usage, repairAttempted: r.repairAttempted }
}
