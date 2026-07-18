// backend/src/session/session-controller.ts
//
// MYT-68 Task 14 — the transient, deterministic turn conductor (PG-direct).
//
// One SessionController exists for the life of ONE DM turn on the worker. It is
// a thin orchestration shell (Zero Framework Cognition): it makes no judgment
// calls — it reconstructs the turn's in-memory FT history from session_messages
// (§3.7), optionally fuses the worker-resolved one-shot direction onto the last
// user message, runs the single on-path reasoning tier (the Fast Thinker),
// persists the rendered DM turn as ONE atomic PG append, and flushes the small
// turn state (usage) back to Redis. The Scribe is no longer an on-path tier
// (MYT-73): it runs as a dedicated POST-TURN job (the secret tripwire + retcon
// author live off the hot path); the controller only assembles + enqueues that
// job (§2.4) via `enqueueScribeJob`, which the worker calls on the
// flushed-success path. The SlowThinker is OFF this path under the
// MYT-69 post-hoc model — it runs in its own worker; directions reach the turn
// as worker-resolved deps (`pendingDirection`, `standingDirective`). Every
// reasoning call lives behind the injected tier seams (`tiers/types.ts`).
//
// THE RECOVERY INVARIANT (rewritten for the PG-direct model):
//
//   load → (in-memory only) → persistTurn → flushToRedis → [worker: turn_end]
//
// Between `loadFromRedis()`/`processDmTurn()` and `persistTurn()` the controller
// mutates ONLY its in-memory state (the reconstructed history, the usage
// accumulator, the rendered assistant message) — it issues NO durable write of
// its own. `persistTurn()` is the SINGLE durability point: a ONE-statement,
// atomic, idempotent-on-turnId PG append (ON CONFLICT (turn_id, turn_ordinal)
// DO NOTHING in the repo). `flushToRedis()` then carries only the small {usage}
// turn state (MYT-69: the running summary is the ST job's, not the turn's). A crash BEFORE `persistTurn`
// therefore leaves both Postgres and Redis at the pre-turn snapshot — nothing to
// undo; BullMQ redelivery re-runs the turn cleanly. The `turn_end` frame is the
// WORKER's (Task 15): it is published only AFTER persist + flush + the trigger
// watermark advance, so a client never sees turn_end for a turn that did not
// durably land.

import type { SessionMessage } from '../repo/types.js'
import { isSeqUniqueViolation } from '../repo/session-messages.js'
import type { SessionState } from '../redis/session-state.js'
import { assistantToRows, rowsToConversation } from './transcript-codec.js'
import { enqueueScribe, type ScribeQueueLike } from './scribe-queue.js'
import type { WorkingSetProposal } from './working-set/types.js'
import type {
  AssistantMessage,
  ContentPart,
  ConversationMessage,
  FastThinker,
  FtTurnContext,
  PartyLedgerSnapshot,
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
  /** The DURABLE max seq (0 when no rows). persistTurn's myth-rf5rn heal reads
   *  it to raise an evicted/behind Redis `:seq` counter before its one retry. */
  maxSeq(sessionId: string): Promise<number>
  /** §3.7 atomic per-turn DM append (one multi-VALUES INSERT, idempotent on
   *  (turn_id, turn_ordinal)). Seqs are caller-allocated, in row order. */
  appendDmTurn(input: {
    sessionId: string
    turnId: string
    rows: readonly { kind: string; content: string }[]
    seqs: readonly number[]
    /** MYT-74b §5 — the originating turn trigger kind, written onto every row of
     *  the turn (shared, like turn_id). Omitted → NULL. Matches the repo binder. */
    triggerKind?: string
  }): Promise<void>
}

export interface SessionControllerDeps {
  readonly sessionState: SessionState
  readonly ft: FastThinker
  /** MYT-73 §2.4 — the narrow post-turn Scribe producer. `enqueueScribeJob`
   *  assembles + enqueues ONE job per turn carrying the player-facing prose (the
   *  tripwire input), the parsed FT world-delta, and this turn's ST injections.
   *  The WORKER (not the controller) gates the call on the flushed-success path. */
  readonly scribeQueue: ScribeQueueLike
  /** MYT-73 §2.4 — the campaign's world id, carried on the Scribe job payload for
   *  the post-turn reconciler's entity resolution. */
  readonly worldId: string
  /** MYT-73 §2.4 — the per-turn injection sink: the SAME array the worker wires
   *  into the FT tools' `recordInjection` (the ST-vet relay, MYT-72). A mid-turn
   *  lookup that relays/invents a fact pushes a (secret-free) proposal here;
   *  `enqueueScribeJob` carries the accumulated array onto the job payload. */
  readonly injections: readonly WorkingSetProposal[]
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
  /** myth-ph544: the shared, mutable player-agency gate set. `processDmTurn`
   *  fills it (normalized) from the batch — the PCs whose messages the DM is
   *  now answering — before rendering. The FT skill-check/lore tools read it to
   *  refuse rolling or recalling for a player character who did not act. */
  readonly actingCharacters: Set<string>
  /** The enforced-ignorance-safe prep doc (session_preps.ft_context), resolved
   *  by the worker (`:state` blob → PG re-load, §3.10). */
  readonly ftContext: string
  /** §6 one-shot direction (worker-resolved; GETDEL'd by the worker's fresh-run
   *  arm, passed in here). Fused onto the last user message BEFORE the FT render
   *  via the unchanged MYT-68 fusion seam. Optional; absent when no one-shot is
   *  pending. */
  readonly pendingDirection?: string
  /** §6 standing directive (worker-resolved; READ not consumed). Threaded onto
   *  the FT context — public-by-construction, rides the FT-facing context
   *  exactly like a fused one-shot. The FT appends it as a raw tail message
   *  AFTER the cache breakpoints (T14). Optional; absent when none is live. */
  readonly standingDirective?: string
  /** §7 party ledger snapshot (worker-resolved per turn from
   *  `repo.characters.readPartyLedgerSnapshot`). Public-by-construction — a
   *  player's own mechanical sheet, no enforced-ignorance interaction. Threaded
   *  onto the FT context; the FT renderer (T11) formats it into a non-persisted
   *  `[Party ledger: …]` tail after the cache breakpoints. Optional; absent when
   *  no characters are joined. */
  readonly partyLedger?: PartyLedgerSnapshot
  /** MYT-74b §5 — the originating turn-trigger kind. The turn worker passes
   *  `job.data.trigger.kind`; the controller threads it onto every persisted row
   *  via `appendDmTurn` so the post-session analysis can structurally exclude
   *  correction/farewell rows from voice-excerpt selection (enforced ignorance).
   *  Optional; absent → the rows' trigger_kind is NULL. */
  readonly triggerKind?: string
  /** Allocates the next server-ordered seq (bound to `sessionState.nextSeq`). */
  readonly allocSeq: () => Promise<number>
  /** myth-rf5rn heal: raises the Redis `:seq` counter to `max` (never lowers a
   *  live counter; bound to `sessionState.reseedSeq`). persistTurn calls it on
   *  a (session_id, seq) unique violation — the signal that the counter fell
   *  behind the durable rows (key expiry after >2h idle) — then re-allocates. */
  readonly reseedSeq: (max: number) => Promise<void>
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
  // The running summary is NOT held here either: under the MYT-69 post-hoc
  // model the ST owns the `:summary` key from its own worker, so the controller
  // neither reads nor writes it. `assistant` is null until the FT renders it —
  // persisting before processDmTurn runs is a programmer error.
  private history: ConversationMessage[] = []
  private usage: TokenUsage = ZERO_USAGE
  private assistant: AssistantMessage | null = null

  constructor(deps: SessionControllerDeps, campaignId: string, sessionId: string, turnId: string) {
    this.deps = deps
    this.campaignId = campaignId
    this.sessionId = sessionId
    this.turnId = turnId
  }

  /** Hydrate the small in-memory turn state from Redis: the usage accumulator
   *  via `loadTurnState`. The running summary on `loadTurnState`'s result is the
   *  ST job's artifact (MYT-69) — the controller ignores it; only `usage` is
   *  the turn's to accumulate and flush. The participant roster is NOT read here
   *  — it is worker-resolved per turn from session_participants (deterministic
   *  order) and injected via `deps.participants`. The FT history is NOT loaded
   *  here either — it is reconstructed from session_messages in `processDmTurn`
   *  (PG-direct, §3.7). */
  async loadFromRedis(): Promise<void> {
    const turnState = await this.deps.sessionState.loadTurnState(this.campaignId)
    this.usage = turnState.usage
  }

  /** Sequence one DM turn (no durable writes): reconstruct the FT history from
   *  session_messages → optionally fuse the worker-resolved one-shot direction
   *  onto the last user message (in-memory only) → FT render. The Scribe no
   *  longer runs here (MYT-73): it is a post-turn job the worker enqueues via
   *  `enqueueScribeJob` on the flushed-success path. Under the MYT-69 post-hoc
   *  model the ST does NOT run on this path either (it runs in its own worker);
   *  directions arrive as worker-resolved deps. The `turn_end` frame is the
   *  worker's, published only after persist + flush + watermark. */
  async processDmTurn(maxConsumedSeq: number): Promise<void> {
    // §3.7: reconstruct the WHOLE FT context from session_messages. The codec
    // THROWS TranscriptCorruptError on an incoherent row — let it propagate
    // (crash-loud; the worker owns the terminal turn handling).
    const rows = await this.deps.transcript.listFtContextRows(this.sessionId, maxConsumedSeq)
    this.history = rowsToConversation(rows, this.deps.attributionNames)

    // myth-ph544: the batch = the trailing run of player messages after the last
    // DM turn — the characters whose actions the DM is now answering. Fill the
    // shared gate set (normalized) so the FT tools refuse to roll or recall for
    // a player character who did NOT act this turn. A playerless turn
    // (correction / farewell / proactive) leaves the set empty → every PC-
    // attributed skill/lore call is refused, which is correct.
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i]
      if (m === undefined || m.role === 'assistant') break
      // role is now narrowed to 'user' (the only non-assistant role).
      if (m.characterName !== undefined && m.characterName !== '') {
        this.deps.actingCharacters.add(m.characterName.trim().toLowerCase())
      }
    }

    // §6: fuse the one-shot onto the LAST user message BEFORE the render. The
    // fuser targets the last user message; the standing tail is appended later,
    // at the FT boundary (T14), so it must not be present yet. The direction is
    // per-turn ephemera (never persisted — §3.7); enforced ignorance holds: the
    // FT sees the constraint, never WHY it was injected. With no user message in
    // the batch (an empty-batch edge), skip with a warn.
    if (this.deps.pendingDirection !== undefined) {
      if (!fuseDirectionIntoLastUserMessage(this.history, this.deps.pendingDirection)) {
        this.deps.logger?.warn(
          { campaignId: this.campaignId, turnId: this.turnId },
          'one-shot direction with no user message to fuse onto; skipping fusion',
        )
      }
    }

    this.assistant = await this.deps.ft.render(this.buildContext(), this.deps.emitter)
    this.usage = addUsage(this.usage, this.assistant.usage)
  }

  /** §2.4 — enqueue the post-turn Scribe job carrying this turn's player-facing
   *  prose (the tripwire input), the parsed FT world-delta, and the mid-turn ST
   *  injections recorded via the FtToolDeps sink. Called by the worker on the
   *  FLUSHED-SUCCESS path only (a turn that didn't durably land must not enqueue).
   *  Best-effort: the caller wraps it; this assembles + enqueues. */
  async enqueueScribeJob(): Promise<void> {
    if (this.assistant === null) return
    const prose = this.assistant.parts
      .filter((p): p is Extract<ContentPart, { kind: 'text' }> => p.kind === 'text')
      .map((p) => p.text)
      .join('\n\n')
    await enqueueScribe(this.deps.scribeQueue, {
      campaignId: this.campaignId,
      sessionId: this.sessionId,
      turnId: this.turnId,
      worldId: this.deps.worldId,
      prose,
      worldDelta: this.assistant.worldDelta ?? null,
      injections: this.deps.injections,
    })
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
    const allocate = async (): Promise<number[]> => {
      const seqs: number[] = []
      while (seqs.length < rows.length) {
        seqs.push(await this.deps.allocSeq())
      }
      return seqs
    }
    const append = (seqs: readonly number[]): Promise<void> =>
      this.deps.transcript.appendDmTurn({
        sessionId: this.sessionId,
        turnId: this.turnId,
        rows,
        seqs,
        // §5 — thread the worker-resolved trigger kind onto every row.
        // exactOptionalPropertyTypes: conditionally spread so the key is ABSENT
        // when no trigger kind was resolved, never present-with-undefined.
        ...(this.deps.triggerKind !== undefined ? { triggerKind: this.deps.triggerKind } : {}),
      })

    try {
      await append(await allocate())
    } catch (err) {
      if (!isSeqUniqueViolation(err)) throw err
      // myth-rf5rn — the Redis `:seq` counter fell behind the durable rows (key
      // expiry after a >2h idle stretch; INCR restarted low). Before this heal
      // the collision failed the whole turn: attempt 1 had already streamed
      // frames, so the BullMQ retry hit the wasTurnEmitted arm and the turn
      // died terminal ("streamed frames but never committed"). Heal exactly:
      // raise the counter to the durable MAX, re-allocate the WHOLE seq block
      // (turn_ordinal keeps mirroring allocation order), retry ONCE. The
      // multi-VALUES INSERT is atomic, so the failed attempt left no rows and
      // the retry re-inserts the full turn. A post-heal collision propagates.
      this.deps.logger?.warn(
        { campaignId: this.campaignId, turnId: this.turnId },
        'persistTurn seq collision — reseeding the counter from the durable max and retrying',
      )
      await this.deps.reseedSeq(await this.deps.transcript.maxSeq(this.sessionId))
      await append(await allocate())
    }
  }

  /** Flush the small in-memory turn state back to Redis: {usage} only (MYT-69
   *  narrowed signature). The running summary is the ST job's artifact now — a
   *  blind summary SET here would clobber the ST's background write. The
   *  transcript is durable in Postgres (persistTurn); Redis carries no FT
   *  history as of MYT-68 (§3.7). */
  async flushToRedis(): Promise<void> {
    await this.deps.sessionState.flushTurnState(this.campaignId, { usage: this.usage })
  }

  private buildContext(): FtTurnContext {
    return {
      campaignId: this.campaignId,
      ftContext: this.deps.ftContext,
      ftHistory: this.history,
      participants: this.deps.participants,
      usage: this.usage,
      workingSet: [],
      // §6 standing directive: rides the FT-facing context (public-by-
      // construction). exactOptionalPropertyTypes — conditionally spread so the
      // key is ABSENT when no directive is live, never present-with-undefined.
      // An EMPTY string can arrive (the ST schema's text has no .min(1)); the
      // FT's buildModelMessages owns empty-string suppression — don't "tighten"
      // this guard and assume symmetry.
      ...(this.deps.standingDirective !== undefined ? { standingDirective: this.deps.standingDirective } : {}),
      // §7 party ledger snapshot: public-by-construction, rides the FT-facing
      // context. exactOptionalPropertyTypes — conditionally spread so the key is
      // ABSENT when no snapshot was resolved (no joined characters), never
      // present-with-undefined.
      ...(this.deps.partyLedger !== undefined ? { partyLedger: this.deps.partyLedger } : {}),
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
