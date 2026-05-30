// backend/src/repo/__tests__/random-tables.test.ts
//
// Integration test for the randomTables namespace (myth-gp2c, Cluster A). The
// world-gen stage-5 (random_tables) persister composes deleteByWorld +
// insertTable + insertEntries inside a repo.transaction. This test exercises
// the binder SQL against real Postgres (the stage unit test asserts only the
// binder-call contract). Mirrors the entity-hierarchy.test conventions:
// scoped fixtures + createTestPool.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { createRepo, type Repo } from '../index.js'
import { createRandomTablesRepo } from '../random-tables.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('randomTables repo', () => {
  let pool: Pool
  let repo: Repo
  let scope: TestScope
  let worldId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    scope = makeTestScope('random-tables')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
    const userId = uuidv7()
    worldId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
  })

  it('insertTable returns a generated id; insertEntries links entries to it', async () => {
    const tableId = await repo.randomTables.insertTable({
      worldId,
      name: 'Travel Encounters',
      category: 'travel_encounters',
    })
    expect(tableId).toMatch(/^[0-9a-f-]{36}$/)

    await repo.randomTables.insertEntries(tableId, [
      { roll_min: 1, roll_max: 10, content: 'A merchant offering a trade.' },
      { roll_min: 11, roll_max: 20, content: 'A washed-out bridge.' },
    ])

    const tableRow = await pool.query<{ name: string; category: string; world_id: string }>(
      `SELECT name, category, world_id FROM random_tables WHERE id = $1`,
      [tableId],
    )
    expect(tableRow.rows[0]).toEqual({
      name: 'Travel Encounters',
      category: 'travel_encounters',
      world_id: worldId,
    })

    const entries = await pool.query<{ roll_min: number; roll_max: number; content: string }>(
      `SELECT roll_min, roll_max, content FROM random_table_entries WHERE table_id = $1 ORDER BY roll_min`,
      [tableId],
    )
    expect(entries.rows).toEqual([
      { roll_min: 1, roll_max: 10, content: 'A merchant offering a trade.' },
      { roll_min: 11, roll_max: 20, content: 'A washed-out bridge.' },
    ])
  })

  it('insertEntries with an empty list writes nothing', async () => {
    const tableId = await repo.randomTables.insertTable({
      worldId,
      name: 'Empty',
      category: 'empty',
    })
    await repo.randomTables.insertEntries(tableId, [])
    const entries = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM random_table_entries WHERE table_id = $1`,
      [tableId],
    )
    expect(entries.rows[0]?.count).toBe('0')
  })

  it('deleteByWorld removes the world tables and CASCADE-clears their entries', async () => {
    const tableId = await repo.randomTables.insertTable({
      worldId,
      name: 'Doomed Table',
      category: 'doomed',
    })
    await repo.randomTables.insertEntries(tableId, [
      { roll_min: 1, roll_max: 20, content: 'gone after delete' },
    ])

    await repo.randomTables.deleteByWorld(worldId)

    const tables = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM random_tables WHERE world_id = $1`,
      [worldId],
    )
    expect(tables.rows[0]?.count).toBe('0')
    const entries = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM random_table_entries WHERE table_id = $1`,
      [tableId],
    )
    expect(entries.rows[0]?.count).toBe('0')
  })

  it('the stage-5 persist shape (deleteByWorld → insertTable → insertEntries) composes inside repo.transaction and commits', async () => {
    // Mirrors stages/random-tables.ts: idempotency delete then one table +
    // its entries per table, all inside one repo.transaction.
    await repo.transaction(async (tx) => {
      await tx.randomTables.deleteByWorld(worldId)
      const t = await tx.randomTables.insertTable({
        worldId,
        name: 'Regional Quirks',
        category: 'quirks',
      })
      await tx.randomTables.insertEntries(t, [
        { roll_min: 1, roll_max: 20, content: 'Speaks in proverbs.' },
      ])
    })

    const tables = await pool.query<{ name: string }>(
      `SELECT name FROM random_tables WHERE world_id = $1`,
      [worldId],
    )
    expect(tables.rows.map((r) => r.name)).toEqual(['Regional Quirks'])
    const entries = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM random_table_entries e
         JOIN random_tables t ON t.id = e.table_id
        WHERE t.world_id = $1`,
      [worldId],
    )
    expect(entries.rows[0]?.count).toBe('1')
  })

  it('createRandomTablesRepo back-compat factory binds the pool surface', async () => {
    // The direct-import factory (createRandomTablesRepo(pool)) is the pre-
    // unification entrypoint; assert it produces a working pool-bound binder.
    const tablesRepo = createRandomTablesRepo(pool)
    const tableId = await tablesRepo.insertTable({
      worldId,
      name: 'Back-Compat Table',
      category: 'compat',
    })
    const row = await pool.query<{ name: string }>(
      `SELECT name FROM random_tables WHERE id = $1`,
      [tableId],
    )
    expect(row.rows[0]?.name).toBe('Back-Compat Table')
  })

  it('a thrown transaction callback rolls back all random-table writes', async () => {
    await expect(
      repo.transaction(async (tx) => {
        await tx.randomTables.deleteByWorld(worldId)
        const t = await tx.randomTables.insertTable({
          worldId,
          name: 'Rolled Back',
          category: 'rollback',
        })
        await tx.randomTables.insertEntries(t, [
          { roll_min: 1, roll_max: 20, content: 'never commits' },
        ])
        throw new Error('boom')
      }),
    ).rejects.toThrow(/boom/)

    const tables = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM random_tables WHERE world_id = $1`,
      [worldId],
    )
    expect(tables.rows[0]?.count).toBe('0')
  })
})
