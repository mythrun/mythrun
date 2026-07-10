// backend/src/repo/__tests__/gen-seed-view.test.ts
//
// myth-gcsp1: genSeedView.fetch composes the mid-generation graph rehydration
// seed — the KNOWN-TIER entities of a world + the known-tier relationships among
// them. This is the SECURITY-load-bearing tier assertion: the seed must carry
// exactly what the live entity-added/edge-added stream already delivered (known
// tier), never a discoverable/secret entity or a secret connection between two
// known entities.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { genSeedView } from '../gen-seed-view.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('genSeedView.fetch — myth-gcsp1', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('gen-seed-view')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  interface SeededFixture {
    readonly worldId: string
    readonly known1: string
    readonly known2: string
    readonly secret: string
  }

  // A generating world with two known entities, one secret entity, a known→known
  // relationship (known tier), a SECRET connection between the two known entities,
  // and a known→secret edge. Only the first should surface in the seed.
  async function seedFixture(): Promise<SeededFixture> {
    const userId = uuidv7()
    const worldId = uuidv7()
    const known1 = uuidv7()
    const known2 = uuidv7()
    const secret = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'c', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
    await entities.insert(pool, {
      id: known1, worldId, entityType: 'faction',
      name: `${scope.id}-k1`, accessLevel: 'known', createdIn: 'stage:test',
    })
    await entities.insert(pool, {
      id: known2, worldId, entityType: 'location',
      name: `${scope.id}-k2`, accessLevel: 'known', createdIn: 'stage:test',
    })
    await entities.insert(pool, {
      id: secret, worldId, entityType: 'npc',
      name: `${scope.id}-secret`, accessLevel: 'secret', createdIn: 'stage:test',
    })
    // Edge 1: known→known @ known tier — the ONLY edge that should seed.
    // Edge 2: known→known @ SECRET tier — a secret connection between two known
    //         entities (the enforced-ignorance gate; both endpoints pass but the
    //         edge's own tier must keep it out).
    // Edge 3: known→secret @ known tier — excluded because an endpoint is secret.
    await pool.query(
      `INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description, access_level)
       VALUES ($1, $2, $3, 'allies_with', 'd1', 'known'),
              ($4, $2, $3, 'secretly_controls', 'd2', 'secret'),
              ($5, $2, $6, 'watches', 'd3', 'known')`,
      [uuidv7(), known1, known2, uuidv7(), uuidv7(), secret],
    )
    return { worldId, known1, known2, secret }
  }

  it('seeds ONLY known-tier entities + the known-tier known→known relationship', async () => {
    const { worldId, known1, known2, secret } = await seedFixture()

    const seed = await genSeedView.fetch(pool, worldId)

    // Entities: the two known ones, never the secret.
    expect(seed.entities.map((e) => e.id).sort()).toEqual([known1, known2].sort())
    expect(seed.entities.some((e) => e.id === secret)).toBe(false)
    // Shape: id/entityType/name only (the graph's seed node fields).
    const k1 = seed.entities.find((e) => e.id === known1)
    expect(k1).toEqual({ id: known1, entityType: 'faction', name: `${scope.id}-k1` })

    // Relationships: exactly the ONE known→known @ known edge. The secret
    // connection between the two known entities and the known→secret edge are both
    // excluded — that is the enforced-ignorance security gate.
    expect(seed.relationships).toHaveLength(1)
    expect(seed.relationships[0]).toEqual({
      sourceEntityId: known1,
      targetEntityId: known2,
      relationshipType: 'allies_with',
    })
  })

  it('returns empty entities + relationships for a world with no committed entities', async () => {
    const userId = uuidv7()
    const worldId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(1), scope.displayName(1), scope.username(1)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'c', 'generating')`,
      [worldId, userId, scope.worldName(1)],
    )

    const seed = await genSeedView.fetch(pool, worldId)

    expect(seed.entities).toEqual([])
    expect(seed.relationships).toEqual([])
  })
})
