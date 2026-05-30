// backend/src/repo/__tests__/world-inventory.test.ts
//
// Integration test for the worldInventory namespace (data-layer-repo-
// unification). `worldInventory.load` is the composite multi-table read moved
// verbatim from world-dump.ts `loadWorldInventory`: entities (+access tier) +
// prose kernels + facts + relationships for one world, into in-memory maps.
// This test exercises the binder SQL against real Postgres and asserts the
// round-trip shape (entitiesById / proseByEntityId / factsById /
// relationshipsById, with synthKey carried through). Mirrors the
// random-tables.test conventions: scoped fixtures + createTestPool.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { createRepo, expectCommitted, type Repo } from '../index.js'
import { entities } from '../entities.js'
import { relationships } from '../relationships.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('worldInventory repo', () => {
  let pool: Pool
  let repo: Repo
  let scope: TestScope
  let userId: string
  let worldId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    scope = makeTestScope('world-inventory')
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
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'complete')`,
      [worldId, userId, scope.worldName(0)],
    )
  })

  it('load returns entities (+tier), prose, facts, and relationships for the world', async () => {
    const entA = uuidv7()
    const entB = uuidv7()
    const factId = uuidv7()
    await entities.insert(pool, {
      id: entA, worldId, entityType: 'location', name: 'Saltwatch Keep', accessLevel: 'known', createdIn: 'stage:test',
    })
    await entities.insert(pool, {
      id: entB, worldId, entityType: 'npc', name: 'Captain Aerion', accessLevel: 'discoverable', createdIn: 'stage:test',
    })
    await pool.query(
      `INSERT INTO prose_kernels (id, entity_id, content)
       VALUES ($1, $2, 'A weather-bitten stockade above the river bend.')`,
      [uuidv7(), entA],
    )
    await pool.query(
      `INSERT INTO facts (id, entity_id, topic, access_level, narrative_status, content)
       VALUES ($1, $2, 'history', 'known', 'undelivered', 'Founded after the second harvest.')`,
      [factId, entA],
    )
    const synthKey = 'entity_relationships/relationships/7'
    const [relId] = await relationships.insertMany(pool, [{
      sourceEntityId: entB,
      targetEntityId: entA,
      relationshipType: 'resides_at',
      description: 'Has lived in the stockade since the burning.',
      synthKey,
    }])

    const inv = await repo.worldInventory.load(worldId)

    // entities (+ tier)
    expect(inv.entitiesById.get(entA)).toEqual({
      id: entA, name: 'Saltwatch Keep', entityType: 'location', accessLevel: 'known',
    })
    expect(inv.entitiesById.get(entB)?.accessLevel).toBe('discoverable')

    // prose
    expect(inv.proseByEntityId.get(entA)).toContain('weather-bitten stockade')
    expect(inv.proseByEntityId.has(entB)).toBe(false)

    // facts
    expect(inv.factsById.get(factId)).toEqual({
      id: factId, entityId: entA, topic: 'history', accessLevel: 'known',
      content: 'Founded after the second harvest.',
    })

    // relationships (+ synthKey carried through)
    expect(inv.relationshipsById.get(relId ?? '')).toMatchObject({
      sourceEntityId: entB,
      targetEntityId: entA,
      relationshipType: 'resides_at',
      synthKey,
    })
  })

  it('load returns empty maps for a world with no entities', async () => {
    const inv = await repo.worldInventory.load(worldId)
    expect(inv.entitiesById.size).toBe(0)
    expect(inv.proseByEntityId.size).toBe(0)
    expect(inv.factsById.size).toBe(0)
    expect(inv.relationshipsById.size).toBe(0)
  })

  it('load scopes to the world (does not leak a sibling world’s rows)', async () => {
    const ownEntity = uuidv7()
    await entities.insert(pool, {
      id: ownEntity, worldId, entityType: 'faction', name: 'Own', accessLevel: 'known', createdIn: 'stage:test',
    })

    // Sibling world owned by a second scoped user.
    const otherUserId = uuidv7()
    const otherWorldId = uuidv7()
    const otherEntity = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [otherUserId, scope.userSub(1), scope.displayName(1), scope.username(1)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'complete')`,
      [otherWorldId, otherUserId, scope.worldName(1)],
    )
    await entities.insert(pool, {
      id: otherEntity, worldId: otherWorldId, entityType: 'faction', name: 'Other', accessLevel: 'known', createdIn: 'stage:test',
    })

    const inv = await repo.worldInventory.load(worldId)
    expect(inv.entitiesById.has(ownEntity)).toBe(true)
    expect(inv.entitiesById.has(otherEntity)).toBe(false)
    expect(inv.entitiesById.size).toBe(1)
  })

  it('tx.worldInventory.load reads same-tx writes inside a transaction', async () => {
    // The binder also binds the in-flight tx client. Seed inside the tx, read
    // inside the tx — confirms the composite read sees uncommitted same-tx rows.
    const entId = uuidv7()
    const inv = expectCommitted(
      await repo.transaction(async (tx) => {
        await tx.entities.insert({
          id: entId, worldId, entityType: 'location', name: 'In-Tx', accessLevel: 'known', createdIn: 'stage:test',
        })
        return tx.worldInventory.load(worldId)
      }),
    )
    expect(inv.entitiesById.has(entId)).toBe(true)
  })
})
