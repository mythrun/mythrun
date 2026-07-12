import { type Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { toCharacter } from './mappers.js'
import type { CharacterDbRow } from './mappers.js'
import type { ClientLike } from './_types.js'
import type { Character, CreateCharacterInput } from './types.js'
import type { SpellcastingProgression } from '../session/srd/spell-slots.js'
import {
  CharacterAlreadyInCampaignError,
  UserAlreadyHasCharacterInCampaignError,
} from './characters-errors.js'
import { charactersLedgerNs } from './characters-ledger.js'

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
  // MYT-70 §3.2 ledger-init fields (the prep stage derives these). The binder
  // writes them onto the `characters` row + the joined slot set so a finalized
  // sheet lands fully playable (gold, hit-dice pool, caster progression, slots).
  readonly startingGold: number
  readonly hitDie: number
  readonly hitDiceRemaining: number
  readonly spellcastingProgression: SpellcastingProgression
  /** Derived from `spellSlotsFor(progression, level)` (§9.1), written full
   *  (max = remaining). Joins replaceSubTables' delete+re-insert set so a
   *  retried stage converges instead of terminal-failing the slot index. */
  readonly slotRows: readonly { readonly slotLevel: number; readonly max: number }[]
  readonly skills: readonly {
    readonly name: string
    readonly proficiencyLevel: 'expertise' | 'proficient' | 'none'
  }[]
  readonly features: readonly {
    readonly name: string
    readonly source: string
    readonly description: string
    // §3.2: tracked-feature counters. null max ⟹ unlimited (untracked); the
    // 025 CHECK pairs (max IS NULL) = (uses_remaining IS NULL) and forbids a
    // recharge schedule on an untracked feature.
    readonly maxUses: number | null
    readonly recharge: 'short_rest' | 'long_rest' | 'none'
  }[]
  readonly equipment: readonly {
    readonly name: string
    readonly quantity: number
    readonly consumable: boolean
  }[]
  readonly spells: readonly {
    readonly name: string
    readonly level: number
    readonly prepared: boolean
    readonly ritual: boolean
  }[]
}

/** MYT-90: the character-concept narrative prose the reveal's prose panel is
 *  built from — the physical description, the personality sentences
 *  (trait/ideal/bond/flaw), and the player-authored situation-grounding text
 *  ("connection to the opening"). Snake_case to match the raw getFullCharacter
 *  wire shape (the api layer validates + the D6 adapter composes these into the
 *  curated sheet's prose). */
export interface CharacterConceptProse {
  readonly physical_description: string | null
  readonly personality_traits: readonly string[]
  readonly ideals: readonly string[]
  readonly bonds: readonly string[]
  readonly flaws: readonly string[]
  readonly situation_grounding_text: string
}

/** Raw row of the concept-prose read. The `-> '<key>'` projections come back as
 *  parsed JS arrays (jsonb), or null when concept_output — or the key — is
 *  absent; `->> 'physical_description'` comes back as text-or-null. */
interface ConceptProseRow {
  situation_grounding_text: string
  physical_description: string | null
  personality_traits: readonly string[] | null
  ideals: readonly string[] | null
  bonds: readonly string[] | null
  flaws: readonly string[] | null
}

/** Map the concept-prose row to the wire shape. A missing row → undefined (the
 *  character has no concept); null personality sets → [] (concept_output not yet
 *  persisted). */
function toConceptProse(row: ConceptProseRow | undefined): CharacterConceptProse | undefined {
  if (row === undefined) return undefined
  return {
    physical_description: row.physical_description,
    personality_traits: row.personality_traits ?? [],
    ideals: row.ideals ?? [],
    bonds: row.bonds ?? [],
    flaws: row.flaws ?? [],
    situation_grounding_text: row.situation_grounding_text,
  }
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
    // MYT-70 §4/§5a/§10: the atomic-mutation ledger substrate (the scoped
    // `LedgerOps` methods + the per-turn party snapshot read). Homed in a
    // sibling binder so this module stays under the 400-line cap; composed
    // here so `repo.characters.*` / `tx.characters.*` surface them unchanged.
    ...charactersLedgerNs(c),

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
     * meaningful columns only, PLUS (MYT-90) the character-concept narrative
     * prose that feeds the reveal's prose panel. Runs the reads in parallel.
     *
     * MYT-90: the persisted `characters` row carries no descriptive prose — the
     * physical description + personality sentences + the player-authored
     * situation-grounding text live on the character CONCEPT. `characters` has
     * no campaign_id (dropped in migration 009); the (campaign, user) → concept
     * mapping is reached via `campaign_characters`. `concept` is undefined when
     * the character has no concept row; the personality arrays default to []
     * (and physical_description to null) when the concept exists but its
     * `concept_output` hasn't been persisted yet. Reading the concept's OWN
     * named prose fields — never parsing prose out of the mechanical sheet (ZFC).
     */
    getFullCharacter: async (
      characterId: string,
    ): Promise<{
      character: CharacterDbRow | undefined
      skills: readonly { skill_name: string; proficiency_level: string }[]
      features: readonly { feature_name: string; feature_source: string; description: string }[]
      equipment: readonly { item_name: string; quantity: number; equipped: boolean }[]
      spells: readonly { spell_name: string; spell_level: number; prepared: boolean }[]
      concept: CharacterConceptProse | undefined
    }> => {
      const [character, skills, features, equipment, spells, concept] = await Promise.all([
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
        // The concept prose, reached through campaign_characters. The scalar
        // physical_description is pulled via ->> (text); each personality set
        // via -> (a jsonb array node-postgres parses to a JS array).
        c.query<ConceptProseRow>(
          `SELECT
             cc.situation_grounding_text,
             cc.concept_output ->> 'physical_description' AS physical_description,
             cc.concept_output ->  'personality_traits'   AS personality_traits,
             cc.concept_output ->  'ideals'               AS ideals,
             cc.concept_output ->  'bonds'                AS bonds,
             cc.concept_output ->  'flaws'                AS flaws
           FROM campaign_characters cch
           JOIN character_concepts cc
             ON cc.campaign_id = cch.campaign_id AND cc.user_id = cch.user_id
          WHERE cch.character_id = $1`,
          [characterId],
        ),
      ])
      return {
        character: character.rows[0],
        skills: skills.rows,
        features: features.rows,
        equipment: equipment.rows,
        spells: spells.rows,
        concept: toConceptProse(concept.rows[0]),
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
           hit_points, max_hit_points, armor_class, proficiency_bonus,
           gold, hit_die, hit_dice_remaining, spellcasting_progression
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                 $18, $19, $20, $21)`,
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
            input.startingGold,
            input.hitDie,
            input.hitDiceRemaining,
            input.spellcastingProgression,
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
           gold = $17, hit_die = $18, hit_dice_remaining = $19, spellcasting_progression = $20,
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
            input.startingGold,
            input.hitDie,
            input.hitDiceRemaining,
            input.spellcastingProgression,
          ],
        )
        // DELETE-by-character-id on sub-tables; re-INSERT below. The slot set
        // joins this delete (§3.2) so a retried stage converges; conditions too
        // (prep inits none, but the delete-set must be clean for a re-run).
        await c.query(`DELETE FROM character_skills WHERE character_id = $1`, [characterId])
        await c.query(`DELETE FROM character_features WHERE character_id = $1`, [characterId])
        await c.query(`DELETE FROM character_equipment WHERE character_id = $1`, [characterId])
        await c.query(`DELETE FROM character_spells WHERE character_id = $1`, [characterId])
        await c.query(`DELETE FROM character_spell_slots WHERE character_id = $1`, [characterId])
        await c.query(`DELETE FROM character_conditions WHERE character_id = $1`, [characterId])
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
        // §3.2: a tracked feature inits uses_remaining = max_uses (written
        // full at finalize); an untracked one carries both NULL (025 pair CHECK).
        await c.query(
          `INSERT INTO character_features
             (id, character_id, feature_name, feature_source, description, max_uses, uses_remaining, recharge)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7)`,
          [uuidv7(), characterId, f.name, f.source, f.description, f.maxUses, f.recharge],
        )
      }
      for (const e of input.equipment) {
        await c.query(
          `INSERT INTO character_equipment (id, character_id, item_name, quantity, consumable)
         VALUES ($1, $2, $3, $4, $5)`,
          [uuidv7(), characterId, e.name, e.quantity, e.consumable],
        )
      }
      for (const sp of input.spells) {
        await c.query(
          `INSERT INTO character_spells (id, character_id, spell_name, spell_level, prepared, ritual)
         VALUES ($1, $2, $3, $4, $5, $6)`,
          [uuidv7(), characterId, sp.name, sp.level, sp.prepared, sp.ritual],
        )
      }
      for (const slot of input.slotRows) {
        // Written full: max = remaining (a finalized sheet starts rested).
        await c.query(
          `INSERT INTO character_spell_slots
             (id, character_id, slot_level, slots_max, slots_remaining)
         VALUES ($1, $2, $3, $4, $4)`,
          [uuidv7(), characterId, slot.slotLevel, slot.max],
        )
      }

      return characterId
    },

    /** MYT-68: the FT prompt roster AND the per-turn player-attribution map —
     *  the session's joined PCs as `{userId, name}`, in a DETERMINISTIC order
     *  (joined_at, then id). Two consumers off one read: the worker renders the
     *  names into the FT system prompt (a re-ordered roster would silently
     *  invalidate the prompt-cache prefix every turn), AND builds the
     *  userId→character-name map the transcript codec attributes player rows by.
     *  Player attribution MUST be the CHARACTER name (not the display name): the
     *  ft-system prompt tells the model to echo the attributed name into
     *  `roll_skill_check.character_name`, which resolves against
     *  session_participants — so the attribution and the resolver must speak the
     *  same names (an early smoke fail-softed the first check when the model
     *  passed a display name). Derived per turn from session_participants (the
     *  same source the skill-check resolver uses) — never from the racy :state
     *  blob (two simultaneous joins lost a name to last-write-wins; caught live
     *  in the MYT-68 smoke). */
    listSessionParticipantCharacters: async (
      sessionId: string,
    ): Promise<readonly { userId: string; name: string }[]> => {
      // (joined_at, id) order — the roster renders into the FT system prompt;
      // a re-ordered roster would invalidate the prompt-cache prefix.
      const result = await c.query<{ user_id: string; name: string }>(
        `SELECT sp.user_id, ch.name FROM session_participants sp
           JOIN characters ch ON ch.id = sp.character_id
          WHERE sp.session_id = $1
          ORDER BY sp.joined_at ASC, sp.id ASC`,
        [sessionId],
      )
      return result.rows.map((r) => ({ userId: r.user_id, name: r.name }))
    },

    /** MYT-69 §4 — the PC roster with class/background for the ST's world-state
     *  block. A NEW read: the existing listSessionParticipantCharacters returns
     *  {userId, name} only and is read on the FT hot path — leave it untouched.
     *  Same (joined_at, id) deterministic order as its sibling. */
    listSessionParticipantRoster: async (
      sessionId: string,
    ): Promise<readonly { name: string; characterClass: string; background: string }[]> => {
      const result = await c.query<{ name: string; class: string; background: string }>(
        `SELECT ch.name, ch.class, ch.background FROM session_participants sp
           JOIN characters ch ON ch.id = sp.character_id
          WHERE sp.session_id = $1
          ORDER BY sp.joined_at ASC, sp.id ASC`,
        [sessionId],
      )
      return result.rows.map((r) => ({
        name: r.name,
        characterClass: r.class,
        background: r.background,
      }))
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
