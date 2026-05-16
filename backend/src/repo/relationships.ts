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

// DB row shape for listByWorld's SELECT (no created_at column read).
interface RelationshipListByWorldDbRow {
  readonly id: string
  readonly source_entity_id: string
  readonly target_entity_id: string
  readonly relationship_type: string
  readonly description: string
}

function toRelationship(row: RelationshipListByWorldDbRow): Relationship {
  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relationshipType: row.relationship_type,
    description: row.description,
  }
}

// myth-exac T06: camelCase row shape for the snapshot-view read path.
// Adds createdAt over Relationship; the existing Relationship type is
// kept as-is so listByWorld callers don't churn.
export interface RelationshipRow {
  readonly id: string
  readonly sourceEntityId: string
  readonly targetEntityId: string
  readonly relationshipType: string
  readonly description: string
  readonly createdAt: Date
}

interface RelationshipDbRow {
  readonly id: string
  readonly source_entity_id: string
  readonly target_entity_id: string
  readonly relationship_type: string
  readonly description: string
  readonly created_at: Date
}

function toRelationshipRow(row: RelationshipDbRow): RelationshipRow {
  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relationshipType: row.relationship_type,
    description: row.description,
    createdAt: row.created_at,
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
  const result = await client.query<RelationshipListByWorldDbRow>(
    `SELECT r.id, r.source_entity_id, r.target_entity_id, r.relationship_type, r.description
       FROM relationships r
       JOIN entities e ON e.id = r.source_entity_id
       WHERE e.world_id = $1`,
    [worldId],
  )
  return result.rows.map(toRelationship)
}

// myth-exac T06: snapshot-view primary read path. Returns relationships
// where BOTH endpoints are in entityIds — i.e. the relationship is
// internal to the snapshot's filtered entity set. Empty input short-
// circuits to [] (matches the facts.listByEntities pattern).
async function listAmong(
  client: ClientLike,
  entityIds: readonly string[],
): Promise<readonly RelationshipRow[]> {
  if (entityIds.length === 0) return []
  const result = await client.query<RelationshipDbRow>(
    `SELECT id, source_entity_id, target_entity_id, relationship_type,
            description, created_at
       FROM relationships
      WHERE source_entity_id = ANY($1) AND target_entity_id = ANY($1)
      ORDER BY id`,
    [entityIds as string[]],
  )
  return result.rows.map(toRelationshipRow)
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
  insertMany, listByWorld, listAmong, deleteByWorld, updateById, deleteById,
} as const
