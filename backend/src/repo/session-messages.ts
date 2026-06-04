import { type Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { toSessionMessage, type SessionMessageDbRow } from './mappers.js'
import type { AppendMessageInput, SessionMessage } from './types.js'
import type { ClientLike } from './_types.js'

// Composable binder — see sessionsNs for the pattern rationale. Each method
// captures the ClientLike `c` so the body serves `repo.sessionMessages.X` and
// `tx.sessionMessages.X`.
//
// session_messages (migration 001 + 023):
//   id UUID PK, session_id UUID FK→sessions (CASCADE), seq INTEGER NOT NULL,
//   user_id UUID (nullable, NO FK), message_type TEXT NOT NULL,
//   content TEXT NOT NULL, created_at TIMESTAMPTZ,
//   UNIQUE(session_id, seq) (migration 023).
//
// The transcript is append-only: the WS chat transport persists every message
// here (persist-then-broadcast) and replays from it on reconnect.
export function sessionMessagesNs(c: ClientLike) {
  return {
    // `seq` is supplied by the caller (the WS route owns the per-session
    // monotonic counter). A re-used (session_id, seq) hits the UNIQUE index and
    // raises a 23505 unique-violation, which we let propagate — the route owns
    // re-INCR-on-conflict. This binder does NOT catch or retry.
    append: async (input: AppendMessageInput): Promise<SessionMessage> => {
      const result = await c.query<SessionMessageDbRow>(
        `INSERT INTO session_messages (id, session_id, seq, user_id, message_type, content)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [uuidv7(), input.sessionId, input.seq, input.userId, input.messageType, input.content],
      )
      const row = result.rows[0]
      if (!row) throw new Error('sessionMessages.append: INSERT returned no row')
      return toSessionMessage(row)
    },

    // Replay surface: every message with seq strictly greater than `afterSeq`,
    // in seq order. Reconnecting clients pass their last-seen seq; a fresh
    // client passes 0 to read the full history.
    listAfterSeq: async (sessionId: string, afterSeq: number): Promise<SessionMessage[]> => {
      const result = await c.query<SessionMessageDbRow>(
        `SELECT * FROM session_messages WHERE session_id = $1 AND seq > $2 ORDER BY seq ASC`,
        [sessionId, afterSeq],
      )
      return result.rows.map(toSessionMessage)
    },

    // MYT-65 Task 10: the DURABLE max seq — `MAX(seq)` over the persisted rows,
    // 0 when none exist. This is the seq a suspend checkpoint records (via
    // session-state's CheckpointStore.readMaxSeq), distinct from the live `:seq`
    // INCR counter in Redis which sits one ahead between INCR and the row
    // INSERT. Returns a plain `number` (COALESCE(...,0)::text → Number) — no new
    // repo/types.ts type, matching sessions.maxSessionNumber's shape.
    maxSeq: async (sessionId: string): Promise<number> => {
      const result = await c.query<{ max: string }>(
        `SELECT COALESCE(MAX(seq), 0)::text AS max
           FROM session_messages WHERE session_id = $1`,
        [sessionId],
      )
      return Number(result.rows[0]?.max ?? 0)
    },
  }
}

/** Back-compat factory — pool-bound `sessionMessages` surface. */
export const createSessionMessagesRepo = (pool: Pool) => sessionMessagesNs(pool)
