// Repo for the `entities` table (migration 001 lines 114–123, extended by
// migration 014). Bare-named exports — every caller already holds a
// PoolClient via the stage's transaction (mirrors `stripe-events.ts`,
// not `worlds.ts`).
//
// entity_type is constrained by the table's CHECK to ('npc', 'location',
// 'faction', 'item'). Regions are persisted as type='location' per the
// pipeline spec §3 (no separate 'region' enum value).
//
// myth-exac: access_level is now a required column on entities (migration
// 014). The LLM emits the tier per entity in stages 2/3; the persister
// stamps it at INSERT time. listByWorld accepts an optional access-level
// filter so snapshot reads can narrow to {known} for Fast Thinker or
// {known, discoverable, secret} for Slow Thinker / prep stages.

import type { ClientLike } from './_types.js'
import type { AccessLevel } from './facts.js'

export type EntityType = 'npc' | 'location' | 'faction' | 'item'

export interface InsertEntityInput {
  readonly id: string
  readonly worldId: string
  readonly entityType: EntityType
  readonly name: string
  // myth-exac: required at insert. The LLM emits this per entity in
  // the world-and-factions / locations-and-npcs stages; the persister
  // passes it straight through.
  readonly accessLevel: AccessLevel
  readonly statBlockId?: string | null
  /** Provenance marker. Format: 'stage:<stage_name>' for world-gen-
   *  created entities; 'session:<uuid>' for Scribe-created entities
   *  during play. */
  readonly createdIn: string
}

export interface Entity {
  readonly id: string
  readonly worldId: string
  readonly entityType: EntityType
  readonly name: string
  readonly accessLevel: AccessLevel
}

interface EntityRow {
  readonly id: string
  readonly world_id: string
  readonly entity_type: EntityType
  readonly name: string
  readonly access_level: AccessLevel
}

function toEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    worldId: row.world_id,
    entityType: row.entity_type,
    name: row.name,
    accessLevel: row.access_level,
  }
}

/** Composable binder: captures `c` (pool OR in-flight tx client) and holds the
 *  canonical SQL so `repo.entities.X` and `tx.entities.X` share one
 *  implementation. Mirrors the worlds.ts `worldsNs` pattern. */
export function entitiesNs(c: ClientLike) {
  return {
    insert: async (input: InsertEntityInput): Promise<void> => {
      await c.query(
        `INSERT INTO entities (id, world_id, entity_type, name, access_level, stat_block_id, created_in)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.id,
          input.worldId,
          input.entityType,
          input.name,
          input.accessLevel,
          input.statBlockId ?? null,
          input.createdIn,
        ],
      )
    },
    findByWorldAndName: async (worldId: string, name: string): Promise<Entity | null> => {
      const result = await c.query<EntityRow>(
        `SELECT id, world_id, entity_type, name, access_level
       FROM entities WHERE world_id = $1 AND name = $2 LIMIT 1`,
        [worldId, name],
      )
      return result.rows[0] ? toEntity(result.rows[0]) : null
    },
    listByWorld: async (
      worldId: string,
      opts?: { readonly accessLevels?: readonly AccessLevel[] },
    ): Promise<Entity[]> => {
      const accessLevels = opts?.accessLevels
      if (accessLevels) {
        const result = await c.query<EntityRow>(
          `SELECT id, world_id, entity_type, name, access_level
         FROM entities WHERE world_id = $1 AND access_level = ANY($2)`,
          [worldId, accessLevels],
        )
        return result.rows.map(toEntity)
      }
      const result = await c.query<EntityRow>(
        `SELECT id, world_id, entity_type, name, access_level
       FROM entities WHERE world_id = $1`,
        [worldId],
      )
      return result.rows.map(toEntity)
    },
  }
}

/** Back-compat shim: explicit-client const-object surface that delegates to the
 *  canonical `entitiesNs` binder. Direct importers (`entities.insert(client,
 *  input)`) keep working; new code goes through `repo.entities`. */
export const entities = {
  insert: (client: ClientLike, input: InsertEntityInput): Promise<void> =>
    entitiesNs(client).insert(input),
  findByWorldAndName: (client: ClientLike, worldId: string, name: string): Promise<Entity | null> =>
    entitiesNs(client).findByWorldAndName(worldId, name),
  listByWorld: (
    client: ClientLike,
    worldId: string,
    opts?: { readonly accessLevels?: readonly AccessLevel[] },
  ): Promise<Entity[]> => entitiesNs(client).listByWorld(worldId, opts),
} as const
