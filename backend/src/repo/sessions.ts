import { type Pool } from 'pg'
import { computeCostUsd, type Model, type UsageDeltas } from '../billing/model-pricing.js'
import { uuidv7 } from './uuidv7.js'
import {
  type CreateSessionInput,
  type Session,
  type SessionUpdate,
  type SessionUsage,
} from './types.js'
import { toSession, toSessionUsage, type SessionDbRow, type SessionUsageDbRow } from './mappers.js'
import { SessionNotFoundError } from './sessions-errors.js'
import type { ClientLike } from './_types.js'

// Composable binder — see campaignsNs for the pattern rationale. Each method
// captures the ClientLike `c` so the body serves `repo.sessions.X` and
// `tx.sessions.X`. SQL unchanged — only `pool.query` → `c.query`.
// eslint-disable-next-line max-lines-per-function
export function sessionsNs(c: ClientLike) {
  return {
    create: async (input: CreateSessionInput): Promise<Session> => {
      // Caller may supply the id (MYT-65 /start mints it up front so the
      // credit-debit idempotency key is known before the INSERT); default
      // to a fresh uuidv7 otherwise.
      const id = input.id ?? uuidv7()
      const result = await c.query<SessionDbRow>(
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
      const result = await c.query<SessionDbRow>('SELECT * FROM sessions WHERE id = $1', [id])
      const row = result.rows[0]
      return row ? toSession(row) : null
    },

    getActiveByCampaign: async (campaignId: string): Promise<Session | null> => {
      // The partial-unique index idx_sessions_one_active guarantees at most
      // one active session per campaign. LIMIT 1 makes the contract self-
      // documenting at the SQL site.
      const result = await c.query<SessionDbRow>(
        `SELECT * FROM sessions WHERE campaign_id = $1 AND status = 'active' LIMIT 1`,
        [campaignId],
      )
      const row = result.rows[0]
      return row ? toSession(row) : null
    },

    listByCampaign: async (campaignId: string): Promise<Session[]> => {
      const result = await c.query<SessionDbRow>(
        `SELECT * FROM sessions WHERE campaign_id = $1 ORDER BY started_at DESC`,
        [campaignId],
      )
      return result.rows.map(toSession)
    },

    /**
     * Highest `session_number` for the campaign, or 0 when none exist. The
     * lifecycle route (MYT-65) adds 1 to derive the "next" session number a
     * /start serves — matching how the session-prep pipeline numbers preps.
     * COALESCE(...,0) so the no-rows case returns 0 rather than null.
     */
    maxSessionNumber: async (campaignId: string): Promise<number> => {
      const result = await c.query<{ max: string }>(
        `SELECT COALESCE(MAX(session_number), 0)::text AS max
           FROM sessions WHERE campaign_id = $1`,
        [campaignId],
      )
      return Number(result.rows[0]?.max ?? 0)
    },

    /**
     * Hard-delete a session row by id. Used ONLY by the MYT-65 /start route's
     * 402-rollback: when the just-created session row can't be paid for
     * (tryDebitForSession reports insufficient credits), the row is removed so
     * the campaign isn't left with an unpaid 'active' session occupying the
     * idx_sessions_one_active slot. session_messages / session_participants
     * CASCADE, but a freshly-created session has none. No-op when the id is
     * absent.
     */
    deleteById: async (id: string): Promise<void> => {
      await c.query(`DELETE FROM sessions WHERE id = $1`, [id])
    },

    /**
     * Record token + cost deltas for a single LLM call against a session.
     * UPSERT keyed on session_id; first call inserts the row, subsequent
     * calls increment the running totals. Returns the post-update row so
     * the Session Runtime can compute wrap-up signals inline (no extra
     * round-trip to budgetSummary).
     *
     * The model parameter is consumed at write-time to weight the cost
     * contribution per the 4-rate MODEL_PRICING table; not persisted.
     *
     * Throws SessionNotFoundError if the sessionId doesn't resolve to a
     * sessions row (the SELECT-FROM clause matches zero rows). The hot
     * path should never see this; firing means an upstream bug.
     *
     * Spec: docs/superpowers/specs/2026-05-08-myt-43-billing-metering-design.md §8
     */
    recordUsage: async (
      sessionId: string,
      model: Model,
      deltas: UsageDeltas,
    ): Promise<SessionUsage> => {
      const cost = computeCostUsd(model, deltas)
      const result = await c.query<SessionUsageDbRow>(
        `INSERT INTO session_usage
           (id, session_id, campaign_id, user_id,
            input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
            estimated_cost_usd)
         SELECT $1, s.id, s.campaign_id, c.created_by, $3, $4, $5, $6, $7
           FROM sessions s
           JOIN campaigns c ON c.id = s.campaign_id
          WHERE s.id = $2
         ON CONFLICT (session_id) DO UPDATE
           SET input_tokens       = session_usage.input_tokens       + EXCLUDED.input_tokens,
               output_tokens      = session_usage.output_tokens      + EXCLUDED.output_tokens,
               cache_write_tokens = session_usage.cache_write_tokens + EXCLUDED.cache_write_tokens,
               cache_read_tokens  = session_usage.cache_read_tokens  + EXCLUDED.cache_read_tokens,
               estimated_cost_usd = session_usage.estimated_cost_usd + EXCLUDED.estimated_cost_usd
         RETURNING *`,
        [
          uuidv7(),
          sessionId,
          deltas.inputTokens,
          deltas.outputTokens,
          deltas.cacheWriteTokens ?? 0,
          deltas.cacheReadTokens ?? 0,
          cost,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new SessionNotFoundError(sessionId)
      return toSessionUsage(row)
    },

    /**
     * Read the durable session_usage row. Used for receipts, dashboards,
     * end-of-session reports, and crash-recovery state. Returns null if
     * the session has no usage yet (created but no LLM calls).
     *
     * NOT called by the Session Runtime hot path — that uses recordUsage's
     * return value to compute wrap-up signals inline. See design §1.
     */
    budgetSummary: async (sessionId: string): Promise<SessionUsage | null> => {
      const result = await c.query<SessionUsageDbRow>(
        `SELECT * FROM session_usage WHERE session_id = $1`,
        [sessionId],
      )
      const row = result.rows[0]
      return row ? toSessionUsage(row) : null
    },

    update: async (id: string, patch: SessionUpdate): Promise<Session> => {
      // sessions table has no updated_at column (only started_at + ended_at),
      // so this UPDATE doesn't include `updated_at = now()`.
      const result = await c.query<SessionDbRow>(
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

    /**
     * MYT-74a §4 conditional-update mutex. Sets `reconciled_at = now()` only
     * when it is still NULL, returning the affected rowCount (1 on the first
     * call, 0 thereafter). The reconcile commit calls this as its LAST in-tx
     * statement and rolls the transaction back when it returns 0 — meaning a
     * concurrent execution already reconciled this session. Single-statement
     * conditional update is the idempotency gate; no SELECT-then-UPDATE race.
     */
    markReconciled: async (id: string): Promise<number> => {
      const result = await c.query(
        `UPDATE sessions SET reconciled_at = now() WHERE id = $1 AND reconciled_at IS NULL`,
        [id],
      )
      return result.rowCount ?? 0
    },
  }
}

/** Back-compat factory — pool-bound `sessions` surface. Identical shape to the
 *  pre-unification `createSessionsRepo`. */
export const createSessionsRepo = (pool: Pool) => sessionsNs(pool)
