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

import { type Repo, expectCommitted } from '../../../repo/index.js'
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
  repo: Repo,
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

  const characterId = await persistCharacter(repo, args, result.output)

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
// join + N sub-table rows. The LLM call already completed in the caller; this
// scope is writes only (MYT-55 — slow I/O never sits inside BEGIN/COMMIT). The
// 6-table SQL lives verbatim in `repo.characters.replaceSubTables`; here we map
// the Zod sheet → the binder's resolved input (proficiency_level enum, the
// narrative.race→species rename, args.narrative.class as feature_source) and
// run it through `repo.transaction`. The callback throws (never returns
// ROLLBACK), so `expectCommitted` narrows the result to the character id.
async function persistCharacter(
  repo: Repo,
  args: CharacterSheetArgs,
  sheet: CharacterSheetOutput,
): Promise<string> {
  return expectCommitted(
    await repo.transaction(async (tx) =>
      tx.characters.replaceSubTables({
        campaignId: args.campaignId,
        userId: args.userId,
        name: args.narrative.name,
        level: args.narrative.level,
        class: args.narrative.class,
        // narrative.race → characters.species (column rename, see file header).
        species: args.narrative.race,
        background: args.narrative.background,
        str: sheet.str,
        dex: sheet.dex,
        con: sheet.con,
        int: sheet.int,
        wis: sheet.wis,
        cha: sheet.cha,
        hitPoints: sheet.hit_points,
        maxHitPoints: sheet.max_hit_points,
        armorClass: sheet.armor_class,
        proficiencyBonus: sheet.proficiency_bonus,
        skills: sheet.skills.map((s) => ({
          name: s.name,
          proficiencyLevel: proficiencyLevel(s),
        })),
        // feature_source has no Zod field — populated with the class, the
        // source of nearly every level-1 feature (see file header).
        features: sheet.features.map((f) => ({
          name: f.name,
          source: args.narrative.class,
          description: f.description,
        })),
        equipment: sheet.equipment.map((e) => ({ name: e.name, quantity: e.quantity })),
        spells: sheet.spells.map((sp) => ({
          name: sp.name,
          level: sp.level,
          prepared: sp.prepared,
        })),
      }),
    ),
  )
}
