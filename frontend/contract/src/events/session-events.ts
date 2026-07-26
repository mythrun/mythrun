// Declarative WebSocket wire contract for the multiplayer session transport.
//
// MYT-65 introduced the player-chat + system-event subset: the frames a
// client and server exchange to join a room, chat, signal typing, and replay
// history on reconnect. MYT-66 adds the first DM-turn streaming frames
// (dm_thinking, text_delta, turn_end, turn_error) as server->client only.
// MYT-68 adds the DM-turn mechanical frames (skill_check, dice_roll,
// dm_message) the FastThinker tool loop emits — live-streamed during a turn
// and replayed from session_messages rows on reconnect. MYT-70 adds
// ledger_update (server->client only) — a post-mutation character-sheet delta
// (hp/gold/item/feature/spell_slot/condition/rest), same live-then-replayed
// lifecycle as the MYT-68 mechanical frames. MYT-75 adds the combat L1 server
// frames (mode_change, combat_started, combat_resolved server->client) and the
// matching resume_combat client frame (T8, owned by the ws-session handler).
// The remaining §5.2 DM-turn frames (session_end already
// landed; st_evaluation, scribe_result, reaction_window, ...) are still
// deliberately ABSENT here — they land as those surfaces are built. Adding them
// prematurely would let the transport accept / broadcast frame types it has no
// handler for.
//
// Mirrors the pattern in backend/src/contract/pipeline-events.ts: a
// `readonly string[]` allowlist + a discriminated-union payload type per
// direction + a `classify*` tripwire over the client allowlist.
//
// Field names follow §5.2 of
// docs/specs/2026-04-06-production-architecture-overview.md (MYT-65 subset).
// The full-protocol `session_reconnect` also carries `combatState` and
// `inFlightResponse`; both are DM-turn / combat surfaces (MYT-66+) and are
// omitted from this subset.

// Client -> Server frame types. The MYT-65 subset (`player_message`,
// `typing_start`, `typing_stop`), the MYT-67 explicit `dm_invoke` summon — the
// "@DM button" that asks the DM to take a turn (no payload fields) — and the
// MYT-74a `end_session` lifecycle frame (a bare summon that ends the live
// session; no payload fields), and the MYT-75 `resume_combat` summon (a bare
// summon that flips a combat-mode session back to exploration; no payload
// fields). `roll_complete`, `combat_action`, `auth_response`, `combat_move` are
// further full-protocol client frames added later.
export const CLIENT_FRAME_TYPES = [
  'player_message',
  'typing_start',
  'typing_stop',
  'dm_invoke',
  'end_session',
  // MYT-75 T8: the combat-resume summon. Combat resolves single-shot, then the
  // session SITS in `combat` mode (the `:combat` blob, status `resolved`)
  // showing the result until ANY member sends `resume_combat`, which flips back
  // to `exploration`. Carries no payload fields (the summon is the whole signal).
  'resume_combat',
] as const

// Server -> Client frame types. The MYT-65 subset, the MYT-66 DM-turn
// streaming frames (`dm_thinking`, `text_delta`, `turn_end`, `turn_error`),
// the MYT-68 mechanical frames (`skill_check`, `dice_roll`, `dm_message`), the
// MYT-70 `ledger_update` character-sheet delta frame, and the MYT-75 combat L1
// frames (`mode_change`, `combat_started`, `combat_resolved`). Further DM-turn
// frames (`st_evaluation`, `scribe_result`, ...) are added later.
export const SERVER_FRAME_TYPES = [
  'session_ready',
  'session_reconnect',
  'player_joined',
  'player_left',
  'player_message',
  'typing_start',
  'typing_stop',
  'error',
  // MYT-66 DM-turn streaming frames (server -> client only). Each carries a
  // `turnId` (H2: stable across redeliveries; the client dedups a re-streamed
  // turn on it). They are intra-turn / control frames and carry NO seq.
  'dm_thinking',
  'text_delta',
  'turn_end',
  'turn_error',
  // MYT-68 DM-turn mechanical frames. Live-streamed during a turn (no seq,
  // like text_delta) AND replayed from session_messages rows on reconnect
  // (then carrying the row's seq). `dm_message` is replay-only: the
  // consolidated DM prose row (live prose streams as text_delta).
  // `roll_complete` is deliberately NOT added to CLIENT_FRAME_TYPES — no
  // server handler exists (spec §3.8); it lands with the frontend
  // roll-animation issue.
  'skill_check',
  'dice_roll',
  'dm_message',
  // MYT-70 character-sheet delta frame. Same live-then-replayed lifecycle as
  // the mechanical frames above: streamed during a turn (no seq) and replayed
  // from session_messages rows on reconnect (carrying the row's seq).
  'ledger_update',
  // MYT-74a session-end frame (server -> client only). A one-shot lifecycle
  // broadcast: the live session is over (the end-of-session reconcile has been
  // fired). Carries a `reason` (`normal` for an explicit/auto end). Not
  // persisted, not replayed — a reconnect to an ended session is rejected at the
  // ws-ticket handshake (status !== 'active'), so there is no replay path here.
  'session_end',
  // MYT-75 combat L1 frames. Same live-then-replayed lifecycle as the MYT-68
  // mechanical frames: streamed during a turn (no seq) and replayed from
  // session_messages rows on reconnect (then carrying the row's seq).
  // `mode_change` flips exploration<->combat; `combat_started` carries the
  // rolled enemy roster + initiative; `combat_resolved` carries the close-out
  // narration + outcome + casualties + HP deltas.
  'mode_change',
  'combat_started',
  'combat_resolved',
  // The DM CORRECTION channel: a rare, legitimate errata frame — the DM amends
  // something previously narrated ("what was said before is corrected"). Same
  // live-then-replayed lifecycle as the mechanical frames (streamed during a
  // turn with no seq; replayed from the persisted `dm_correction`
  // session_messages row on reconnect, carrying that row's seq). It is NOT DM
  // narration: the client renders it as a set-apart errata slip in the
  // transcript, never as story prose (so a correction can never masquerade as
  // the fiction it corrects).
  'dm_correction',
] as const

// Snapshot of a connected participant, used in the reconnect replay payload.
// Mirrors the §5.2 `participants: Array<{userId, displayName, characterName}>`
// shape.
/**
 * One condition currently active on a character, as carried by a
 * `ledger_update` frame's `activeConditions` (myth-hlydp).
 *
 * `level` is the 5e exhaustion track (1-6) and is `null` for every other
 * condition. It rides the wire as structured data rather than surviving only
 * in the prose `summary`, so a client can render "Exhaustion 3" without
 * re-parsing prose — parsing prose to recover mechanics is exactly the
 * local-intelligence pattern the architecture bans.
 */
export interface ActiveCondition {
  readonly condition: string
  readonly level: number | null
}

export interface ParticipantSummary {
  userId: string
  displayName: string
  characterName: string
}

/**
 * myth-nu0hm — how far through its mechanical ceiling this session is.
 *
 * `fraction` is 0..1, MONOTONIC NON-DECREASING within a session, and COARSE
 * (always an exact multiple of 0.05). It is the max of the server's mechanical
 * ceilings — cumulative token spend against the session budget, and the Fast
 * Thinker's context fill against its usable window — because the session ends
 * when EITHER is reached. Computed in backend/src/session/session-progress.ts.
 *
 * PURELY MECHANICAL, and deliberately so: it is the one progress number the
 * PLAYER sees, so under enforced ignorance it may never encode plot state, NPC
 * secrets, or any narrative judgment about how close the story is to an ending.
 * The narrative side of converging lives with the SlowThinker, on the secret
 * side of the boundary, and never rides this field.
 *
 * A client should render it as an approximate "how much evening is left"
 * signal, never as a countdown to an exact moment: the fraction can hold flat
 * across several turns, and it can jump a bucket or two after a token-heavy
 * combat turn. It must never be shown decreasing — the server guarantees it
 * won't, and a client that interpolates should clamp the same way.
 */
export interface SessionProgress {
  readonly fraction: number
}

// Client -> Server payloads. Discriminated on `type`.
export type ClientFrame =
  | { type: 'player_message'; text: string }
  | { type: 'typing_start' }
  | { type: 'typing_stop' }
  // MYT-67: explicit "@DM button" summon — asks the DM to take a turn. Carries
  // no payload fields (the summon itself is the whole signal).
  | { type: 'dm_invoke' }
  // MYT-74a: explicit session-end summon — ends the live session (fires the
  // end-of-session reconcile). Carries no payload fields (the summon is the
  // whole signal); the server resolves campaign/world/session from the socket.
  | { type: 'end_session' }
  // MYT-75 T8: combat-resume summon — flips a `combat`-mode session (sitting on a
  // resolved fight) back to `exploration`. Carries no payload fields; the server
  // resolves campaign/session from the socket and reads the live `:state`/`:combat`
  // blobs. A once-only interlock (`tryMarkResumed`) collapses concurrent summons.
  | { type: 'resume_combat' }

// Server -> Client payloads. Discriminated on `type`.
//
// Only `player_message` carries the server-assigned monotonic `seq` (§5.2:
// `Redis INCR` on `session:{campaignId}:seq`); clients render the SEQ STREAM
// in seq order, not arrival order. `session_ready` / `player_joined` /
// `player_left` / `typing_*` / `error` are non-ordered, out-of-band control /
// presence frames and carry NO seq — they are not persisted to
// `session_messages`, so a client must never gap-detect on a seq they carry
// (that would corrupt reconnect-replay ordering). Per architecture overview
// §5.2, which lists no seq on the presence frames.
export type ServerFrame =
  // myth-nu0hm: `progress` rides session_ready so a client that has just joined
  // is not blank until the next turn completes — the fraction is session-scoped
  // state the server already holds, so the very first frame can carry it.
  // OPTIONAL and additive: absent on a brand-new session (nothing burned yet)
  // and whenever the read fails, and no existing consumer breaks by ignoring it.
  | { type: 'session_ready'; progress?: SessionProgress }
  | {
      type: 'player_joined'
      userId: string
      displayName: string
      characterName: string
    }
  | { type: 'player_left'; userId: string }
  | {
      type: 'player_message'
      seq: number
      userId: string
      displayName: string
      characterName: string
      text: string
    }
  | { type: 'typing_start'; userId: string; displayName?: string }
  | { type: 'typing_stop'; userId: string; displayName?: string }
  | {
      type: 'session_reconnect'
      messages: ServerFrame[]
      participants: ParticipantSummary[]
      mode: 'exploration' | 'combat'
      // myth-nu0hm: `progress` rides session_reconnect too, and in practice this
      // — not `session_ready` — is the arm that reaches a real client. The
      // shipped web client connects with `seedLastSeq: 0`, so it always puts
      // `lastSeq=0` on the upgrade URL; the server's `parseLastSeq` treats 0 as
      // a valid seq, takes the RECONNECT branch, and `session_ready` is never
      // sent. Carrying the fraction on only the two originally-pinned frames
      // would have left every real join blank until the first turn completed.
      //
      // ABSENT on the corrected-turn whole-turn-replace, which reuses this frame
      // kind (turn-publisher's `turnReplace`) but makes no progress statement.
      // Absence means "no statement" — hold the last known value, don't reset.
      progress?: SessionProgress
    }
  | { type: 'error'; message: string }
  // MYT-66 DM-turn streaming frames (server -> client only). `turnId` is stable
  // across redeliveries (H2) so the client can dedup a re-streamed turn. These
  // are intra-turn / control frames and carry NO seq, consistent with the
  // presence-frame rule above.
  | { type: 'dm_thinking'; turnId: string }
  | { type: 'text_delta'; turnId: string; text: string }
  // myth-nu0hm: `progress` rides turn_end because that frame already fires
  // exactly once per turn, AFTER persist + flush — the natural beat on which
  // the mechanical counters have just moved. OPTIONAL: absent when the
  // computation fails, so a progress hiccup can never cost the table a
  // turn_end (which is what tells the client the turn is over).
  | { type: 'turn_end'; turnId: string; progress?: SessionProgress }
  | { type: 'turn_error'; turnId: string; message: string }
  // MYT-68 DM-turn mechanical frames. Live-streamed during a turn (no seq) and
  // replayed from session_messages rows on reconnect (carrying the row's seq).
  | {
      type: 'skill_check'
      turnId: string
      seq?: number // present only on reconnect replay (persisted row)
      characterName: string
      skill: string
      context: string
      roll: number
      roll2: number | null
      rollType: 'normal' | 'advantage' | 'disadvantage'
      modifier: number
      total: number
      dc: number
      outcomeTier: 'fail' | 'success' | 'great_success'
      constraint: string
    }
  | {
      type: 'dice_roll'
      turnId: string
      seq?: number
      count: number
      sides: number
      results: number[]
      total: number
    }
  // Replay-only: one consolidated DM prose row (live prose = text_delta).
  | { type: 'dm_message'; seq: number; turnId: string; text: string }
  // myth-d6knq §correction-channel — a structured DM correction from the FT's
  // `issue_correction` tool (never inline prose). Live-streamed during a turn
  // (no seq) and replayed from the persisted dm_correction row on reconnect
  // (then carrying the row's seq), same lifecycle as the mechanical frames.
  // SHARED CONTRACT with the frontend rendering: the live frame is exactly
  // `{ type: 'dm_correction', turnId, text }`.
  | { type: 'dm_correction'; turnId: string; seq?: number; text: string }
  // MYT-70 character-sheet delta. Live-streamed during a turn (no seq) and
  // replayed from session_messages rows on reconnect (carrying the row's seq),
  // same lifecycle as skill_check/dice_roll above. ONE flat member: `kind`
  // discriminates which post-mutation value fields are populated (e.g. `hp` +
  // `maxHp` on an hp change, `slotLevel` + `slotsRemaining` on a spell_slot),
  // and `summary` is the always-present human-readable line. The concrete
  // value fields are all optional so a single shape covers every kind without a
  // union explosion. The publisher (later task) maps the LedgerUpdatePayload
  // onto these fields one-for-one; typecheck catches drift at the publisher.
  //
  // `restType` (myth-lhp99) rides ONLY the `kind: 'rest'` LIVE frame — the
  // structured short/long discriminator the play surface hangs its wind-down
  // "call it a night?" offer off (parsing the human-readable `summary` prose for
  // "long rest" would be a brittle copy-coupling). Absent on replay: a long rest
  // from an hour ago must NOT re-pop the offer, so it is a live-only signal like
  // the missing `seq`.
  | {
      type: 'ledger_update'
      turnId: string
      seq?: number // present only on reconnect replay (persisted row)
      characterName: string
      kind: 'hp' | 'gold' | 'item' | 'feature' | 'spell_slot' | 'condition' | 'rest'
      restType?: 'short' | 'long' // present only on a LIVE kind:'rest' frame
      summary: string
      hp?: number
      maxHp?: number
      gold?: number
      slotLevel?: number
      slotsRemaining?: number
      itemName?: string
      quantity?: number
      featureName?: string
      usesRemaining?: number
      condition?: string
      // myth-hlydp: the character's FULL post-mutation active-condition set —
      // authoritative, not a delta, exactly like the `hp`/`gold` post-values
      // above. A client SETS its condition state from this whenever the field
      // is present, so re-applying a frame (a reconnect replay) is idempotent.
      //
      // A direction flag was the obvious alternative and does NOT work: a long
      // rest mutates TWO conditions in one operation (clears unconscious via
      // the HP->max write, decrements exhaustion) while emitting a single
      // `kind:'rest'` frame, and every HP write silently syncs the HP-derived
      // `unconscious` row while emitting only `kind:'hp'`. One
      // {condition, direction} pair per frame cannot express either. The full
      // list can, which is why it rides the hp/rest frames too, not just
      // `kind:'condition'`.
      //
      // ABSENT on frames whose tool cannot touch conditions (gold, item,
      // feature, spell_slot): absence means "no statement", so a client holds
      // its last known set rather than clearing it.
      activeConditions?: readonly ActiveCondition[]
      diceRolled?: readonly number[]
    }
  // MYT-74a session-end broadcast. A one-shot lifecycle frame: the live session
  // is over. `reason` is `normal` for an explicit `end_session` summon or the
  // budget auto-end (T12 may add further reasons). Carries NO seq (a control
  // frame, like the presence frames) and is not persisted/replayed.
  | { type: 'session_end'; reason: 'normal' }
  // MYT-75 combat L1 frames. Live-streamed during a turn (no seq) and replayed
  // from session_messages rows on reconnect (then carrying the row's seq), same
  // lifecycle as the MYT-68 mechanical frames. Each carries `turnId` (stable
  // across redeliveries, H2) when emitted INSIDE a turn.
  | {
      type: 'mode_change'
      // OPTIONAL (MYT-75 T8): a turn emits mode_change with a turnId, but the
      // `resume_combat` flip back to exploration is turn-LESS (no turn is
      // running), so it publishes mode_change without one.
      turnId?: string
      seq?: number // present only on reconnect replay (persisted row)
      from: 'exploration' | 'combat'
      to: 'exploration' | 'combat'
      reason: string
    }
  | {
      type: 'combat_started'
      turnId: string
      seq?: number // present only on reconnect replay (persisted row)
      enemies: readonly { name: string; description: string; count: number }[]
      initiative: readonly { combatant: string; roll: number }[]
    }
  | {
      type: 'combat_resolved'
      turnId: string
      seq?: number // present only on reconnect replay (persisted row)
      narration: string
      outcome: 'victory' | 'defeat' | 'flee' | 'other'
      casualties: readonly { name: string; type: 'pc' | 'npc'; fate: string }[]
      hpChanges: readonly {
        combatant: string
        hpBefore: number
        hpAfter: number
        maxHp: number
      }[]
    }

// Tripwire over the client allowlist. Only these client frame types may
// originate a persisted/broadcast frame; everything else (DM-turn frames,
// unknown garbage) is rejected at the transport boundary. Mirrors the
// `classifyPipelineEvent` gate in sse/pipeline-subscriber.ts (which checks
// membership against the PIPELINE_SSE_EVENTS allowlist declared alongside
// this one in pipeline-events.ts) — a structural gate, not LLM cognition
// (ZFC exception: structural validation).
export function classifyClientFrame(t: string): boolean {
  return (CLIENT_FRAME_TYPES as readonly string[]).includes(t)
}
