import {
  sheetViewModel,
  type CharacterSheetSource,
  type SheetSpell,
} from '@mythrun/client-core/character'
import { CLASSES, CLASS_SAVES, type Ability, type ClassName } from '@mythrun/client-core/srd'
import type { CharacterFull } from '@mythrun/client-core'
import type { CuratedSheet, FullSheet, SheetEntry, SheetSkill } from '@mythrun/client-core/contract'

// The RAW getCharacter → reveal view-model adapter (MYT-90 D6). `getCharacter`
// returns the backend `characters` row plus its four sub-tables VERBATIM
// (snake_case); this module reshapes that into the DOM-free CharacterSheetSource the
// committed B4 `sheetViewModel` folds into the reveal's `{ curated, full }` views.
//
// Every derivation is deterministic math over STRUCTURED fields + SRD maps — never a
// parse of LLM prose (ZFC): ability modifiers by formula, saving throws via
// CLASS_SAVES, a default speed, and a graceful subclass-omit.
//   • subclass — the `characters` row has no structured subclass column, and
//     splitting it out of the free `class` string / feature names is exactly the
//     pattern-match ZFC forbids, so it is always omitted (the identity line degrades
//     gracefully).
//   • prose — MYT-90: the reveal's prose panel is fed by the character CONCEPT
//     narrative (`raw.concept`), NOT the persisted `characters` row. The adapter
//     ASSEMBLES the concept's own already-authored prose fields (physical
//     description + the personality sentences + the player's situation-grounding
//     text) into 1–2 paragraphs — it never generates or parses prose (ZFC). The
//     panel degrades to empty when the character has no concept narrative.

/** The reveal defaults Speed to 30 ft: the backend does not return a speed, and a
 *  species-specific speed is a documented later refinement (30 is the common case). */
const DEFAULT_SPEED = 30

type RawCharacter = CharacterFull['character']

/** The six ability ids in canonical sheet order (STR…CHA). */
const ABILITY_ORDER: readonly Ability[] = ['str', 'dex', 'con', 'int', 'wis', 'cha']

/** Full display labels for the saving-throw lines. */
const ABILITY_LABEL: Record<Ability, string> = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
}

/** D&D 5e ability modifier: floor((score − 10) / 2). Deterministic; the LLM never rolls. */
function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2)
}

/** A signed modifier with the typographic minus, matching the reveal's ability tiles. */
function signed(value: number): string {
  return value >= 0 ? `+${String(value)}` : `−${String(Math.abs(value))}`
}

/** Resolve the free backend `class` string to a canonical SRD class id for the
 *  CLASS_SAVES lookup — an EXACT, case-insensitive membership check against the
 *  closed 12-class set (schema-style validation, not a heuristic prose parse). An
 *  unrecognized class (e.g. a freeform "Fighter (Champion)") resolves to undefined,
 *  and its saves fall back to the bare ability modifiers (graceful, ZFC-safe). */
function resolveClassName(raw: string): ClassName | undefined {
  const normalized = raw.trim().toLowerCase()
  return (CLASSES as readonly string[]).includes(normalized) ? (normalized as ClassName) : undefined
}

/** One backend skill row → the sheet's proficiency flags. `expertise` (double
 *  proficiency) implies `proficient`; everything else is a plain flag. */
function toSheetSkill(row: CharacterFull['skills'][number]): SheetSkill {
  const level = row.proficiency_level
  return {
    name: row.skill_name,
    proficient: level === 'proficient' || level === 'expertise',
    expertise: level === 'expertise',
  }
}

/** One backend feature row → a curated entry. `feature_source` is dropped — it is the
 *  class name, already carried by the identity line. */
function toSheetFeature(row: CharacterFull['features'][number]): SheetEntry {
  return { name: row.feature_name, gloss: row.description }
}

/** One backend equipment row → a curated entry. A stack (`quantity > 1`) glosses its
 *  count; the `equipped` flag is state, not shown (the brand carries state as data,
 *  never a badge/chip). */
function toSheetEquipment(row: CharacterFull['equipment'][number]): SheetEntry {
  return row.quantity > 1
    ? { name: row.item_name, gloss: `×${String(row.quantity)}` }
    : { name: row.item_name }
}

/** One backend spell row → the sheet spell (name + slot level; the slot gloss is
 *  derived downstream by `sheetViewModel`, and `prepared` is not surfaced). */
function toSheetSpell(row: CharacterFull['spells'][number]): SheetSpell {
  return { name: row.spell_name, level: row.spell_level }
}

/** Compose the reveal's prose panel from the character-concept narrative
 *  (MYT-90). ASSEMBLY, not generation (ZFC): every string is a prose field the
 *  concept stage already authored — the physical description as one paragraph,
 *  and a connection paragraph woven from the personality sentences
 *  (trait/ideal/bond/flaw, in canonical order) followed by the player's
 *  situation-grounding text ("connection to the opening"). Blank fields are
 *  dropped so an unpopulated concept degrades to a shorter panel (or none). */
function buildConceptProse(concept: CharacterFull['concept']): string[] {
  if (concept === undefined) return []
  const paragraphs: string[] = []

  const physical = concept.physical_description?.trim() ?? ''
  if (physical.length > 0) paragraphs.push(physical)

  const connection = [
    ...concept.personality_traits,
    ...concept.ideals,
    ...concept.bonds,
    ...concept.flaws,
    concept.situation_grounding_text,
  ]
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
    .join(' ')
  if (connection.length > 0) paragraphs.push(connection)

  return paragraphs
}

/** All six saving throws as "<Ability> <signed total>" — the total adds the
 *  proficiency bonus on exactly the class's two proficient saves (CLASS_SAVES). */
function buildSavingThrows(character: RawCharacter, className: ClassName | undefined): string[] {
  const proficient: readonly Ability[] = className !== undefined ? CLASS_SAVES[className] : []
  return ABILITY_ORDER.map((ability) => {
    const modifier = abilityModifier(character[ability])
    const total = modifier + (proficient.includes(ability) ? character.proficiency_bonus : 0)
    return `${ABILITY_LABEL[ability]} ${signed(total)}`
  })
}

/** Reshape the RAW getCharacter response into the DOM-free source the committed B4
 *  `sheetViewModel` folds into the reveal. `subclass` + `prose` are intentionally
 *  omitted (see the module header). */
export function toCharacterSheetSource(raw: CharacterFull): CharacterSheetSource {
  const c = raw.character
  return {
    name: c.name,
    level: c.level,
    species: c.species,
    class: c.class,
    background: c.background,
    abilities: { str: c.str, dex: c.dex, con: c.con, int: c.int, wis: c.wis, cha: c.cha },
    armorClass: c.armor_class,
    hitPoints: c.hit_points,
    maxHitPoints: c.max_hit_points,
    proficiencyBonus: c.proficiency_bonus,
    hitDie: c.hit_die,
    speed: DEFAULT_SPEED,
    prose: buildConceptProse(raw.concept),
    features: raw.features.map(toSheetFeature),
    equipment: raw.equipment.map(toSheetEquipment),
    spells: raw.spells.map(toSheetSpell),
    skills: raw.skills.map(toSheetSkill),
    savingThrows: buildSavingThrows(c, resolveClassName(c.class)),
  }
}

/** RAW getCharacter → the reveal's `{ curated, full }` view-model. */
export function toRevealViewModel(raw: CharacterFull): { curated: CuratedSheet; full: FullSheet } {
  return sheetViewModel(toCharacterSheetSource(raw))
}
