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

import type { ClientLike } from './_types.js'
import { uuidv7 } from './uuidv7.js'

export type AccessLevel = 'public' | 'private' | 'secret'

export interface InsertFactInput {
  readonly entityId: string
  readonly topic: string
  readonly accessLevel: AccessLevel
  readonly content: string
}

async function insertMany(client: ClientLike, rows: readonly InsertFactInput[]): Promise<void> {
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
  await client.query(
    `INSERT INTO facts (id, entity_id, topic, access_level, content, narrative_status)
     VALUES ${values.join(', ')}`,
    params,
  )
}

async function updateContentById(
  client: ClientLike,
  factId: string,
  patch: { content: string },
): Promise<number> {
  const result = await client.query(
    `UPDATE facts SET content = $1, updated_at = now() WHERE id = $2`,
    [patch.content, factId],
  )
  /* c8 ignore next — `?? 0` falsy arm: pg always returns a numeric rowCount on UPDATE. */
  return result.rowCount ?? 0
}

export const facts = { insertMany, updateContentById } as const
