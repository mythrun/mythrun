// backend/src/repo/srd.ts
//
// myth-5nb — repo for the SRD reference tables (migration 003: srd_monsters,
// srd_spells, srd_conditions). Backend Core spec §5.2: `getMonster`, `getSpell`,
// `getCondition`, `searchMonsters`, `searchSpells`.
//
// READ-ONLY BY DESIGN, for now. The tables are populated by the SRD content
// loader, which is not built yet — and the loader's write strategy (idempotent
// UPSERT vs truncate-and-reload) is what decides whether this namespace needs a
// write primitive at all, and of which shape. Rather than guess, the write
// surface stays deferred to that ticket; these five reads are the part the spec
// pins and no consumer can disagree with.
//
// SHAPES: the JSONB columns (`speed`, `skills`, `senses`, `actions`, `data`, …)
// are typed `unknown`. Nothing in-tree pins their shape — the loader has not
// run, so there is no data to pin against — and `unknown` forces a consumer to
// validate at its own boundary instead of inheriting a shape invented here.
//
// SEARCH: a plain case-insensitive SUBSTRING test via `strpos`, NOT
// `ILIKE '%'||$1||'%'`. A caller's `%`/`_` would be a wildcard under ILIKE (a
// bare `%` matching the entire table); under strpos it is literal text. The
// tables are reference-sized (the SRD is a few hundred rows) so a sequential
// scan is the right plan and there is no index to defeat. Results are bounded
// by a default limit so a broad query can never return an unbounded page.
// `ORDER BY name` sorts under the database collation — stable per deployment,
// but NOT byte order (a locale-aware collation ranks "Fireball" before "Fire
// Bolt"). Callers that need a specific order must sort client-side.

import type { ClientLike } from './_types.js'

/** Default result cap for the `search*` reads. Reference-data browsing, not
 *  pagination: a caller that wants more passes an explicit limit. */
const DEFAULT_SEARCH_LIMIT = 50

export interface SrdMonsterRow {
  readonly id: string
  readonly name: string
  readonly size: string
  readonly type: string
  readonly alignment: string | null
  readonly ac: number
  readonly acType: string | null
  readonly hp: number
  readonly hitDice: string
  readonly speed: unknown
  readonly str: number
  readonly dex: number
  readonly con: number
  readonly int: number
  readonly wis: number
  readonly cha: number
  readonly savingThrows: unknown
  readonly skills: unknown
  readonly damageResistances: readonly string[] | null
  readonly damageImmunities: readonly string[] | null
  readonly damageVulnerabilities: readonly string[] | null
  readonly conditionImmunities: readonly string[] | null
  readonly senses: unknown
  readonly languages: readonly string[] | null
  readonly cr: string
  readonly xp: number
  readonly specialAbilities: unknown
  readonly actions: unknown
  readonly legendaryActions: unknown
  readonly reactions: unknown
  readonly data: unknown
}

export interface SrdSpellRow {
  readonly id: string
  readonly name: string
  readonly level: number
  readonly school: string
  readonly castingTime: string
  readonly range: string
  readonly components: string
  readonly duration: string
  readonly concentration: boolean
  readonly description: string
  readonly higherLevels: string | null
  readonly damage: unknown
  readonly areaOfEffect: unknown
  readonly save: unknown
  readonly classes: readonly string[] | null
  readonly data: unknown
}

export interface SrdConditionRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly mechanicalEffects: unknown
}

interface SrdMonsterDbRow {
  readonly id: string
  readonly name: string
  readonly size: string
  readonly type: string
  readonly alignment: string | null
  readonly ac: number
  readonly ac_type: string | null
  readonly hp: number
  readonly hit_dice: string
  readonly speed: unknown
  readonly str: number
  readonly dex: number
  readonly con: number
  readonly int: number
  readonly wis: number
  readonly cha: number
  readonly saving_throws: unknown
  readonly skills: unknown
  readonly damage_resistances: readonly string[] | null
  readonly damage_immunities: readonly string[] | null
  readonly damage_vulnerabilities: readonly string[] | null
  readonly condition_immunities: readonly string[] | null
  readonly senses: unknown
  readonly languages: readonly string[] | null
  readonly cr: string
  readonly xp: number
  readonly special_abilities: unknown
  readonly actions: unknown
  readonly legendary_actions: unknown
  readonly reactions: unknown
  readonly data: unknown
}

interface SrdSpellDbRow {
  readonly id: string
  readonly name: string
  readonly level: number
  readonly school: string
  readonly casting_time: string
  readonly range: string
  readonly components: string
  readonly duration: string
  readonly concentration: boolean
  readonly description: string
  readonly higher_levels: string | null
  readonly damage: unknown
  readonly area_of_effect: unknown
  readonly save: unknown
  readonly classes: readonly string[] | null
  readonly data: unknown
}

interface SrdConditionDbRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly mechanical_effects: unknown
}

function toMonster(r: SrdMonsterDbRow): SrdMonsterRow {
  return {
    id: r.id,
    name: r.name,
    size: r.size,
    type: r.type,
    alignment: r.alignment,
    ac: r.ac,
    acType: r.ac_type,
    hp: r.hp,
    hitDice: r.hit_dice,
    speed: r.speed,
    str: r.str,
    dex: r.dex,
    con: r.con,
    int: r.int,
    wis: r.wis,
    cha: r.cha,
    savingThrows: r.saving_throws,
    skills: r.skills,
    damageResistances: r.damage_resistances,
    damageImmunities: r.damage_immunities,
    damageVulnerabilities: r.damage_vulnerabilities,
    conditionImmunities: r.condition_immunities,
    senses: r.senses,
    languages: r.languages,
    cr: r.cr,
    xp: r.xp,
    specialAbilities: r.special_abilities,
    actions: r.actions,
    legendaryActions: r.legendary_actions,
    reactions: r.reactions,
    data: r.data,
  }
}

function toSpell(r: SrdSpellDbRow): SrdSpellRow {
  return {
    id: r.id,
    name: r.name,
    level: r.level,
    school: r.school,
    castingTime: r.casting_time,
    range: r.range,
    components: r.components,
    duration: r.duration,
    concentration: r.concentration,
    description: r.description,
    higherLevels: r.higher_levels,
    damage: r.damage,
    areaOfEffect: r.area_of_effect,
    save: r.save,
    classes: r.classes,
    data: r.data,
  }
}

function toCondition(r: SrdConditionDbRow): SrdConditionRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    mechanicalEffects: r.mechanical_effects,
  }
}

const MONSTER_COLUMNS = `id, name, size, type, alignment, ac, ac_type, hp, hit_dice, speed,
                         str, dex, con, int, wis, cha, saving_throws, skills,
                         damage_resistances, damage_immunities, damage_vulnerabilities,
                         condition_immunities, senses, languages, cr, xp,
                         special_abilities, actions, legendary_actions, reactions, data`

const SPELL_COLUMNS = `id, name, level, school, casting_time, range, components, duration,
                       concentration, description, higher_levels, damage, area_of_effect,
                       save, classes, data`

/** Composable binder over a single ClientLike. Reference data is immutable
 *  during play, so these bind identically on the pool and tx surfaces. */
export function srdNs(c: ClientLike) {
  return {
    getMonster: async (id: string): Promise<SrdMonsterRow | null> => {
      const { rows } = await c.query<SrdMonsterDbRow>(
        `SELECT ${MONSTER_COLUMNS} FROM srd_monsters WHERE id = $1`,
        [id],
      )
      const r = rows[0]
      return r ? toMonster(r) : null
    },

    getSpell: async (id: string): Promise<SrdSpellRow | null> => {
      const { rows } = await c.query<SrdSpellDbRow>(
        `SELECT ${SPELL_COLUMNS} FROM srd_spells WHERE id = $1`,
        [id],
      )
      const r = rows[0]
      return r ? toSpell(r) : null
    },

    getCondition: async (id: string): Promise<SrdConditionRow | null> => {
      const { rows } = await c.query<SrdConditionDbRow>(
        `SELECT id, name, description, mechanical_effects FROM srd_conditions WHERE id = $1`,
        [id],
      )
      const r = rows[0]
      return r ? toCondition(r) : null
    },

    /** Case-insensitive name SUBSTRING match (see the SEARCH note in the
     *  header). Ordered by name so results are stable across calls. */
    searchMonsters: async (
      query: string,
      limit: number = DEFAULT_SEARCH_LIMIT,
    ): Promise<readonly SrdMonsterRow[]> => {
      const { rows } = await c.query<SrdMonsterDbRow>(
        `SELECT ${MONSTER_COLUMNS} FROM srd_monsters
          WHERE strpos(lower(name), lower($1)) > 0
          ORDER BY name
          LIMIT $2`,
        [query, limit],
      )
      return rows.map(toMonster)
    },

    searchSpells: async (
      query: string,
      limit: number = DEFAULT_SEARCH_LIMIT,
    ): Promise<readonly SrdSpellRow[]> => {
      const { rows } = await c.query<SrdSpellDbRow>(
        `SELECT ${SPELL_COLUMNS} FROM srd_spells
          WHERE strpos(lower(name), lower($1)) > 0
          ORDER BY name
          LIMIT $2`,
        [query, limit],
      )
      return rows.map(toSpell)
    },
  }
}
