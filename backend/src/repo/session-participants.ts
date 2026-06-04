import { type Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { charactersNs } from './characters.js'
import { toSessionParticipant, type SessionParticipantDbRow } from './mappers.js'
import { NoCharacterForParticipantError } from './session-participants-errors.js'
import type { JoinParticipantInput, SessionParticipant } from './types.js'
import type { ClientLike } from './_types.js'

// Composable binder — see sessionsNs for the pattern rationale. Each method
// captures the ClientLike `c` so the body serves `repo.sessionParticipants.X`
// and `tx.sessionParticipants.X`.
//
// session_participants (migration 001):
//   id UUID PK, session_id UUID FK→sessions (CASCADE),
//   user_id UUID FK→users, character_id UUID NOT NULL FK→characters,
//   joined_at TIMESTAMPTZ, UNIQUE(session_id, user_id).
//
// The campaign is `active` when a session is live, so every member has an
// integrated character. `join` resolves it server-side via the characters
// namespace — the client never supplies a character_id, and a missing
// character surfaces as a typed NoCharacterForParticipantError rather than a
// raw 23503 FK violation.
export function sessionParticipantsNs(c: ClientLike) {
  const characters = charactersNs(c)
  return {
    join: async (input: JoinParticipantInput): Promise<SessionParticipant> => {
      const character = await characters.findUserCharacterForCampaign(
        input.userId,
        input.campaignId,
      )
      if (!character) {
        throw new NoCharacterForParticipantError(input.campaignId, input.userId)
      }
      // ON CONFLICT DO UPDATE (no-op) so the row is returned whether this is a
      // fresh join or a re-join — avoids a second round-trip to fetch the
      // existing row that DO NOTHING + null-return would require.
      const result = await c.query<SessionParticipantDbRow>(
        `INSERT INTO session_participants (id, session_id, user_id, character_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (session_id, user_id) DO UPDATE
           SET joined_at = session_participants.joined_at
         RETURNING *`,
        [uuidv7(), input.sessionId, input.userId, character.id],
      )
      const row = result.rows[0]
      if (!row) throw new Error('sessionParticipants.join: INSERT returned no row')
      return toSessionParticipant(row)
    },

    leave: async (sessionId: string, userId: string): Promise<void> => {
      await c.query(
        `DELETE FROM session_participants WHERE session_id = $1 AND user_id = $2`,
        [sessionId, userId],
      )
    },

    list: async (sessionId: string): Promise<SessionParticipant[]> => {
      const result = await c.query<SessionParticipantDbRow>(
        `SELECT * FROM session_participants WHERE session_id = $1 ORDER BY joined_at ASC, id ASC`,
        [sessionId],
      )
      return result.rows.map(toSessionParticipant)
    },
  }
}

/** Back-compat factory — pool-bound `sessionParticipants` surface. */
export const createSessionParticipantsRepo = (pool: Pool) => sessionParticipantsNs(pool)
