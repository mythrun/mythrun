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
      return row ? toCampaignInvite(row) : null
    },

    getCodePreview: async (code: string): Promise<CampaignInvitePreview | null> => {
      const result = await c.query<{
        campaign_name: string
        owner_username: string
        owner_display_name: string
        valid: boolean
      }>(
        `SELECT c.name AS campaign_name,
                u.username AS owner_username,
                u.display_name AS owner_display_name,
                (ci.expires_at IS NULL OR ci.expires_at > now()) AS valid
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
      // Validity is computed IN SQL so revoke (`expires_at = now()`, PG clock)
      // and this read compare on the SAME clock — a Node-side `new Date()`
      // comparison is skew-sensitive across the Docker-VM/host boundary.
      const valid = row.valid
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
      // `primary` is the is_primary column now (migration 036), not the old
      // oldest-row heuristic — the DB owns which invite is the share link.
      return result.rows.map((r) => toCampaignInvite(r))
    },

    revoke: async (
      inviteCode: string,
      campaignId: string,
    ): Promise<{ revoked: true } | { notFoundOrWrongCampaign: true }> => {
      // Clear is_primary alongside expiry: a revoked invite is no longer the
      // active primary, and clearing it frees the partial unique index so a
      // fresh primary can be minted (the index predicate has no now() clause, so
      // it counts an is_primary=true row regardless of expiry — the invariant
      // is_primary=true ⟺ active primary is maintained HERE, myth-y5c4q).
      const result = await c.query(
        `UPDATE campaign_invites
            SET expires_at = now(), is_primary = false
          WHERE invite_code = $1 AND campaign_id = $2`,
        [inviteCode, campaignId],
      )
      if (result.rowCount === 1) return { revoked: true }
      return { notFoundOrWrongCampaign: true }
    },
  }
}

/** Is this pg error the invite_code UNIQUE collision the create retry loop
 *  absorbs (vs. any other constraint violation, which must propagate)? */
function isInviteCodeCollision(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505' &&
    'constraint' in err &&
    (err as { constraint?: string }).constraint === 'campaign_invites_invite_code_key'
  )
}

/** Lock the campaigns row FIRST per the lock-order convention (campaigns →
 *  invites → members): concurrent invite writes serialize on it, so the
 *  cap/primary checks below are correct and the create/ensure races collapse to
 *  one winner. */
async function lockCampaignRow(client: PoolClient, campaignId: string): Promise<void> {
  await client.query('SELECT id FROM campaigns WHERE id = $1 FOR NO KEY UPDATE', [campaignId])
}

/** Throw InviteCapReachedError if the campaign is already at the active-invite
 *  cap. The caller holds the campaign lock, so the count is stable. */
async function assertUnderInviteCap(client: PoolClient, campaignId: string): Promise<void> {
  const cap = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM campaign_invites
      WHERE campaign_id = $1
        AND (expires_at IS NULL OR expires_at > now())`,
    [campaignId],
  )
  /* c8 ignore start — `?? '0'` falsy arm is unreachable: count(*) always
   * returns one row. Kept for TS. */
  const active = Number(cap.rows[0]?.count ?? '0')
  /* c8 ignore stop */
  if (active >= INVITE_CAP_PER_CAMPAIGN) {
    throw new InviteCapReachedError(campaignId, active)
  }
}

/** The campaign's active primary invite row, or null. `is_primary` is the
 *  migration-036 column; the invariant (revoke clears is_primary) means an
 *  is_primary=true row is never expired, but the expiry guard stays for defense
 *  in depth. */
async function selectActivePrimary(
  client: PoolClient,
  campaignId: string,
): Promise<CampaignInviteDbRow | null> {
  const result = await client.query<CampaignInviteDbRow>(
    `SELECT * FROM campaign_invites
      WHERE campaign_id = $1 AND is_primary
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1`,
    [campaignId],
  )
  return result.rows[0] ?? null
}

/** INSERT an invite row, retrying on the (rare) invite_code UNIQUE collision.
 *  Returns the inserted row; throws InviteCreationError after INVITE_CODE_RETRIES
 *  collisions. The caller owns the transaction (BEGIN/COMMIT/ROLLBACK) and the
 *  campaign lock. `isPrimary` sets the new row's is_primary — the partial unique
 *  index (idx_campaign_invites_one_primary) is the DB guard against a 2nd primary. */
async function insertInviteWithRetry(
  client: PoolClient,
  campaignId: string,
  createdBy: string,
  isPrimary: boolean,
): Promise<CampaignInviteDbRow> {
  for (let i = 0; i < INVITE_CODE_RETRIES; i++) {
    const id = uuidv7()
    const code = generateInviteCode()
    try {
      const result = await client.query<CampaignInviteDbRow>(
        `INSERT INTO campaign_invites (id, campaign_id, created_by, invite_code, is_primary)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [id, campaignId, createdBy, code, isPrimary],
      )
      const row = result.rows[0]
      /* c8 ignore start — `!row` arm is unreachable: an INSERT ... RETURNING *
       * always emits one row on success. */
      if (!row) throw new Error('invites.insert: INSERT returned no row')
      /* c8 ignore stop */
      return row
    } catch (err) {
      if (isInviteCodeCollision(err)) continue
      /* c8 ignore start — re-throw of non-collision pg errors (FK 23503, the
       * primary-index 23505, etc.): they propagate to the caller's ROLLBACK. */
      throw err
      /* c8 ignore stop */
    }
  }
  throw new InviteCreationError(INVITE_CODE_RETRIES)
}

/**
 * Self-managing `invites` methods bound to the pool. `create`, `ensurePrimary`,
 * and `acceptInvite` each own their own connection + the lock-order-sensitive
 * multi-row FOR UPDATE sequence (campaigns → invites → members) + the three
 * `SET LOCAL` timeouts, and `acceptInvite` maps pg timeout errors to
 * InviteTimeoutError. The lock order is load-bearing for deadlock avoidance, so
 * these stay self-managing and out of TxRepo (see the design's "Two idioms").
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
        await lockCampaignRow(client, input.campaignId)
        await assertUnderInviteCap(client, input.campaignId)
        // A campaign's FIRST active invite is its primary (preserving the old
        // oldest-is-primary semantics); every additional invite is non-primary.
        // Computed under the campaign lock, so the flag is race-free; the
        // partial unique index is the DB backstop.
        const existingPrimary = await selectActivePrimary(client, input.campaignId)
        const row = await insertInviteWithRetry(
          client,
          input.campaignId,
          input.createdBy,
          existingPrimary === null,
        )
        await client.query('COMMIT')
        inTransaction = false
        return toCampaignInvite(row)
      } catch (err) {
        /* c8 ignore start — the false arm (error AFTER the COMMIT flipped the
           flag) is unreachable by construction: only the pure row-mapper runs
           between COMMIT and return, on a row the INSERT itself produced. The
           rollback arms are exercised by the fake-pool cap tests. */
        if (inTransaction) {
          try {
            await client.query('ROLLBACK')
          } catch {
            /* ignore — reported by the caller */
          }
        }
        throw err
      } finally {
        /* c8 ignore stop */
        client.release()
      }
    },

    // Idempotent get-or-create of the campaign's ONE primary share link
    // (myth-y5c4q). The client's ensurePrimaryInvite was a list-then-create RMW
    // that double-minted under a StrictMode double-mount / two-tab race; this
    // moves the get-or-create server-side and atomic. Under the campaign-row
    // lock, concurrent ensures serialize: the first mints the primary, the rest
    // return it — never a second row. The partial unique index
    // (idx_campaign_invites_one_primary) is the belt-and-suspenders DB guard.
    ensurePrimary: async (input: CreateInviteInput): Promise<CampaignInvite> => {
      const client = await pool.connect()
      let inTransaction = false
      try {
        await beginAndConfigure(client)
        inTransaction = true
        await lockCampaignRow(client, input.campaignId)
        const existing = await selectActivePrimary(client, input.campaignId)
        if (existing !== null) {
          await client.query('COMMIT')
          inTransaction = false
          return toCampaignInvite(existing)
        }
        await assertUnderInviteCap(client, input.campaignId)
        const row = await insertInviteWithRetry(client, input.campaignId, input.createdBy, true)
        await client.query('COMMIT')
        inTransaction = false
        return toCampaignInvite(row)
      } catch (err) {
        /* c8 ignore start — the false arm (error AFTER the COMMIT flipped the
           flag) is unreachable by construction: only the pure row-mapper runs
           between COMMIT and return, on a row the INSERT itself produced. The
           rollback arms are exercised by the fake-pool cap tests. */
        if (inTransaction) {
          try {
            await client.query('ROLLBACK')
          } catch {
            /* ignore — reported by the caller */
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

        // Step 1: Lock the invite row. `expired` is computed IN SQL so the
        // check shares a clock with revoke's `expires_at = now()` stamp (a
        // Node-side `new Date()` comparison is skew-sensitive across the
        // Docker-VM/host boundary).
        const inviteResult = await client.query<CampaignInviteDbRow & { expired: boolean }>(
          `SELECT *, (expires_at IS NOT NULL AND expires_at <= now()) AS expired
             FROM campaign_invites WHERE invite_code = $1 FOR NO KEY UPDATE`,
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
        if (invite.expired) {
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
