// The character-sheet view-model (MYT-90): maps the normalized backend sheet into
// the two views the @mythrun/ui reveal renders — the CURATED field-guide view (the
// "Meet your character" front, prose-forward) and the FULL mechanical view the
// curated view hides behind an opt-in. Ability modifiers are computed here in
// deterministic code (the LLM never rolls); the caster spells panel is present on
// the curated view only when the sheet actually has spells.
//
// Platform-independent BRAIN (R1): no React/DOM. The input is already normalized to
// camelCase entries by the api layer (the raw DB-row → entry reshape is not this
// module's job); this module owns the VIEW logic (identity line, tiles, curated /
// full split, caster gating).

import type {
  AbilityAbbrev,
  AbilityTile,
  CuratedSheet,
  FullSheet,
  SheetEntry,
  SheetSkill,
  SheetStat,
} from '../contract/index.ts'

/** The six ability scores (3..20), as the sheet carries them. */
export interface SheetAbilityScores {
  readonly str: number
  readonly dex: number
  readonly con: number
  readonly int: number
  readonly wis: number
  readonly cha: number
}

/** One spell on the sheet — name + slot level (0 = cantrip). */
export interface SheetSpell {
  readonly name: string
  readonly level: number
}

/** The normalized character sheet the reveal is built from. `subclass`, `hitDie`,
 *  and `speed` are optional (a low-level or subclass-less character omits them);
 *  `spells` is empty for a non-caster. */
export interface CharacterSheetSource {
  readonly name: string
  readonly level: number
  readonly species: string
  readonly class: string
  readonly subclass?: string
  readonly background: string
  readonly abilities: SheetAbilityScores
  readonly armorClass: number
  readonly hitPoints: number
  readonly maxHitPoints: number
  readonly proficiencyBonus: number
  readonly hitDie?: number
  readonly speed?: number
  readonly prose: readonly string[]
  readonly features: readonly SheetEntry[]
  readonly equipment: readonly SheetEntry[]
  readonly spells: readonly SheetSpell[]
  readonly skills: readonly SheetSkill[]
  readonly savingThrows: readonly string[]
}

const ABILITY_TILES: readonly [AbilityAbbrev, keyof SheetAbilityScores][] = [
  ['STR', 'str'],
  ['DEX', 'dex'],
  ['CON', 'con'],
  ['INT', 'int'],
  ['WIS', 'wis'],
  ['CHA', 'cha'],
]

/** D&D 5e ability modifier: `floor((score - 10) / 2)`. */
function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2)
}

function buildAbilityTiles(abilities: SheetAbilityScores): AbilityTile[] {
  return ABILITY_TILES.map(([abbrev, key]) => {
    const score = abilities[key]
    return { abbrev, score, modifier: abilityModifier(score) }
  })
}

/** "Level N · <species> <class> · <subclass> · <background>" — the subclass segment
 *  drops out when the character has no subclass. */
function buildIdentityLine(source: CharacterSheetSource): string {
  const segments = [`Level ${String(source.level)}`, `${source.species} ${source.class}`]
  if (source.subclass !== undefined) segments.push(source.subclass)
  segments.push(source.background)
  return segments.join(' · ')
}

/** The AC / HP / Proficiency stripe, with Hit Die + Speed appended when present. */
function buildStats(source: CharacterSheetSource): SheetStat[] {
  const stats: SheetStat[] = [
    { label: 'AC', value: String(source.armorClass) },
    { label: 'HP', value: `${String(source.hitPoints)} / ${String(source.maxHitPoints)}` },
    { label: 'Proficiency', value: `+${String(source.proficiencyBonus)}` },
  ]
  if (source.hitDie !== undefined) stats.push({ label: 'Hit Die', value: `d${String(source.hitDie)}` })
  if (source.speed !== undefined) stats.push({ label: 'Speed', value: `${String(source.speed)} ft` })
  return stats
}

function toSpellEntry(spell: SheetSpell): SheetEntry {
  return { name: spell.name, gloss: spell.level === 0 ? 'Cantrip' : `Level ${String(spell.level)}` }
}

function buildCurated(source: CharacterSheetSource): CuratedSheet {
  const base: CuratedSheet = {
    name: source.name,
    identityLine: buildIdentityLine(source),
    stats: buildStats(source),
    abilities: buildAbilityTiles(source.abilities),
    prose: [...source.prose],
    features: [...source.features],
    equipment: [...source.equipment],
  }
  // Caster-only: the curated spells panel appears only when the sheet has spells.
  return source.spells.length > 0 ? { ...base, spells: source.spells.map(toSpellEntry) } : base
}

function buildFull(source: CharacterSheetSource): FullSheet {
  return {
    skills: [...source.skills],
    savingThrows: [...source.savingThrows],
    equipment: [...source.equipment],
    spells: source.spells.map(toSpellEntry),
  }
}

/** Map the normalized sheet into the curated field-guide view + the full mechanical
 *  view the @mythrun/ui reveal renders. */
export function sheetViewModel(sheet: CharacterSheetSource): { curated: CuratedSheet; full: FullSheet } {
  return { curated: buildCurated(sheet), full: buildFull(sheet) }
}
