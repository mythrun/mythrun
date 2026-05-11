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

// Namespace factory: the body is the method dictionary, not a complex
// algorithm. Splitting it into top-level helpers would lose the `pool`
// closure and force a per-call argument; the namespace pattern is
// load-bearing for the repo layer's grep-ability.
// eslint-disable-next-line max-lines-per-function
export function createCampaignsRepo(pool: Pool) {
  return {
    create: async (input: CreateCampaignInput): Promise<Campaign> => {
      const id = uuidv7()
      const result = await pool.query<CampaignDbRow>(
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

    getById: async (id: string): Promise<Campaign | null> => {
      const result = await pool.query<CampaignDbRow>('SELECT * FROM campaigns WHERE id = $1', [id])
      const row = result.rows[0]
      return row ? toCampaign(row) : null
    },

    listByUser: async (userId: string): Promise<Campaign[]> => {
      const result = await pool.query<CampaignDbRow>(
        `SELECT c.* FROM campaigns c
            JOIN campaign_members cm ON cm.campaign_id = c.id
          WHERE cm.user_id = $1 AND cm.invite_accepted = true
          ORDER BY c.created_at DESC`,
        [userId],
      )
      return result.rows.map(toCampaign)
    },

    update: async (id: string, patch: CampaignUpdate): Promise<Campaign> => {
      const result = await pool.query<CampaignDbRow>(
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
      const inserted = await pool.query<CampaignMemberDbRow>(
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
      const existing = await pool.query<CampaignMemberDbRow>(
        `SELECT * FROM campaign_members WHERE campaign_id = $1 AND user_id = $2`,
        [input.campaignId, input.userId],
      )
      const row = existing.rows[0]
      if (!row) throw new Error('addMember: ON CONFLICT then SELECT returned no row')
      return toCampaignMember(row)
    },

    getMembership: async (campaignId: string, userId: string): Promise<CampaignMember | null> => {
      const result = await pool.query<CampaignMemberDbRow>(
        `SELECT * FROM campaign_members WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId],
      )
      const row = result.rows[0]
      return row ? toCampaignMember(row) : null
    },

    getOwner: async (campaignId: string): Promise<CampaignMember | null> => {
      const result = await pool.query<CampaignMemberDbRow>(
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
      const result = await pool.query<{
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
