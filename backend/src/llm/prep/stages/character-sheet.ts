// backend/src/llm/prep/stages/character-sheet.ts
//
// MYT-53 / myth-wolj T9: stage 3 of the character-creation worker. Sonnet
// generateObject producing mechanical stats + the four sub-table rows.
// Owns the SINGLE INSERT into `characters` + the `campaign_characters`
// join + the four sub-tables (skills/features/equipment/spells) in one
// transaction.
//
// Idempotent re-run: if a characters row already exists for
// (campaign_id, user_id) — looked up via campaign_characters — UPDATE the
// characters row in place and DELETE the four sub-tables before re-INSERT,
// so a retried stage 3 converges to the same shape as a fresh one.
//
// Zod-to-DB mapping (the schema does NOT line up 1:1 with the sub-table
// column names from migration 001 — see the prompt header table for the
// full mapping):
//   skills[].proficient/expertise -> character_skills.proficiency_level
//     (enum: 'expertise' > 'proficient' > 'none')
//   features[].name -> character_features.feature_name
//   features[].description -> character_features.description
//   (no Zod field) -> character_features.feature_source — populated with
//     args.narrative.class, the source of nearly every level-1 feature.
//   equipment[].name -> character_equipment.item_name
//   equipment[].quantity -> character_equipment.quantity
//   (no Zod field) -> character_equipment.equipped — handler omits the
//     column from the INSERT so the DB default (false) fires.
//   spells[].name -> character_spells.spell_name
//   spells[].level -> character_spells.spell_level
//   narrative.race -> characters.species (note column rename).

import type { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { generateObject } from '../../ai.js'
import { SONNET } from '../../models.js'
import {
  CharacterSheetOutputSchema,
  type CharacterSheetOutput,
} from '../../schemas/character-sheet.js'
import type { CharacterConceptOutput } from '../../schemas/character-concept.js'
import { uuidv7 } from '../../../repo/uuidv7.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../prompts/prep/character-sheet.txt',
  ),
  'utf8',
)

// Anthropic Sonnet pricing per https://www.anthropic.com/pricing. Held
// local to the stage so a per-stage tier change is one-file scoped — same
// convention as character-concept.ts.
const SONNET_INPUT_PER_MTOK = 3.0
const SONNET_OUTPUT_PER_MTOK = 15.0

export interface CharacterSheetArgs {
  readonly campaignId: string
  readonly userId: string
  readonly worldId: string
  readonly narrative: CharacterConceptOutput
  readonly worldTone: string
  readonly worldEra: string
}

export interface CharacterSheetStageResult {
  readonly characterId: string
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
}

export async function runCharacterSheetStage(
  pool: Pool,
  args: CharacterSheetArgs,
): Promise<CharacterSheetStageResult> {
  const prompt = renderPrompt(args)

  const result = await generateObject({
    model: SONNET,
    schema: CharacterSheetOutputSchema,
    schemaName: 'CharacterSheetOutputSchema',
    callSite: 'character-sheet',
    prompt,
    temperature: 0.5,
    maxRetries: 3,
  })

  const characterId = await persistCharacter(pool, args, result.output)

  // LanguageModelUsage exposes token fields as `number | undefined`; default
  // to 0 to keep the strict-number contract (matches character-concept.ts).
  /* c8 ignore start — Anthropic provider always populates these. */
  const inputTokens = result.usage.inputTokens ?? 0
  const outputTokens = result.usage.outputTokens ?? 0
  /* c8 ignore stop */
  return {
    characterId,
    costUsd:
      (inputTokens / 1_000_000) * SONNET_INPUT_PER_MTOK +
      (outputTokens / 1_000_000) * SONNET_OUTPUT_PER_MTOK,
    inputTokens,
    outputTokens,
  }
}

function renderPrompt(args: CharacterSheetArgs): string {
  return PROMPT_TEMPLATE.replace('{{name}}', args.narrative.name)
    .replace('{{race}}', args.narrative.race)
    .replace('{{class}}', args.narrative.class)
    .replace('{{background}}', args.narrative.background)
    .replace('{{alignment}}', args.narrative.alignment)
    .replace('{{physicalDescription}}', args.narrative.physical_description)
    .replace('{{backstory}}', args.narrative.backstory)
    .replace('{{tone}}', args.worldTone)
    .replace('{{era}}', args.worldEra)
}

function proficiencyLevel(s: {
  proficient: boolean
  expertise: boolean
}): 'expertise' | 'proficient' | 'none' {
  if (s.expertise) return 'expertise'
  if (s.proficient) return 'proficient'
  return 'none'
}

// Single transactional write spanning 1 characters row + 1 campaign_characters
// join + N sub-table rows. Exceeds the 50-line budget (~75 lines) because the
// statements are inherently coupled — splitting would lose the single-BEGIN/
// COMMIT semantic and force callers to thread a client through nested helpers.
// eslint-disable-next-line max-lines-per-function
async function persistCharacter(
  pool: Pool,
  args: CharacterSheetArgs,
  sheet: CharacterSheetOutput,
): Promise<string> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Lookup-or-INSERT keyed on (campaign_id, user_id) via campaign_characters.
    // The join table's UNIQUE (campaign_id, user_id) is the day-one "one PC
    // per player per campaign" invariant from migration 009.
    const existing = await client.query<{ character_id: string }>(
      `SELECT character_id FROM campaign_characters
       WHERE campaign_id = $1 AND user_id = $2`,
      [args.campaignId, args.userId],
    )
    const characterId = existing.rows[0]?.character_id ?? uuidv7()

    if (existing.rows.length === 0) {
      await client.query(
        `INSERT INTO characters (
           id, user_id, name, level, class, species, background,
           str, dex, con, int, wis, cha,
           hit_points, max_hit_points, armor_class, proficiency_bonus
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          characterId,
          args.userId,
          args.narrative.name,
          args.narrative.level,
          args.narrative.class,
          args.narrative.race,
          args.narrative.background,
          sheet.str,
          sheet.dex,
          sheet.con,
          sheet.int,
          sheet.wis,
          sheet.cha,
          sheet.hit_points,
          sheet.max_hit_points,
          sheet.armor_class,
          sheet.proficiency_bonus,
        ],
      )
      await client.query(
        `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
         VALUES ($1, $2, $3, $4)`,
        [uuidv7(), args.campaignId, characterId, args.userId],
      )
    } else {
      await client.query(
        `UPDATE characters SET
           name = $2, level = $3, class = $4, species = $5, background = $6,
           str = $7, dex = $8, con = $9, int = $10, wis = $11, cha = $12,
           hit_points = $13, max_hit_points = $14, armor_class = $15, proficiency_bonus = $16,
           updated_at = now()
         WHERE id = $1`,
        [
          characterId,
          args.narrative.name,
          args.narrative.level,
          args.narrative.class,
          args.narrative.race,
          args.narrative.background,
          sheet.str,
          sheet.dex,
          sheet.con,
          sheet.int,
          sheet.wis,
          sheet.cha,
          sheet.hit_points,
          sheet.max_hit_points,
          sheet.armor_class,
          sheet.proficiency_bonus,
        ],
      )
      // DELETE-by-character-id on sub-tables; re-INSERT below.
      await client.query(`DELETE FROM character_skills WHERE character_id = $1`, [characterId])
      await client.query(`DELETE FROM character_features WHERE character_id = $1`, [characterId])
      await client.query(`DELETE FROM character_equipment WHERE character_id = $1`, [characterId])
      await client.query(`DELETE FROM character_spells WHERE character_id = $1`, [characterId])
    }

    // Sub-table inserts with Zod-to-DB column mapping (see file header).
    for (const s of sheet.skills) {
      await client.query(
        `INSERT INTO character_skills (id, character_id, skill_name, proficiency_level)
         VALUES ($1, $2, $3, $4)`,
        [uuidv7(), characterId, s.name, proficiencyLevel(s)],
      )
    }
    for (const f of sheet.features) {
      await client.query(
        `INSERT INTO character_features (id, character_id, feature_name, feature_source, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), characterId, f.name, args.narrative.class, f.description],
      )
    }
    for (const e of sheet.equipment) {
      await client.query(
        `INSERT INTO character_equipment (id, character_id, item_name, quantity)
         VALUES ($1, $2, $3, $4)`,
        [uuidv7(), characterId, e.name, e.quantity],
      )
    }
    for (const sp of sheet.spells) {
      await client.query(
        `INSERT INTO character_spells (id, character_id, spell_name, spell_level, prepared)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), characterId, sp.name, sp.level, sp.prepared],
      )
    }

    await client.query('COMMIT')
    return characterId
    /* c8 ignore start — ROLLBACK arm fires only when one of the INSERTs
     * throws (PG constraint violation, connection drop). All inputs are
     * Zod-validated; defense-in-depth, not happy path. */
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
    /* c8 ignore stop */
  } finally {
    client.release()
  }
}
