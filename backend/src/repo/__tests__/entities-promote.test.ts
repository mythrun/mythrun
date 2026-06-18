import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { createRepo, type Repo } from '../index.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

// MYT-74c T3: promoteToKnown flips a set of entities to access_level='known'
// (deterministic "entity follows fact" — the commit promotes the owning
// entities of any promoted facts so the wiki, which filters entities by tier
// first, doesn't orphan the now-known facts). Idempotent: already-known
// entities are skipped (not counted in rowCount). Empty input is a no-op.
describe('entities repo — promoteToKnown', () => {
  let pool: Pool
  let repo: Repo
  let userId: string
  let worldId: string
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    scope = makeTestScope('entities-promote')
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

  it('promotes discoverable + secret entities to known and returns the count', async () => {
    const id1 = uuidv7()
    const id2 = uuidv7()
    await entities.insert(pool, {
      id: id1, worldId, entityType: 'npc', name: 'Mara', accessLevel: 'discoverable', createdIn: 'stage:test',
    })
    await entities.insert(pool, {
      id: id2, worldId, entityType: 'location', name: 'Vault', accessLevel: 'secret', createdIn: 'stage:test',
    })

    const affected = await repo.entities.promoteToKnown([id1, id2])
    expect(affected).toBe(2)

    const after = await pool.query<{ access_level: string }>(
      `SELECT access_level FROM entities WHERE id = ANY($1) ORDER BY id`,
      [[id1, id2]],
    )
    expect(after.rows).toHaveLength(2)
    expect(after.rows.every((r) => r.access_level === 'known')).toBe(true)
  })

  it('skips an already-known entity: it is not counted (no-op rowCount)', async () => {
    const idKnown = uuidv7()
    const idSecret = uuidv7()
    await entities.insert(pool, {
      id: idKnown, worldId, entityType: 'npc', name: 'Already', accessLevel: 'known', createdIn: 'stage:test',
    })
    await entities.insert(pool, {
      id: idSecret, worldId, entityType: 'item', name: 'Relic', accessLevel: 'secret', createdIn: 'stage:test',
    })

    const affected = await repo.entities.promoteToKnown([idKnown, idSecret])
    // Only the secret entity flips; the already-known one is a no-op.
    expect(affected).toBe(1)

    const after = await pool.query<{ id: string; access_level: string }>(
      `SELECT id, access_level FROM entities WHERE id = ANY($1)`,
      [[idKnown, idSecret]],
    )
    expect(after.rows.every((r) => r.access_level === 'known')).toBe(true)
  })

  it('is a no-op for an empty id list: returns 0 and touches nothing', async () => {
    const id = uuidv7()
    await entities.insert(pool, {
      id, worldId, entityType: 'npc', name: 'Untouched', accessLevel: 'secret', createdIn: 'stage:test',
    })

    const affected = await repo.entities.promoteToKnown([])
    expect(affected).toBe(0)

    const row = await pool.query<{ access_level: string }>(
      `SELECT access_level FROM entities WHERE id = $1`,
      [id],
    )
    expect(row.rows[0]?.access_level).toBe('secret')
  })
})
