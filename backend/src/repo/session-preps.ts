// backend/src/repo/session-preps.ts
//
// Repo for the session_preps table (migration 001 lines 322–331).
//
// Columns: id, campaign_id, session_number, ft_context, sd_playbook,
// snapshot_id, created_at. NO status column. The (campaign_id,
// session_number) UNIQUE constraint (MYT-61 T1) backs the idempotent
// ON CONFLICT DO NOTHING insert: a re-run of the prep stage keeps the
// first persisted row rather than overwriting it.

import type { ClientLike } from './_types.js'
import { uuidv7 } from './uuidv7.js'
import type { SessionPrepRow } from './types.js'

interface SessionPrepDbRow {
  readonly id: string
  readonly campaign_id: string
  readonly session_number: number
  readonly ft_context: string
  readonly sd_playbook: string
  readonly snapshot_id: string | null
  readonly created_at: Date
}

/** Composable binder over a single ClientLike. Holds the canonical SQL so
 *  `repo.sessionPreps.X` and `tx.sessionPreps.X` share one body. */
export function sessionPrepsNs(c: ClientLike) {
  return {
    insert: async (input: {
      campaignId: string
      sessionNumber: number
      ftContext: string
      sdPlaybook: string
    }): Promise<void> => {
      await c.query(
        `INSERT INTO session_preps (id, campaign_id, session_number, ft_context, sd_playbook)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (campaign_id, session_number) DO NOTHING`,
        [uuidv7(), input.campaignId, input.sessionNumber, input.ftContext, input.sdPlaybook],
      )
    },
    existsFor: async (campaignId: string, sessionNumber: number): Promise<boolean> => {
      const { rowCount } = await c.query<{ readonly exists: number }>(
        `SELECT 1 AS exists FROM session_preps WHERE campaign_id = $1 AND session_number = $2`,
        [campaignId, sessionNumber],
      )
      return (rowCount ?? 0) > 0
    },
    getBy: async (campaignId: string, sessionNumber: number): Promise<SessionPrepRow | null> => {
      const { rows } = await c.query<SessionPrepDbRow>(
        `SELECT id, campaign_id, session_number, ft_context, sd_playbook, snapshot_id, created_at
         FROM session_preps WHERE campaign_id = $1 AND session_number = $2`,
        [campaignId, sessionNumber],
      )
      const r = rows[0]
      return r
        ? {
            id: r.id,
            campaignId: r.campaign_id,
            sessionNumber: r.session_number,
            ftContext: r.ft_context,
            sdPlaybook: r.sd_playbook,
            snapshotId: r.snapshot_id,
            createdAt: r.created_at,
          }
        : null
    },
  }
}
