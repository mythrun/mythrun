// backend/src/repo/__tests__/facts-supersede.test.ts
//
// MYT-74a T5 — append-only-canon write methods + live-only read filter on the
// facts repo. Real PG (mythrun_test); scoped fixtures.
//
// Append-only canon model (migration 027): a session-improvised correction
// APPENDS a new fact via `insertReconciled` and points the old fact's
// superseded_by at it via `setSuperseded` (content is never edited). Live canon
// = superseded_by IS NULL; `listByEntities`'s default liveOnly filter hides the
// superseded row and surfaces only its live replacement.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { createRepo, type Repo } from '../index.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const VECTOR_DIMS = 512

/** Build the pgvector text literal for a unit vector with a 1 at `axis`. */
function unitVec(axis: number): string {
  const parts = new Array<string>(VECTOR_DIMS).fill('0')
  parts[axis] = '1'
  return `[${parts.join(',')}]`
}

describe('facts repo — append-only canon (MYT-74a T5)', () => {
  let pool: Pool
  let repo: Repo
  let scope: TestScope
  let userId: string
  let worldId: string
  let entityId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    scope = makeTestScope('facts-supersede')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
    userId = uuidv7()
    worldId = uuidv7()
    entityId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
    await repo.entities.insert({
      id: entityId,
      worldId,
      entityType: 'npc',
      name: 'The Spymaster',
      accessLevel: 'known',
      createdIn: 'stage:test',
    })
  })

  describe('insertReconciled', () => {
    it('writes a live session-authored canon row (source=session, status=delivered)', async () => {
      const factId = await repo.facts.insertReconciled({
        entityId,
        topic: 'allegiance',
        content: 'The Spymaster secretly serves the Crown.',
        accessLevel: 'known',
      })
      expect(factId).toMatch(/[0-9a-f-]{36}/)

      const rows = await repo.facts.listByEntities([entityId], { accessLevels: ['known'] })
      expect(rows).toHaveLength(1)
      const row = rows[0]
      expect(row).toBeDefined()
      if (!row) throw new Error('expected a reconciled fact row')
      expect(row.id).toBe(factId)
      expect(row.source).toBe('session')
      expect(row.narrativeStatus).toBe('delivered')
      expect(row.topic).toBe('allegiance')
      expect(row.content).toBe('The Spymaster secretly serves the Crown.')
      expect(row.accessLevel).toBe('known')
    })
  })

  describe('setSuperseded', () => {
    it('points the old fact at the new, nulls its embedding, and is idempotent', async () => {
      const oldId = await repo.facts.insertReconciled({
        entityId,
        topic: 'allegiance',
        content: 'The Spymaster serves the Duke.',
        accessLevel: 'known',
      })
      const newId = await repo.facts.insertReconciled({
        entityId,
        topic: 'allegiance',
        content: 'The Spymaster serves the Crown.',
        accessLevel: 'known',
      })
      // Seed the old fact with an embedding so we can prove setSuperseded nulls it.
      const embedded = await repo.facts.updateEmbedding(oldId, unitVec(0))
      expect(embedded).toBe(1)

      const affected = await repo.facts.setSuperseded(oldId, newId)
      expect(affected).toBe(1)

      const after = await pool.query<{
        superseded_by: string | null
        superseded_at: Date | null
        embedding: string | null
        embedded_at: Date | null
      }>(
        `SELECT superseded_by, superseded_at, embedding, embedded_at FROM facts WHERE id = $1`,
        [oldId],
      )
      const r = after.rows[0]
      expect(r).toBeDefined()
      if (!r) throw new Error('expected the superseded fact row')
      expect(r.superseded_by).toBe(newId)
      expect(r.superseded_at).not.toBeNull()
      expect(r.embedding).toBeNull()
      expect(r.embedded_at).toBeNull()

      // Double-supersede is a no-op: the WHERE superseded_by IS NULL guard skips it.
      const second = await repo.facts.setSuperseded(oldId, newId)
      expect(second).toBe(0)
    })
  })

  describe('listByEntities liveOnly filter', () => {
    it('default hides superseded facts; liveOnly:false shows both', async () => {
      const oldId = await repo.facts.insertReconciled({
        entityId,
        topic: 'allegiance',
        content: 'The Spymaster serves the Duke.',
        accessLevel: 'known',
      })
      const newId = await repo.facts.insertReconciled({
        entityId,
        topic: 'allegiance',
        content: 'The Spymaster serves the Crown.',
        accessLevel: 'known',
      })
      await repo.facts.setSuperseded(oldId, newId)

      // Default (liveOnly implicit true): only the live replacement.
      const live = await repo.facts.listByEntities([entityId], { accessLevels: ['known'] })
      expect(live.map((f) => f.id)).toEqual([newId])

      // liveOnly: false → the full append-only log, both rows.
      const all = await repo.facts.listByEntities([entityId], {
        accessLevels: ['known'],
        liveOnly: false,
      })
      expect(all.map((f) => f.id).sort()).toEqual([oldId, newId].sort())
    })

    it('empty entityIds short-circuits to []', async () => {
      const rows = await repo.facts.listByEntities([], { accessLevels: ['known'] })
      expect(rows).toEqual([])
    })
  })
})
