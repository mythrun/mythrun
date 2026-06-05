// backend/src/session/tiers/types.ts
//
// MYT-66 Task 4 — the tier-boundary seam, defined once.
//
// Enforced ignorance is STRUCTURAL, not a prompting suggestion: the Fast
// Thinker is typed against `FtTurnContext`, which is public-by-construction
// (H4) — every field is FT-safe, and secrets simply have nowhere to live on
// this type. The Slow Thinker and Scribe receive any secret material via their
// constructor dependencies, never via this context. If you ever feel the urge
// to add a plot/NPC-secret field here so the FT can "see a little more," that
// is the bug the type system exists to prevent.
//
// This module is self-contained on purpose (H5): `TurnEmit` is a plain
// `(text: string) => Promise<void>`. It does NOT import any frame type from
// `../../contract/session-events.js` — the publisher (Task 6) is what builds
// the wire frame around the emitted text. Keeping the seam frame-agnostic lets
// MYT-68 widen the emit signature without dragging the contract module into
// every tier implementation.

/** One player message that triggered this turn. */
export interface TriggerMessage {
  readonly userId: string
  readonly characterName: string
  readonly text: string
}

/**
 * Provisional (H12.f): MYT-68's tool loop needs multi-part content; widen then.
 */
export interface ConversationMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly characterName?: string
}

export interface TokenUsage {
  readonly input: number
  readonly output: number
}

/**
 * PUBLIC-BY-CONSTRUCTION (H4): every field is FT-safe. The FT and ST both read
 * this; secrets never go here.
 */
export interface FtTurnContext {
  readonly campaignId: string
  readonly triggerMessages: readonly TriggerMessage[]
  readonly ftHistory: readonly ConversationMessage[]
  readonly runningSummary: string
  /** The Redis `:state` shape (H12.b), NOT the repo `SessionParticipant`. */
  readonly participants: readonly string[]
  readonly usage: TokenUsage
  /** Reserved (H9); empty in MYT-66. */
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

export interface AssistantMessage {
  readonly role: 'assistant'
  readonly content: string
  readonly usage?: TokenUsage
}

/** Controller flushes these (H9). */
export interface ScribeResult {
  readonly workingSetDeltas: readonly unknown[]
}

/**
 * Publishes ONE text_delta cross-container. Kept as a plain `string` for
 * MYT-66 — the publisher in Task 6 builds the frame. MYT-68 may widen this (H5).
 */
export type TurnEmit = (text: string) => Promise<void>

export interface SlowThinker {
  evaluate(ctx: FtTurnContext): Promise<StEvaluation>
}

/**
 * `render`'s signature is PROVISIONAL (H5): MYT-68 adds a resolveTool callback
 * + a wider emit.
 */
export interface FastThinker {
  render(ctx: FtTurnContext, emit: TurnEmit): Promise<AssistantMessage>
}

export interface Scribe {
  extract(ctx: FtTurnContext): Promise<ScribeResult>
}
