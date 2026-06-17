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

    /** §3.7 single-piece context read: player rows up to the consumed
     *  watermark + ALL DM rows (their seqs can exceed an early next-batch
     *  player seq when chat raced the prior turn's end), seq ASC. */
    listFtContextRows: async (sessionId: string, maxPlayerSeq: number): Promise<SessionMessage[]> => {
      const result = await c.query<SessionMessageDbRow>(
        `SELECT * FROM session_messages
          WHERE session_id = $1
            AND ((message_type = 'player_message' AND seq <= $2)
                 OR message_type IN (
                   'dm_text','skill_check','dice_roll',
                   -- MYT-70 §8: the six party-ledger tool rows MUST be in the
                   -- FT-context rebuild, or the FT loses its own mutation
                   -- record mid-session (a coherence break).
                   'cast_spell','spend_resource','acquire_resource',
                   'adjust_hp','update_condition','take_rest'
                 ))
          ORDER BY seq ASC`,
        [sessionId, maxPlayerSeq],
      )
      return result.rows.map(toSessionMessage)
    },

    // §3.7 idempotency probe: have any rows for this turn already committed?
    // A BullMQ re-run reads this before re-emitting so a fully-persisted turn
    // is not re-rendered.
    turnRowsExist: async (turnId: string): Promise<boolean> => {
      const result = await c.query(
        `SELECT 1 FROM session_messages WHERE turn_id = $1 LIMIT 1`,
        [turnId],
      )
      return (result.rowCount ?? 0) > 0
    },

    /** §3.7 atomic per-turn DM append: ONE multi-VALUES INSERT (single
     *  statement = atomic; all rows or none), idempotent via ON CONFLICT
     *  (turn_id, turn_ordinal) DO NOTHING. Seqs are allocated by the caller
     *  (Redis :seq INCR) BEFORE the insert, in row order. turn_ordinal is
     *  passed explicitly (i = 0..n-1). user_id is NULL for DM rows. */
    appendDmTurn: async (input: {
      sessionId: string
      turnId: string
      rows: readonly { kind: string; content: string }[]
      seqs: readonly number[]
      /** MYT-74b §5 — the originating turn trigger kind, written onto every row of
       *  this turn (shared, like turn_id) so the post-session analysis can
       *  structurally exclude correction/farewell rows. Omitted → NULL. */
      triggerKind?: string
    }): Promise<void> => {
      if (input.rows.length !== input.seqs.length) {
        throw new Error(
          `sessionMessages.appendDmTurn: rows/seqs length mismatch (${String(input.rows.length)} vs ${String(input.seqs.length)})`,
        )
      }
      if (input.rows.length === 0) return

      // $1 = session_id, $2 = turn_id, $3 = trigger_kind — all shared across rows.
      // Per-row params follow. Each tuple is (id, seq, message_type, content,
      // turn_ordinal); user_id is a literal NULL. turn_ordinal is passed
      // EXPLICITLY (the row index i) — no window-function tricks. `base` =
      // values.length now starts at 3 (the 3rd shared param), so the per-row
      // `$${base+1}…` indices remain correct and never collide with $1/$2/$3.
      const values: unknown[] = [input.sessionId, input.turnId, input.triggerKind ?? null]
      const tuples = input.rows.map((row, i) => {
        const base = values.length
        values.push(uuidv7(), input.seqs[i], row.kind, row.content, i)
        return `($${String(base + 1)}, $1, $${String(base + 2)}, NULL, $${String(base + 3)}, $${String(base + 4)}, $2, $${String(base + 5)}, $3)`
      })

      await c.query(
        `INSERT INTO session_messages
           (id, session_id, seq, user_id, message_type, content, turn_id, turn_ordinal, trigger_kind)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (turn_id, turn_ordinal) WHERE turn_id IS NOT NULL DO NOTHING`,
        values,
      )
    },

    /** MYT-74b §2 — the post-session analysis transcript read: the LAST `limit`
     *  rows in seq-ASC order, projecting the trigger_kind the containment verifier
     *  filters on. Bounds the Opus call's input on the largest sessions; the late
     *  tail is where voice/affect lives. */
    listForAnalysis: async (
      sessionId: string,
      limit: number,
    ): Promise<readonly { seq: number; messageType: string; content: string; triggerKind: string | null }[]> => {
      const result = await c.query<{ seq: number; message_type: string; content: string; trigger_kind: string | null }>(
        `SELECT seq, message_type, content, trigger_kind FROM (
           SELECT seq, message_type, content, trigger_kind
             FROM session_messages WHERE session_id = $1
            ORDER BY seq DESC LIMIT $2
         ) sub ORDER BY seq ASC`,
        [sessionId, limit],
      )
      return result.rows.map((r) => ({
        seq: r.seq,
        messageType: r.message_type,
        content: r.content,
        triggerKind: r.trigger_kind,
      }))
    },
  }
}

/** Back-compat factory — pool-bound `sessionMessages` surface. */
export const createSessionMessagesRepo = (pool: Pool) => sessionMessagesNs(pool)
