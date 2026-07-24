// backend/src/llm/secret-tripwire.ts
//
// MYT-73 — the per-turn secret tripwire: a cheap Haiku generateObject call that
// checks the Fast Thinker's player-facing prose against the session's CORE
// SECRETS and emits an OPAQUE control signal { severity, confidence, secretRef }
// where `severity` is none | soft_consistency | hard_reveal (myth-retprop) and
// `secretRef` is a HANDLE (e.g. [SECRET-1]), never secret-derived prose.
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
import { SCRIBE_TRIPWIRE_MODEL, SCRIBE_TRIPWIRE_TIMEOUT_MS } from '../session/scribe-config.js'

export interface SecretTripwireInput {
  /** The Fast Thinker's player-facing prose for this turn. */
  readonly prose: string
  /** Pre-formatted, handle-annotated core-secrets block (caller-resolved). */
  readonly secrets: string
  /** myth-retprop — the FT's PUBLIC briefing (the enforced-ignorance-safe
   *  ft_context). A detail GROUNDED here was licensed to the narrator and is
   *  definitionally NOT a breach (severity none), even when it is thematically
   *  consistent with a secret. This is the grounding floor: it stops the
   *  tripwire firing over prose the FT was explicitly told to write (the
   *  "Unsheathed Folly" incident — an NPC watching a door the briefing already
   *  said he watches). Public by construction; carries no secret. */
  readonly publicContext: string
  readonly abortSignal?: AbortSignal
}

export interface SecretTripwireOutput {
  readonly result: SecretTripwireResult
  readonly usage: LanguageModelUsage
  readonly repairAttempted: boolean
}

export async function runSecretTripwire(input: SecretTripwireInput): Promise<SecretTripwireOutput> {
  const r = await generateObject({
    model: SCRIBE_TRIPWIRE_MODEL,
    schema: SecretTripwireResultSchema,
    schemaName: 'SecretTripwireResultSchema',
    prompt: loadPrompt('session', 'secret-tripwire', {
      prose: input.prose,
      secrets: input.secrets,
      publicContext: input.publicContext,
    }),
    callSite: 'secret-tripwire',
    repairStrategy: 'haiku-then-sonnet',
    timeoutMs: SCRIBE_TRIPWIRE_TIMEOUT_MS,
    redactRawText: true,
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
  })
  return { result: r.output, usage: r.usage, repairAttempted: r.repairAttempted }
}
