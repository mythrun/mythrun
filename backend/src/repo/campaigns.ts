import { type Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import {
  toCampaign,
  toCampaignMember,
  type CampaignDbRow,
  type CampaignMemberDbRow,
} from './mappers.js'
import type {
  Campaign,
  CampaignMember,
  CampaignMemberRole,
  CampaignUpdate,
  CreateCampaignInput,
} from './types.js'
import type { ClientLike } from './_types.js'

// Composable binder: each method captures the ClientLike `c` (pool OR an
// in-flight tx client) so the same body serves `repo.campaigns.X` and
// `tx.campaigns.X`. The body is the method dictionary, not a complex
// algorithm; the namespace pattern is load-bearing for the repo layer's
// grep-ability. SQL unchanged — only `pool.query` → `c.query`.
// eslint-disable-next-line max-lines-per-function
export function campaignsNs(c: ClientLike) {
  return {
    create: async (input: CreateCampaignInput): Promise<Campaign> => {
      const id = uuidv7()
      const result = await c.query<CampaignDbRow>(
        `INSERT INTO campaigns (id, world_id, source_world_id, created_by, name, status, language)
         VALUES (
            $1, $2, $3, $4, $5,
            COALESCE($6, 'setup'),
            COALESCE($7, 'en')
         ) RETURNING *`,
        [
          id,
          input.worldId,
          input.sourceWorldId ?? null,
          input.createdBy,
          input.name,
          input.status ?? null,
          input.language ?? null,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error('campaigns.create: INSERT returned no row')
      return toCampaign(row)
    },

    /**
     * Cluster-A create-tx footprint: insert a campaign row in 'setup' status
     * with name 'Untitled'. Composable — runs over the captured client. SQL
     * verbatim from `executeCreateTransaction` (backend/src/routes/campaigns.ts):
     * `INSERT INTO campaigns (id, world_id, created_by, name, status) VALUES
     * ($1, $2, $3, 'Untitled', 'setup')`. Distinct from `create` (which
     * COALESCEs status/language and carries source_world_id) — this is the
     * fixed-literal create-side shape.
     */
    insertSetup: async (input: {
      id: string
      worldId: string
      createdBy: string
      name?: string
    }): Promise<void> => {
      await c.query(
        `INSERT INTO campaigns (id, world_id, created_by, name, status)
         VALUES ($1, $2, $3, $4, 'setup')`,
        [input.id, input.worldId, input.createdBy, input.name ?? 'Untitled'],
      )
    },

    /**
     * Cluster-A create-tx footprint: insert the owner membership row.
     * Composable — runs over the captured client. SQL verbatim from
     * `executeCreateTransaction`: `INSERT INTO campaign_members (id,
     * campaign_id, user_id, role, invite_accepted) VALUES ($1, $2, $3, 'owner',
     * true)`. Distinct from `addMember` — that one parameterizes role +
     * invite_accepted and carries ON CONFLICT DO NOTHING + a RETURNING/SELECT
     * round-trip; the create site writes the owner row with fixed literals and
     * no conflict handling.
     */
    insertOwnerMember: async (input: {
      id: string
      campaignId: string
      userId: string
    }): Promise<void> => {
      await c.query(
        `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
         VALUES ($1, $2, $3, 'owner', true)`,
        [input.id, input.campaignId, input.userId],
      )
    },

    getById: async (id: string): Promise<Campaign | null> => {
      const result = await c.query<CampaignDbRow>('SELECT * FROM campaigns WHERE id = $1', [id])
      const row = result.rows[0]
      return row ? toCampaign(row) : null
    },

    /**
     * concept-intake (stage 1) name propagation. Sets the campaign owning
     * `worldId` to the LLM-synthesized name, but ONLY while it still carries
     * the create-time 'Untitled' placeholder (so a user's PATCH rename isn't
     * clobbered). Composable — runs over the captured client. SQL verbatim
     * from `stages/concept-intake.ts` (myth-4lhr).
     */
    setNameFromUntitled: async (worldId: string, name: string): Promise<void> => {
      await c.query(
        `UPDATE campaigns SET name = $2 WHERE world_id = $1 AND name = 'Untitled'`,
        [worldId, name],
      )
    },

    listByUser: async (userId: string): Promise<Campaign[]> => {
      const result = await c.query<CampaignDbRow>(
        `SELECT c.* FROM campaigns c
            JOIN campaign_members cm ON cm.campaign_id = c.id
          WHERE cm.user_id = $1 AND cm.invite_accepted = true
          ORDER BY c.created_at DESC`,
        [userId],
      )
      return result.rows.map(toCampaign)
    },

    update: async (id: string, patch: CampaignUpdate): Promise<Campaign> => {
      const result = await c.query<CampaignDbRow>(
        `UPDATE campaigns
            SET name       = COALESCE($2, name),
                status     = COALESCE($3, status),
                language   = COALESCE($4, language),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [id, patch.name ?? null, patch.status ?? null, patch.language ?? null],
      )
      const row = result.rows[0]
      if (!row) throw new Error(`campaigns.update: no campaign with id ${id}`)
      return toCampaign(row)
    },

    addMember: async (input: {
      campaignId: string
      userId: string
      role: CampaignMemberRole
      inviteAccepted?: boolean
    }): Promise<CampaignMember> => {
      const id = uuidv7()
      const inserted = await c.query<CampaignMemberDbRow>(
        `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (campaign_id, user_id) DO NOTHING
         RETURNING *`,
        [id, input.campaignId, input.userId, input.role, input.inviteAccepted ?? true],
      )
      const insertedRow = inserted.rows[0]
      if (inserted.rowCount === 1 && insertedRow !== undefined) {
        return toCampaignMember(insertedRow)
      }
      const existing = await c.query<CampaignMemberDbRow>(
        `SELECT * FROM campaign_members WHERE campaign_id = $1 AND user_id = $2`,
        [input.campaignId, input.userId],
      )
      const row = existing.rows[0]
      if (!row) throw new Error('addMember: ON CONFLICT then SELECT returned no row')
      return toCampaignMember(row)
    },

    getMembership: async (campaignId: string, userId: string): Promise<CampaignMember | null> => {
      const result = await c.query<CampaignMemberDbRow>(
        `SELECT * FROM campaign_members WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId],
      )
      const row = result.rows[0]
      return row ? toCampaignMember(row) : null
    },

    getOwner: async (campaignId: string): Promise<CampaignMember | null> => {
      const result = await c.query<CampaignMemberDbRow>(
        `SELECT * FROM campaign_members WHERE campaign_id = $1 AND role = 'owner'`,
        [campaignId],
      )
      const row = result.rows[0]
      return row ? toCampaignMember(row) : null
    },

    listMembers: async (
      campaignId: string,
    ): Promise<
      {
        userId: string
        role: CampaignMemberRole
        username: string
        displayName: string
        characterId: string | null
        joinedAt: Date
      }[]
    > => {
      const result = await c.query<{
        user_id: string
        role: string
        username: string
        display_name: string
        joined_at: Date
      }>(
        `SELECT cm.user_id, cm.role, u.username, u.display_name, cm.joined_at
           FROM campaign_members cm
           JOIN users u ON u.id = cm.user_id
          WHERE cm.campaign_id = $1
            AND u.suspended_at IS NULL
          ORDER BY cm.joined_at ASC`,
        [campaignId],
      )
      return result.rows.map((r) => ({
        userId: r.user_id,
        role: r.role === 'owner' ? 'owner' : 'player',
        username: r.username,
        displayName: r.display_name,
        characterId: null,
        joinedAt: r.joined_at,
      }))
    },
  }
}

/** Back-compat factory — pool-bound `campaigns` surface. Identical shape to
 *  the pre-unification `createCampaignsRepo`. */
export const createCampaignsRepo = (pool: Pool) => campaignsNs(pool)
