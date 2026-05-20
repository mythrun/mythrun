import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

// myth-oehx wave 4e: resetData removed. The seeded demo world
// (019700e0-0000-7000-8000-000000000002, owned by the system user
// "system:mythrun") is NOT touched by cleanupTestScope — its cognito_sub
// doesn't match our scope prefix. The getDemo tests that mutate
// worlds.is_demo on the seeded row already wrap the mutation in a
// try/finally that restores the flag.

describe('worlds repo (integration)', () => {
  let pool: Pool
  let scope: TestScope
  let baseUserInput: { cognitoSub: string; displayName: string; username: string }

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('worlds')
    baseUserInput = {
      cognitoSub: scope.userSub(0),
      displayName: scope.displayName(0),
      username: scope.username(0),
    }
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    // myth-oehx wave 4e: scoped cleanup replaces resetData. The seeded
    // demo world + system user persist across tests; only our scope's
    // rows are removed between iterations.
    await cleanupTestScope(pool, scope)
  })

  it('create returns a populated world with default status=generating', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const w = await worlds.create({
      createdBy: owner.id,
      name: scope.worldName(0),
      concept: 'A grim world.',
    })
    expect(w.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(w.createdBy).toBe(owner.id)
    expect(w.name).toBe(scope.worldName(0))
    expect(w.status).toBe('generating')
    expect(w.forkCount).toBe(0)
    expect(w.isPublic).toBe(false)
    expect(w.language).toBe('en')
    expect(w.moderationStatus).toBe('unreviewed')
  })

  it('getById returns null for unknown world', async () => {
    const worlds = createWorldsRepo(pool)
    expect(await worlds.getById('019dccef-0000-7000-8000-000000000000')).toBeNull()
  })

  it('getById returns the world when present', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    const found = await worlds.getById(w.id)
    expect(found?.id).toBe(w.id)
  })

  it('update with empty patch is a no-op on every nullable field (covers ?? null=null branches)', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    const updated = await worlds.update(w.id, {})
    expect(updated.name).toBe(scope.worldName(0))
    expect(updated.concept).toBe('c')
  })

  it('create defensively throws when INSERT returns no row (fake pool)', async () => {
    const fakePool = {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    } as unknown as Pool
    const worlds = createWorldsRepo(fakePool)
    await expect(
      worlds.create({
        createdBy: '019dccef-0000-7000-8000-000000000001',
        name: 'X',
        concept: 'c',
      }),
    ).rejects.toThrow(/INSERT returned no row/)
  })

  it('listByUser returns DESC by createdAt', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const a = await worlds.create({
      createdBy: owner.id,
      name: scope.worldName(0),
      concept: 'first',
    })
    await new Promise((r) => setTimeout(r, 5))
    const b = await worlds.create({
      createdBy: owner.id,
      name: scope.worldName(1),
      concept: 'second',
    })
    const list = await worlds.listByUser(owner.id)
    expect(list.map((w) => w.id)).toEqual([b.id, a.id])
  })

  it('listByUser returns empty array for user with no worlds', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    expect(await worlds.listByUser(owner.id)).toEqual([])
  })

  it('update bumps updatedAt and mutates supplied fields', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    await new Promise((r) => setTimeout(r, 5))
    const updated = await worlds.update(w.id, { name: scope.worldName(1), isPublic: true })
    expect(updated.name).toBe(scope.worldName(1))
    expect(updated.isPublic).toBe(true)
    expect(updated.concept).toBe('c')
    expect(updated.updatedAt.getTime()).toBeGreaterThan(w.updatedAt.getTime())
  })

  it('update with every patch field defined hits all COALESCE branches', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    const updated = await worlds.update(w.id, {
      name: scope.worldName(1),
      concept: 'new concept',
      tone: 'grim',
      themes: 'isolation',
      geographySummary: 'mountains',
      politicalSummary: 'fractured',
      era: 'twilight',
      keyTensions: 'guild vs crown',
      worldOverview: 'overview text',
      followUpQuestions: 'q1\nq2',
      startingSituations: 'opening situations',
      isPublic: true,
      moderationStatus: 'approved',
      language: 'en',
    })
    expect(updated.name).toBe(scope.worldName(1))
    expect(updated.tone).toBe('grim')
    expect(updated.era).toBe('twilight')
    expect(updated.isPublic).toBe(true)
    expect(updated.moderationStatus).toBe('approved')
  })

  it('update throws when the world does not exist', async () => {
    const worlds = createWorldsRepo(pool)
    await expect(
      worlds.update('019dccef-0000-7000-8000-000000000000', { name: 'X' }),
    ).rejects.toThrow(/no world with id/)
  })

  it('updateStatus throws when the world does not exist', async () => {
    const worlds = createWorldsRepo(pool)
    await expect(
      worlds.updateStatus('019dccef-0000-7000-8000-000000000000', 'complete'),
    ).rejects.toThrow(/no world with id/)
  })

  it('incrementForkCount throws when the world does not exist', async () => {
    const worlds = createWorldsRepo(pool)
    await expect(
      worlds.incrementForkCount('019dccef-0000-7000-8000-000000000000'),
    ).rejects.toThrow(/no world with id/)
  })

  it('updateStatus moves a world through generating → complete', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    expect(w.status).toBe('generating')
    const completed = await worlds.updateStatus(w.id, 'complete')
    expect(completed.status).toBe('complete')
  })

  it('incrementForkCount adds 1 atomically', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    expect(w.forkCount).toBe(0)
    const bumped = await worlds.incrementForkCount(w.id)
    expect(bumped.forkCount).toBe(1)
    const bumped2 = await worlds.incrementForkCount(w.id)
    expect(bumped2.forkCount).toBe(2)
  })

  describe('getDemo (MYT-43)', () => {
    it('returns the seeded demo world', async () => {
      const worlds = createWorldsRepo(pool)
      const result = await worlds.getDemo()
      if (result === null) throw new Error('expected seeded demo world')
      expect(result.isDemo).toBe(true)
      expect(result.id).toBe('019700e0-0000-7000-8000-000000000002')
      expect(result.name).toBe('Demo Adventure')
    })

    it('returns null when no demo world exists', async () => {
      const worlds = createWorldsRepo(pool)
      // myth-oehx wave 4e: temporarily flip the demo flag off. The seeded
      // row is shared state across all worlds tests in this file — the
      // try/finally restore is required so subsequent tests still see
      // is_demo=true. cleanupTestScope does NOT touch this row (its
      // cognito_sub is 'system:mythrun', not our scope prefix).
      await pool.query(
        `UPDATE worlds SET is_demo = false WHERE id = '019700e0-0000-7000-8000-000000000002'`,
      )
      try {
        const result = await worlds.getDemo()
        expect(result).toBeNull()
      } finally {
        await pool.query(
          `UPDATE worlds SET is_demo = true WHERE id = '019700e0-0000-7000-8000-000000000002'`,
        )
      }
    })

    it('toWorld correctly maps is_demo', async () => {
      const worlds = createWorldsRepo(pool)
      const result = await worlds.getDemo()
      if (result === null) throw new Error('expected seeded demo world')
      expect(result.isDemo).toBe(true)
    })
  })
})
