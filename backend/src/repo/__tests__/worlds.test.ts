import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { resetData } from './_helpers/reset-data.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: () => {
      // discard log output
    },
  }
  return pino(
    { base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } },
    sink,
  )
}

const baseUserInput = {
  cognitoSub: 'google_99',
  email: 'owner@example.com',
  displayName: 'Owner',
  username: 'owner',
  authProvider: 'google' as const,
}

describe('worlds repo (integration)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 1 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetData(pool)
  })

  it('create returns a populated world with default status=generating', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: 'Realm', concept: 'A grim world.' })
    expect(w.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(w.createdBy).toBe(owner.id)
    expect(w.name).toBe('Realm')
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
    const w = await worlds.create({ createdBy: owner.id, name: 'A', concept: 'c' })
    const found = await worlds.getById(w.id)
    expect(found?.id).toBe(w.id)
  })

  it('update with empty patch is a no-op on every nullable field (covers ?? null=null branches)', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: 'A', concept: 'c' })
    const updated = await worlds.update(w.id, {})
    expect(updated.name).toBe('A')
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
    const a = await worlds.create({ createdBy: owner.id, name: 'A', concept: 'first' })
    await new Promise((r) => setTimeout(r, 5))
    const b = await worlds.create({ createdBy: owner.id, name: 'B', concept: 'second' })
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
    const w = await worlds.create({ createdBy: owner.id, name: 'A', concept: 'c' })
    await new Promise((r) => setTimeout(r, 5))
    const updated = await worlds.update(w.id, { name: 'A renamed', isPublic: true })
    expect(updated.name).toBe('A renamed')
    expect(updated.isPublic).toBe(true)
    expect(updated.concept).toBe('c')
    expect(updated.updatedAt.getTime()).toBeGreaterThan(w.updatedAt.getTime())
  })

  it('update with every patch field defined hits all COALESCE branches', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: 'A', concept: 'c' })
    const updated = await worlds.update(w.id, {
      name: 'renamed',
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
    expect(updated.name).toBe('renamed')
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
    const w = await worlds.create({ createdBy: owner.id, name: 'A', concept: 'c' })
    expect(w.status).toBe('generating')
    const completed = await worlds.updateStatus(w.id, 'complete')
    expect(completed.status).toBe('complete')
  })

  it('incrementForkCount adds 1 atomically', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: 'A', concept: 'c' })
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
      // Temporarily flip the demo flag off; resetData restores it next run.
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
