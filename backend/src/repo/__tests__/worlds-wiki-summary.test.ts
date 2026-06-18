// Integration test for repo.worlds.getWikiSummary — the PLAYER-facing narrow
// world projection (MYT-74c). It is getSnapshotSummary MINUS `concept`: the
// owner's raw freeform world seed can carry plot and must never reach a player
// wiki. This file pins the runtime shape (concept absent, the allowlist keys
// present) and the unknown-id null behaviour.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { createRepo } from '../index.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestUser } from './_helpers/create-test-user.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('repo.worlds.getWikiSummary — player-facing narrow projection', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('wiki-summary')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  async function seedWorld(): Promise<{ worldId: string; seededName: string }> {
    const { id: userId } = await createTestUser(pool, scope, { sub: scope.userSub(0) })
    const worldId = uuidv7()
    const seededName = scope.worldName(0)
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, tone, themes, status,
                            dev_bypass_access_filter, era)
       VALUES ($1, $2, $3, 'a freeform world seed that carries plot secrets',
               'wistful', 'belonging', 'generating', false, 'the late bronze age')`,
      [worldId, userId, seededName],
    )
    return { worldId, seededName }
  }

  it('returns the narrow wiki summary without concept', async () => {
    const repo = createRepo(pool)
    const { worldId, seededName } = await seedWorld()

    const s = await repo.worlds.getWikiSummary(worldId)
    expect(s).not.toBeNull()
    expect('concept' in (s as object)).toBe(false)
    expect(s?.name).toBe(seededName)
    expect(await repo.worlds.getWikiSummary(uuidv7())).toBeNull()
  })

  it('exposes exactly the allowlist keys and never concept', async () => {
    const repo = createRepo(pool)
    const { worldId } = await seedWorld()

    const s = await repo.worlds.getWikiSummary(worldId)
    expect(s).not.toBeNull()
    if (s === null) throw new Error('unreachable')

    expect(Object.keys(s).sort()).toEqual(
      ['era', 'id', 'name', 'themes', 'tone', 'vocabularyRegistry'].sort(),
    )
    expect(s.id).toBe(worldId)
    expect(s.era).toBe('the late bronze age')
    expect('concept' in s).toBe(false)
  })
})
