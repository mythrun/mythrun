import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { createRepo } from '../index.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('sessionPreps repo', () => {
  let pool: Pool
  let campaignId: string
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('sessionpreps')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
    const userId = uuidv7()
    const worldId = uuidv7()
    campaignId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'complete')`,
      [worldId, userId, scope.worldName(0)],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, status) VALUES ($1, $2, $3, $4, 'setup')`,
      [campaignId, worldId, userId, scope.campaignName(0)],
    )
  })

  it('insert + existsFor + getBy; ON CONFLICT keeps the first row', async () => {
    const repo = createRepo(pool)
    await repo.sessionPreps.insert({ campaignId, sessionNumber: 1, ftContext: 'FT', sdPlaybook: 'SD' })
    expect(await repo.sessionPreps.existsFor(campaignId, 1)).toBe(true)
    expect(await repo.sessionPreps.existsFor(campaignId, 2)).toBe(false)
    const row = await repo.sessionPreps.getBy(campaignId, 1)
    expect(row?.ftContext).toBe('FT')
    expect(row?.sdPlaybook).toBe('SD')
    await repo.sessionPreps.insert({ campaignId, sessionNumber: 1, ftContext: 'FT2', sdPlaybook: 'SD2' }) // ON CONFLICT DO NOTHING
    expect((await repo.sessionPreps.getBy(campaignId, 1))?.ftContext).toBe('FT')
  })

  it('opening round-trips when provided and reads back null when omitted (MYT-101)', async () => {
    const repo = createRepo(pool)
    await repo.sessionPreps.insert({
      campaignId,
      sessionNumber: 1,
      ftContext: 'FT',
      sdPlaybook: 'SD',
      opening: 'Welcome to the Marches. What do you do?',
    })
    expect((await repo.sessionPreps.getBy(campaignId, 1))?.opening).toBe(
      'Welcome to the Marches. What do you do?',
    )
    await repo.sessionPreps.insert({ campaignId, sessionNumber: 2, ftContext: 'FT', sdPlaybook: 'SD' })
    expect((await repo.sessionPreps.getBy(campaignId, 2))?.opening).toBeNull()
  })

  it('getBy returns null when no prep exists for the session', async () => {
    const repo = createRepo(pool)
    expect(await repo.sessionPreps.getBy(campaignId, 7)).toBeNull()
  })

  describe('listFor / getById / deleteFor (MYT-63)', () => {
    it('listFor returns rows ordered by session_number; empty when none', async () => {
      const repo = createRepo(pool)
      expect(await repo.sessionPreps.listFor(campaignId)).toEqual([])
      await repo.sessionPreps.insert({ campaignId, sessionNumber: 2, ftContext: 'FT2', sdPlaybook: 'SD2' })
      await repo.sessionPreps.insert({ campaignId, sessionNumber: 1, ftContext: 'FT1', sdPlaybook: 'SD1' })
      const rows = await repo.sessionPreps.listFor(campaignId)
      expect(rows.map((r) => r.sessionNumber)).toEqual([1, 2])
      expect(rows[0]?.ftContext).toBe('FT1')
      expect(rows[0]?.sdPlaybook).toBe('SD1') // repo row still carries the secret; the HTTP projection strips it (later task)
    })

    it('getById returns the row by id, null on miss', async () => {
      const repo = createRepo(pool)
      await repo.sessionPreps.insert({ campaignId, sessionNumber: 1, ftContext: 'FT', sdPlaybook: 'SD' })
      const id = (await repo.sessionPreps.listFor(campaignId))[0]?.id
      if (id === undefined) throw new Error('expected a seeded prep')
      const row = await repo.sessionPreps.getById(id)
      expect(row?.id).toBe(id)
      expect(row?.campaignId).toBe(campaignId)
      expect(await repo.sessionPreps.getById(uuidv7())).toBeNull()
    })

    it('deleteFor removes the row; idempotent on a missing row', async () => {
      const repo = createRepo(pool)
      await repo.sessionPreps.insert({ campaignId, sessionNumber: 1, ftContext: 'FT', sdPlaybook: 'SD' })
      await repo.sessionPreps.deleteFor(campaignId, 1)
      expect(await repo.sessionPreps.existsFor(campaignId, 1)).toBe(false)
      await expect(repo.sessionPreps.deleteFor(campaignId, 1)).resolves.toBeUndefined()
    })
  })
})
