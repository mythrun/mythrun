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
  // myth-imxg.2: required so stage 7 (coherence pass) can address the
  // existing row on the wire by its synth_key when emitting edge-removed
  // SSE events. Column is nullable in the schema (migration 020) but
  // every write path going forward must supply a value.
  readonly synthKey: string
}

export interface Relationship {
  readonly id: string
  readonly sourceEntityId: string
  readonly targetEntityId: string
  readonly relationshipType: string
  readonly description: string
  readonly synthKey: string
}

// DB row shape for listByWorld's SELECT (no created_at column read).
interface RelationshipListByWorldDbRow {
  readonly id: string
  readonly source_entity_id: string
  readonly target_entity_id: string
  readonly relationship_type: string
  readonly description: string
  readonly synth_key: string
}

function toRelationship(row: RelationshipListByWorldDbRow): Relationship {
  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relationshipType: row.relationship_type,
    description: row.description,
    synthKey: row.synth_key,
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
  readonly synthKey: string
}

interface RelationshipDbRow {
  readonly id: string
  readonly source_entity_id: string
  readonly target_entity_id: string
  readonly relationship_type: string
  readonly description: string
  readonly created_at: Date
  readonly synth_key: string
}

function toRelationshipRow(row: RelationshipDbRow): RelationshipRow {
  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relationshipType: row.relationship_type,
    description: row.description,
    createdAt: row.created_at,
    synthKey: row.synth_key,
  }
}

/** Composable binder over a single ClientLike. Holds the canonical SQL so
 *  `repo.relationships.X` and `tx.relationships.X` share one body. */
export function relationshipsNs(c: ClientLike) {
  return {
    // Returns the generated UUIDv7 ids in input order. Stage 4 (entity_relationships)
    // uses these ids to emit `finalized` events for relationships whose endpoints
    // pass the tier filter (myth-exac T15).
    insertMany: async (rows: readonly InsertRelationshipInput[]): Promise<readonly string[]> => {
      if (rows.length === 0) return []
      const values: string[] = []
      const params: unknown[] = []
      const ids: string[] = []
      let p = 1
      for (const row of rows) {
        const id = uuidv7()
        ids.push(id)
        values.push(`($${String(p++)}, $${String(p++)}, $${String(p++)}, $${String(p++)}, $${String(p++)}, $${String(p++)})`)
        params.push(id, row.sourceEntityId, row.targetEntityId, row.relationshipType, row.description, row.synthKey)
      }
      await c.query(
        `INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description, synth_key)
     VALUES ${values.join(', ')}`,
        params,
      )
      return ids
    },
    /**
     * Insert a single relationship row with a CALLER-SUPPLIED id + synthKey
     * (coherence-pass mints `newId` + `coherence_pass/edges/<newId>` so the
     * SSE edge-added event and the persisted synth_key column agree). Distinct
     * from `insertMany`, which generates ids internally. SQL verbatim from
     * `stages/coherence-pass.ts` `applyFixRelationship` / `applyAddRelationship`.
     */
    insertOne: async (input: {
      id: string
      sourceEntityId: string
      targetEntityId: string
      relationshipType: string
      description: string
      synthKey: string
    }): Promise<void> => {
      await c.query(
        `INSERT INTO relationships
           (id, source_entity_id, target_entity_id, relationship_type, description, synth_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.id,
          input.sourceEntityId,
          input.targetEntityId,
          input.relationshipType,
          input.description,
          input.synthKey,
        ],
      )
    },
    /**
     * myth-gp2c Cluster C: insert one character-integration relationship (PC→world
     * and the mirrored PC↔PC edges). The id is minted internally (uuidv7) and
     * synth_key is intentionally OMITTED — character-integration edges are not
     * addressed on the wire by synth_key the way world-gen edges are, so the
     * column stays NULL (nullable per migration 020). SQL verbatim from
     * `stages/character-integration.ts writeIntegration` pass 2 — distinct from
     * `insertOne` / `insertMany`, which both write synth_key. Composes inside the
     * stage's `repo.transaction`.
     */
    insertIntegrationEdge: async (input: {
      sourceEntityId: string
      targetEntityId: string
      relationshipType: string
      description: string
    }): Promise<void> => {
      await c.query(
        `INSERT INTO relationships
             (id, source_entity_id, target_entity_id, relationship_type, description)
           VALUES ($1, $2, $3, $4, $5)`,
        [
          uuidv7(),
          input.sourceEntityId,
          input.targetEntityId,
          input.relationshipType,
          input.description,
        ],
      )
    },
    listByWorld: async (worldId: string): Promise<Relationship[]> => {
      const result = await c.query<RelationshipListByWorldDbRow>(
        `SELECT r.id, r.source_entity_id, r.target_entity_id, r.relationship_type, r.description, r.synth_key
       FROM relationships r
       JOIN entities e ON e.id = r.source_entity_id
       WHERE e.world_id = $1`,
        [worldId],
      )
      return result.rows.map(toRelationship)
    },
    // myth-exac T06: snapshot-view primary read path. Returns relationships
    // where BOTH endpoints are in entityIds — i.e. the relationship is
    // internal to the snapshot's filtered entity set. Empty input short-
    // circuits to [] (matches the facts.listByEntities pattern).
    listAmong: async (entityIds: readonly string[]): Promise<readonly RelationshipRow[]> => {
      if (entityIds.length === 0) return []
      const result = await c.query<RelationshipDbRow>(
        `SELECT id, source_entity_id, target_entity_id, relationship_type,
            description, created_at, synth_key
       FROM relationships
      WHERE source_entity_id = ANY($1) AND target_entity_id = ANY($1)
      ORDER BY id`,
        [entityIds],
      )
      return result.rows.map(toRelationshipRow)
    },
    deleteByWorld: async (worldId: string): Promise<void> => {
      await c.query(
        `DELETE FROM relationships
       WHERE source_entity_id IN (SELECT id FROM entities WHERE world_id = $1)`,
        [worldId],
      )
    },
    updateById: async (
      id: string,
      patch: { relationshipType?: string; description?: string },
    ): Promise<number> => {
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
      const result = await c.query(
        `UPDATE relationships SET ${sets.join(', ')} WHERE id = $${String(p)}`,
        params,
      )
      /* c8 ignore next — `?? 0` falsy arm: pg always returns a numeric rowCount on UPDATE. */
      return result.rowCount ?? 0
    },
    deleteById: async (id: string): Promise<number> => {
      const result = await c.query(`DELETE FROM relationships WHERE id = $1`, [id])
      /* c8 ignore next — `?? 0` falsy arm: pg always returns a numeric rowCount on DELETE. */
      return result.rowCount ?? 0
    },
  }
}

/** Back-compat shim: explicit-client const-object surface that delegates to the
 *  canonical `relationshipsNs` binder. Direct importers
 *  (`relationships.insertMany(client, rows)`) keep working; new code goes
 *  through `repo.relationships`. */
export const relationships = {
  insertMany: (
    client: ClientLike,
    rows: readonly InsertRelationshipInput[],
  ): Promise<readonly string[]> => relationshipsNs(client).insertMany(rows),
  listByWorld: (client: ClientLike, worldId: string): Promise<Relationship[]> =>
    relationshipsNs(client).listByWorld(worldId),
  listAmong: (
    client: ClientLike,
    entityIds: readonly string[],
  ): Promise<readonly RelationshipRow[]> => relationshipsNs(client).listAmong(entityIds),
  deleteByWorld: (client: ClientLike, worldId: string): Promise<void> =>
    relationshipsNs(client).deleteByWorld(worldId),
  updateById: (
    client: ClientLike,
    id: string,
    patch: { relationshipType?: string; description?: string },
  ): Promise<number> => relationshipsNs(client).updateById(id, patch),
  deleteById: (client: ClientLike, id: string): Promise<number> =>
    relationshipsNs(client).deleteById(id),
} as const
