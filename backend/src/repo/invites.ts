// backend/src/repo/invites.ts

import { randomBytes } from 'node:crypto'
import { type Pool, type PoolClient } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { toCampaignInvite, type CampaignInviteDbRow } from './mappers.js'
import type { ClientLike } from './_types.js'
import type { CampaignInvite, CampaignInvitePreview, CreateInviteInput } from './types.js'
import {
  ACCEPT_LOCK_TIMEOUT_MS,
  ACCEPT_STATEMENT_TIMEOUT_MS,
  INVITE_CAP_PER_CAMPAIGN,
  INVITE_CODE_RETRIES,
  InviteCapReachedError,
  InviteCreationError,
  InviteTimeoutError,
  PARTY_SIZE_CAP,
} from './invites-errors.js'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

// 12-char base62 with rejection sampling to remove modulo bias.
function generateInviteCode(): string {
  const result: string[] = []
  while (result.length < 12) {
    const buf = randomBytes(1)
    const b = buf[0]
    /* c8 ignore start — `b === undefined` is unreachable: randomBytes(1)
     * returns a length-1 Buffer. Kept for TS narrowing. */
    if (b === undefined) continue
    /* c8 ignore stop */
    if (b < 248) {
      const ch = ALPHABET[b % 62]
      /* c8 ignore start — `ch === undefined` is unreachable: `b % 62`
       * is in [0, 62) and ALPHABET has length 62. */
      if (ch !== undefined) result.push(ch)
      /* c8 ignore stop */
    }
  }
  return result.join('')
}

export interface InvitesRepoOpts {
  readonly lockTimeoutMs?: number
  readonly statementTimeoutMs?: number
}

/**
 * Composable `invites` binder — the pure reads + the single-statement `revoke`
 * write, over an arbitrary ClientLike, so they serve `repo.invites.X` and
 * `tx.invites.X`. SQL unchanged.
 *
 * `create` and `acceptInvite` are NOT here: they own their own connection +
 * the lock-order-sensitive multi-row sequence (campaigns → invites → members)
 * + per-call SET LOCAL, so they're self-managing (see selfManagingInvites) and
 * excluded from TxRepo. A free-form callback could reorder those locks and
 * reintroduce deadlocks.
 */
export function invitesNs(c: ClientLike) {
  return {
    getByCode: async (code: string): Promise<CampaignInvite | null> => {
      const result = await c.query<CampaignInviteDbRow>(
        `SELECT * FROM campaign_invites WHERE invite_code = $1`,
        [code],
      )
      const row = result.rows[0]
      return row ? toCampaignInvite(row, false) : null
    },

    getCodePreview: async (code: string): Promise<CampaignInvitePreview | null> => {
      const result = await c.query<{
        campaign_name: string
        owner_username: string
        owner_display_name: string
        expires_at: Date | null
      }>(
        `SELECT c.name AS campaign_name,
                u.username AS owner_username,
                u.display_name AS owner_display_name,
                ci.expires_at
           FROM campaign_invites ci
           JOIN campaigns c ON c.id = ci.campaign_id
           JOIN users u ON u.id = ci.created_by
          WHERE ci.invite_code = $1
            AND u.suspended_at IS NULL
          LIMIT 1`,
        [code],
      )
      const row = result.rows[0]
      if (!row) return null
      const valid = row.expires_at === null || row.expires_at > new Date()
      return {
        campaignName: row.campaign_name,
        ownerUsername: row.owner_username,
        ownerDisplayName: row.owner_display_name,
        valid,
      }
    },

    listForCampaign: async (campaignId: string): Promise<CampaignInvite[]> => {
      const result = await c.query<CampaignInviteDbRow>(
        `SELECT * FROM campaign_invites
          WHERE campaign_id = $1
            AND (expires_at IS NULL OR expires_at > now())
          ORDER BY created_at ASC`,
        [campaignId],
      )
      return result.rows.map((r, i) => toCampaignInvite(r, i === 0))
    },

    revoke: async (
      inviteCode: string,
      campaignId: string,
    ): Promise<{ revoked: true } | { notFoundOrWrongCampaign: true }> => {
      const result = await c.query(
        `UPDATE campaign_invites
            SET expires_at = now()
          WHERE invite_code = $1 AND campaign_id = $2`,
        [inviteCode, campaignId],
      )
      if (result.rowCount === 1) return { revoked: true }
      return { notFoundOrWrongCampaign: true }
    },
  }
}

/**
 * Self-managing `invites` methods bound to the pool. `create` and
 * `acceptInvite` each own their own connection + the lock-order-sensitive
 * multi-row FOR UPDATE sequence (campaigns → invites → members) + the three
 * `SET LOCAL` timeouts, and map pg timeout errors to InviteTimeoutError. The
 * lock order is load-bearing for deadlock avoidance, so these stay
 * self-managing and out of TxRepo (see the design's "Two idioms").
 */
// eslint-disable-next-line max-lines-per-function
export function selfManagingInvites(pool: Pool, opts: InvitesRepoOpts = {}) {
  const lockMs = opts.lockTimeoutMs ?? ACCEPT_LOCK_TIMEOUT_MS
  const stmtMs = opts.statementTimeoutMs ?? ACCEPT_STATEMENT_TIMEOUT_MS

  // Helper: BEGIN + isolation + dual timeouts as a single multi-statement
  // string. Matches MYT-40's discipline.
  const beginAndConfigure = (client: PoolClient): Promise<unknown> =>
    client.query(
      `BEGIN;
       SET LOCAL transaction_isolation = 'read committed';
       SET LOCAL lock_timeout = '${String(lockMs)}ms';
       SET LOCAL statement_timeout = '${String(stmtMs)}ms';`,
    )

  return {
    create: async (input: CreateInviteInput): Promise<CampaignInvite> => {
      const client = await pool.connect()
      let inTransaction = false
      try {
        await beginAndConfigure(client)
        inTransaction = true

        // Lock the campaigns row first per the lock-order convention
        // (campaigns → invites → members). This serializes concurrent
        // creates so the cap check is correct.
        await client.query('SELECT id FROM campaigns WHERE id = $1 FOR NO KEY UPDATE', [
          input.campaignId,
        ])

        // Cap check (active invites only).
        const cap = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM campaign_invites
            WHERE campaign_id = $1
              AND (expires_at IS NULL OR expires_at > now())`,
          [input.campaignId],
        )
        /* c8 ignore start — `?? '0'` falsy arm is unreachable: count(*)
         * always returns one row. Kept for TS. */
        const active = Number(cap.rows[0]?.count ?? '0')
        /* c8 ignore stop */
        if (active >= INVITE_CAP_PER_CAMPAIGN) {
          await client.query('ROLLBACK')
          inTransaction = false
          throw new InviteCapReachedError(input.campaignId, active)
        }

        // Insert with retry on UNIQUE collision on invite_code.
        for (let i = 0; i < INVITE_CODE_RETRIES; i++) {
          const id = uuidv7()
          const code = generateInviteCode()
          try {
            const result = await client.query<CampaignInviteDbRow>(
              `INSERT INTO campaign_invites (id, campaign_id, created_by, invite_code)
               VALUES ($1, $2, $3, $4)
               RETURNING *`,
              [id, input.campaignId, input.createdBy, code],
            )
            await client.query('COMMIT')
            inTransaction = false
            const row = result.rows[0]
            /* c8 ignore start — `!row` arm is unreachable: an INSERT ...
             * RETURNING * always emits one row on success. */
            if (!row) throw new Error('invites.create: INSERT returned no row')
            /* c8 ignore stop */
            return toCampaignInvite(row, true)
          } catch (err) {
            if (
              typeof err === 'object' &&
              err !== null &&
              'code' in err &&
              (err as { code?: string }).code === '23505' &&
              'constraint' in err &&
              (err as { constraint?: string }).constraint === 'campaign_invites_invite_code_key'
            ) {
              continue
            }
            /* c8 ignore start — re-throw of non-23505 pg errors: pg
             * client errors propagate to the caller. The 23505 retry
             * loop is tested; this is the catch-all path. */
            throw err
            /* c8 ignore stop */
          }
        }
        await client.query('ROLLBACK')
        inTransaction = false
        throw new InviteCreationError(INVITE_CODE_RETRIES)
      } catch (err) {
        /* c8 ignore start — outer rollback + rethrow: every inner
         * catch arm above handles its own ROLLBACK; this is defense-
         * in-depth for the case where the INSERT itself never ran
         * (e.g. BEGIN failed). */
        if (inTransaction) {
          try {
            await client.query('ROLLBACK')
          } catch {
            /* ignore */
          }
        }
        throw err
      } finally {
        /* c8 ignore stop */
        client.release()
      }
    },

    // Transaction script: BEGIN → lock invite row → validate state →
    // INSERT membership (or detect idempotent re-call) → COMMIT.
    // The discriminated-union return type forks the caller's response
    // (200/409/404). Each step's error message is callable-specific.
    // Breaking this into helpers would either lose the transaction
    // boundary or require passing PoolClient through every helper.
    // eslint-disable-next-line max-lines-per-function
    acceptInvite: async (input: {
      code: string
      userId: string
    }): Promise<
      | { campaignId: string; alreadyMember: boolean }
      | { notFound: true }
      | { revoked: true }
      | { campaignGone: true }
      | { campaignFull: true; activeMembers: number }
    > => {
      const client = await pool.connect()
      let inTransaction = false
      try {
        await beginAndConfigure(client)
        inTransaction = true

        // Step 1: Lock the invite row.
        const inviteResult = await client.query<CampaignInviteDbRow>(
          `SELECT * FROM campaign_invites WHERE invite_code = $1 FOR NO KEY UPDATE`,
          [input.code],
        )
        const invite = inviteResult.rows[0]
        if (!invite) {
          await client.query('ROLLBACK')
          inTransaction = false
          return { notFound: true }
        }

        const campaignId = invite.campaign_id

        // Step 2: Membership check FIRST. If the caller is already a member,
        // they short-circuit success regardless of expiry (membership trumps revoke).
        const memberResult = await client.query<{ id: string }>(
          `SELECT id FROM campaign_members WHERE campaign_id = $1 AND user_id = $2`,
          [campaignId, input.userId],
        )
        if (memberResult.rowCount === 1) {
          await client.query('COMMIT')
          inTransaction = false
          return { campaignId, alreadyMember: true }
        }

        // Step 3: Expiry check, only for non-members.
        if (invite.expires_at !== null && invite.expires_at <= new Date()) {
          await client.query('ROLLBACK')
          inTransaction = false
          return { revoked: true }
        }

        // Step 4: Cap check before INSERT.
        const memberCount = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM campaign_members WHERE campaign_id = $1`,
          [campaignId],
        )
        /* c8 ignore start — `?? '0'` falsy arm is unreachable: count(*)
         * always returns one row. Kept for TS narrowing. */
        const active = Number(memberCount.rows[0]?.count ?? '0')
        /* c8 ignore stop */
        if (active >= PARTY_SIZE_CAP) {
          await client.query('ROLLBACK')
          inTransaction = false
          return { campaignFull: true, activeMembers: active }
        }

        // Step 5: Insert membership; ON CONFLICT means a concurrent accept
        // by the same user via a DIFFERENT code just landed the row.
        let insertedRowCount = 0
        try {
          const insertResult = await client.query(
            `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
             VALUES ($1, $2, $3, 'player', true)
             ON CONFLICT (campaign_id, user_id) DO NOTHING
             RETURNING *`,
            [uuidv7(), campaignId, input.userId],
          )
          /* c8 ignore start — `?? 0` falsy arm: pg's QueryResult always
           * sets rowCount on INSERT ... RETURNING. Kept for TS. */
          insertedRowCount = insertResult.rowCount ?? 0
          /* c8 ignore stop */
        } catch (err) {
          // FK violation 23503 → campaign was deleted between step 1 and step 5.
          if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code?: string }).code === '23503'
          ) {
            await client.query('ROLLBACK')
            inTransaction = false
            return { campaignGone: true }
          }
          throw err
        }

        if (insertedRowCount === 0) {
          // A concurrent accept (different invite, same user) just landed the row.
          // Do NOT increment uses on this invite — the user joined via the other.
          await client.query('COMMIT')
          inTransaction = false
          return { campaignId, alreadyMember: true }
        }

        // Step 6: Increment uses ONLY on the rowCount === 1 path.
        await client.query(`UPDATE campaign_invites SET uses = uses + 1 WHERE id = $1`, [invite.id])

        await client.query('COMMIT')
        inTransaction = false
        return { campaignId, alreadyMember: false }
      } catch (err) {
        if (inTransaction) {
          try {
            await client.query('ROLLBACK')
          } catch {
            /* ignore */
          }
        }
        // Map pg timeout errors to InviteTimeoutError.
        if (typeof err === 'object' && err !== null && 'code' in err) {
          const sqlstate = (err as { code?: string }).code
          if (sqlstate === '55P03') {
            throw new InviteTimeoutError(input.code, 'lock', '55P03')
          }
          if (sqlstate === '57014') {
            throw new InviteTimeoutError(input.code, 'statement', '57014')
          }
        }
        /* c8 ignore start — re-throw of non-timeout, non-typed errors:
         * pg client errors (disconnected, broken protocol) propagate to
         * the caller. The 55P03 and 57014 branches are tested; this is
         * the catch-all. */
        throw err
      } finally {
        /* c8 ignore stop */
        client.release()
      }
    },
  }
}

/** Back-compat factory — pool-bound `invites` surface, identical shape to the
 *  pre-unification `createInvitesRepo` (composable reads/revoke ∪ self-managing
 *  create/acceptInvite). The `opts` (lock/statement timeouts) flow to the
 *  self-managing methods. */
export const createInvitesRepo = (pool: Pool, opts: InvitesRepoOpts = {}) => ({
  ...invitesNs(pool),
  ...selfManagingInvites(pool, opts),
})
