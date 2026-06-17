// Session-prep GENERATION STAGE (MYT-59 T4).
//
// Streams the omniscient world-state document through Opus and returns the two
// prep artifacts: the Fast-Thinker context (`ft_context`, ENFORCED-IGNORANCE
// safe — discoverable facts only, no secrets) and the Slow-Thinker stage-
// direction playbook (`sd_playbook`). Unlike the array-keyed prep stages this
// emits a TWO-STRING object, so it reads the structured result via
// `await result.object` directly — there is NO delineator and NO
// `runStreamingStage` (which is array-keyed and would emit nothing here).
import { z } from 'zod'
import { streamObject, type LanguageModelUsage } from '../../ai.js'
import { OPUS } from '../../models.js'
import { loadPrompt } from '../../prompts.js'
import { serializeWorldStateForPrep } from '../serialize-world-state-for-prep.js'
import type { PriorSessionContext } from '../serialize-world-state-for-prep.js'
import type { Repo } from '../../../repo/index.js'

export const sessionPrepSchema = z.object({
  // Presence/length FLOOR — a "did the model produce a real doc" guard, NOT a
  // completeness check (spec §9). The prose-quality bar is an eval concern.
  ft_context: z.string().min(200),
  sd_playbook: z.string().min(100),
})
export type SessionPrep = z.infer<typeof sessionPrepSchema>

// Two large prose docs in one structured object; the SDK default ceiling
// truncates mid-document without this (spec §9).
const MAX_OUTPUT_TOKENS = 16384
// Deliberately the largest LLM timeout in the codebase: Opus generating two
// long documents over a streamed object.
const SESSION_PREP_TIMEOUT_MS = 9 * 60 * 1000

export interface GenerateSessionPrepArgs {
  readonly campaignId: string
  readonly worldId: string
  readonly sessionNumber: number
  // Optional progressive-prose sink. When present we drain
  // `partialObjectStream` (which the SDK is already producing — zero extra LLM
  // cost) and emit the newly-appended substring per field as it streams. When
  // absent we skip the drain entirely and go straight to `await result.object`.
  readonly onProseDelta?: (field: 'ft_context' | 'sd_playbook', text: string) => void
  // MYT-74b §4 — prior-session context (chronological summaries + latest
  // handoff anchor). Threaded into the world-state serializer so the prep
  // prompt opens on where the last session left the party.
  readonly priorSessionContext?: PriorSessionContext
}

export interface SessionPrepResult {
  readonly ft_context: string
  readonly sd_playbook: string
  readonly usage: LanguageModelUsage
}

export async function generateSessionPrep(
  repo: Repo,
  args: GenerateSessionPrepArgs,
): Promise<SessionPrepResult> {
  const worldState = await serializeWorldStateForPrep(repo, {
    campaignId: args.campaignId,
    sessionNumber: args.sessionNumber,
    ...(args.priorSessionContext !== undefined ? { priorSessionContext: args.priorSessionContext } : {}),
  })

  const prompt = loadPrompt('prep', 'session-prep', {
    world_state: worldState,
    session_number: String(args.sessionNumber),
  })

  // maxRetries: 0 per design D2 — the Haiku→Sonnet repair chain (driven inside
  // `await result.object`) owns validation recovery; BullMQ stage retry owns
  // transport recovery. No third hidden retry layer in the SDK.
  const result = streamObject({
    model: OPUS,
    schema: sessionPrepSchema,
    prompt,
    temperature: 0.7,
    maxRetries: 0,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: SESSION_PREP_TIMEOUT_MS,
    repairStrategy: 'haiku-then-sonnet',
    callSite: 'session-prep',
    schemaName: 'SessionPrepSchema',
    providerOptions: {
      mythrun: {
        campaignId: args.campaignId,
        worldId: args.worldId,
        stage: 'session_prep',
      },
    },
  })

  // Progressive prose: diff each field's streamed value against the prior tick
  // and forward only the newly-appended tail. We retain the previous full value
  // per field and emit `value.slice(prev.length)` only when `value` strictly
  // extends `prev` (`startsWith(prev)`). When the new value is NOT a strict
  // extension — the AI SDK's mid-escape truncation, where a partial briefly
  // rewrites an in-flight escape (e.g. a dangling `\` resolves to `\n`) so the
  // prefix diverges — we resync `prev` and emit nothing for that tick rather
  // than slice garbage. `await result.object` below is authoritative regardless.
  const FIELDS = ['ft_context', 'sd_playbook'] as const
  const prev: Record<(typeof FIELDS)[number], string> = { ft_context: '', sd_playbook: '' }
  if (args.onProseDelta) {
    for await (const partial of result.partialObjectStream) {
      for (const field of FIELDS) {
        const value = partial[field]
        if (typeof value !== 'string') continue
        if (value.length <= prev[field].length) continue
        if (!value.startsWith(prev[field])) {
          prev[field] = value
          continue
        }
        const delta = value.slice(prev[field].length)
        prev[field] = value
        try {
          args.onProseDelta(field, delta)
        } catch {
          /* fire-and-forget: a faulty sink must never abort generation */
        }
      }
    }
  }

  const output = await result.object
  const usage = await result.usage
  return { ft_context: output.ft_context, sd_playbook: output.sd_playbook, usage }
}
