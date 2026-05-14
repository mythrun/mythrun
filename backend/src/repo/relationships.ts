// backend/src/repo/relationships.ts
//
// Repo for the relationships table (migration 001 lines 161–168). No
// UNIQUE constraint on (source, target, type) by schema — stage 4's
// retry idempotency is enforced by calling deleteByWorld at stage
// start (design §D9).

import type { ClientLike } from './_types.js'
import { uuidv7 } from './uuidv7.js'

export interface InsertRelationshipInput {
  readonly sourceEntityId: string
  readonly targetEntityId: string
  readonly relationshipType: string
  readonly description: string
}

export interface Relationship {
  readonly id: string
  readonly sourceEntityId: string
  readonly targetEntityId: string
  readonly relationshipType: string
  readonly description: string
}

interface RelationshipRow {
  readonly id: string
  readonly source_entity_id: string
  readonly target_entity_id: string
  readonly relationship_type: string
  readonly description: string
}

function toRelationship(row: RelationshipRow): Relationship {
  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relationshipType: row.relationship_type,
    description: row.description,
  }
}

async function insertMany(client: ClientLike, rows: readonly InsertRelationshipInput[]): Promise<void> {
  if (rows.length === 0) return
  const values: string[] = []
  const params: unknown[] = []
  let p = 1
  for (const row of rows) {
    values.push(`($${String(p++)}, $${String(p++)}, $${String(p++)}, $${String(p++)}, $${String(p++)})`)
    params.push(uuidv7(), row.sourceEntityId, row.targetEntityId, row.relationshipType, row.description)
  }
  await client.query(
    `INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description)
     VALUES ${values.join(', ')}`,
    params,
  )
}

async function listByWorld(client: ClientLike, worldId: string): Promise<Relationship[]> {
  const result = await client.query<RelationshipRow>(
    `SELECT r.id, r.source_entity_id, r.target_entity_id, r.relationship_type, r.description
       FROM relationships r
       JOIN entities e ON e.id = r.source_entity_id
       WHERE e.world_id = $1`,
    [worldId],
  )
  return result.rows.map(toRelationship)
}

async function deleteByWorld(client: ClientLike, worldId: string): Promise<void> {
  await client.query(
    `DELETE FROM relationships
       WHERE source_entity_id IN (SELECT id FROM entities WHERE world_id = $1)`,
    [worldId],
  )
}

async function updateById(
  client: ClientLike,
  id: string,
  patch: { relationshipType?: string; description?: string },
): Promise<number> {
  const sets: string[] = []
  const params: unknown[] = []
  let p = 1
  if (patch.relationshipType !== undefined) {
    sets.push(`relationship_type = $${String(p++)}`)
    params.push(patch.relationshipType)
  }
  if (patch.description !== undefined) {
    sets.push(`description = $${String(p++)}`)
    params.push(patch.description)
  }
  if (sets.length === 0) return 0
  params.push(id)
  const result = await client.query(
    `UPDATE relationships SET ${sets.join(', ')} WHERE id = $${String(p)}`,
    params,
  )
  /* c8 ignore next — `?? 0` falsy arm: pg always returns a numeric rowCount on UPDATE. */
  return result.rowCount ?? 0
}

async function deleteById(client: ClientLike, id: string): Promise<number> {
  const result = await client.query(`DELETE FROM relationships WHERE id = $1`, [id])
  /* c8 ignore next — `?? 0` falsy arm: pg always returns a numeric rowCount on DELETE. */
  return result.rowCount ?? 0
}

export const relationships = {
  insertMany, listByWorld, deleteByWorld, updateById, deleteById,
} as const
