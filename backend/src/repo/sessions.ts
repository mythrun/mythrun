import { type Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { type CreateSessionInput, type Session, type SessionUpdate } from './types.js'
import { toSession, type SessionDbRow } from './mappers.js'

export function createSessionsRepo(pool: Pool) {
  return {
    create: async (input: CreateSessionInput): Promise<Session> => {
      const id = uuidv7()
      const result = await pool.query<SessionDbRow>(
        `INSERT INTO sessions (id, campaign_id, session_number, status)
         VALUES ($1, $2, $3, COALESCE($4, 'active'))
         RETURNING *`,
        [id, input.campaignId, input.sessionNumber, input.status ?? null],
      )
      const row = result.rows[0]
      if (!row) throw new Error('sessions.create: INSERT returned no row')
      return toSession(row)
    },

    getById: async (id: string): Promise<Session | null> => {
      const result = await pool.query<SessionDbRow>('SELECT * FROM sessions WHERE id = $1', [id])
      const row = result.rows[0]
      return row ? toSession(row) : null
    },

    getActiveByCampaign: async (campaignId: string): Promise<Session | null> => {
      // The partial-unique index idx_sessions_one_active guarantees at most
      // one active session per campaign. LIMIT 1 makes the contract self-
      // documenting at the SQL site.
      const result = await pool.query<SessionDbRow>(
        `SELECT * FROM sessions WHERE campaign_id = $1 AND status = 'active' LIMIT 1`,
        [campaignId],
      )
      const row = result.rows[0]
      return row ? toSession(row) : null
    },

    listByCampaign: async (campaignId: string): Promise<Session[]> => {
      const result = await pool.query<SessionDbRow>(
        `SELECT * FROM sessions WHERE campaign_id = $1 ORDER BY started_at DESC`,
        [campaignId],
      )
      return result.rows.map(toSession)
    },

    update: async (id: string, patch: SessionUpdate): Promise<Session> => {
      // sessions table has no updated_at column (only started_at + ended_at),
      // so this UPDATE doesn't include `updated_at = now()`.
      const result = await pool.query<SessionDbRow>(
        `UPDATE sessions
            SET status              = COALESCE($2, status),
                ended_at            = COALESCE($3, ended_at),
                summary             = COALESCE($4, summary),
                st_running_summary  = COALESCE($5, st_running_summary),
                handoff             = COALESCE($6, handoff)
          WHERE id = $1
          RETURNING *`,
        [
          id,
          patch.status ?? null,
          patch.endedAt ?? null,
          patch.summary ?? null,
          patch.stRunningSummary ?? null,
          patch.handoff ?? null,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error(`sessions.update: no session with id ${id}`)
      return toSession(row)
    },
  }
}
