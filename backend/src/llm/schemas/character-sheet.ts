// backend/src/llm/schemas/character-sheet.ts
//
// MYT-53 stage 3: mechanical half — ability scores, derived stats,
// and the four sub-tables (skills/features/equipment/spells).

import { z } from 'zod'

const abilityScore = z.number().int().min(3).max(20)

export const skillEntrySchema = z.object({
  name: z.string().min(2).max(40),
  proficient: z.boolean(),
  expertise: z.boolean(),
})

export const featureEntrySchema = z.object({
  name: z.string().min(2).max(80),
  // min-only: no max on free LLM prose — see feedback_no_max_on_llm_prose_fields /
  // myth-vimk. The haiku→sonnet repair only fixes malformed JSON, so a max()
  // terminal-fails the stage on valid-but-long feature text.
  description: z.string().min(5),
})

export const equipmentEntrySchema = z.object({
  name: z.string().min(2).max(80),
  quantity: z.number().int().min(1).max(99),
})

export const spellEntrySchema = z.object({
  name: z.string().min(2).max(80),
  level: z.number().int().min(0).max(9),
  prepared: z.boolean(),
})

export const CharacterSheetOutputSchema = z.object({
  str: abilityScore,
  dex: abilityScore,
  con: abilityScore,
  int: abilityScore,
  wis: abilityScore,
  cha: abilityScore,
  hit_points: z.number().int().min(1).max(500),
  max_hit_points: z.number().int().min(1).max(500),
  armor_class: z.number().int().min(8).max(30),
  proficiency_bonus: z.number().int().min(2).max(6),
  skills: z.array(skillEntrySchema).min(1).max(20),
  features: z.array(featureEntrySchema).min(1).max(20),
  equipment: z.array(equipmentEntrySchema).min(1).max(40),
  spells: z.array(spellEntrySchema).max(60),
})

export type CharacterSheetOutput = z.infer<typeof CharacterSheetOutputSchema>
export type SkillEntry = z.infer<typeof skillEntrySchema>
export type FeatureEntry = z.infer<typeof featureEntrySchema>
export type EquipmentEntry = z.infer<typeof equipmentEntrySchema>
export type SpellEntry = z.infer<typeof spellEntrySchema>
