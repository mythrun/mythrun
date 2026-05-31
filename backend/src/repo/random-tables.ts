// backend/src/repo/random-tables.ts
//
// Repo for the random_tables + random_table_entries tables (migration 001
// lines 179–193). The world-gen stage-5 (random_tables) persister is the
// only writer: a per-world idempotency DELETE followed by one row per table
// and one row per entry.
//
// Composable binder-canonical (mirrors worlds.ts `worldsNs`): each method
// captures the ClientLike `c` (pool OR an in-flight tx client) so the same
// body serves `repo.randomTables.X` and `tx.randomTables.X`. The stage runs
// the DELETE + INSERTs inside a `repo.transaction` callback so a retried
// stage starts from a clean slate atomically (design §3 "idempotent
// persisters"). SQL is byte-identical to the prior stage-local statements —
// only relocated into the binder; uuidv7 id-generation moves into the binder
// as its canonical home.

import type { Pool } from 'pg'
import type { ClientLike } from './_types.js'
import { uuidv7 } from './uuidv7.js'

export interface InsertRandomTableInput {
  readonly worldId: string
  readonly name: string
  readonly category: string
}

export interface InsertRandomTableEntryInput {
  readonly roll_min: number
  readonly roll_max: number
  readonly content: string
}

/** Composable binder over a single ClientLike. Holds the canonical SQL so
 *  `repo.randomTables.X` and `tx.randomTables.X` share one body. */
export function randomTablesNs(c: ClientLike) {
  return {
    /**
     * Per-world idempotency wipe. CASCADE FK on random_table_entries.table_id
     * clears the entries. SQL verbatim from `stages/random-tables.ts`.
     */
    deleteByWorld: async (worldId: string): Promise<void> => {
      await c.query(`DELETE FROM random_tables WHERE world_id = $1`, [worldId])
    },

    /**
     * T19b GET /random-tables read: the world's random_tables (id + name +
     * category), ordered by name. SQL verbatim from the former inline
     * `SELECT id, name, category FROM random_tables WHERE world_id = $1
     * ORDER BY name` in campaign-characters.ts.
     */
    listByWorld: async (
      worldId: string,
    ): Promise<readonly { id: string; name: string; category: string }[]> => {
      const result = await c.query<{ id: string; name: string; category: string }>(
        `SELECT id, name, category FROM random_tables WHERE world_id = $1 ORDER BY name`,
        [worldId],
      )
      return result.rows
    },

    /**
     * T19b GET /random-tables read: the entries for a set of table ids, ordered
     * by (table_id, roll_min). Empty `tableIds` short-circuits to [] without a
     * DB round-trip (the route skipped the query when no tables existed). SQL
     * verbatim from the former inline `SELECT table_id, roll_min, roll_max,
     * content FROM random_table_entries WHERE table_id = ANY($1::uuid[])
     * ORDER BY table_id, roll_min`.
     */
    listEntriesByTableIds: async (
      tableIds: readonly string[],
    ): Promise<
      readonly { table_id: string; roll_min: number; roll_max: number; content: string }[]
    > => {
      if (tableIds.length === 0) return []
      const result = await c.query<{
        table_id: string
        roll_min: number
        roll_max: number
        content: string
      }>(
        `SELECT table_id, roll_min, roll_max, content
               FROM random_table_entries
               WHERE table_id = ANY($1::uuid[])
               ORDER BY table_id, roll_min`,
        [tableIds],
      )
      return result.rows
    },

    /**
     * Insert one random_tables row and return its generated UUIDv7 id (the
     * entries reference it as table_id). SQL verbatim from
     * `stages/random-tables.ts`.
     */
    insertTable: async (input: InsertRandomTableInput): Promise<string> => {
      const tableId = uuidv7()
      await c.query(
        `INSERT INTO random_tables (id, world_id, name, category) VALUES ($1, $2, $3, $4)`,
        [tableId, input.worldId, input.name, input.category],
      )
      return tableId
    },

    /**
     * Insert the entries for a table. One INSERT per entry — preserves the
     * stage's prior statement shape exactly (a per-entry single-row INSERT).
     * SQL verbatim from `stages/random-tables.ts`.
     */
    insertEntries: async (
      tableId: string,
      entries: readonly InsertRandomTableEntryInput[],
    ): Promise<void> => {
      for (const entry of entries) {
        await c.query(
          `INSERT INTO random_table_entries (id, table_id, roll_min, roll_max, content)
           VALUES ($1, $2, $3, $4, $5)`,
          [uuidv7(), tableId, entry.roll_min, entry.roll_max, entry.content],
        )
      }
    },
  }
}

/** Back-compat factory — pool-bound `randomTables` surface. Mirrors the
 *  Tier-1 `createWorldsRepo` shape. Direct importers keep working; new code
 *  goes through `repo.randomTables`. */
export const createRandomTablesRepo = (pool: Pool) => randomTablesNs(pool)
