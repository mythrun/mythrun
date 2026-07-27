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
import { OPUS, OPUS_MAX_OUTPUT_TOKENS } from '../../models.js'
import { loadPrompt } from '../../prompts.js'
import { logger } from '../../logger.js'
import { serializeWorldStateForPrep } from '../serialize-world-state-for-prep.js'
import type { PriorSessionContext } from '../serialize-world-state-for-prep.js'
import type { Repo } from '../../../repo/index.js'

export const sessionPrepSchema = z.object({
  // Presence/length FLOOR — a "did the model produce a real doc" guard, NOT a
  // completeness check (spec §9). The prose-quality bar is an eval concern.
  ft_context: z.string().min(200),
  sd_playbook: z.string().min(100),
  // MYT-101: the player-facing session opening the DM reads aloud at the top
  // of the session. Floor only — no .max() on LLM prose.
  opening: z.string().min(100),
})
export type SessionPrep = z.infer<typeof sessionPrepSchema>

// Pin the prep call's output ceiling to Opus's real max (myth-vb2ov). The
// output is bounded WELL under this by the prompt's output budget + the
// serializer's working-set input tiering; the high ceiling is the backstop so a
// long campaign's accumulated canon doesn't truncate prep mid-schema at a low
// fixed cap (the old 16,384 wall crashed prep around session ~10).
const MAX_OUTPUT_TOKENS = OPUS_MAX_OUTPUT_TOKENS
// Deliberately the largest LLM timeout in the codebase: Opus generating two
// long documents over a streamed object.
const SESSION_PREP_TIMEOUT_MS = 9 * 60 * 1000

// myth-vb2ov graceful-failure retry. On a `finishReason: 'length'` overflow the
// stage re-runs ONCE with this instruction appended, forcing a ruthlessly
// working-set-scoped (and therefore shorter) result. A second overflow is a
// TERMINAL job failure — retrying again would not help. The 'OUTPUT BUDGET
// OVERRIDE' marker is the deterministic signal the retry prompt carries.
const TIGHTER_BUDGET_INSTRUCTION = `

---

## URGENT OUTPUT BUDGET OVERRIDE

Your previous attempt exceeded the hard output limit and was discarded. You MUST
produce a SHORTER result this time. Scope all three documents to ONLY the
entities, threads, and locations in play THIS session — the working set at the
top of the world state. Do NOT re-describe dormant or background canon; reference
it in a single line at most, or omit it. Keep the Fast Thinker Context under 2,000
words and the Stage-Direction Playbook under 1,200 words. Brevity is mandatory —
covering the working set well matters far more than covering the whole world.`

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
  /** MYT-101: player-facing opening — tripwire-vetted by the processor before persist. */
  readonly opening: string
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

  const basePrompt = loadPrompt('prep', 'session-prep', {
    world_state: worldState,
    session_number: String(args.sessionNumber),
  })

  // Attempt 1 — full budget + progressive prose deltas.
  const first = await runPrepStream(args, basePrompt, args.onProseDelta)
  if (first.kind === 'ok') {
    logUsage(args, first.usage, 1)
    return toResult(first.output, first.usage)
  }

  // myth-vb2ov graceful failure: a `finishReason: 'length'` overflow means the
  // structured output outgrew the cap. Log the wall, then retry ONCE with a
  // tighter, working-set-only budget. No deltas on the retry — the truncated
  // attempt already streamed a (discarded) partial; the retry's final object is
  // the authoritative artifact and is persisted whole.
  logOverflow(args, first.usage, 1)
  const second = await runPrepStream(args, basePrompt + TIGHTER_BUDGET_INSTRUCTION, undefined)
  if (second.kind === 'ok') {
    logUsage(args, second.usage, 2)
    return toResult(second.output, second.usage)
  }

  // Second overflow — retrying again would not help. Fail as a clean TERMINAL
  // job error (the shared `{ terminal: true }` contract) so the processor marks
  // the stage failed and returns without re-throwing; nothing crashes.
  logOverflow(args, second.usage, 2)
  throw Object.assign(
    new Error(
      `session-prep output exceeded the ${String(MAX_OUTPUT_TOKENS)}-token cap on both ` +
        `attempts (campaign ${args.campaignId}, session ${String(args.sessionNumber)}); failing terminally`,
    ),
    { terminal: true as const },
  )
}

/** One streamObject attempt: drain prose deltas, then resolve the object —
 *  classifying a `finishReason: 'length'` truncation as an overflow (retryable)
 *  rather than letting it surface as an opaque parse failure. A genuine schema
 *  failure (finishReason ≠ 'length') propagates unchanged. */
type PrepStreamOutcome =
  | { readonly kind: 'ok'; readonly output: SessionPrep; readonly usage: LanguageModelUsage }
  | { readonly kind: 'overflow'; readonly usage: LanguageModelUsage | undefined }

async function runPrepStream(
  args: GenerateSessionPrepArgs,
  prompt: string,
  onProseDelta: GenerateSessionPrepArgs['onProseDelta'],
): Promise<PrepStreamOutcome> {
  // maxRetries: 0 per design D2 — the Haiku→Sonnet repair chain (driven inside
  // `await result.object`) owns validation recovery; BullMQ stage retry owns
  // transport recovery. No third hidden retry layer in the SDK.
  const result = streamObject({
    model: OPUS,
    schema: sessionPrepSchema,
    prompt,
    maxRetries: 0,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: SESSION_PREP_TIMEOUT_MS,
    repairStrategy: 'haiku-then-sonnet',
    callSite: 'session-prep',
    schemaName: 'SessionPrepSchema',
    providerOptions: {
      mythrun: { campaignId: args.campaignId, worldId: args.worldId, stage: 'session_prep' },
    },
  })

  // myth-xbdkq — DRAIN UNCONDITIONALLY. This used to be `if (onProseDelta)`,
  // which made the delta sink accidentally load-bearing: `result.object` below
  // NEVER SETTLES unless something first consumes the stream, so a caller that
  // omitted the sink would hang for the full SESSION_PREP_TIMEOUT_MS (9 minutes)
  // and then fail. Verified against the real API on both Opus 4.7 and Opus 5:
  // `await .object` alone hangs past 90s; drain-then-await returns in ~2.5s. It
  // never bit only because the single production caller happens to pass a sink.
  // The sink is now optional to the DRAIN, not the other way round.
  try {
    await drainProseDeltas(result, onProseDelta)
  } catch {
    // A truncated stream can throw mid-drain; `await result.object` below is
    // authoritative, so swallow here rather than let a delta blip escape.
  }

  try {
    const output = await result.object
    const usage = await result.usage
    // A completed-but-length-capped object still lost content — treat it as an
    // overflow so the caller retries with a tighter budget.
    if ((await settledFinishReason(result)) === 'length') return { kind: 'overflow', usage }
    return { kind: 'ok', output, usage }
  } catch (err) {
    // The object promise rejects on a length-truncated stream (the JSON never
    // closes). Distinguish that from a genuine schema failure via finishReason.
    if ((await settledFinishReason(result)) === 'length') {
      return { kind: 'overflow', usage: await settledUsage(result) }
    }
    throw err
  }
}

// Progressive prose: diff each field's streamed value against the prior tick and
// forward only the newly-appended tail. We retain the previous full value per
// field and emit `value.slice(prev.length)` only when `value` strictly extends
// `prev` (`startsWith(prev)`). When the new value is NOT a strict extension — the
// AI SDK's mid-escape truncation, where a partial briefly rewrites an in-flight
// escape (e.g. a dangling `\` resolves to `\n`) so the prefix diverges — we
// resync `prev` and emit nothing for that tick rather than slice garbage.
// `onProseDelta` is OPTIONAL here by design (myth-xbdkq): the drain must happen
// whether or not anyone is listening, because consuming the stream is what makes
// `result.object` settle. With no sink this degenerates to a pure pump.
async function drainProseDeltas(
  result: ReturnType<typeof streamObject<SessionPrep>>,
  onProseDelta: GenerateSessionPrepArgs['onProseDelta'],
): Promise<void> {
  const FIELDS = ['ft_context', 'sd_playbook'] as const
  const prev: Record<(typeof FIELDS)[number], string> = { ft_context: '', sd_playbook: '' }
  for await (const partial of result.partialObjectStream) {
    // Pump-only mode: keep consuming so `.object` can settle, but skip the
    // per-field diffing when there is nobody to hand the deltas to.
    if (onProseDelta === undefined) continue
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
        onProseDelta(field, delta)
      } catch {
        /* fire-and-forget: a faulty sink must never abort generation */
      }
    }
  }
}

function toResult(output: SessionPrep, usage: LanguageModelUsage): SessionPrepResult {
  return { ft_context: output.ft_context, sd_playbook: output.sd_playbook, opening: output.opening, usage }
}

/** Read the stream's `finishReason` promise defensively (it may be absent on a
 *  hand-scripted test double, or reject on a torn stream). */
async function settledFinishReason(result: unknown): Promise<string | undefined> {
  const fr = (result as { finishReason?: unknown }).finishReason
  return Promise.resolve(fr).then(
    (r) => (typeof r === 'string' ? r : undefined),
    () => undefined,
  )
}

async function settledUsage(result: {
  usage: Promise<LanguageModelUsage>
}): Promise<LanguageModelUsage | undefined> {
  return Promise.resolve(result.usage).then(
    (u) => u,
    () => undefined,
  )
}

function logUsage(
  args: GenerateSessionPrepArgs,
  usage: LanguageModelUsage,
  attempt: number,
): void {
  // Growth observability: every successful prep logs its measured output tokens
  // against the cap, so operators can watch a long campaign approach the wall
  // before it hits (myth-vb2ov).
  logger.info(
    {
      event: 'session_prep.usage',
      campaignId: args.campaignId,
      sessionNumber: args.sessionNumber,
      attempt,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
    'session-prep output token usage',
  )
}

function logOverflow(
  args: GenerateSessionPrepArgs,
  usage: LanguageModelUsage | undefined,
  attempt: number,
): void {
  logger.warn(
    {
      event: 'session_prep.output_overflow',
      campaignId: args.campaignId,
      sessionNumber: args.sessionNumber,
      attempt,
      outputTokens: usage?.outputTokens,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      willRetry: attempt === 1,
    },
    `session-prep output overflowed the ${String(MAX_OUTPUT_TOKENS)}-token cap`,
  )
}
