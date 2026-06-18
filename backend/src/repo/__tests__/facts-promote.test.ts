// backend/src/repo/__tests__/facts-promote.test.ts
//
// MYT-74c T2 — promoteToKnown flips discovered facts to `known`. Real PG
// (mythrun_test); scoped fixtures.
//
// promoteToKnown is a metadata flip: content is unchanged, so there is no
// supersede and no re-embed. It skips already-known + superseded facts
// (idempotent, never resurrects dead canon) and returns the DISTINCT owning
// entity ids actually flipped (the commit then promotes those entities too).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { createRepo, type Repo } from '../index.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('facts repo — promoteToKnown (MYT-74c T2)', () => {
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
    scope = makeTestScope('facts-promote')
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
      accessLevel: 'secret',
      createdIn: 'stage:test',
    })
  })

  it('flips discoverable/secret live facts to known, returns distinct entity ids, idempotent', async () => {
    // Seed entity E with three live facts on one entity: f1 discoverable,
    // f2 secret, f3 already-known.
    const f1 = await repo.facts.insertReconciled({
      entityId,
      topic: 'rumor',
      content: 'A rumor circulates in the market district.',
      accessLevel: 'discoverable',
    })
    const f2 = await repo.facts.insertReconciled({
      entityId,
      topic: 'allegiance',
      content: 'The Spymaster secretly serves the Crown.',
      accessLevel: 'secret',
    })
    const f3 = await repo.facts.insertReconciled({
      entityId,
      topic: 'appearance',
      content: 'The Spymaster wears a grey cloak.',
      accessLevel: 'known',
    })

    const flipped = await repo.facts.promoteToKnown([f1, f2, f3])
    // f1, f2 share entity E (distinct → one id); f3 already known → not returned.
    expect(flipped).toEqual([entityId])

    const live = await repo.facts.listByEntities([entityId], {
      accessLevels: ['known', 'discoverable', 'secret'],
    })
    expect(live.filter((f) => f.accessLevel !== 'known')).toHaveLength(0)

    // Re-promoting an already-known fact is a no-op.
    expect(await repo.facts.promoteToKnown([f1])).toEqual([])
  })

  it('never promotes a superseded fact', async () => {
    const fOld = await repo.facts.insertReconciled({
      entityId,
      topic: 'allegiance',
      content: 'The Spymaster serves the Duke.',
      accessLevel: 'secret',
    })
    const fNew = await repo.facts.insertReconciled({
      entityId,
      topic: 'allegiance',
      content: 'The Spymaster serves the Crown.',
      accessLevel: 'secret',
    })
    await repo.facts.setSuperseded(fOld, fNew)

    // The superseded old fact is dead canon — never resurrected.
    expect(await repo.facts.promoteToKnown([fOld])).toEqual([])

    // fOld stays as it was: still secret, still superseded.
    const after = await pool.query<{ access_level: string; superseded_by: string | null }>(
      `SELECT access_level, superseded_by FROM facts WHERE id = $1`,
      [fOld],
    )
    const row = after.rows[0]
    expect(row).toBeDefined()
    if (!row) throw new Error('expected the superseded fact row')
    expect(row.access_level).toBe('secret')
    expect(row.superseded_by).toBe(fNew)
  })

  it('empty input is a no-op', async () => {
    expect(await repo.facts.promoteToKnown([])).toEqual([])
  })
})
