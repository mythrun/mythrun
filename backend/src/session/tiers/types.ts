// backend/src/session/tiers/types.ts
//
// MYT-68 Task 7 — the tier-boundary seam, widened for the real FastThinker.
//
// Enforced ignorance is STRUCTURAL, not a prompting suggestion: the Fast
// Thinker is typed against `FtTurnContext`, which is public-by-construction
// (H4) — every field is FT-safe, and secrets simply have nowhere to live on
// this type. As of MYT-68 the seam is STRENGTHENED: `ftContext` is the
// enforced-ignorance-safe prep document (session_preps.ft_context; the
// secret-bearing sd_playbook never loads here), and the old `runningSummary`
// is REMOVED — it is authored by the secret-bearing Slow Thinker tier, the FT
// never reads it, and from MYT-69 the ST gets its own widened view via
// `TurnContext = FtTurnContext & StSecrets`. If you ever feel the urge to add
// a plot/NPC-secret field here so the FT can "see a little more," that is the
// bug the type system exists to prevent.
//
// This module is self-contained on purpose (H5): the emit seam (`TurnEmitter`)
// is a plain set of methods that does NOT import any frame type from
// `../../contract/session-events.js` — the publisher (turn-publisher.ts) is
// what builds the wire frame around each emitted piece. Keeping the seam
// frame-agnostic lets the contract module stay out of every tier
// implementation. The frame PAYLOAD types (`SkillCheckFramePayload`,
// `DiceRollFramePayload`) are owned here so both the FT consume loop and the
// publisher agree on the field-by-field shape without either depending on the
// other.

/** One player message that triggered this turn. Still rides the turn-queue
 *  payload for the MYT-67 trigger classifier. */
export interface TriggerMessage {
  readonly userId: string
  readonly characterName: string
  readonly text: string
}

/** One block of a multi-part conversation message (§3.7). Mythrun-OWNED and
 *  versioned — never persist the raw SDK ModelMessage shape; the FT maps
 *  to/from SDK messages at its boundary. */
export type ContentPart =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'tool_call'
      readonly toolCallId: string
      readonly toolName: string
      readonly input: unknown
    }
  | {
      readonly kind: 'tool_result'
      readonly toolCallId: string
      readonly toolName: string
      readonly output: unknown
    }

/** v1 of the Mythrun multi-part message. `v` is the schema version: a future
 *  shape change bumps it and the reader fails loud on an unknown version. */
export interface ConversationMessage {
  readonly v: 1
  readonly role: 'user' | 'assistant'
  readonly parts: readonly ContentPart[]
  readonly characterName?: string
}

export interface TokenUsage {
  readonly input: number
  readonly output: number
}

/**
 * PUBLIC-BY-CONSTRUCTION (H4) — and as of MYT-68, STRENGTHENED: ftContext is
 * the enforced-ignorance-safe prep doc (session_preps.ft_context; sd_playbook
 * never loads here), and runningSummary is REMOVED (ST-authored — secrets had
 * a place to live; the ST gets its own view in MYT-69 via
 * `TurnContext = FtTurnContext & StSecrets`). ftHistory is the WHOLE turn
 * context reconstructed from session_messages (§3.7 single-piece predicate)
 * including the current batch — there is no separate batch append.
 */
export interface FtTurnContext {
  readonly campaignId: string
  readonly ftContext: string
  readonly ftHistory: readonly ConversationMessage[]
  readonly participants: readonly string[]
  readonly usage: TokenUsage
  /** Reserved (H9); empty in MYT-68. */
  readonly workingSet: readonly unknown[]
}

/** Alias today; the ST's view becomes `FtTurnContext & StSecrets` in MYT-69. */
export type TurnContext = FtTurnContext

export interface StEvaluation {
  readonly intervene: boolean
  readonly direction?: string
  readonly summaryUpdate?: string
  readonly usage?: TokenUsage
}

/** Controller flushes these (H9). */
export interface ScribeResult {
  readonly workingSetDeltas: readonly unknown[]
}

/** Payload of a skill_check frame + transcript row (§3.5 step 6 — carries
 *  characterName: multiplayer clients must see WHOSE check fired). */
export interface SkillCheckFramePayload {
  readonly characterName: string
  readonly skill: string
  readonly context: string
  readonly roll: number
  readonly roll2: number | null
  readonly rollType: 'normal' | 'advantage' | 'disadvantage'
  readonly modifier: number
  readonly total: number
  readonly dc: number
  readonly outcomeTier: 'fail' | 'success' | 'great_success'
  readonly constraint: string
}

export interface DiceRollFramePayload {
  readonly count: number
  readonly sides: number
  readonly results: readonly number[]
  readonly total: number
}

/** The widened emit seam (§3.7): one method per player-visible frame kind.
 *  ALL emission happens from the FT's consume loop in stream-part order —
 *  tools never emit (§3.2 step 5). */
export interface TurnEmitter {
  emitText(text: string): Promise<void>
  emitSkillCheck(payload: SkillCheckFramePayload): Promise<void>
  emitDiceRoll(payload: DiceRollFramePayload): Promise<void>
}

export interface AssistantMessage {
  readonly role: 'assistant'
  readonly parts: readonly ContentPart[]
  /** totalUsage of the whole tool loop (all steps). */
  readonly usage?: TokenUsage
}

export interface SlowThinker {
  evaluate(ctx: FtTurnContext): Promise<StEvaluation>
}

export interface FastThinker {
  render(ctx: FtTurnContext, emit: TurnEmitter): Promise<AssistantMessage>
}

export interface Scribe {
  extract(ctx: FtTurnContext): Promise<ScribeResult>
}
