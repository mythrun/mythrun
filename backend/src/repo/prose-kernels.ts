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

async function insert(client: ClientLike, input: InsertProseKernelInput): Promise<void> {
  await client.query(
    `INSERT INTO prose_kernels (id, entity_id, content) VALUES ($1, $2, $3)`,
    [uuidv7(), input.entityId, input.content],
  )
}

async function updateByEntityId(
  client: ClientLike,
  entityId: string,
  patch: { content: string },
): Promise<number> {
  const result = await client.query(
    `UPDATE prose_kernels SET content = $1, updated_at = now() WHERE entity_id = $2`,
    [patch.content, entityId],
  )
  /* c8 ignore next — `?? 0` falsy arm: pg always returns a numeric rowCount on UPDATE. */
  return result.rowCount ?? 0
}

export const proseKernels = { insert, updateByEntityId } as const
