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

/** Resolved (Zod-already-mapped) shape of the character-sheet write absorbed
 *  by `replaceSubTables`. The caller (character-sheet stage) does the
 *  Zod→DB column mapping (proficiency_level enum, feature_source, the
 *  narrative.race→species rename) before handing these in — the binder holds
 *  only the SQL. */
export interface ReplaceSubTablesInput {
  readonly campaignId: string
  readonly userId: string
  readonly name: string
  readonly level: number
  readonly class: string
  /** maps to characters.species (column rename from narrative.race). */
  readonly species: string
  readonly background: string
  readonly str: number
  readonly dex: number
  readonly con: number
  readonly int: number
  readonly wis: number
  readonly cha: number
  readonly hitPoints: number
  readonly maxHitPoints: number
  readonly armorClass: number
  readonly proficiencyBonus: number
  readonly skills: readonly {
    readonly name: string
    readonly proficiencyLevel: 'expertise' | 'proficient' | 'none'
  }[]
  readonly features: readonly {
    readonly name: string
    readonly source: string
    readonly description: string
  }[]
  readonly equipment: readonly { readonly name: string; readonly quantity: number }[]
  readonly spells: readonly {
    readonly name: string
    readonly level: number
    readonly prepared: boolean
  }[]
}

// Composable binder — each method captures the ClientLike `c` so the body
// serves `repo.characters.X` and `tx.characters.X`. SQL unchanged.
//
// `create` keeps its explicit `tx` first-param: its callers (POST /characters,
// the repo tests) pass a PoolClient from a hand-managed tx, and dropping the
// param is a later migration step (see the design's Migration note). Holding
// it preserves the byte-for-byte caller contract.
export function charactersNs(c: ClientLike) {
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

    /**
     * T18 ownership check: is `characterId` linked to `campaignId` via
     * campaign_characters? Returns true when the join row exists. Guards against
     * fishing for a character_id by probing campaigns the caller can see. SQL
     * verbatim from the former inline `SELECT character_id FROM
     * campaign_characters WHERE campaign_id = $1 AND character_id = $2`.
     */
    isInCampaign: async (campaignId: string, characterId: string): Promise<boolean> => {
      const result = await c.query<{ character_id: string }>(
        `SELECT character_id FROM campaign_characters
         WHERE campaign_id = $1 AND character_id = $2`,
        [campaignId, characterId],
      )
      return result.rows.length > 0
    },

    /**
     * T18 GET /characters/:charId full read: the characters row + its four
     * sub-tables (skills / features / equipment / spells), each projected to the
     * meaningful columns only. Runs the four sub-table reads in parallel exactly
     * as the route did. SQL byte-identical to the former inline reads in
     * campaign-characters.ts. Homed on `repo.characters.getFullCharacter` per the
     * design's `characters` namespace table.
     */
    getFullCharacter: async (
      characterId: string,
    ): Promise<{
      character: CharacterDbRow | undefined
      skills: readonly { skill_name: string; proficiency_level: string }[]
      features: readonly { feature_name: string; feature_source: string; description: string }[]
      equipment: readonly { item_name: string; quantity: number; equipped: boolean }[]
      spells: readonly { spell_name: string; spell_level: number; prepared: boolean }[]
    }> => {
      const [character, skills, features, equipment, spells] = await Promise.all([
        c.query<CharacterDbRow>(`SELECT * FROM characters WHERE id = $1`, [characterId]),
        c.query<{ skill_name: string; proficiency_level: string }>(
          `SELECT skill_name, proficiency_level FROM character_skills WHERE character_id = $1`,
          [characterId],
        ),
        c.query<{ feature_name: string; feature_source: string; description: string }>(
          `SELECT feature_name, feature_source, description FROM character_features WHERE character_id = $1`,
          [characterId],
        ),
        c.query<{ item_name: string; quantity: number; equipped: boolean }>(
          `SELECT item_name, quantity, equipped FROM character_equipment WHERE character_id = $1`,
          [characterId],
        ),
        c.query<{ spell_name: string; spell_level: number; prepared: boolean }>(
          `SELECT spell_name, spell_level, prepared FROM character_spells WHERE character_id = $1`,
          [characterId],
        ),
      ])
      return {
        character: character.rows[0],
        skills: skills.rows,
        features: features.rows,
        equipment: equipment.rows,
        spells: spells.rows,
      }
    },

    /**
     * GET /api/campaigns/:campaignId details: the campaign's finalized PCs — one
     * row per completed/integrated character_concept joined through
     * campaign_characters to the characters row. Filters on the concept status
     * (the ground truth) so half-built rows never surface. SQL verbatim from the
     * former inline read in campaigns.ts. Homed on
     * `repo.characters.listCampaignCharacters` per the design's cross-domain
     * join section ("finalized-PC list").
     */
    listCampaignCharacters: async (
      campaignId: string,
    ): Promise<
      readonly {
        user_id: string
        character_id: string
        name: string
        class: string
        level: number
      }[]
    > => {
      const result = await c.query<{
        user_id: string
        character_id: string
        name: string
        class: string
        level: number
      }>(
        `SELECT cc.user_id, c.id AS character_id, c.name, c.class, c.level
         FROM character_concepts cc
         JOIN campaign_characters cm
           ON cm.campaign_id = cc.campaign_id AND cm.user_id = cc.user_id
         JOIN characters c ON c.id = cm.character_id
         WHERE cc.campaign_id = $1 AND cc.status IN ('completed', 'integrated')`,
        [campaignId],
      )
      return result.rows
    },

    addToCampaign: async (
      campaignId: string,
      characterId: string,
      userId: string,
    ): Promise<void> => {
      const id = uuidv7()
      try {
        await c.query(
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
      const result = await c.query<CharacterDbRow>(
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
      const result = await c.query<CharacterDbRow>(
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

    // myth-gp2c Cluster C: the character-sheet stage's 6-table write — the
    // `characters` row + the `campaign_characters` join + the four sub-tables
    // (skills/features/equipment/spells). Lookup-or-INSERT keyed on
    // (campaign_id, user_id) via campaign_characters; idempotent re-run UPDATEs
    // the existing characters row and DELETEs + re-INSERTs the four sub-tables
    // so a retried stage converges to the same shape as a fresh one. Returns
    // the resolved character_id. SQL relocated verbatim from the former
    // `character-sheet.ts persistCharacter`; composes inside the stage's
    // `repo.transaction(tx => tx.characters.replaceSubTables(...))`.
    // Exceeds the 50-line budget (~75 lines) because the statements are
    // inherently coupled — splitting would force threading a client through
    // nested helpers (the exact footgun the unification removes).
    // eslint-disable-next-line max-lines-per-function
    replaceSubTables: async (input: ReplaceSubTablesInput): Promise<string> => {
      // Lookup-or-INSERT keyed on (campaign_id, user_id) via campaign_characters.
      // The join table's UNIQUE (campaign_id, user_id) is the day-one "one PC
      // per player per campaign" invariant from migration 009.
      const existing = await c.query<{ character_id: string }>(
        `SELECT character_id FROM campaign_characters
       WHERE campaign_id = $1 AND user_id = $2`,
        [input.campaignId, input.userId],
      )
      const characterId = existing.rows[0]?.character_id ?? uuidv7()

      if (existing.rows.length === 0) {
        await c.query(
          `INSERT INTO characters (
           id, user_id, name, level, class, species, background,
           str, dex, con, int, wis, cha,
           hit_points, max_hit_points, armor_class, proficiency_bonus
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [
            characterId,
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
        await c.query(
          `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
         VALUES ($1, $2, $3, $4)`,
          [uuidv7(), input.campaignId, characterId, input.userId],
        )
      } else {
        await c.query(
          `UPDATE characters SET
           name = $2, level = $3, class = $4, species = $5, background = $6,
           str = $7, dex = $8, con = $9, int = $10, wis = $11, cha = $12,
           hit_points = $13, max_hit_points = $14, armor_class = $15, proficiency_bonus = $16,
           updated_at = now()
         WHERE id = $1`,
          [
            characterId,
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
        // DELETE-by-character-id on sub-tables; re-INSERT below.
        await c.query(`DELETE FROM character_skills WHERE character_id = $1`, [characterId])
        await c.query(`DELETE FROM character_features WHERE character_id = $1`, [characterId])
        await c.query(`DELETE FROM character_equipment WHERE character_id = $1`, [characterId])
        await c.query(`DELETE FROM character_spells WHERE character_id = $1`, [characterId])
      }

      // Sub-table inserts. The caller has already done the Zod→DB mapping.
      for (const s of input.skills) {
        await c.query(
          `INSERT INTO character_skills (id, character_id, skill_name, proficiency_level)
         VALUES ($1, $2, $3, $4)`,
          [uuidv7(), characterId, s.name, s.proficiencyLevel],
        )
      }
      for (const f of input.features) {
        await c.query(
          `INSERT INTO character_features (id, character_id, feature_name, feature_source, description)
         VALUES ($1, $2, $3, $4, $5)`,
          [uuidv7(), characterId, f.name, f.source, f.description],
        )
      }
      for (const e of input.equipment) {
        await c.query(
          `INSERT INTO character_equipment (id, character_id, item_name, quantity)
         VALUES ($1, $2, $3, $4)`,
          [uuidv7(), characterId, e.name, e.quantity],
        )
      }
      for (const sp of input.spells) {
        await c.query(
          `INSERT INTO character_spells (id, character_id, spell_name, spell_level, prepared)
         VALUES ($1, $2, $3, $4, $5)`,
          [uuidv7(), characterId, sp.name, sp.level, sp.prepared],
        )
      }

      return characterId
    },

    /** MYT-68 §3.5 step 1 — resolve a skill-check roller from the SESSION
     *  roster (session_participants carries character_id; a campaign member
     *  who never joined isn't rollable). Exact match on normalized name —
     *  closed-set structural validation, NO fuzzy matching (ZFC). */
    findSessionParticipantCharacterByName: async (
      sessionId: string,
      characterName: string,
    ): Promise<
      | {
          outcome: 'found'
          character: Character
          skills: readonly { skill_name: string; proficiency_level: string }[]
        }
      | { outcome: 'not_found' }
      | { outcome: 'ambiguous' }
    > => {
      const matches = await c.query<CharacterDbRow>(
        `SELECT ch.* FROM session_participants sp
           JOIN characters ch ON ch.id = sp.character_id
          WHERE sp.session_id = $1
            AND lower(trim(ch.name)) = lower(trim($2))`,
        [sessionId, characterName],
      )
      const [row, ...rest] = matches.rows
      if (!row) return { outcome: 'not_found' }
      if (rest.length > 0) return { outcome: 'ambiguous' }
      const character = toCharacter(row)
      const skills = await c.query<{ skill_name: string; proficiency_level: string }>(
        `SELECT skill_name, proficiency_level FROM character_skills WHERE character_id = $1`,
        [character.id],
      )
      return { outcome: 'found', character, skills: skills.rows }
    },

    // myth-gp2c Cluster C: link a PC's freshly-created entity to its characters
    // row during character-integration (pass 4). characters has no campaign_id
    // column (dropped in migration 009); the (campaign, user) → character_id
    // mapping lives in campaign_characters, so the UPDATE resolves the row via
    // a sub-SELECT. SQL verbatim from `stages/character-integration.ts
    // writeIntegration`. Composes inside the stage's `repo.transaction`.
    linkEntityForCampaignUser: async (input: {
      entityId: string
      campaignId: string
      userId: string
    }): Promise<void> => {
      await c.query(
        `UPDATE characters
            SET entity_id = $1, updated_at = now()
          WHERE id = (
            SELECT character_id FROM campaign_characters
             WHERE campaign_id = $2 AND user_id = $3
          )`,
        [input.entityId, input.campaignId, input.userId],
      )
    },
  }
}

/** Back-compat factory — pool-bound `characters` surface. Identical shape to
 *  the pre-unification `createCharactersRepo`. */
export const createCharactersRepo = (pool: Pool) => charactersNs(pool)
