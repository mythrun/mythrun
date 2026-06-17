import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { createRepo, type Repo } from '../index.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

// MYT-74a T6: markTouchedByPlay flips encountered + modified_by_play (both
// default false at insert) to true for a set of entity ids, stamping
// updated_at. Empty-input is a no-op (returns 0, runs no query).
describe('entities repo — markTouchedByPlay', () => {
  let pool: Pool
  let repo: Repo
  let userId: string
  let worldId: string
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    scope = makeTestScope('entities-touched')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
    userId = uuidv7()
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

  it('flips encountered + modified_by_play to true for the given ids and returns the count', async () => {
    const id1 = uuidv7()
    const id2 = uuidv7()
    await entities.insert(pool, {
      id: id1, worldId, entityType: 'npc', name: 'Mara', accessLevel: 'known', createdIn: 'stage:test',
    })
    await entities.insert(pool, {
      id: id2, worldId, entityType: 'location', name: 'Wharf', accessLevel: 'known', createdIn: 'stage:test',
    })

    // Both default to false at insert.
    const before = await pool.query<{ encountered: boolean; modified_by_play: boolean }>(
      `SELECT encountered, modified_by_play FROM entities WHERE id = ANY($1) ORDER BY id`,
      [[id1, id2]],
    )
    expect(before.rows.every((r) => !r.encountered && !r.modified_by_play)).toBe(true)

    const affected = await repo.entities.markTouchedByPlay([id1, id2])
    expect(affected).toBe(2)

    const after = await pool.query<{ encountered: boolean; modified_by_play: boolean }>(
      `SELECT encountered, modified_by_play FROM entities WHERE id = ANY($1) ORDER BY id`,
      [[id1, id2]],
    )
    expect(after.rows).toHaveLength(2)
    expect(after.rows.every((r) => r.encountered && r.modified_by_play)).toBe(true)
  })

  it('is a no-op for an empty id list: returns 0 and touches nothing', async () => {
    const id = uuidv7()
    await entities.insert(pool, {
      id, worldId, entityType: 'npc', name: 'Untouched', accessLevel: 'known', createdIn: 'stage:test',
    })

    const affected = await repo.entities.markTouchedByPlay([])
    expect(affected).toBe(0)

    const row = await pool.query<{ encountered: boolean; modified_by_play: boolean }>(
      `SELECT encountered, modified_by_play FROM entities WHERE id = $1`,
      [id],
    )
    expect(row.rows[0]).toEqual({ encountered: false, modified_by_play: false })
  })
})
