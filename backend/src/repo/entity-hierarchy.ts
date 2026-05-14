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

async function insert(client: ClientLike, input: InsertHierarchyInput): Promise<void> {
  await client.query(
    `INSERT INTO entity_hierarchy (id, parent_entity_id, child_entity_id) VALUES ($1, $2, $3)`,
    [uuidv7(), input.parentEntityId, input.childEntityId],
  )
}

export const entityHierarchy = { insert } as const
