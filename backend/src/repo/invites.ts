// backend/src/repo/invites.ts

import { randomBytes } from 'node:crypto'
import { type Pool, type PoolClient } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { toCampaignInvite, type CampaignInviteDbRow } from './mappers.js'
import type { CampaignInvite, CampaignInvitePreview, CreateInviteInput } from './types.js'
import {
  ACCEPT_LOCK_TIMEOUT_MS,
  ACCEPT_STATEMENT_TIMEOUT_MS,
  INVITE_CAP_PER_CAMPAIGN,
  INVITE_CODE_RETRIES,
  InviteCapReachedError,
  InviteCreationError,
} from './invites-errors.js'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

// 12-char base62 with rejection sampling to remove modulo bias.
function generateInviteCode(): string {
  const result: string[] = []
  while (result.length < 12) {
    const b = randomBytes(1)[0]!
    if (b < 248) result.push(ALPHABET[b % 62]!)
  }
  return result.join('')
}

export interface InvitesRepoOpts {
  readonly lockTimeoutMs?: number
  readonly statementTimeoutMs?: number
}

export function createInvitesRepo(pool: Pool, opts: InvitesRepoOpts = {}) {
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
        await client.query('SELECT id FROM campaigns WHERE id = $1 FOR NO KEY UPDATE', [input.campaignId])

        // Cap check (active invites only).
        const cap = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM campaign_invites
            WHERE campaign_id = $1
              AND (expires_at IS NULL OR expires_at > now())`,
          [input.campaignId],
        )
        const active = Number(cap.rows[0]?.count ?? '0')
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
            if (!row) throw new Error('invites.create: INSERT returned no row')
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
            throw err
          }
        }
        await client.query('ROLLBACK')
        inTransaction = false
        throw new InviteCreationError(INVITE_CODE_RETRIES)
      } catch (err) {
        if (inTransaction) {
          try { await client.query('ROLLBACK') } catch { /* ignore */ }
        }
        throw err
      } finally {
        client.release()
      }
    },

    getByCode: async (code: string): Promise<CampaignInvite | null> => {
      const result = await pool.query<CampaignInviteDbRow>(
        `SELECT * FROM campaign_invites WHERE invite_code = $1`,
        [code],
      )
      const row = result.rows[0]
      return row ? toCampaignInvite(row, false) : null
    },

    getCodePreview: async (code: string): Promise<CampaignInvitePreview | null> => {
      const result = await pool.query<{
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
      const result = await pool.query<CampaignInviteDbRow>(
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
      const result = await pool.query(
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
