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

async function insert(client: ClientLike, input: InsertHierarchyInput): Promise<void> {
  await client.query(
    `INSERT INTO entity_hierarchy (id, parent_entity_id, child_entity_id) VALUES ($1, $2, $3)`,
    [uuidv7(), input.parentEntityId, input.childEntityId],
  )
}

// myth-exac T06: snapshot-view primary read path. Hierarchy is scoped
// to a world via JOIN to entities (the table has no world_id column).
// Filters on the parent's world; child must be in the same world by
// the design's invariants, so the parent-side filter is sufficient.
async function listForWorld(
  client: ClientLike,
  worldId: string,
): Promise<readonly EntityHierarchyRow[]> {
  const result = await client.query<EntityHierarchyDbRow>(
    `SELECT eh.id, eh.parent_entity_id, eh.child_entity_id
       FROM entity_hierarchy eh
       JOIN entities pe ON pe.id = eh.parent_entity_id
      WHERE pe.world_id = $1
      ORDER BY eh.id`,
    [worldId],
  )
  return result.rows.map(toEntityHierarchyRow)
}

export const entityHierarchy = { insert, listForWorld } as const

/** Composable binder over a single ClientLike. Delegates to the bare-named
 *  `entityHierarchy` object so `repo.entityHierarchy.X` and
 *  `tx.entityHierarchy.X` share one body. */
export function entityHierarchyNs(c: ClientLike) {
  return {
    insert: (input: InsertHierarchyInput): Promise<void> => entityHierarchy.insert(c, input),
    listForWorld: (worldId: string): Promise<readonly EntityHierarchyRow[]> =>
      entityHierarchy.listForWorld(c, worldId),
  }
}
