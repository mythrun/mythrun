// backend/src/repo/stat-blocks.ts
//
// myth-exac: new repo module for the snapshot endpoint's statBlocks
// projection. Existing entities reference stat_blocks via stat_block_id
// (nullable). The snapshot endpoint reads only the stat blocks
// referenced by the known-tier entities it returns.

import type { ClientLike } from './_types.js'

export interface StatBlockRow {
  readonly id: string
  readonly name: string
  readonly cr: string | null
  readonly armorClass: number
  readonly hitPoints: number
  readonly hitDice: string | null
  readonly speed: string
  readonly str: number
  readonly dex: number
  readonly con: number
  readonly int: number
  readonly wis: number
  readonly cha: number
  readonly skills: string | null
  readonly senses: string | null
  readonly languages: string | null
  readonly createdAt: Date
}

interface StatBlockDbRow {
  readonly id: string
  readonly name: string
  readonly cr: string | null
  readonly armor_class: number
  readonly hit_points: number
  readonly hit_dice: string | null
  readonly speed: string
  readonly str: number
  readonly dex: number
  readonly con: number
  readonly int: number
  readonly wis: number
  readonly cha: number
  readonly skills: string | null
  readonly senses: string | null
  readonly languages: string | null
  readonly created_at: Date
}

function toStatBlockRow(r: StatBlockDbRow): StatBlockRow {
  return {
    id: r.id,
    name: r.name,
    cr: r.cr,
    armorClass: r.armor_class,
    hitPoints: r.hit_points,
    hitDice: r.hit_dice,
    speed: r.speed,
    str: r.str,
    dex: r.dex,
    con: r.con,
    int: r.int,
    wis: r.wis,
    cha: r.cha,
    skills: r.skills,
    senses: r.senses,
    languages: r.languages,
    createdAt: r.created_at,
  }
}

// myth-exac: snapshot-view read path. Returns stat blocks for the given
// IDs. Empty IDs list short-circuits to [] without a DB round-trip
// (covers the snapshot's "no known-tier entities reference stat blocks"
// case).
async function listByIds(
  client: ClientLike,
  ids: readonly string[],
): Promise<readonly StatBlockRow[]> {
  if (ids.length === 0) return []
  const result = await client.query<StatBlockDbRow>(
    `SELECT id, name, cr, armor_class, hit_points, hit_dice, speed,
            str, dex, con, int, wis, cha, skills, senses, languages,
            created_at
       FROM stat_blocks
      WHERE id = ANY($1)
      ORDER BY id`,
    [ids],
  )
  return result.rows.map(toStatBlockRow)
}

export const statBlocks = { listByIds } as const
