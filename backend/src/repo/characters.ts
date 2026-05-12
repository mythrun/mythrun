import { type Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { toCharacter } from './mappers.js'
import type { CharacterDbRow } from './mappers.js'
import type { ClientLike } from './_types.js'
import type { Character, CreateCharacterInput } from './types.js'
import {
  CharacterAlreadyInCampaignError,
  UserAlreadyHasCharacterInCampaignError,
} from './characters-errors.js'

export function createCharactersRepo(pool: Pool) {
  return {
    create: async (tx: ClientLike, input: CreateCharacterInput): Promise<Character> => {
      const id = uuidv7()
      const result = await tx.query<CharacterDbRow>(
        `INSERT INTO characters (
           id, user_id, name, level, class, species, background,
           str, dex, con, int, wis, cha,
           hit_points, max_hit_points, armor_class, proficiency_bonus
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING *`,
        [
          id,
          input.userId,
          input.name,
          input.level,
          input.class,
          input.species,
          input.background,
          input.str,
          input.dex,
          input.con,
          input.int,
          input.wis,
          input.cha,
          input.hitPoints,
          input.maxHitPoints,
          input.armorClass,
          input.proficiencyBonus,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error('characters.create: INSERT returned no row')
      return toCharacter(row)
    },

    addToCampaign: async (
      campaignId: string,
      characterId: string,
      userId: string,
    ): Promise<void> => {
      const id = uuidv7()
      try {
        await pool.query(
          `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
           VALUES ($1, $2, $3, $4)`,
          [id, campaignId, characterId, userId],
        )
      } catch (err) {
        if (typeof err === 'object' && err !== null && 'code' in err && 'constraint' in err) {
          const pgErr = err as { code?: string; constraint?: string }
          if (pgErr.code === '23505') {
            if (pgErr.constraint === 'campaign_characters_campaign_id_character_id_key') {
              throw new CharacterAlreadyInCampaignError(campaignId, characterId)
            }
            if (pgErr.constraint === 'campaign_characters_campaign_id_user_id_key') {
              throw new UserAlreadyHasCharacterInCampaignError(campaignId, userId)
            }
          }
        }
        throw err
      }
    },

    listForCampaign: async (campaignId: string): Promise<readonly Character[]> => {
      const result = await pool.query<CharacterDbRow>(
        `SELECT c.*
         FROM characters c
         JOIN campaign_characters cc ON cc.character_id = c.id
         WHERE cc.campaign_id = $1
         ORDER BY cc.joined_at ASC, cc.id ASC`,
        [campaignId],
      )
      return result.rows.map(toCharacter)
    },

    findUserCharacterForCampaign: async (
      userId: string,
      campaignId: string,
    ): Promise<Character | null> => {
      const result = await pool.query<CharacterDbRow>(
        `SELECT c.*
         FROM characters c
         JOIN campaign_characters cc ON cc.character_id = c.id
         WHERE cc.campaign_id = $1 AND cc.user_id = $2
         LIMIT 1`,
        [campaignId, userId],
      )
      const row = result.rows[0]
      return row ? toCharacter(row) : null
    },
  }
}
