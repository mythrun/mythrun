// Repo for entity_hierarchy table (migration 001 lines 170–175).
// UNIQUE(child_entity_id) — at most one parent per entity. The caller
// (stage 4's straggler insert) pre-filters against existing rows; this
// repo does NOT do ON CONFLICT (design §D9 — caller controls collision
// policy, here it's "stage 3 wins").

import type { ClientLike } from './_types.js'
import { uuidv7 } from './uuidv7.js'

export interface InsertHierarchyInput {
  readonly parentEntityId: string
  readonly childEntityId: string
}

export interface EntityHierarchyRow {
  readonly id: string
  readonly parentEntityId: string
  readonly childEntityId: string
}

interface EntityHierarchyDbRow {
  readonly id: string
  readonly parent_entity_id: string
  readonly child_entity_id: string
}

function toEntityHierarchyRow(r: EntityHierarchyDbRow): EntityHierarchyRow {
  return {
    id: r.id,
    parentEntityId: r.parent_entity_id,
    childEntityId: r.child_entity_id,
  }
}

/** Composable binder over a single ClientLike. Holds the canonical SQL so
 *  `repo.entityHierarchy.X` and `tx.entityHierarchy.X` share one body. */
export function entityHierarchyNs(c: ClientLike) {
  return {
    insert: async (input: InsertHierarchyInput): Promise<void> => {
      await c.query(
        `INSERT INTO entity_hierarchy (id, parent_entity_id, child_entity_id) VALUES ($1, $2, $3)`,
        [uuidv7(), input.parentEntityId, input.childEntityId],
      )
    },
    /**
     * stage-4 (entity_relationships) straggler pre-filter. Returns the subset
     * of `childIds` that already have a hierarchy row whose child belongs to
     * `worldId` — design §D9 "stage 3 wins" on collisions. SQL verbatim from
     * `stages/entity-relationships.ts` `persistStragglers`; runs inside the
     * stage's transaction so it sees the same-tx writes.
     */
    listExistingChildIds: async (
      childIds: readonly string[],
      worldId: string,
    ): Promise<readonly string[]> => {
      const result = await c.query<{ child_entity_id: string }>(
        `SELECT child_entity_id FROM entity_hierarchy
           WHERE child_entity_id = ANY($1::uuid[])
             AND child_entity_id IN (SELECT id FROM entities WHERE world_id = $2)`,
        [childIds, worldId],
      )
      return result.rows.map((r) => r.child_entity_id)
    },
    // myth-exac T06: snapshot-view primary read path. Hierarchy is scoped
    // to a world via JOIN to entities (the table has no world_id column).
    // Filters on the parent's world; child must be in the same world by
    // the design's invariants, so the parent-side filter is sufficient.
    listForWorld: async (worldId: string): Promise<readonly EntityHierarchyRow[]> => {
      const result = await c.query<EntityHierarchyDbRow>(
        `SELECT eh.id, eh.parent_entity_id, eh.child_entity_id
       FROM entity_hierarchy eh
       JOIN entities pe ON pe.id = eh.parent_entity_id
      WHERE pe.world_id = $1
      ORDER BY eh.id`,
        [worldId],
      )
      return result.rows.map(toEntityHierarchyRow)
    },
  }
}

/** Back-compat shim: explicit-client const-object surface that delegates to the
 *  canonical `entityHierarchyNs` binder. Direct importers
 *  (`entityHierarchy.insert(client, input)`) keep working; new code goes
 *  through `repo.entityHierarchy`. */
export const entityHierarchy = {
  insert: (client: ClientLike, input: InsertHierarchyInput): Promise<void> =>
    entityHierarchyNs(client).insert(input),
  listForWorld: (client: ClientLike, worldId: string): Promise<readonly EntityHierarchyRow[]> =>
    entityHierarchyNs(client).listForWorld(worldId),
} as const
