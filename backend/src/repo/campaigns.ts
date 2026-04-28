import { type Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { type Campaign, type CampaignUpdate, type CreateCampaignInput } from './types.js'
import { toCampaign, type CampaignDbRow } from './mappers.js'

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
        [id, input.worldId, input.sourceWorldId ?? null, input.createdBy, input.name, input.status ?? null, input.language ?? null],
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
  }
}
