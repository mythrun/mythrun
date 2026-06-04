// Declarative WebSocket wire contract for the multiplayer session transport.
//
// MYT-65 covers the player-chat + system-event subset ONLY: the frames a
// client and server exchange to join a room, chat, signal typing, and replay
// history on reconnect. The DM-turn frames from the full §5.2 protocol
// (text_delta, dm_thinking, skill_check, dice_roll, turn_end, combat_*,
// session_end, st_evaluation, scribe_result, reaction_window, ...) are
// deliberately ABSENT here — they land in MYT-66 when the DM-turn streaming
// surface is built. Adding them prematurely would let the transport accept /
// broadcast frame types it has no handler for.
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

// Client -> Server frame types (the only types a client may originate in
// MYT-65). `dm_invoke`, `roll_complete`, `end_session`, `combat_action`,
// `auth_response`, `combat_move` are full-protocol client frames added later.
export const CLIENT_FRAME_TYPES = ['player_message', 'typing_start', 'typing_stop'] as const

// Server -> Client frame types for the MYT-65 subset. `text_delta`,
// `dm_thinking`, `turn_end`, `combat_*`, `session_end`, etc. are DM-turn
// frames added in MYT-66.
export const SERVER_FRAME_TYPES = [
  'session_ready',
  'session_reconnect',
  'player_joined',
  'player_left',
  'player_message',
  'typing_start',
  'typing_stop',
  'error',
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
