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
// lifecycle as the MYT-68 mechanical frames. The remaining §5.2
// DM-turn frames (combat_*, session_end, st_evaluation, scribe_result,
// reaction_window, ...) are still deliberately ABSENT here — they land as
// those surfaces are built. Adding them prematurely would let the transport
// accept / broadcast frame types it has no handler for.
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
// session; no payload fields). `roll_complete`, `combat_action`,
// `auth_response`, `combat_move` are further full-protocol client frames added
// later.
export const CLIENT_FRAME_TYPES = [
  'player_message',
  'typing_start',
  'typing_stop',
  'dm_invoke',
  'end_session',
] as const

// Server -> Client frame types. The MYT-65 subset, the MYT-66 DM-turn
// streaming frames (`dm_thinking`, `text_delta`, `turn_end`, `turn_error`),
// the MYT-68 mechanical frames (`skill_check`, `dice_roll`, `dm_message`), and
// the MYT-70 `ledger_update` character-sheet delta frame. `combat_*`,
// `session_end`, etc. are further DM-turn frames added later.
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
] as const

// Snapshot of a connected participant, used in the reconnect replay payload.
// Mirrors the §5.2 `participants: Array<{userId, displayName, characterName}>`
// shape.
export interface ParticipantSummary {
  userId: string
  displayName: string
  characterName: string
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
  | { type: 'session_ready' }
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
    }
  | { type: 'error'; message: string }
  // MYT-66 DM-turn streaming frames (server -> client only). `turnId` is stable
  // across redeliveries (H2) so the client can dedup a re-streamed turn. These
  // are intra-turn / control frames and carry NO seq, consistent with the
  // presence-frame rule above.
  | { type: 'dm_thinking'; turnId: string }
  | { type: 'text_delta'; turnId: string; text: string }
  | { type: 'turn_end'; turnId: string }
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
  // MYT-70 character-sheet delta. Live-streamed during a turn (no seq) and
  // replayed from session_messages rows on reconnect (carrying the row's seq),
  // same lifecycle as skill_check/dice_roll above. ONE flat member: `kind`
  // discriminates which post-mutation value fields are populated (e.g. `hp` +
  // `maxHp` on an hp change, `slotLevel` + `slotsRemaining` on a spell_slot),
  // and `summary` is the always-present human-readable line. The concrete
  // value fields are all optional so a single shape covers every kind without a
  // union explosion. The publisher (later task) maps the LedgerUpdatePayload
  // onto these fields one-for-one; typecheck catches drift at the publisher.
  | {
      type: 'ledger_update'
      turnId: string
      seq?: number // present only on reconnect replay (persisted row)
      characterName: string
      kind: 'hp' | 'gold' | 'item' | 'feature' | 'spell_slot' | 'condition' | 'rest'
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
      diceRolled?: readonly number[]
    }
  // MYT-74a session-end broadcast. A one-shot lifecycle frame: the live session
  // is over. `reason` is `normal` for an explicit `end_session` summon or the
  // budget auto-end (T12 may add further reasons). Carries NO seq (a control
  // frame, like the presence frames) and is not persisted/replayed.
  | { type: 'session_end'; reason: 'normal' }

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
