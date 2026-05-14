// Repo for the `entities` table (migration 001 lines 114–123). Bare-named
// exports — every caller already holds a PoolClient via the stage's
// transaction (mirrors `stripe-events.ts`, not `worlds.ts`).
//
// entity_type is constrained by the table's CHECK to ('npc', 'location',
// 'faction', 'item'). Regions are persisted as type='location' per the
// pipeline spec §3 (no separate 'region' enum value).

import type { ClientLike } from './_types.js'

export type EntityType = 'npc' | 'location' | 'faction' | 'item'

export interface InsertEntityInput {
  readonly id: string
  readonly worldId: string
  readonly entityType: EntityType
  readonly name: string
}

export interface Entity {
  readonly id: string
  readonly worldId: string
  readonly entityType: EntityType
  readonly name: string
}

interface EntityRow {
  readonly id: string
  readonly world_id: string
  readonly entity_type: EntityType
  readonly name: string
}

function toEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    worldId: row.world_id,
    entityType: row.entity_type,
    name: row.name,
  }
}

async function insert(client: ClientLike, input: InsertEntityInput): Promise<Entity> {
  await client.query(
    `INSERT INTO entities (id, world_id, entity_type, name)
     VALUES ($1, $2, $3, $4)`,
    [input.id, input.worldId, input.entityType, input.name],
  )
  return {
    id: input.id,
    worldId: input.worldId,
    entityType: input.entityType,
    name: input.name,
  }
}

async function findByWorldAndName(
  client: ClientLike,
  worldId: string,
  name: string,
): Promise<Entity | null> {
  const result = await client.query<EntityRow>(
    `SELECT id, world_id, entity_type, name
       FROM entities WHERE world_id = $1 AND name = $2 LIMIT 1`,
    [worldId, name],
  )
  return result.rows[0] ? toEntity(result.rows[0]) : null
}

async function listByWorld(client: ClientLike, worldId: string): Promise<Entity[]> {
  const result = await client.query<EntityRow>(
    `SELECT id, world_id, entity_type, name FROM entities WHERE world_id = $1`,
    [worldId],
  )
  return result.rows.map(toEntity)
}

export const entities = { insert, findByWorldAndName, listByWorld } as const
