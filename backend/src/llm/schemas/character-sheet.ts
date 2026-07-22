// backend/src/llm/schemas/character-sheet.ts
//
// MYT-53 stage 3: mechanical half — ability scores, derived stats,
// and the four sub-tables (skills/features/equipment/spells).

import { z } from 'zod'

const abilityScore = z.number().int().min(3).max(20)

// myth-wj43: the canonical 18 skills of 5e (SRD), spelled as the live proficiency
// lookup expects. The write side constrains `skill.name` to this exact set so a
// free-text name ('Sleight Of Hand', a mis-spelling, or a tool proficiency like
// "Thieves' Tools") can never be persisted and then silently miss the read-side
// join. The read side (session/skill-check.ts SKILL_ABILITIES) matches on
// lower(trim(name)); these canonical spellings normalize to the same keys, so a
// proficiency written here always resolves there. Tool proficiencies are NOT
// skills and are deliberately excluded — they have no home on the sheet's skills
// table. Keep in lockstep with the read-side twin SKILL_ABILITIES; the schema
// tests pin this exact 18-name set.
export const CANONICAL_SKILLS = [
  'Acrobatics',
  'Animal Handling',
  'Arcana',
  'Athletics',
  'Deception',
  'History',
  'Insight',
  'Intimidation',
  'Investigation',
  'Medicine',
  'Nature',
  'Perception',
  'Performance',
  'Persuasion',
  'Religion',
  'Sleight of Hand',
  'Stealth',
  'Survival',
] as const

export const skillEntrySchema = z.object({
  // myth-wj43: a native enum (not free z.string) so the provider's structured
  // output is constrained to the canonical 18, and any drift terminal-fails the
  // stage loudly rather than persisting an unmatchable name. The prompt names the
  // same 18 (prompt+schema co-evolve).
  name: z.enum(CANONICAL_SKILLS),
  proficient: z.boolean(),
  expertise: z.boolean(),
})

const featureEntrySchema = z.object({
  name: z.string().min(2).max(80),
  // min-only: no max on free LLM prose — see feedback_no_max_on_llm_prose_fields /
  // myth-vimk. The haiku→sonnet repair only fixes malformed JSON, so a max()
  // terminal-fails the stage on valid-but-long feature text.
  description: z.string().min(5),
  // MYT-70 §3.2: limited features carry both uses and recharge; null = unlimited
  // (untracked — no counter, no resolver debit). Short structured field, max OK.
  max_uses: z.number().int().min(1).max(20).nullable(),
  recharge: z.enum(['short_rest', 'long_rest', 'none']),
})

const equipmentEntrySchema = z.object({
  name: z.string().min(2).max(80),
  quantity: z.number().int().min(1).max(99),
  // MYT-70 §3.2: consume-on-use metadata (potions, scrolls, rations). §7 snapshot
  // display flag; not name-matched in code.
  consumable: z.boolean(),
})

const spellEntrySchema = z.object({
  name: z.string().min(2).max(80),
  level: z.number().int().min(0).max(9),
  prepared: z.boolean(),
  // MYT-70 §3.2 / §5 cast_spell: castable as a ritual (no slot debit). Prep-structured,
  // not name-matched against the SRD ritual list.
  ritual: z.boolean(),
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
  // MYT-70 §3.2: starting wealth → the ledger's opening gold balance.
  starting_gold: z.number().int().min(0).max(500),
  // MYT-70 §3.2: the class hit die (6/8/10/12) — short-rest healing currency.
  hit_die: z.union([z.literal(6), z.literal(8), z.literal(10), z.literal(12)]),
  // MYT-70 §3.2 / §9.1: what KIND of caster this character is — the model's
  // one-time judgment. Code derives slot tables from (progression, level); never
  // string-matches the free-text class name. 'none' = no leveled slots.
  spellcasting_progression: z.enum(['full', 'half', 'third', 'pact', 'none']),
  skills: z.array(skillEntrySchema).min(1).max(20),
  features: z.array(featureEntrySchema).min(1).max(20),
  equipment: z.array(equipmentEntrySchema).min(1).max(40),
  spells: z.array(spellEntrySchema).max(60),
})

export type CharacterSheetOutput = z.infer<typeof CharacterSheetOutputSchema>
export type FeatureEntry = z.infer<typeof featureEntrySchema>
export type EquipmentEntry = z.infer<typeof equipmentEntrySchema>
export type SpellEntry = z.infer<typeof spellEntrySchema>
