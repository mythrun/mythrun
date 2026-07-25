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
  type EquipmentEntry,
  type FeatureEntry,
  type SpellEntry,
} from '../../schemas/character-sheet.js'
import type { CharacterConceptOutput } from '../../schemas/character-concept.js'
import { spellSlotsFor, maxSlotLevel } from '../../../session/srd/spell-slots.js'
import { SRD_SUBCLASSES, srdSubclassFor } from '../../../session/srd/subclasses.js'

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

// MYT-70 §3.2: how many full generate→validate attempts before a coherence
// violation terminal-fails the stage LOUD. `generateObject`'s own `maxRetries`
// is the SDK's JSON-repair (Haiku/Sonnet fixing malformed structure), which
// CANNOT fix a spell that's structurally valid but mechanically incoherent
// (e.g. a level-9 spell on a level-1 caster). A coherence violation is a
// regenerate, not a repair — so we re-run the whole generation up to this many
// times, accumulating spend across every attempt.
const COHERENCE_MAX_ATTEMPTS = 3

/**
 * MYT-70 §3.2 — thrown by `validateCoherence` when the generated sheet is
 * structurally valid (Zod-clean) but mechanically incoherent against the SRD
 * slot tables. Caught inside the stage's generate loop to trigger a FULL
 * regenerate (NOT the SDK's JSON-repair, which can't fix mechanical mismatch);
 * after the attempt budget is exhausted it propagates and terminal-fails the
 * stage LOUD.
 */
export class CharacterSheetCoherenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CharacterSheetCoherenceError'
  }
}

export async function runCharacterSheetStage(
  repo: Repo,
  args: CharacterSheetArgs,
): Promise<CharacterSheetStageResult> {
  const prompt = renderPrompt(args)

  let inputTokens = 0
  let outputTokens = 0
  let sheet: CharacterSheetOutput | undefined
  let lastCoherenceError: CharacterSheetCoherenceError | undefined

  // Generate→validate loop. Each attempt is a fresh generation; a coherence
  // violation discards the output and regenerates (the SDK's JSON-repair only
  // fixes malformed structure, never mechanical incoherence). Spend from EVERY
  // attempt — including the discarded incoherent ones — accrues to the cost.
  for (let attempt = 0; attempt < COHERENCE_MAX_ATTEMPTS; attempt += 1) {
    const result = await generateObject({
      model: SONNET,
      schema: CharacterSheetOutputSchema,
      schemaName: 'CharacterSheetOutputSchema',
      callSite: 'character-sheet',
      prompt,
      temperature: 0.5,
      maxRetries: 3,
    })
    // LanguageModelUsage exposes token fields as `number | undefined`; default
    // to 0 to keep the strict-number contract (matches character-concept.ts).
    /* c8 ignore start — Anthropic provider always populates these. */
    inputTokens += result.usage.inputTokens ?? 0
    outputTokens += result.usage.outputTokens ?? 0
    /* c8 ignore stop */

    try {
      validateCoherence(result.output, args.narrative.level, {
        className: args.narrative.class,
        pinnedSubclass: args.narrative.subclass,
      })
      sheet = result.output
      break
    } catch (err) {
      if (!(err instanceof CharacterSheetCoherenceError)) throw err
      lastCoherenceError = err
    }
  }

  // Budget exhausted with no coherent sheet — terminal-fail LOUD. The
  // accumulated coherence error names the mismatch for the pipeline error blob.
  if (sheet === undefined) {
    /* c8 ignore next -- defensive: the loop always sets lastCoherenceError before sheet stays undefined. */
    throw lastCoherenceError ?? new CharacterSheetCoherenceError('character-sheet: incoherent')
  }

  const characterId = await persistCharacter(repo, args, sheet)

  return {
    characterId,
    costUsd:
      (inputTokens / 1_000_000) * SONNET_INPUT_PER_MTOK +
      (outputTokens / 1_000_000) * SONNET_OUTPUT_PER_MTOK,
    inputTokens,
    outputTokens,
  }
}

// ── Dedupe-merge (ZFC: mechanical aggregation on normalized names) ──────────
//
// The §3.1 unique indexes are on `lower(btrim(name))`, so an LLM that emits two
// "Healing Potion"/"healing potion" rows would terminal-fail the insert. We
// normalize + collapse name-collisions BEFORE the write: SUM quantities for
// equipment (two stacks of the same item merge), KEEP-FIRST for features and
// spells (no quantity to sum — the first emission wins, later dupes drop).

/** The repo's normalization: `lower(btrim(name))` — trim THEN case-fold. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

/** Equipment dedupe: collisions SUM quantities, first occurrence holds position
 *  + its consumable flag. */
export function dedupeMergeEquipment(
  equipment: readonly EquipmentEntry[],
): readonly EquipmentEntry[] {
  const byKey = new Map<string, EquipmentEntry>()
  for (const e of equipment) {
    const key = normalizeName(e.name)
    const existing = byKey.get(key)
    if (existing === undefined) {
      byKey.set(key, e)
    } else {
      byKey.set(key, { ...existing, quantity: existing.quantity + e.quantity })
    }
  }
  return [...byKey.values()]
}

/** Features dedupe: KEEP-FIRST on name collision (no quantity to merge). */
export function dedupeMergeFeatures(features: readonly FeatureEntry[]): readonly FeatureEntry[] {
  return keepFirstByName(features)
}

/** Spells dedupe: KEEP-FIRST on name collision. */
export function dedupeMergeSpells(spells: readonly SpellEntry[]): readonly SpellEntry[] {
  return keepFirstByName(spells)
}

function keepFirstByName<T extends { readonly name: string }>(items: readonly T[]): readonly T[] {
  const byKey = new Map<string, T>()
  for (const item of items) {
    const key = normalizeName(item.name)
    if (!byKey.has(key)) byKey.set(key, item)
  }
  return [...byKey.values()]
}

// ── Coherence validation (ZFC exception: structural validation) ─────────────
//
// Deterministic level-scaled invariants — no CON-mod guesswork on the caller's
// side, no class-name string-matching, pure math against the §9.1 slot tables
// and the SRD level curves:
//   1. every leveled spell's level ≤ maxSlotLevel(progression, level);
//   2. leveled spells present ⟹ progression ≠ 'none';
//   3. (MYT-90 A5) proficiency_bonus matches the level (1–4 → +2, 5 → +3);
//   4. (MYT-90 A5) max_hit_points sits inside a hit_die/CON/level HP band;
//   5. (myth-4jhrk) SRD-subclass allowlist: an SRD class at a subclass-granting
//      level must NAME its expected subclass (the player's pinned choice when
//      one exists, else the class's single SRD 2014 subclass) in at least one
//      feature name or description. Run-2 forensics: a guided "Life Domain"
//      pick silently became a full Grave Domain kit (non-SRD — licensing
//      exposure) because nothing gated the model's free choice. The check is a
//      12-entry lookup + case-insensitive containment — structural validation,
//      not semantic pattern-matching (ZFC-legal); flavored non-SRD class names
//      skip it.
// Cantrip-only lists (every spell level 0) with progression 'none' are LEGAL.
//
// NOT gated here: ASI/feat presence at level N. There is no pre-ASI baseline
// to diff the final ability scores against, and detecting a feat would mean
// string-matching free prose — a ZFC violation. Those ride on prompt quality
// + the guided builder, not on this deterministic shell.

// Per-level HP slack for racial bonuses (e.g. Hill Dwarf +1/level) so a legal
// sheet never false terminal-fails on the ceiling. See `validateCoherence`.
const HP_SLACK_PER_LEVEL = 1

/** myth-4jhrk: the subclass gate's inputs — the narrative class (decides
 *  whether and at what level the allowlist applies) and the player's pinned
 *  subclass when one exists (guided pick or concept-derived). Optional third
 *  argument to `validateCoherence` so the pure mechanical checks stay callable
 *  without it; the stage always passes it. */
export interface SubclassCheck {
  readonly className: string
  readonly pinnedSubclass?: string | undefined
}

/**
 * MYT-70 §3.2 / MYT-90 A5 — throws `CharacterSheetCoherenceError` when the
 * sheet is mechanically impossible for its (progression, level): a spell above
 * the slot cap, a proficiency bonus that doesn't match the level, or
 * max_hit_points outside the level's HP band. Pure; exported for unit tests.
 * Cantrips (level 0) never need a slot, so a cantrip-only list with 'none'
 * progression passes the spell checks.
 *
 * myth-4jhrk: with `subclassCheck` present, also enforces the SRD-subclass
 * allowlist (invariant 5 in the section header above).
 */
export function validateCoherence(
  sheet: CharacterSheetOutput,
  level: number,
  subclassCheck?: SubclassCheck,
): void {
  const leveledSpells = sheet.spells.filter((s) => s.level > 0)
  if (leveledSpells.length > 0) {
    if (sheet.spellcasting_progression === 'none') {
      throw new CharacterSheetCoherenceError(
        `character-sheet: ${String(leveledSpells.length)} leveled spell(s) present but spellcasting_progression is 'none'`,
      )
    }

    // maxSlotLevel throws a plain Error on an out-of-range level — the loop in
    // runCharacterSheetStage rethrows that (not a coherence retry). Keep this
    // BEFORE the pb/HP checks so that behavior is preserved.
    const cap = maxSlotLevel(sheet.spellcasting_progression, level)
    for (const spell of leveledSpells) {
      if (spell.level > cap) {
        throw new CharacterSheetCoherenceError(
          `character-sheet: spell '${spell.name}' is level ${String(spell.level)} but the highest castable slot level for ${sheet.spellcasting_progression}/L${String(level)} is ${String(cap)}`,
        )
      }
    }
  }

  // Proficiency bonus by level — runs for EVERY sheet (casters and not). Only
  // L1–5 parties ship (migration 033 caps starting_level at 5): 1–4 → +2, 5 → +3.
  const expectedPb = level <= 4 ? 2 : 3
  if (sheet.proficiency_bonus !== expectedPb) {
    throw new CharacterSheetCoherenceError(
      `character-sheet: proficiency_bonus ${String(sheet.proficiency_bonus)} != ${String(expectedPb)} for level ${String(level)}`,
    )
  }

  // HP band from structured fields (hit_die, CON mod, level). Floor = L1 max +
  // the SRD per-level minimum (≥1 HP/level); ceil = max-roll every level plus
  // HP_SLACK_PER_LEVEL for racial HP. max_hit_points outside the band terminal-fails.
  const conMod = Math.floor((sheet.con - 10) / 2)
  const hpFloor = sheet.hit_die + conMod + (level - 1) * Math.max(1, 1 + conMod)
  const hpCeil = level * (sheet.hit_die + conMod) + level * HP_SLACK_PER_LEVEL
  if (sheet.max_hit_points < hpFloor || sheet.max_hit_points > hpCeil) {
    throw new CharacterSheetCoherenceError(
      `character-sheet: max_hit_points ${String(sheet.max_hit_points)} outside [${String(hpFloor)}, ${String(hpCeil)}] for L${String(level)}`,
    )
  }

  if (subclassCheck !== undefined) validateSubclass(sheet, level, subclassCheck)
}

// myth-4jhrk invariant 5. An SRD class at a subclass-granting level must NAME
// its expected subclass — the player's pinned choice when one exists (a
// non-SRD pin is the PLAYER's explicit ask and is honored), else the class's
// single SRD subclass — in at least one feature name or description. The
// prompt instructs the model to carry the name in a feature name ("Divine
// Domain: Life Domain"); descriptions also count so a differently-shaped but
// correct kit doesn't false-fail. A miss means the model built some OTHER
// subclass (the Grave Domain failure) → coherence retry, terminal when the
// budget exhausts.
function validateSubclass(
  sheet: CharacterSheetOutput,
  level: number,
  check: SubclassCheck,
): void {
  const entry = srdSubclassFor(check.className)
  if (entry === null || level < entry.subclassLevel) return

  const expected = check.pinnedSubclass ?? entry.subclass
  const needle = expected.trim().toLowerCase()
  const named = sheet.features.some(
    (f) =>
      f.name.toLowerCase().includes(needle) ||
      f.description.toLowerCase().includes(needle),
  )
  if (!named) {
    throw new CharacterSheetCoherenceError(
      `character-sheet: no feature names the expected subclass '${expected}' for ${check.className} at L${String(level)} (pinned: ${check.pinnedSubclass !== undefined ? 'yes' : 'no'})`,
    )
  }
}

// myth-4jhrk: the prompt's SRD-subclass table, rendered from the SAME const
// the validateCoherence allowlist reads — the prompt and the gate cannot
// drift. "Barbarian — Berserker; Bard — College of Lore; …" (title-cased
// class, canonical subclass).
function renderSrdSubclassTable(): string {
  return SRD_SUBCLASSES.map(
    (e) => `${e.className.charAt(0).toUpperCase()}${e.className.slice(1)} — ${e.subclass}`,
  ).join('; ')
}

function renderPrompt(args: CharacterSheetArgs): string {
  // myth-4jhrk: a pinned subclass (guided pick or concept-derived) renders as
  // a hard constraint line under Class; without one the line collapses to
  // empty and the prompt's SRD-default rule governs.
  const subclassLine =
    args.narrative.subclass !== undefined
      ? `Subclass (FIXED, do not change): ${args.narrative.subclass}`
      : ''
  // Function replacers for the narrative/world fields: each is user/LLM-derived,
  // so a `$&`/`$'`-style sequence must splice in literally rather than being read
  // as a special replacement pattern.
  return PROMPT_TEMPLATE.replace('{{name}}', () => args.narrative.name)
    .replace('{{race}}', () => args.narrative.race)
    .replace('{{class}}', () => args.narrative.class)
    .replace('{{subclassLine}}', () => subclassLine)
    .replace('{{srdSubclassTable}}', () => renderSrdSubclassTable())
    .replace('{{background}}', () => args.narrative.background)
    .replace('{{alignment}}', () => args.narrative.alignment)
    .replace('{{physicalDescription}}', () => args.narrative.physical_description)
    .replace('{{backstory}}', () => args.narrative.backstory)
    .replace('{{tone}}', () => args.worldTone)
    .replace('{{era}}', () => args.worldEra)
    // MYT-90 A4: level is deterministic (campaign.starting_level, injected by
    // the processor) — a number, so `$`-free and safe as a plain string
    // replacement. It appears in multiple places in the template, so replaceAll.
    .replaceAll('{{level}}', String(args.narrative.level))
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
  const level = args.narrative.level
  // Dedupe-merge BEFORE the write (the §3.1 unique indexes are on the
  // normalized name). Skills are not name-indexed in the same way and carry no
  // merge semantics, so they pass through unchanged (the proficiency_level
  // enum is the only mapping). §3.2 ledger init: gold ← starting_gold; hit-dice
  // pool ← level; hit_die / progression ← emitted; slot rows derived from
  // (progression, level), written full (max = remaining).
  const equipment = dedupeMergeEquipment(sheet.equipment)
  const features = dedupeMergeFeatures(sheet.features)
  const spells = dedupeMergeSpells(sheet.spells)
  const slotRows = spellSlotsFor(sheet.spellcasting_progression, level)

  return expectCommitted(
    await repo.transaction(async (tx) =>
      tx.characters.replaceSubTables({
        campaignId: args.campaignId,
        userId: args.userId,
        name: args.narrative.name,
        level,
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
        // §3.2 ledger-init fields.
        startingGold: sheet.starting_gold,
        hitDie: sheet.hit_die,
        hitDiceRemaining: level,
        spellcastingProgression: sheet.spellcasting_progression,
        slotRows: slotRows.map((r) => ({ slotLevel: r.slotLevel, max: r.max })),
        skills: sheet.skills.map((s) => ({
          name: s.name,
          proficiencyLevel: proficiencyLevel(s),
        })),
        // feature_source has no Zod field — populated with the class, the
        // source of nearly every level-1 feature (see file header).
        features: features.map((f) => ({
          name: f.name,
          source: args.narrative.class,
          description: f.description,
          maxUses: f.max_uses,
          recharge: f.recharge,
        })),
        equipment: equipment.map((e) => ({
          name: e.name,
          quantity: e.quantity,
          consumable: e.consumable,
        })),
        spells: spells.map((sp) => ({
          name: sp.name,
          level: sp.level,
          prepared: sp.prepared,
          ritual: sp.ritual,
        })),
      }),
    ),
  )
}
