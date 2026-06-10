// backend/src/session/session-controller.ts
//
// MYT-68 Task 14 — the transient, deterministic turn conductor (PG-direct).
//
// One SessionController exists for the life of ONE DM turn on the worker. It is
// a thin orchestration shell (Zero Framework Cognition): it makes no judgment
// calls — it reconstructs the turn's in-memory FT history from session_messages
// (§3.7), sequences the tiers (Slow Thinker → Fast Thinker → Scribe), persists
// the rendered DM turn as ONE atomic PG append, and flushes the small turn
// state (summary/usage) back to Redis. Every reasoning call lives behind the
// injected tier seams (`tiers/types.ts`).
//
// THE RECOVERY INVARIANT (rewritten for the PG-direct model):
//
//   load → (in-memory only) → persistTurn → flushToRedis → [worker: turn_end]
//
// Between `loadFromRedis()`/`processDmTurn()` and `persistTurn()` the controller
// mutates ONLY its in-memory state (the reconstructed history, the running
// summary, the usage accumulator, the rendered assistant message) — it issues
// NO durable write of its own. `persistTurn()` is the SINGLE durability point: a
// ONE-statement, atomic, idempotent-on-turnId PG append (ON CONFLICT
// (turn_id, turn_ordinal) DO NOTHING in the repo). `flushToRedis()` then carries
// only the small {summary, usage} turn state. A crash BEFORE `persistTurn`
// therefore leaves both Postgres and Redis at the pre-turn snapshot — nothing to
// undo; BullMQ redelivery re-runs the turn cleanly. The `turn_end` frame is the
// WORKER's (Task 15): it is published only AFTER persist + flush + the trigger
// watermark advance, so a client never sees turn_end for a turn that did not
// durably land.

import type { SessionMessage } from '../repo/types.js'
import type { SessionState } from '../redis/session-state.js'
import { assistantToRows, rowsToConversation } from './transcript-codec.js'
import type {
  AssistantMessage,
  ConversationMessage,
  FastThinker,
  FtTurnContext,
  Scribe,
  SlowThinker,
  StEvaluation,
  TokenUsage,
  TurnEmitter,
} from './tiers/types.js'

/** A pino logger is structurally compatible; only `warn` is needed here so the
 *  controller stays decoupled from the full Logger surface (mirrors the
 *  minimal-logger pattern in `llm/prep/streaming-extractor.ts`). */
interface MinimalLogger {
  warn: (objOrMsg: Record<string, unknown> | string, msg?: string) => void
}

/** The session_messages access the controller needs, narrowed to the two
 *  methods it uses so the worker can bind a repo (or a tx) without exposing the
 *  whole surface. Mirrors `repo.sessionMessages.{listFtContextRows,appendDmTurn}`. */
export interface TranscriptStore {
  /** §3.7 single-piece context read: player rows ≤ the consumed watermark ∪ ALL
   *  DM rows, seq ASC. Returns the WHOLE FT context — there is no separate batch. */
  listFtContextRows(sessionId: string, maxPlayerSeq: number): Promise<SessionMessage[]>
  /** §3.7 atomic per-turn DM append (one multi-VALUES INSERT, idempotent on
   *  (turn_id, turn_ordinal)). Seqs are caller-allocated, in row order. */
  appendDmTurn(input: {
    sessionId: string
    turnId: string
    rows: readonly { kind: string; content: string }[]
    seqs: readonly number[]
  }): Promise<void>
}

export interface SessionControllerDeps {
  readonly sessionState: SessionState
  readonly st: SlowThinker
  readonly ft: FastThinker
  readonly scribe: Scribe
  /** The latched frame emitter the worker builds (Task 15): the FT streams every
   *  player-visible frame through it. The controller never emits itself. */
  readonly emitter: TurnEmitter
  readonly transcript: TranscriptStore
  /** userId → CHARACTER name, for the codec's player-row attribution. The
   *  attribution must be the character name (not a display name): the ft-system
   *  prompt instructs the model to echo the attributed name into
   *  roll_skill_check.character_name, which the skill-check resolver matches
   *  against session_participants — so the attribution and the resolver speak
   *  the same names. Resolved by the worker per turn from session_participants. */
  readonly attributionNames: ReadonlyMap<string, string>
  /** MYT-68: the FT prompt roster — the session's joined PC names. Resolved by
   *  the worker per turn from session_participants (the source of truth the
   *  skill-check resolver reads), in deterministic joined order — NOT the racy
   *  `:state` blob (two simultaneous joins lost a name to last-write-wins;
   *  caught live in the MYT-68 smoke). */
  readonly participants: readonly string[]
  /** The enforced-ignorance-safe prep doc (session_preps.ft_context), resolved
   *  by the worker (`:state` blob → PG re-load, §3.10). */
  readonly ftContext: string
  /** Allocates the next server-ordered seq (bound to `sessionState.nextSeq`). */
  readonly allocSeq: () => Promise<number>
  readonly logger?: MinimalLogger
}

const ZERO_USAGE: TokenUsage = { input: 0, output: 0 }

export class SessionController {
  private readonly deps: SessionControllerDeps
  private readonly campaignId: string
  private readonly sessionId: string
  private readonly turnId: string

  // In-memory turn state, mutated between load and persist (the recovery
  // invariant). `history` is reconstructed from session_messages each turn (no
  // longer Redis). The participant roster is NOT held here — it is a per-turn
  // dep (`deps.participants`), resolved by the worker from session_participants.
  // `assistant` is null until the FT renders it — persisting before
  // processDmTurn runs is a programmer error.
  private history: ConversationMessage[] = []
  private summary = ''
  private usage: TokenUsage = ZERO_USAGE
  private assistant: AssistantMessage | null = null

  constructor(deps: SessionControllerDeps, campaignId: string, sessionId: string, turnId: string) {
    this.deps = deps
    this.campaignId = campaignId
    this.sessionId = sessionId
    this.turnId = turnId
  }

  /** Hydrate the small in-memory turn state from Redis: the running summary +
   *  usage via `loadTurnState`. The participant roster is NOT read here — it is
   *  worker-resolved per turn from session_participants (deterministic order)
   *  and injected via `deps.participants`. The FT history is NOT loaded here
   *  either — it is reconstructed from session_messages in `processDmTurn`
   *  (PG-direct, §3.7). */
  async loadFromRedis(): Promise<void> {
    const turnState = await this.deps.sessionState.loadTurnState(this.campaignId)
    this.summary = turnState.summary
    this.usage = turnState.usage
  }

  /** Sequence one DM turn (no durable writes): reconstruct the FT history from
   *  session_messages → ST evaluate → apply evaluation (summary + usage) →
   *  optionally fuse the stage direction onto the last user message (in-memory
   *  only) → FT render → fire-and-forget Scribe. The `turn_end` frame is the
   *  worker's, published only after persist + flush + watermark. */
  async processDmTurn(maxConsumedSeq: number): Promise<void> {
    // §3.7: reconstruct the WHOLE FT context from session_messages. The codec
    // THROWS TranscriptCorruptError on an incoherent row — let it propagate
    // (crash-loud; the worker owns the terminal turn handling).
    const rows = await this.deps.transcript.listFtContextRows(this.sessionId, maxConsumedSeq)
    this.history = rowsToConversation(rows, this.deps.attributionNames)

    const evaluation = await this.deps.st.evaluate(this.buildContext())
    this.applyEvaluation(evaluation)
    this.fuseDirection(evaluation)

    this.assistant = await this.deps.ft.render(this.buildContext(), this.deps.emitter)
    this.usage = addUsage(this.usage, this.assistant.usage)

    // Fire-and-forget (H12): the Scribe extracts world-state deltas off the
    // critical path. Its failure must NEVER throw out of the turn — swallow and
    // log. The `Promise.resolve().then(...)` wrapper also captures a SYNCHRONOUS
    // throw (a non-async Scribe that throws before returning its promise) into
    // the same `.catch`, so neither a rejection nor a sync throw escapes. `void`
    // marks the deliberate non-await so no floating-promise lint.
    const scribeCtx = this.buildContext()
    void Promise.resolve()
      .then(() => this.deps.scribe.extract(scribeCtx))
      .catch((err: unknown) => this.deps.logger?.warn({ err }, 'scribe.extract failed'))
  }

  /** The single durability point: encode the rendered assistant message to DM
   *  rows (§3.7 codec), allocate one seq per row SEQUENTIALLY (order matters —
   *  turn_ordinal mirrors row order), and append them in ONE atomic, idempotent
   *  PG INSERT. An empty render (no rows) is a no-op. Calling before
   *  `processDmTurn` has rendered the assistant is a programmer error. */
  async persistTurn(): Promise<void> {
    if (this.assistant === null) {
      throw new Error('SessionController.persistTurn called before processDmTurn rendered the assistant')
    }
    const rows = assistantToRows(this.assistant)
    if (rows.length === 0) return

    // Allocate seqs SEQUENTIALLY (one per row, awaited in order) — the Redis
    // INCR is the server's ordering authority, and the rows' turn_ordinal
    // mirrors this allocation order. (A `while` rather than an index loop: the
    // body never reads the index, and `prefer-for-of` rejects the index form.)
    const seqs: number[] = []
    while (seqs.length < rows.length) {
      seqs.push(await this.deps.allocSeq())
    }

    await this.deps.transcript.appendDmTurn({
      sessionId: this.sessionId,
      turnId: this.turnId,
      rows,
      seqs,
    })
  }

  /** Flush the small in-memory turn state back to Redis: {summary, usage} only.
   *  The transcript is durable in Postgres (persistTurn); Redis carries no
   *  FT history as of MYT-68 (§3.7). */
  async flushToRedis(): Promise<void> {
    await this.deps.sessionState.flushTurnState(this.campaignId, {
      summary: this.summary,
      usage: this.usage,
    })
  }

  private buildContext(): FtTurnContext {
    return {
      campaignId: this.campaignId,
      ftContext: this.deps.ftContext,
      ftHistory: this.history,
      participants: this.deps.participants,
      usage: this.usage,
      workingSet: [],
    }
  }

  /** Apply the ST's evaluation: append ANY summary update (the running-summary
   *  is decoupled from `intervene` per the runtime spec §6 step 2 / MYT-66
   *  design §5 — only the stage `direction` is gated on `intervene`, in
   *  `fuseDirection`) and accumulate its token usage (H12.a). */
  private applyEvaluation(evaluation: StEvaluation): void {
    if (evaluation.summaryUpdate !== undefined) {
      this.summary = this.summary === ''
        ? evaluation.summaryUpdate
        : `${this.summary}\n${evaluation.summaryUpdate}`
    }
    this.usage = addUsage(this.usage, evaluation.usage)
  }

  /** When the ST chose to intervene with a direction, fuse it onto the LAST user
   *  message in the reconstructed history (in-memory ONLY; directions are
   *  per-turn ephemera, never persisted — §3.7). Enforced ignorance holds: the
   *  direction is a constraint, the FT never learns WHY it was injected. With no
   *  user message in the batch (an empty-batch edge), skip with a warn. */
  private fuseDirection(evaluation: StEvaluation): void {
    if (!evaluation.intervene || evaluation.direction === undefined) return
    if (!fuseDirectionIntoLastUserMessage(this.history, evaluation.direction)) {
      this.deps.logger?.warn(
        { campaignId: this.campaignId, turnId: this.turnId },
        'ST direction with no user message to fuse onto; skipping fusion',
      )
    }
  }
}

/**
 * Fuse a stage direction onto the LAST user message in `history` (in place):
 * its FIRST text part becomes `${text}\n\n[DM direction: ${direction}]`; every
 * other part is preserved verbatim. Returns false (fusing nothing) when the
 * history holds no user message — the caller owns the warn.
 *
 * Exported as a pure function so the multi-part preservation arm is directly
 * unit-testable: the §3.7 codec only ever produces SINGLE-text-part user
 * messages, so a multi-part last user message is unreachable through
 * `processDmTurn` — but this function must stay correct if that shape ever
 * changes, and the test pins it.
 */
export function fuseDirectionIntoLastUserMessage(
  history: ConversationMessage[],
  direction: string,
): boolean {
  const lastUserIndex = history.findLastIndex((message) => message.role === 'user')
  if (lastUserIndex === -1) return false

  const target = history[lastUserIndex]
  /* c8 ignore next 2 -- noUncheckedIndexedAccess narrowing; lastUserIndex comes
     from findLastIndex so the element exists */
  if (target === undefined) return false
  const fusedParts = target.parts.map((part, index) =>
    index === 0 && part.kind === 'text'
      ? ({ kind: 'text', text: `${part.text}\n\n[DM direction: ${direction}]` } as const)
      : part,
  )
  history[lastUserIndex] = { ...target, parts: fusedParts }
  return true
}

/** Sum a tier's optional usage onto the running total. A tier that omits usage
 *  contributes nothing. */
function addUsage(total: TokenUsage, delta: TokenUsage | undefined): TokenUsage {
  if (delta === undefined) return total
  return { input: total.input + delta.input, output: total.output + delta.output }
}
