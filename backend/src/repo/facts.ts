// backend/src/repo/facts.ts
//
// Repo for the facts table (migration 001 lines 148–159).
//
// narrative_status is NOT NULL with CHECK ('undelivered', 'delivered',
// 'developed', 'resolved'). The LLM does NOT emit this field per design
// §3.1 — the persister stamps 'undelivered' as a constant on every
// row at INSERT time. Play-runtime owns subsequent transitions.
//
// source defaults to 'prep' via the column default. Persister relies
// on the default; no explicit value passed.
//
// myth-exac: AccessLevel enum renamed from (public/private/secret) to
// (known/discoverable/secret). See migration 014.

import type { ClientLike } from './_types.js'
import { uuidv7 } from './uuidv7.js'

export type AccessLevel = 'known' | 'discoverable' | 'secret'

export type NarrativeStatus = 'undelivered' | 'delivered' | 'developed' | 'resolved'

export interface InsertFactInput {
  readonly entityId: string
  readonly topic: string
  readonly accessLevel: AccessLevel
  readonly content: string
}

export interface FactRow {
  readonly id: string
  readonly entityId: string
  readonly topic: string
  readonly accessLevel: AccessLevel
  readonly narrativeStatus: NarrativeStatus
  readonly content: string
  readonly source: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface FactDbRow {
  readonly id: string
  readonly entity_id: string
  readonly topic: string
  readonly access_level: AccessLevel
  readonly narrative_status: NarrativeStatus
  readonly content: string
  readonly source: string
  readonly created_at: Date
  readonly updated_at: Date
}

function toFactRow(r: FactDbRow): FactRow {
  return {
    id: r.id,
    entityId: r.entity_id,
    topic: r.topic,
    accessLevel: r.access_level,
    narrativeStatus: r.narrative_status,
    content: r.content,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Composable binder over a single ClientLike. Holds the canonical SQL so
 *  `repo.facts.X` and `tx.facts.X` share one body. */
export function factsNs(c: ClientLike) {
  return {
    insertMany: async (rows: readonly InsertFactInput[]): Promise<void> => {
      if (rows.length === 0) return

      // Build parameterized multi-row INSERT. Each row contributes 5
      // placeholders ($1..$5, $6..$10, etc.). narrative_status is baked in
      // as the constant 'undelivered'; source defaults via the column.
      const values: string[] = []
      const params: unknown[] = []
      let p = 1
      for (const row of rows) {
        values.push(`($${String(p++)}, $${String(p++)}, $${String(p++)}, $${String(p++)}, $${String(p++)}, 'undelivered')`)
        params.push(uuidv7(), row.entityId, row.topic, row.accessLevel, row.content)
      }
      await c.query(
        `INSERT INTO facts (id, entity_id, topic, access_level, content, narrative_status)
     VALUES ${values.join(', ')}`,
        params,
      )
    },
    /**
     * Insert a single fact row with a CALLER-SUPPLIED id (coherence-pass mints
     * `newId` so its fact-added SSE event references the same id). narrative_status
     * is baked in as the canonical 'undelivered' literal; source defaults via the
     * column. SQL verbatim from `stages/coherence-pass.ts` `applyAddFact` — note
     * the column order (id, entity_id, topic, content, access_level,
     * narrative_status) differs from `insertMany`'s, preserved exactly here.
     */
    insertOne: async (input: {
      id: string
      entityId: string
      topic: string
      content: string
      accessLevel: AccessLevel
    }): Promise<void> => {
      await c.query(
        `INSERT INTO facts (id, entity_id, topic, content, access_level, narrative_status)
         VALUES ($1, $2, $3, $4, $5, 'undelivered')`,
        [input.id, input.entityId, input.topic, input.content, input.accessLevel],
      )
    },
    /**
     * myth-gp2c Cluster C: insert one character-integration fact — both the
     * per-PC starter facts and the `newFacts` on existing world entities. The
     * id is minted internally (uuidv7); access_level + narrative_status are the
     * baked-in literals 'known' / 'undelivered' (a PC's backstory fact is
     * player-known by construction). SQL verbatim from
     * `stages/character-integration.ts writeIntegration` (passes 2 + 3) — note
     * the column order (id, entity_id, topic, access_level, narrative_status,
     * content) differs from `insertOne` / `insertMany`, preserved exactly here.
     * Composes inside the stage's `repo.transaction`.
     */
    insertIntegrationFact: async (input: {
      entityId: string
      topic: string
      content: string
    }): Promise<void> => {
      await c.query(
        `INSERT INTO facts (id, entity_id, topic, access_level, narrative_status, content)
         VALUES ($1, $2, $3, 'known', 'undelivered', $4)`,
        [uuidv7(), input.entityId, input.topic, input.content],
      )
    },
    updateContentById: async (factId: string, patch: { content: string }): Promise<number> => {
      const result = await c.query(
        `UPDATE facts SET content = $1, updated_at = now() WHERE id = $2`,
        [patch.content, factId],
      )
      /* c8 ignore next — `?? 0` falsy arm: pg always returns a numeric rowCount on UPDATE. */
      return result.rowCount ?? 0
    },
    deleteById: async (id: string): Promise<number> => {
      const result = await c.query(`DELETE FROM facts WHERE id = $1`, [id])
      /* c8 ignore next — `?? 0` falsy arm: pg always returns a numeric rowCount on DELETE. */
      return result.rowCount ?? 0
    },
    /**
     * MYT-71 (world-retrieval): set the pgvector embedding + stamp embedded_at.
     * Mirrors `entities.updateEmbedding` against the facts table. `vecLiteral`
     * is the `'[f1,…,f512]'` text form; cast to ::vector here. Canonical write
     * so `embed-write.ts` calls `repo.facts.updateEmbedding` / `tx.facts
     * .updateEmbedding`. Returns the affected row count (0 = no such id).
     */
    updateEmbedding: async (id: string, vecLiteral: string): Promise<number> => {
      const result = await c.query(
        `UPDATE facts SET embedding = $1::vector, embedded_at = now() WHERE id = $2`,
        [vecLiteral, id],
      )
      /* c8 ignore next — `?? 0` falsy arm: pg always returns a numeric rowCount on UPDATE. */
      return result.rowCount ?? 0
    },
    // myth-exac: snapshot-view primary read path. Returns facts for the
    // given entity IDs filtered by access tier. Empty entity ID list
    // short-circuits to [] without a round-trip (covers the snapshot's
    // "world has no entities yet" case).
    listByEntities: async (
      entityIds: readonly string[],
      opts: { readonly accessLevels: readonly AccessLevel[] },
    ): Promise<readonly FactRow[]> => {
      if (entityIds.length === 0) return []
      const result = await c.query<FactDbRow>(
        `SELECT id, entity_id, topic, access_level, narrative_status, content,
            source, created_at, updated_at
       FROM facts
      WHERE entity_id = ANY($1) AND access_level = ANY($2)
      ORDER BY entity_id, id`,
        [entityIds, opts.accessLevels],
      )
      return result.rows.map(toFactRow)
    },
  }
}

/** Back-compat shim: explicit-client const-object surface that delegates to the
 *  canonical `factsNs` binder. Direct importers (`facts.insertMany(client,
 *  rows)`) keep working; new code goes through `repo.facts`. */
export const facts = {
  insertMany: (client: ClientLike, rows: readonly InsertFactInput[]): Promise<void> =>
    factsNs(client).insertMany(rows),
  updateContentById: (
    client: ClientLike,
    factId: string,
    patch: { content: string },
  ): Promise<number> => factsNs(client).updateContentById(factId, patch),
  deleteById: (client: ClientLike, id: string): Promise<number> =>
    factsNs(client).deleteById(id),
  listByEntities: (
    client: ClientLike,
    entityIds: readonly string[],
    opts: { readonly accessLevels: readonly AccessLevel[] },
  ): Promise<readonly FactRow[]> => factsNs(client).listByEntities(entityIds, opts),
} as const
