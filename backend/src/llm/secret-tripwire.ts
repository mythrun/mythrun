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

import { generateObject, type LanguageModelUsage, type PromptBlocks } from './ai.js'
import { interpolateVars, loadPrompt } from './prompts.js'
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
  /** myth-g4hf3 — NON-secret playbook material (encounter scripts, pacing,
   *  knowledge bounds). Prose that contradicts or parallels it is a CONSISTENCY
   *  matter — at most soft_consistency (the silent ST steer), NEVER hard_reveal.
   *  Optional; absent renders as an empty block (fail-safe: nothing is treated
   *  as consistency-only unless the caller classified it so). */
  readonly consistencyContext?: string
  /** myth-g4hf3 — the turn's RESOLVED skill-check outcome constraints, formatted
   *  by the caller. Part of the grounding floor: content the system licensed via
   *  a resolved roll (the Haiku-pre-generated outcome the deterministic dice
   *  matched) is definitionally NOT a breach. Public by construction. Optional;
   *  absent renders as an empty block. */
  readonly diceOutcomes?: string
  /** Cost-harness scope id (cost wave 1 §1.0) — rides providerOptions.mythrun
   *  only, NEVER the prompt. OPTIONAL: the tripwire is dual-context (per-turn
   *  scribe leg AND the prep engine's opening vet); a prep-context line
   *  without sessionId is correct behavior. */
  readonly sessionId?: string
  /** Cost-harness scope id (cost wave 1 §1.0) — the PREP leg's attribution:
   *  session-prep's opening vet has no session yet, but does have a campaign.
   *  Rides providerOptions.mythrun only, NEVER the prompt. */
  readonly campaignId?: string
  readonly abortSignal?: AbortSignal
}

export interface SecretTripwireOutput {
  readonly result: SecretTripwireResult
  readonly usage: LanguageModelUsage
  readonly repairAttempted: boolean
}

// Cost-wave1 §3 — tripwire caching. secret-tripwire.txt is ordered
// stable-first (instruction head + secrets + publicContext +
// consistencyContext above; the per-turn prose + dice outcomes + the
// output-format tail below), a pure section permutation gated by
// secret-tripwire-parity.test.ts. The assembly cuts the RAW template at the
// volatile marker — variable content can never move the boundary — and pins
// the cache breakpoint on the stable block. The scribe leg re-sends the
// stable span every turn (cacheRead was 0); the prep leg's single opening-vet
// call pays a negligible write premium and can even warm the session's first
// scribe read when play starts inside the TTL.
const TRIPWIRE_VOLATILE_MARKER = 'Player-facing prose this turn:'

/** Cuts the raw template at the volatile marker, which must appear EXACTLY
 *  once: zero is template drift, and a second occurrence would make a
 *  first-occurrence cut silently move the cache breakpoint. Exported for the
 *  marker-validation tests (the drifted templates never reach disk). */
export function splitTripwireTemplate(template: string): { head: string; tail: string } {
  const cut = template.indexOf(TRIPWIRE_VOLATILE_MARKER)
  if (cut === -1) {
    throw new Error(
      `secret-tripwire.txt: volatile marker ${JSON.stringify(TRIPWIRE_VOLATILE_MARKER)} not found — template drifted; re-derive the cache breakpoint (cost-wave1 §3)`,
    )
  }
  if (template.includes(TRIPWIRE_VOLATILE_MARKER, cut + TRIPWIRE_VOLATILE_MARKER.length)) {
    throw new Error(
      `secret-tripwire.txt: volatile marker ${JSON.stringify(TRIPWIRE_VOLATILE_MARKER)} appears more than once — the cut point is ambiguous; re-derive the cache breakpoint (cost-wave1 §3)`,
    )
  }
  return { head: template.slice(0, cut), tail: template.slice(cut) }
}

function tripwireBlocks(input: SecretTripwireInput): PromptBlocks {
  const { head, tail } = splitTripwireTemplate(loadPrompt('session', 'secret-tripwire'))
  const vars = {
    prose: input.prose,
    secrets: input.secrets,
    publicContext: input.publicContext,
    consistencyContext: input.consistencyContext ?? '(none)',
    diceOutcomes: input.diceOutcomes ?? '(none this turn)',
  }
  return [
    { role: 'user', text: interpolateVars(head, vars), cacheBreakpoint: true },
    { role: 'user', text: interpolateVars(tail, vars) },
  ]
}

export async function runSecretTripwire(input: SecretTripwireInput): Promise<SecretTripwireOutput> {
  const r = await generateObject({
    model: SCRIBE_TRIPWIRE_MODEL,
    schema: SecretTripwireResultSchema,
    schemaName: 'SecretTripwireResultSchema',
    blocks: tripwireBlocks(input),
    callSite: 'secret-tripwire',
    providerOptions: {
      mythrun: {
        stage: 'secret_tripwire',
        sessionId: input.sessionId,
        campaignId: input.campaignId,
      },
    },
    repairStrategy: 'haiku-then-sonnet',
    timeoutMs: SCRIBE_TRIPWIRE_TIMEOUT_MS,
    redactRawText: true,
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
  })
  return { result: r.output, usage: r.usage, repairAttempted: r.repairAttempted }
}
