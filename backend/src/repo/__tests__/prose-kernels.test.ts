import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { proseKernels } from '../prose-kernels.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('proseKernels repo', () => {
  let pool: Pool
  let entityId: string
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('prose-kernels')
  })
  afterAll(async () => {
    // myth-5jdo: cleanup only this scope's rows; the seeded dev users
    // + system user + demo world remain intact for the next test file.
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    // myth-5jdo: scoped cleanup replaces the prior blanket DELETEs. We
    // remove only THIS scope's rows from the prior iteration, so the
    // seeded dev users + system user keep existing across tests.
    await cleanupTestScope(pool, scope)
    const userId = uuidv7()
    const worldId = uuidv7()
    entityId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
    await entities.insert(pool, {
      id: entityId, worldId, entityType: 'location', name: 'X', accessLevel: 'known', createdIn: 'stage:test',
    })
  })

  it('insert writes a prose_kernel row for the entity', async () => {
    await proseKernels.insert(pool, { entityId, content: 'A forested region.' })
    const row = await pool.query<{ content: string }>(
      `SELECT content FROM prose_kernels WHERE entity_id = $1`, [entityId],
    )
    expect(row.rows[0]?.content).toBe('A forested region.')
  })

  it('insert errors when entity_id already has a prose_kernel (UNIQUE violation)', async () => {
    await proseKernels.insert(pool, { entityId, content: 'first' })
    await expect(
      proseKernels.insert(pool, { entityId, content: 'second' }),
    ).rejects.toThrow()
  })

  it('updateByEntityId replaces the existing content', async () => {
    await proseKernels.insert(pool, { entityId, content: 'original' })
    await proseKernels.updateByEntityId(pool, entityId, { content: 'revised' })
    const row = await pool.query<{ content: string }>(
      `SELECT content FROM prose_kernels WHERE entity_id = $1`, [entityId],
    )
    expect(row.rows[0]?.content).toBe('revised')
  })

  it('updateByEntityId is a no-op when no row exists (zero affected rows)', async () => {
    const affected = await proseKernels.updateByEntityId(pool, entityId, { content: 'x' })
    expect(affected).toBe(0)
  })

  describe('listByEntities', () => {
    // myth-exac T06: snapshot-view primary read path. Returns kernels
    // for the given entity IDs only. Empty input short-circuits to [].
    it('returns kernels only for the given entity ids', async () => {
      // Build a second entity in the same world so we can prove the
      // filter is doing the work, not "happens to be the only row".
      const worldLookup = await pool.query<{ world_id: string }>(
        `SELECT world_id FROM entities WHERE id = $1`,
        [entityId],
      )
      const worldRow = worldLookup.rows[0]
      if (!worldRow) throw new Error('entity world_id lookup failed')
      const otherEntityId = uuidv7()
      await entities.insert(pool, {
        id: otherEntityId,
        worldId: worldRow.world_id,
        entityType: 'location',
        name: 'Y',
        accessLevel: 'known',
        createdIn: 'stage:test',
      })

      await proseKernels.insert(pool, { entityId, content: 'first kernel' })
      await proseKernels.insert(pool, { entityId: otherEntityId, content: 'second kernel' })

      const rows = await proseKernels.listByEntities(pool, [entityId])
      expect(rows).toHaveLength(1)
      expect(rows[0]?.entityId).toBe(entityId)
      expect(rows[0]?.content).toBe('first kernel')
    })

    it('returns [] for an empty entity id list (no round-trip)', async () => {
      await proseKernels.insert(pool, { entityId, content: 'x' })
      const rows = await proseKernels.listByEntities(pool, [])
      expect(rows).toEqual([])
    })
  })
})
