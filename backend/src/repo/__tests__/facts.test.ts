import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { facts, factsNs } from '../facts.js'
import { createRepo, type Repo } from '../index.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('facts repo', () => {
  let pool: Pool
  let repo: Repo
  let entityId: string
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    scope = makeTestScope('facts')
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
    await entities.insert(pool, { id: entityId, worldId, entityType: 'location', name: 'X', accessLevel: 'known', createdIn: 'stage:test' })
  })

  it('insertMany stamps narrative_status=undelivered and source=prep on every row', async () => {
    await facts.insertMany(pool, [
      { entityId, topic: 'history', accessLevel: 'known', content: 'Founded long ago.' },
      { entityId, topic: 'secrets', accessLevel: 'secret', content: 'Hidden vault below.' },
    ])
    const rows = await pool.query<{
      topic: string; access_level: string; content: string; narrative_status: string; source: string
    }>(
      `SELECT topic, access_level, content, narrative_status, source FROM facts WHERE entity_id = $1 ORDER BY topic`,
      [entityId],
    )
    expect(rows.rows).toEqual([
      { topic: 'history', access_level: 'known', content: 'Founded long ago.', narrative_status: 'undelivered', source: 'prep' },
      { topic: 'secrets', access_level: 'secret', content: 'Hidden vault below.', narrative_status: 'undelivered', source: 'prep' },
    ])
  })

  it('insertMany with empty array is a no-op', async () => {
    await facts.insertMany(pool, [])
    // Scope the count to THIS test's entity so leftover rows from prior
    // runs (the globalSetup model doesn't drop the schema between runs)
    // don't fail the empty-array assertion.
    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM facts WHERE entity_id = $1`,
      [entityId],
    )
    expect(count.rows[0]?.count).toBe('0')
  })

  it('updateContentById updates a single fact row', async () => {
    await facts.insertMany(pool, [
      { entityId, topic: 'history', accessLevel: 'known', content: 'wrong' },
    ])
    const row = await pool.query<{ id: string }>(`SELECT id FROM facts WHERE entity_id = $1`, [entityId])
    const factId = row.rows[0]?.id
    if (factId === undefined) throw new Error('expected fact row to exist')
    await facts.updateContentById(pool, factId, { content: 'corrected' })
    const updated = await pool.query<{ content: string }>(
      `SELECT content FROM facts WHERE id = $1`, [factId],
    )
    expect(updated.rows[0]?.content).toBe('corrected')
  })

  it('deleteById removes a single fact row (back-compat shim)', async () => {
    await facts.insertMany(pool, [{ entityId, topic: 'history', accessLevel: 'known', content: 'x' }])
    const row = await pool.query<{ id: string }>(`SELECT id FROM facts WHERE entity_id = $1`, [entityId])
    const factId = row.rows[0]?.id
    if (factId === undefined) throw new Error('expected fact row to exist')
    const affected = await facts.deleteById(pool, factId)
    expect(affected).toBe(1)
    const after = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM facts WHERE id = $1`, [factId])
    expect(after.rows[0]?.n).toBe('0')
  })

  // data-layer unification: caller-supplied-id single insert (coherence add_fact).
  it('insertOne inserts a fact with a caller-supplied id + canonical undelivered status', async () => {
    const factId = uuidv7()
    await factsNs(pool).insertOne({
      id: factId, entityId, topic: 'governance', content: 'Run by the harbor council.', accessLevel: 'known',
    })
    const row = await pool.query<{ id: string; topic: string; content: string; access_level: string; narrative_status: string }>(
      `SELECT id, topic, content, access_level, narrative_status FROM facts WHERE id = $1`,
      [factId],
    )
    expect(row.rows[0]).toEqual({
      id: factId, topic: 'governance', content: 'Run by the harbor council.',
      access_level: 'known', narrative_status: 'undelivered',
    })
  })

  // myth-gp2c Cluster C: character-integration fact insert (column order
  // id, entity_id, topic, access_level, narrative_status, content — distinct
  // from insertOne/insertMany; access_level + narrative_status baked-in).
  it('insertIntegrationFact inserts with baked-in known/undelivered + minted id', async () => {
    await factsNs(pool).insertIntegrationFact({
      entityId,
      topic: 'origin',
      content: 'Raised at the Bone Sept.',
    })
    const row = await pool.query<{
      topic: string; content: string; access_level: string; narrative_status: string
    }>(
      `SELECT topic, content, access_level, narrative_status FROM facts WHERE entity_id = $1`,
      [entityId],
    )
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0]).toEqual({
      topic: 'origin',
      content: 'Raised at the Bone Sept.',
      access_level: 'known',
      narrative_status: 'undelivered',
    })
  })

  // MYT-71 T6: updateEmbedding sets the pgvector embedding + embedded_at.
  it('updateEmbedding sets embedding + stamps embedded_at', async () => {
    await facts.insertMany(pool, [
      { entityId, topic: 'history', accessLevel: 'known', content: 'x' },
    ])
    const row = await pool.query<{ id: string }>(
      `SELECT id FROM facts WHERE entity_id = $1`, [entityId],
    )
    const factId = row.rows[0]?.id
    if (factId === undefined) throw new Error('expected fact row to exist')
    const lit = `[${['1', ...new Array<string>(511).fill('0')].join(',')}]`
    const affected = await repo.facts.updateEmbedding(factId, lit)
    expect(affected).toBe(1)
    const after = await pool.query<{ embedding: string | null; embedded_at: Date | null }>(
      `SELECT embedding, embedded_at FROM facts WHERE id = $1`, [factId],
    )
    expect(after.rows[0]?.embedding).not.toBeNull()
    expect(after.rows[0]?.embedded_at).not.toBeNull()
  })

  it('updateEmbedding returns 0 for an unknown id', async () => {
    const lit = `[${['1', ...new Array<string>(511).fill('0')].join(',')}]`
    const affected = await repo.facts.updateEmbedding(
      '019dccef-0000-7000-8000-000000000099', lit,
    )
    expect(affected).toBe(0)
  })

  describe('listByEntities (myth-exac)', () => {
    it('returns facts for given entity IDs filtered by accessLevels', async () => {
      // Reuse the outer beforeEach's world+entity (entityId) as entity 1; create entity 2 alongside it.
      const ownerWorldRow = await pool.query<{ world_id: string }>(
        `SELECT world_id FROM entities WHERE id = $1`,
        [entityId],
      )
      const worldId = ownerWorldRow.rows[0]?.world_id
      if (worldId === undefined) throw new Error('expected entity to have a world')

      const entityId2 = uuidv7()
      await entities.insert(pool, { id: entityId2, worldId, entityType: 'location', name: 'Y', accessLevel: 'known', createdIn: 'stage:test' })

      await facts.insertMany(pool, [
        { entityId, topic: 'a', accessLevel: 'known', content: 'k1' },
        { entityId, topic: 'b', accessLevel: 'discoverable', content: 'd1' },
        { entityId: entityId2, topic: 'c', accessLevel: 'secret', content: 's2' },
      ])

      const knownOnly = await facts.listByEntities(pool, [entityId, entityId2], {
        accessLevels: ['known'],
      })
      expect(knownOnly).toHaveLength(1)
      expect(knownOnly[0]?.content).toBe('k1')

      const all = await facts.listByEntities(pool, [entityId, entityId2], {
        accessLevels: ['known', 'discoverable', 'secret'],
      })
      expect(all).toHaveLength(3)
    })

    it('returns [] for empty entity ID list', async () => {
      const rows = await facts.listByEntities(pool, [], { accessLevels: ['known'] })
      expect(rows).toEqual([])
    })
  })
})
