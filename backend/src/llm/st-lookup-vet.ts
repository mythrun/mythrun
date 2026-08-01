// backend/src/llm/st-lookup-vet.ts
//
// MYT-72 §17.4 — the Opus ST-vet for a world-knowledge lookup. The SINGLE
// tier-safety gate: a synchronous generateObject call that holds the secret
// sd_playbook, sees tier-annotated over-pulled results + recent narration +
// channel, and emits { mode, text, tier } where `text` is the player-facing
// relay/invention prose surfaced VERBATIM to the player (authoritative like
// st-director's `direction`).
//
// CRITICAL — enforced ignorance: this is the ONE Mythrun LLM call whose raw
// output reasons over secrets. `redactRawText: true` keeps a malformed-JSON
// response from spilling a secret into the repair WARN log / the rethrown
// error's `.diagnostic` / SSE.
//
// Discard-on-repair posture (copies st-director.ts, NOT st-gate.ts): the vet's
// `text` is authoritative prose, so the wrapper's repairAttempted flag is
// surfaced UNCHANGED — the caller treats repairAttempted===true as fail-soft.

import { generateObject, type LanguageModelUsage } from './ai.js'
import { loadPrompt } from './prompts.js'
import { StLookupVetResultSchema, type StLookupVetResult } from './schemas/st-lookup-vet.js'
import {
  ST_LOOKUP_VET_MODEL,
  ST_LOOKUP_VET_TIMEOUT_MS,
  ST_LOOKUP_VET_MAX_OUTPUT_TOKENS,
} from '../session/world-lookup-config.js'

export interface StLookupVetInput {
  readonly question: string
  readonly recentNarrative: string
  readonly channel: 'dm' | 'npc'
  /** Present only for the NPC channel: the NPC's public identity + playbook-
   *  bounded knowledge framing. Empty string for DM. */
  readonly npcFraming: string
  /** Pre-rendered, tier-annotated results block. */
  readonly results: string
  readonly resolverDegraded: boolean
  readonly sdPlaybook: string
  readonly worldTone: string
  /** Cost-harness scope id (cost wave 1 §1.0) — rides providerOptions.mythrun
   *  only, NEVER the prompt. */
  readonly sessionId: string
  readonly abortSignal?: AbortSignal
}

export interface StLookupVetOutput {
  readonly result: StLookupVetResult
  readonly usage: LanguageModelUsage
  readonly repairAttempted: boolean
}

export async function runStLookupVet(input: StLookupVetInput): Promise<StLookupVetOutput> {
  const r = await generateObject({
    model: ST_LOOKUP_VET_MODEL,
    schema: StLookupVetResultSchema,
    schemaName: 'StLookupVetResultSchema',
    prompt: loadPrompt('session', 'st-lookup-vet', {
      question: input.question,
      recent_narrative: input.recentNarrative,
      channel: input.channel,
      npc_framing: input.npcFraming,
      results: input.results,
      resolver_degraded: input.resolverDegraded ? 'degraded' : 'healthy',
      sd_playbook: input.sdPlaybook,
      world_tone: input.worldTone,
    }),
    callSite: 'st-lookup-vet',
    providerOptions: { mythrun: { stage: 'st_lookup_vet', sessionId: input.sessionId } },
    repairStrategy: 'haiku-then-sonnet',
    timeoutMs: ST_LOOKUP_VET_TIMEOUT_MS,
    maxOutputTokens: ST_LOOKUP_VET_MAX_OUTPUT_TOKENS,
    redactRawText: true,
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
  })
  return { result: r.output, usage: r.usage, repairAttempted: r.repairAttempted }
}
