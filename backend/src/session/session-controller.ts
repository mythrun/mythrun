// backend/src/session/session-controller.ts
//
// MYT-66 Task 7 — the transient, deterministic turn conductor.
//
// One SessionController exists for the life of ONE DM turn on the worker. It is
// a thin orchestration shell (Zero Framework Cognition): it makes no judgment
// calls — it loads the turn's in-memory state from Redis, sequences the tiers
// (Slow Thinker → Fast Thinker → Scribe), and flushes the mutated state back.
// Every reasoning call lives behind the injected tier seams (`tiers/types.ts`).
//
// THE RECOVERY INVARIANT: between `loadFromRedis()` and `flushToRedis()` the
// controller mutates ONLY its in-memory copy of the turn state — it issues NO
// direct Redis writes of its own. A crash mid-turn therefore leaves Redis at
// the pre-turn snapshot; the only state mutation is the single atomic
// `flushTurnState` MULTI at the end. (Streaming text_delta frames go out via
// the publisher, but those are transport, not turn state.)

import type { SessionState, SessionStateBlob } from '../redis/session-state.js'
import type {
  AssistantMessage,
  ConversationMessage,
  FastThinker,
  FtTurnContext,
  Scribe,
  SlowThinker,
  StEvaluation,
  TokenUsage,
  TriggerMessage,
} from './tiers/types.js'
import type { TurnPublisher } from './turn-publisher.js'

/** A pino logger is structurally compatible; only `warn` is needed here so the
 *  controller stays decoupled from the full Logger surface (mirrors the
 *  minimal-logger pattern in `llm/prep/streaming-extractor.ts`). */
interface MinimalLogger {
  warn: (objOrMsg: Record<string, unknown> | string, msg?: string) => void
}

export interface SessionControllerDeps {
  readonly sessionState: SessionState
  readonly st: SlowThinker
  readonly ft: FastThinker
  readonly scribe: Scribe
  readonly publisher: TurnPublisher
  readonly logger?: MinimalLogger
}

const ZERO_USAGE: TokenUsage = { input: 0, output: 0 }

export class SessionController {
  private readonly deps: SessionControllerDeps
  private readonly campaignId: string
  private readonly turnId: string

  // In-memory turn state, mutated between load and flush (the recovery
  // invariant). `participants` comes from the `:state` blob and is read-only
  // for the turn (the FT/ST see it via the context).
  private ftHistory: ConversationMessage[] = []
  private summary = ''
  private usage: TokenUsage = ZERO_USAGE
  private participants: readonly string[] = []

  constructor(deps: SessionControllerDeps, campaignId: string, turnId: string) {
    this.deps = deps
    this.campaignId = campaignId
    this.turnId = turnId
  }

  /** Hydrate the in-memory turn state from Redis: the three LLM-tier keys via
   *  `loadTurnState`, and the participant roster from the `:state` blob. */
  async loadFromRedis(): Promise<void> {
    const turnState = await this.deps.sessionState.loadTurnState(this.campaignId)
    this.ftHistory = [...turnState.ftHistory]
    this.summary = turnState.summary
    this.usage = turnState.usage

    const state: SessionStateBlob | null = await this.deps.sessionState.getState(this.campaignId)
    this.participants = state === null ? [] : state.participants
  }

  /** Sequence one DM turn: ST evaluate → append triggers (with optional
   *  direction injection) → FT render → turnEnd → fire-and-forget Scribe. */
  async processDmTurn(triggerMessages: TriggerMessage[]): Promise<void> {
    const ctx = this.buildContext(triggerMessages)

    const evaluation = await this.deps.st.evaluate(ctx)
    this.applyEvaluation(evaluation)
    this.appendTriggers(triggerMessages, evaluation)

    const ctxAfterTriggers = this.buildContext(triggerMessages)
    const emit = this.deps.publisher.emitFor(this.campaignId, this.turnId)
    const assistant = await this.deps.ft.render(ctxAfterTriggers, emit)
    this.appendAssistant(assistant)

    await this.deps.publisher.turnEnd(this.campaignId, this.turnId)

    // Fire-and-forget (H12): the Scribe extracts world-state deltas off the
    // critical path. Its failure must NEVER throw out of the turn — swallow and
    // log. The `Promise.resolve().then(...)` wrapper also captures a SYNCHRONOUS
    // throw (a non-async Scribe that throws before returning its promise) into
    // the same `.catch`, so neither a rejection nor a sync throw escapes. `void`
    // marks the deliberate non-await so no floating-promise lint.
    void Promise.resolve()
      .then(() => this.deps.scribe.extract(ctxAfterTriggers))
      .catch((err: unknown) => this.deps.logger?.warn({ err }, 'scribe.extract failed'))
  }

  /** Flush the mutated in-memory turn state back to Redis in one atomic MULTI
   *  (the only Redis write this controller performs). */
  async flushToRedis(): Promise<void> {
    await this.deps.sessionState.flushTurnState(this.campaignId, {
      ftHistory: this.ftHistory,
      summary: this.summary,
      usage: this.usage,
    })
  }

  private buildContext(triggerMessages: readonly TriggerMessage[]): FtTurnContext {
    return {
      campaignId: this.campaignId,
      triggerMessages,
      ftHistory: this.ftHistory,
      runningSummary: this.summary,
      participants: this.participants,
      usage: this.usage,
      workingSet: [],
    }
  }

  /** Apply the ST's evaluation: append ANY summary update (the running-summary
   *  is decoupled from `intervene` per the runtime spec §6 step 2 / MYT-66
   *  design §5 — only the stage `direction` is gated on `intervene`, in
   *  `appendTriggers`) and accumulate its token usage (H12.a). */
  private applyEvaluation(evaluation: StEvaluation): void {
    if (evaluation.summaryUpdate !== undefined) {
      this.summary = this.summary === ''
        ? evaluation.summaryUpdate
        : `${this.summary}\n${evaluation.summaryUpdate}`
    }
    this.usage = addUsage(this.usage, evaluation.usage)
  }

  /** Append each trigger as a `user` ConversationMessage. When the ST chose to
   *  intervene with a direction, fuse it onto the LAST user message's content
   *  so the FT renders under the stage direction (enforced ignorance holds: the
   *  direction is a constraint, the FT never learns WHY it was injected). */
  private appendTriggers(triggerMessages: readonly TriggerMessage[], evaluation: StEvaluation): void {
    const direction =
      evaluation.intervene && evaluation.direction !== undefined ? evaluation.direction : null

    triggerMessages.forEach((trigger, index) => {
      const isLast = index === triggerMessages.length - 1
      const content =
        direction !== null && isLast ? `${trigger.text}\n\n[DM direction: ${direction}]` : trigger.text
      this.ftHistory.push({ role: 'user', content, characterName: trigger.characterName })
    })
  }

  private appendAssistant(assistant: AssistantMessage): void {
    this.ftHistory.push({ role: 'assistant', content: assistant.content })
    this.usage = addUsage(this.usage, assistant.usage)
  }
}

/** Sum a tier's optional usage onto the running total. A tier that omits usage
 *  contributes nothing. */
function addUsage(total: TokenUsage, delta: TokenUsage | undefined): TokenUsage {
  if (delta === undefined) return total
  return { input: total.input + delta.input, output: total.output + delta.output }
}
