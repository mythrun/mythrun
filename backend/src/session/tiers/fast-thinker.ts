// backend/src/session/tiers/fast-thinker.ts
//
// MYT-68 Task 13 — the real FastThinker. The player-facing prose tier: it
// streams Sonnet narration, lets the model call the deterministic dice/skill
// tools, and emits player-visible frames in the EXACT order the model produced
// them. Operates under enforced ignorance by construction — `FtTurnContext`
// is public-by-type (no plot/secret field has anywhere to live).
//
// DESIGN RULES (load-bearing — these are the heart of the tier, spec §3.2 /
// §3.6 / §3.9 / §5):
//
//   1. THE CONSUME LOOP IS THE SINGLE EMISSION POINT (§3.2 step 5). We iterate
//      `fullStream` and emit in stream-part ORDER. Tools NEVER emit: the SDK
//      executes tools at internal pipeline pace, AHEAD of the consumer, so an
//      execute-side publish would race earlier prose deltas. Part-order
//      emission == model-output order, and it serializes parallel same-step
//      tool calls deterministically (the stream lists them in a fixed order).
//
//   2. `error` AND `abort` ARE IN-BAND fullStream parts — the for-await NEVER
//      throws on its own (verified against the ai@6 dist). The loop MUST throw
//      on both, or a truncated turn gets persisted as canon:
//        - `error` part → throw `part.error` (already Mythrun-mapped by the
//          ai.ts middleware).
//        - `abort` part → throw `LlmTimeoutError` (the per-turn budget fired).
//
//   3. CAP CLOSE (§3.6): we NEVER use `toolChoice: 'none'` — the Anthropic
//      provider strips the tools param for it, producing a 400 when the
//      history still holds tool blocks. Instead `prepareStep` on the FINAL
//      step (stepNumber === FT_MAX_TOOL_STEPS - 1) appends an instructed-close
//      user message (`FT_CLOSE_INSTRUCTION`); every other step returns
//      undefined (no override).
//
//   4. WE ASSEMBLE THE RETURNED `AssistantMessage` PARTS DIRECTLY from the
//      consumed stream parts — text deltas coalesce into text parts, split at
//      tool boundaries; tool-call / tool-result parts append at their
//      positions. No coupling to the SDK's `response.messages` shape. A
//      dangling tool_call with no result (a cap-defied edge) is FILTERED from
//      the returned parts and logged at warn.
//
//   5. CACHE BREAKPOINTS (§3.9): the per-MESSAGE `providerOptions.anthropic.
//      cacheControl` breakpoint goes on (a) the system message and (b) the
//      last SETTLED message (second-to-last in the history array — the current
//      batch is the last and stays uncached). Call-level providerOptions
//      carries ONLY the mythrun log bindings (cache_control is silently inert
//      at call level on this provider).
//
//   6. FRAME EMISSION FROM TOOL-RESULT PARTS: a roll_skill_check ok-output is
//      mapped from snake_case to the camelCase `SkillCheckFramePayload`; an
//      output with an `error` key emits NO frame (fail-soft — no roll
//      happened). roll_dice maps to a `DiceRollFramePayload`, falling back to
//      the tool-call input for count/sides when the output omits them. We
//      track pending tool-call inputs by toolCallId.

import {
  streamTextWithTools,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from '../../llm/ai.js'
import { LlmTimeoutError } from '../../llm/errors.js'
import { loadPrompt } from '../../llm/prompts.js'
import { FT_MODEL, FT_MAX_TOOL_STEPS, FT_TURN_TIMEOUT_MS, FT_CLOSE_INSTRUCTION } from '../ft-config.js'
import type {
  FastThinker,
  FtTurnContext,
  TurnEmitter,
  AssistantMessage,
  ContentPart,
  ConversationMessage,
  SkillCheckFramePayload,
  DiceRollFramePayload,
  TokenUsage,
} from './types.js'

/** Per-MESSAGE Anthropic cache breakpoint (§3.9). Attached to the system
 *  message and the last settled history message. */
const ANTHROPIC_CACHE_BREAKPOINT = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
} as const

export interface SonnetFastThinkerDeps {
  /** The per-turn tool registry (`buildFtTools(...)`), constructed by the
   *  worker with that turn's scoped skill-check deps. */
  readonly tools: ToolSet
  readonly logger?: { warn: (o: Record<string, unknown>, m: string) => void }
  /** Test seam; defaults to FT_MODEL (Sonnet). */
  readonly model?: LanguageModel
  /** Test seam; defaults to FT_TURN_TIMEOUT_MS. */
  readonly timeoutMs?: number
}

// ── Message mapping ────────────────────────────────────────────────────────

/** Render one persisted ConversationMessage into one-or-two SDK ModelMessages.
 *  Assistant messages that carry tool_result parts split into an assistant
 *  message (text + tool-call blocks) followed by a tool message (tool-result
 *  blocks) per the SDK's role contract. */
function mapConversationMessage(msg: ConversationMessage): ModelMessage[] {
  if (msg.role === 'user') {
    const text = msg.parts
      .filter((p): p is Extract<ContentPart, { kind: 'text' }> => p.kind === 'text')
      .map((p) => p.text)
      .join('')
    return [{ role: 'user', content: `${msg.characterName ?? 'Player'}: ${text}` }]
  }

  // Assistant: split parts into assistant content (text + tool-call) and tool
  // content (tool-result).
  const assistantContent: AssistantContentBlock[] = []
  const toolContent: ToolResultBlock[] = []
  for (const part of msg.parts) {
    if (part.kind === 'text') {
      assistantContent.push({ type: 'text', text: part.text })
    } else if (part.kind === 'tool_call') {
      assistantContent.push({
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      })
    } else {
      toolContent.push({
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        // The SDK's ToolResultOutput union: a JSON tool output is
        // `{ type: 'json', value }`. `value` is typed `JSONValue`; our
        // persisted `output` is `unknown`, so narrow with a cast (the data
        // is always a JSON-serializable tool result by construction).
        output: { type: 'json', value: part.output as JsonValue },
      })
    }
  }

  const out: ModelMessage[] = [{ role: 'assistant', content: assistantContent }]
  if (toolContent.length > 0) {
    out.push({ role: 'tool', content: toolContent })
  }
  return out
}

/** Local mirrors of the SDK content-block shapes we emit. Kept narrow so the
 *  mapper stays self-documenting; the SDK's ModelMessage union accepts these. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }
type AssistantContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool-call'; readonly toolCallId: string; readonly toolName: string; readonly input: unknown }
interface ToolResultBlock {
  readonly type: 'tool-result'
  readonly toolCallId: string
  readonly toolName: string
  readonly output: { readonly type: 'json'; readonly value: JsonValue }
}

/**
 * Build the SDK message array for a turn (EXPORTED for tests; deterministic —
 * the same ctx maps to byte-identical messages). Layout:
 *   [ system(ft_context + roster, cache breakpoint),
 *     ...history mapped to user/assistant/tool messages,
 *     (optional) [DM direction: …] standing-directive tail ]
 * The cache breakpoint also rides the last SETTLED history message
 * (second-to-last entry; the current batch stays uncached). The §6 standing
 * directive, when live, is appended as ONE raw user message AFTER the
 * breakpoint placement — it rides the always-uncached zone past the last
 * breakpoint, never perturbing the cached prefix and never shifting the
 * sliding-breakpoint index. It is render-only: never persisted, never pushed
 * into ftHistory.
 */
export function buildModelMessages(ctx: FtTurnContext): ModelMessage[] {
  const system = loadPrompt('session', 'ft-system', {
    ft_context: ctx.ftContext,
    party_roster: ctx.participants.join(', '),
  })

  const historyMessages = ctx.ftHistory.flatMap(mapConversationMessage)

  // §3.9: cache breakpoint on the last settled message. The history's final
  // message is the current (unsettled) batch, so the breakpoint rides the
  // second-to-last ModelMessage. With only one history message there is no
  // settled prior turn, so nothing else is marked.
  if (historyMessages.length >= 2) {
    const idx = historyMessages.length - 2
    const target = historyMessages[idx]
    if (target !== undefined) {
      historyMessages[idx] = { ...target, providerOptions: ANTHROPIC_CACHE_BREAKPOINT }
    }
  }

  const messages: ModelMessage[] = [
    { role: 'system', content: system, providerOptions: ANTHROPIC_CACHE_BREAKPOINT },
    ...historyMessages,
  ]

  // §6 standing directive: a raw, uncached tail message AFTER the breakpoints.
  // NEVER persisted, NEVER pushed into ftHistory (that would shift the
  // sliding-breakpoint index and render through the codec's attribution as a
  // phantom "Player"). The controller resolved it from the standing slot (read,
  // not consumed). The wrapper form mirrors the fused one-shot's `[DM direction:
  // …]` delimiter; the ft-system DM Direction Protocol amendment (T5) covers the
  // standalone form.
  if (ctx.standingDirective !== undefined && ctx.standingDirective !== '') {
    messages.push({ role: 'user', content: `[DM direction: ${ctx.standingDirective}]` })
  }

  return messages
}

// ── prepareStep (cap close, §3.6) ────────────────────────────────────────────

function makePrepareStep(): NonNullable<Parameters<typeof streamTextWithTools>[0]['prepareStep']> {
  return ({ stepNumber, messages }) => {
    // Only the FINAL step gets the instructed-close override. NEVER
    // toolChoice:'none' — the provider strips the tools param for it.
    if (stepNumber === FT_MAX_TOOL_STEPS - 1) {
      return {
        messages: [...messages, { role: 'user', content: FT_CLOSE_INSTRUCTION }],
      }
    }
    return undefined
  }
}

// ── Frame mapping from tool-result outputs ───────────────────────────────────

function toSkillCheckFrame(output: Record<string, unknown>): SkillCheckFramePayload {
  return {
    characterName: String(output.character_name),
    skill: String(output.skill),
    context: String(output.context),
    roll: Number(output.roll),
    roll2: output.roll2 === null || output.roll2 === undefined ? null : Number(output.roll2),
    rollType: output.roll_type as 'normal' | 'advantage' | 'disadvantage',
    modifier: Number(output.modifier),
    total: Number(output.total),
    dc: Number(output.dc),
    outcomeTier: output.outcome_tier as 'fail' | 'success' | 'great_success',
    constraint: String(output.constraint),
  }
}

function toDiceRollFrame(
  output: Record<string, unknown>,
  callInput: Record<string, unknown> | undefined,
): DiceRollFramePayload {
  const count = output.count ?? callInput?.count
  const sides = output.sides ?? callInput?.sides
  const results = Array.isArray(output.results) ? (output.results as number[]) : []
  return {
    count: Number(count),
    sides: Number(sides),
    results,
    total: Number(output.total),
  }
}

// ── Stream-part assembly helpers ─────────────────────────────────────────────

/** Mutable accumulator for the returned AssistantMessage parts. Text deltas
 *  coalesce into the trailing text part; a tool boundary closes the current
 *  text run. */
class PartsAssembler {
  private readonly parts: ContentPart[] = []
  private textBuffer = ''

  pushTextDelta(text: string): void {
    this.textBuffer += text
  }

  private flushText(): void {
    if (this.textBuffer.length > 0) {
      this.parts.push({ kind: 'text', text: this.textBuffer })
      this.textBuffer = ''
    }
  }

  pushToolCall(toolCallId: string, toolName: string, input: unknown): void {
    this.flushText()
    this.parts.push({ kind: 'tool_call', toolCallId, toolName, input })
  }

  pushToolResult(toolCallId: string, toolName: string, output: unknown): void {
    this.flushText()
    this.parts.push({ kind: 'tool_result', toolCallId, toolName, output })
  }

  /** Finalize: flush any trailing text, then drop dangling tool_calls (a
   *  tool_call with no matching tool_result — the cap-defied edge), logging
   *  each at warn. */
  finalize(logger?: { warn: (o: Record<string, unknown>, m: string) => void }): ContentPart[] {
    this.flushText()
    const resolvedCallIds = new Set(
      this.parts
        .filter((p): p is Extract<ContentPart, { kind: 'tool_result' }> => p.kind === 'tool_result')
        .map((p) => p.toolCallId),
    )
    const kept: ContentPart[] = []
    for (const part of this.parts) {
      if (part.kind === 'tool_call' && !resolvedCallIds.has(part.toolCallId)) {
        logger?.warn(
          { toolCallId: part.toolCallId, toolName: part.toolName },
          'ft: dropping dangling tool_call with no result',
        )
        continue
      }
      kept.push(part)
    }
    return kept
  }
}

// ── The tier ─────────────────────────────────────────────────────────────────

export class SonnetFastThinker implements FastThinker {
  private readonly tools: ToolSet
  private readonly logger: { warn: (o: Record<string, unknown>, m: string) => void } | undefined
  private readonly model: LanguageModel
  private readonly timeoutMs: number

  constructor(deps: SonnetFastThinkerDeps) {
    this.tools = deps.tools
    this.logger = deps.logger
    this.model = deps.model ?? FT_MODEL
    this.timeoutMs = deps.timeoutMs ?? FT_TURN_TIMEOUT_MS
  }

  async render(ctx: FtTurnContext, emit: TurnEmitter): Promise<AssistantMessage> {
    const messages = buildModelMessages(ctx)
    const stream = streamTextWithTools({
      model: this.model,
      messages,
      tools: this.tools,
      stopWhen: stepCountIs(FT_MAX_TOOL_STEPS),
      prepareStep: makePrepareStep(),
      callSite: 'ft-turn',
      timeoutMs: this.timeoutMs,
      providerOptions: { mythrun: { campaignId: ctx.campaignId } },
    })

    const assembler = new PartsAssembler()
    // Track each pending tool-call's input by id so a roll_dice result can
    // fall back to it for count/sides.
    const pendingInputs = new Map<string, Record<string, unknown>>()

    for await (const part of stream.fullStream) {
      // `error` / `abort` are IN-BAND — the for-await never throws on its own.
      // Throwing here prevents a truncated turn from being persisted as canon.
      if (part.type === 'error') {
        throw part.error instanceof Error ? part.error : new Error(String(part.error))
      }
      if (part.type === 'abort') {
        throw new LlmTimeoutError('ft turn aborted (per-turn budget exceeded)')
      }

      if (part.type === 'text-delta') {
        assembler.pushTextDelta(part.text)
        await emit.emitText(part.text)
        continue
      }

      if (part.type === 'tool-call') {
        const input = asRecord(part.input)
        pendingInputs.set(part.toolCallId, input)
        assembler.pushToolCall(part.toolCallId, part.toolName, part.input)
        continue
      }

      if (part.type === 'tool-result') {
        assembler.pushToolResult(part.toolCallId, part.toolName, part.output)
        await this.emitFrameForResult(part.toolName, part.output, pendingInputs.get(part.toolCallId), emit)
        continue
      }
      // All other part types (text-start/end, step boundaries, finish, raw,
      // reasoning, tool-input-*) carry no player-visible payload — ignore.
    }

    const totalUsage = await stream.totalUsage
    const usage = mapUsage(totalUsage)
    const parts = assembler.finalize(this.logger)
    return { role: 'assistant', parts, usage }
  }

  private async emitFrameForResult(
    toolName: string,
    output: unknown,
    callInput: Record<string, unknown> | undefined,
    emit: TurnEmitter,
  ): Promise<void> {
    const out = asRecord(output)
    // Fail-soft: an `error` key means no roll happened — emit no frame.
    if ('error' in out) return

    if (toolName === 'roll_skill_check') {
      await emit.emitSkillCheck(toSkillCheckFrame(out))
      return
    }
    if (toolName === 'roll_dice') {
      await emit.emitDiceRoll(toDiceRollFrame(out, callInput))
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function mapUsage(totalUsage: { inputTokens?: number | undefined; outputTokens?: number | undefined }): TokenUsage {
  return { input: totalUsage.inputTokens ?? 0, output: totalUsage.outputTokens ?? 0 }
}
