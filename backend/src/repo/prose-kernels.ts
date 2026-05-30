// Repo for prose_kernels table (migration 001 lines 140–146).
// UNIQUE(entity_id) — exactly one prose blob per entity.
//
// insert() errors on conflict (used by stages 2/3 with fresh entities).
// updateByEntityId() is the coherence-pass fix_prose path. Do NOT
// implement as an upsert that conflates the two cases — the design
// (§4.3) explicitly calls out the separation.

import type { ClientLike } from './_types.js'
import { uuidv7 } from './uuidv7.js'

export interface InsertProseKernelInput {
  readonly entityId: string
  readonly content: string
}

export interface ProseKernelRow {
  readonly id: string
  readonly entityId: string
  readonly content: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface ProseKernelDbRow {
  readonly id: string
  readonly entity_id: string
  readonly content: string
  readonly created_at: Date
  readonly updated_at: Date
}

function toProseKernelRow(r: ProseKernelDbRow): ProseKernelRow {
  return {
    id: r.id,
    entityId: r.entity_id,
    content: r.content,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Composable binder over a single ClientLike. Holds the canonical SQL so
 *  `repo.proseKernels.X` and `tx.proseKernels.X` share one body. */
export function proseKernelsNs(c: ClientLike) {
  return {
    insert: async (input: InsertProseKernelInput): Promise<void> => {
      await c.query(
        `INSERT INTO prose_kernels (id, entity_id, content) VALUES ($1, $2, $3)`,
        [uuidv7(), input.entityId, input.content],
      )
    },
    updateByEntityId: async (entityId: string, patch: { content: string }): Promise<number> => {
      const result = await c.query(
        `UPDATE prose_kernels SET content = $1, updated_at = now() WHERE entity_id = $2`,
        [patch.content, entityId],
      )
      /* c8 ignore next — `?? 0` falsy arm: pg always returns a numeric rowCount on UPDATE. */
      return result.rowCount ?? 0
    },
    // myth-exac T06: snapshot-view primary read path. Returns prose kernels
    // for the given entity IDs. Empty input short-circuits to [] (matches
    // facts.listByEntities).
    listByEntities: async (entityIds: readonly string[]): Promise<readonly ProseKernelRow[]> => {
      if (entityIds.length === 0) return []
      const result = await c.query<ProseKernelDbRow>(
        `SELECT id, entity_id, content, created_at, updated_at
       FROM prose_kernels
      WHERE entity_id = ANY($1)
      ORDER BY entity_id`,
        [entityIds],
      )
      return result.rows.map(toProseKernelRow)
    },
  }
}

/** Back-compat shim: explicit-client const-object surface that delegates to the
 *  canonical `proseKernelsNs` binder. Direct importers
 *  (`proseKernels.insert(client, input)`) keep working; new code goes through
 *  `repo.proseKernels`. */
export const proseKernels = {
  insert: (client: ClientLike, input: InsertProseKernelInput): Promise<void> =>
    proseKernelsNs(client).insert(input),
  updateByEntityId: (
    client: ClientLike,
    entityId: string,
    patch: { content: string },
  ): Promise<number> => proseKernelsNs(client).updateByEntityId(entityId, patch),
  listByEntities: (
    client: ClientLike,
    entityIds: readonly string[],
  ): Promise<readonly ProseKernelRow[]> => proseKernelsNs(client).listByEntities(entityIds),
} as const
