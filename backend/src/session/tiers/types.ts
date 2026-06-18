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
// is REMOVED — it is authored by the secret-bearing Slow Thinker, the FT never
// reads it. MYT-69 then retires the in-turn ST seam entirely: under the
// POST-HOC model the ST runs OFF the turn path in its own worker (it loads its
// own view from PG + Redis), so the `SlowThinker`/`StEvaluation` interfaces and
// the reserved `TurnContext = FtTurnContext & StSecrets` widening are GONE —
// the ST never consumes the FT's context object. The only ST-authored value
// that rides this type is `standingDirective`, which is public-by-construction
// (behavior-bound under the §4 channel contract — never secret rationale). If
// you ever feel the urge to add a plot/NPC-secret field here so the FT can
// "see a little more," that is the bug the type system exists to prevent.
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

/** §7 per-turn party ledger snapshot — the typed per-character mechanical
 *  block (HP, hit dice, gold, slots, conditions, tracked features, spells,
 *  equipment) read by `repo.characters.readPartyLedgerSnapshot`. Re-exported
 *  here so the tier layer has ONE import point for the snapshot type (T11). */
export type { PartyLedgerSnapshot } from '../../repo/characters-ledger.js'
import type { PartyLedgerSnapshot } from '../../repo/characters-ledger.js'

/** MYT-73 §4.2 — the per-turn world delta the Fast Thinker appends after its
 *  player-facing prose on a newline-anchored `\n[[WORLD_DELTA]]\n{json}` section.
 *  Public-by-construction (the FT has no secrets); the parser stamps
 *  `tier:'known'` downstream (the schema has no tier field). Re-exported here so
 *  the tier layer has ONE import point. */
export type { WorldDelta } from '../../llm/schemas/world-delta.js'
import type { WorldDelta } from '../../llm/schemas/world-delta.js'

/** The post-mutation values the FT needs to narrate concretely (constraint-
 *  injection: the resolver owns the outcome, the FT owns the telling). One
 *  flat shape — `kind` discriminates which optional values are populated,
 *  matching the §8 `ledger_update` frame one-for-one. CANONICAL HOME (T11):
 *  the Rules Lawyer (`rules-lawyer.ts`) and the emit seam (§8) import it from
 *  here; `rules-lawyer.ts` re-exports it so existing consumers keep their path. */
export interface LedgerUpdatePayload {
  readonly characterName: string
  readonly kind: 'hp' | 'gold' | 'item' | 'feature' | 'spell_slot' | 'condition' | 'rest'
  readonly summary: string
  readonly hp?: number
  readonly maxHp?: number
  readonly gold?: number
  readonly slotLevel?: number
  readonly slotsRemaining?: number
  readonly itemName?: string
  readonly quantity?: number
  readonly featureName?: string
  readonly usesRemaining?: number
  readonly condition?: string
  readonly diceRolled?: readonly number[]
}

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
 * a place to live). Under the MYT-69 post-hoc model the ST no longer consumes
 * this object at all (it runs off the turn path); the only ST-authored field
 * here is `standingDirective`, behavior-bound and public-by-construction.
 * ftHistory is the WHOLE turn context reconstructed from session_messages
 * (§3.7 single-piece predicate) including the current batch — there is no
 * separate batch append.
 */
export interface FtTurnContext {
  readonly campaignId: string
  readonly ftContext: string
  readonly ftHistory: readonly ConversationMessage[]
  readonly participants: readonly string[]
  readonly usage: TokenUsage
  /** Reserved (H9); empty in MYT-68. */
  readonly workingSet: readonly unknown[]
  /** §6 standing directive: a behavior-bound stage direction the ST authored
   *  under the §4 channel contract — public-by-construction (never secret
   *  rationale). The FT appends it as a raw `[DM direction: …]` tail message
   *  AFTER buildModelMessages places the cache breakpoints (T14). Optional;
   *  absent when no standing directive is live. */
  readonly standingDirective?: string
  /** §7 party ledger snapshot: each session-participant character's live
   *  mechanical sheet (HP, hit dice, gold, slot ledger, conditions, tracked
   *  features, spells, equipment) as of turn START. PUBLIC-BY-CONSTRUCTION — a
   *  player's own character sheet has NO enforced-ignorance interaction (it is
   *  the players' own numbers, not plot/NPC secrets), exactly like the existing
   *  public fields. The FT renderer (T11) formats it into ONE non-persisted
   *  `[Party ledger: …]` tail message AFTER the breakpoints (the block changes
   *  every turn — rendering it through the cached system prefix would bust the
   *  static-payload cache, §7). Optional; absent when no characters are joined. */
  readonly partyLedger?: PartyLedgerSnapshot
}

/**
 * Alias for `FtTurnContext`. MYT-66 reserved this as the SlowThinker's widened
 * view (`TurnContext = FtTurnContext & StSecrets`), but the MYT-69 POST-HOC
 * model SUPERSEDES that: the ST runs OFF the turn path in its own worker and
 * never consumes the FT's context object at all (it loads its own view from
 * PG + Redis). The `& StSecrets` widening is therefore NOT needed and was never
 * introduced — this stays a plain alias, retained only as a stable name for
 * the FT-facing turn context.
 */
export type TurnContext = FtTurnContext

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
  /** §4.2 — the NPC world-lookup roll-hidden variant sets this; the publisher
   *  omits the roll fields when true so a hidden NPC's standing never leaks.
   *  Absent on every other skill-check frame. */
  readonly rollHidden?: boolean
}

export interface DiceRollFramePayload {
  readonly count: number
  readonly sides: number
  readonly results: readonly number[]
  readonly total: number
}

/** MYT-75 §combat — the L1 mode-change frame payload: the session flips between
 *  exploration and combat. `reason` is a public, behavior-bound label (never
 *  secret rationale). */
export interface ModeChangeFramePayload {
  readonly from: 'exploration' | 'combat'
  readonly to: 'exploration' | 'combat'
  readonly reason: string
}

/** MYT-75 §combat — the combat_started frame payload: the rolled enemy roster
 *  and the initiative order. */
export interface CombatStartedFramePayload {
  readonly enemies: readonly { name: string; description: string; count: number }[]
  readonly initiative: readonly { combatant: string; roll: number }[]
}

/** MYT-75 §combat — the combat_resolved frame payload: the close-out narration,
 *  the outcome, the casualty list, and the per-combatant HP deltas. */
export interface CombatResolvedFramePayload {
  readonly narration: string
  readonly outcome: 'victory' | 'defeat' | 'flee' | 'other'
  readonly casualties: readonly { name: string; type: 'pc' | 'npc'; fate: string }[]
  readonly hpChanges: readonly {
    combatant: string
    hpBefore: number
    hpAfter: number
    maxHp: number
  }[]
}

/** The widened emit seam (§3.7): one method per player-visible frame kind.
 *  ALL emission happens from the FT's consume loop in stream-part order —
 *  tools never emit (§3.2 step 5). */
export interface TurnEmitter {
  emitText(text: string): Promise<void>
  emitSkillCheck(payload: SkillCheckFramePayload): Promise<void>
  emitDiceRoll(payload: DiceRollFramePayload): Promise<void>
  /** §8 post-mutation character-sheet delta. ONE emit per affected character:
   *  the single-payload ledger tools (cast/spend/acquire/adjust_hp/condition)
   *  emit once; `take_rest` emits once per character in its payload array. The
   *  consume loop only emits on `ok:true` (and a non-no-op condition) — `ok:false`
   *  rejections and idempotent no-ops emit nothing (§8). */
  emitLedgerUpdate(payload: LedgerUpdatePayload): Promise<void>
  /** MYT-75 §combat L1 — the session flips between exploration and combat. */
  emitModeChange(payload: ModeChangeFramePayload): Promise<void>
  /** MYT-75 §combat L1 — combat begins: the rolled enemy roster + initiative. */
  emitCombatStarted(payload: CombatStartedFramePayload): Promise<void>
  /** MYT-75 §combat L1 — combat ends: close-out narration, outcome, casualties,
   *  and per-combatant HP deltas. */
  emitCombatResolved(payload: CombatResolvedFramePayload): Promise<void>
}

export interface AssistantMessage {
  readonly role: 'assistant'
  readonly parts: readonly ContentPart[]
  /** totalUsage of the whole tool loop (all steps). */
  readonly usage?: TokenUsage
  /** MYT-73 §4.2 — the parsed `[[WORLD_DELTA]]` section the FT appended after its
   *  prose (the new named entities/facts introduced this turn, for the working
   *  set). The delimiter-guard strips the raw section from BOTH the live player
   *  stream AND the persisted transcript / re-injected FT history, so it never
   *  reaches `parts`; this is where the parsed result rides instead. Absent when
   *  the FT emitted no section, or when the section was present but unparseable
   *  (fail-soft — the prose still ships). */
  readonly worldDelta?: WorldDelta
}

export interface FastThinker {
  render(ctx: FtTurnContext, emit: TurnEmitter): Promise<AssistantMessage>
}
