import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createCreditsRepo } from '../credits.js'
import { uuidv7 } from '../uuidv7.js'
import { resetData } from './_helpers/reset-data.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: () => {
      // discard
    },
  }
  return pino(
    { base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } },
    sink,
  )
}

const baseUserInput = {
  cognitoSub: 'google_credits_test',
  email: 'credits@test.local',
  displayName: 'Credits Tester',
  username: 'creditstester',
  authProvider: 'google' as const,
}

describe('credits repo (integration)', () => {
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

  describe('balance()', () => {
    it('returns 0 for an empty ledger (both credit types)', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      expect(await credits.balance(u.id, 'session')).toBe(0)
      expect(await credits.balance(u.id, 'world_gen')).toBe(0)
    })

    it('grant + balance returns the granted amount', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)

      await credits.grant({
        userId: u.id,
        creditType: 'session',
        amount: 5,
        sourceType: 'gift',
      })

      expect(await credits.balance(u.id, 'session')).toBe(5)
      expect(await credits.balance(u.id, 'world_gen')).toBe(0)
    })

    it('multiple grants sum', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 3, sourceType: 'gift' })
      await credits.grant({ userId: u.id, creditType: 'session', amount: 2, sourceType: 'gift' })
      expect(await credits.balance(u.id, 'session')).toBe(5)
    })

    it('expired credits are excluded', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await credits.grant({
        userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift',
        expiresAt: new Date(Date.now() - 86_400_000),
      })
      await credits.grant({
        userId: u.id, creditType: 'session', amount: 3, sourceType: 'gift',
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      expect(await credits.balance(u.id, 'session')).toBe(3)
    })

    it('credit-type isolation: session and world_gen do not bleed', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift' })
      await credits.grant({ userId: u.id, creditType: 'world_gen', amount: 2, sourceType: 'gift' })
      expect(await credits.balance(u.id, 'session')).toBe(5)
      expect(await credits.balance(u.id, 'world_gen')).toBe(2)
    })
  })

  describe('grant()', () => {
    it('inserts a positive credit entry and balance reflects it', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)

      const entry = await credits.grant({
        userId: u.id,
        creditType: 'session',
        amount: 5,
        sourceType: 'gift',
      })

      expect(entry.amount).toBe(5)
      expect(entry.sourceType).toBe('gift')
      expect(entry.creditType).toBe('session')
      expect(entry.userId).toBe(u.id)
      expect(entry.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(entry.expiresAt).toBeNull()
      expect(await credits.balance(u.id, 'session')).toBe(5)
    })

    it('throws on amount <= 0', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)

      await expect(
        credits.grant({ userId: u.id, creditType: 'session', amount: 0, sourceType: 'gift' }),
      ).rejects.toThrow(/amount must be > 0/)

      await expect(
        credits.grant({ userId: u.id, creditType: 'session', amount: -1, sourceType: 'gift' }),
      ).rejects.toThrow(/amount must be > 0/)
    })

    it('throws UserNotFoundError when user does not exist', async () => {
      const credits = createCreditsRepo(pool)
      const fakeId = '019dccef-0000-7000-8000-000000000000'

      const { UserNotFoundError } = await import('../credits-errors.js')
      await expect(
        credits.grant({ userId: fakeId, creditType: 'session', amount: 1, sourceType: 'gift' }),
      ).rejects.toBeInstanceOf(UserNotFoundError)
    })
  })

  describe('atomicDebit()', () => {
    it('debits and returns the new entry; balance reflects it', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift' })

      const sourceId = uuidv7()
      const entry = await credits.atomicDebit({
        userId: u.id, creditType: 'session', amount: 1, sourceId,
      })

      expect(entry.amount).toBe(-1)
      expect(entry.sourceType).toBe('debit')
      expect(entry.sourceId).toBe(sourceId)
      expect(await credits.balance(u.id, 'session')).toBe(4)
    })

    it('throws InsufficientCreditsError when balance is too low', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 1, sourceType: 'gift' })

      const { InsufficientCreditsError } = await import('../credits-errors.js')
      await expect(
        credits.atomicDebit({
          userId: u.id, creditType: 'session', amount: 2, sourceId: uuidv7(),
        }),
      ).rejects.toBeInstanceOf(InsufficientCreditsError)

      const after = await credits.balance(u.id, 'session')
      expect(after).toBe(1)
    })

    it('throws InsufficientCreditsError on empty ledger', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)

      const { InsufficientCreditsError } = await import('../credits-errors.js')
      await expect(
        credits.atomicDebit({
          userId: u.id, creditType: 'session', amount: 1, sourceId: uuidv7(),
        }),
      ).rejects.toBeInstanceOf(InsufficientCreditsError)
      expect(await credits.balance(u.id, 'session')).toBe(0)
    })

    it('debit on world_gen does not see session credits', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift' })

      const { InsufficientCreditsError } = await import('../credits-errors.js')
      await expect(
        credits.atomicDebit({
          userId: u.id, creditType: 'world_gen', amount: 1, sourceId: uuidv7(),
        }),
      ).rejects.toBeInstanceOf(InsufficientCreditsError)
      expect(await credits.balance(u.id, 'session')).toBe(5)
    })

    it('throws on amount <= 0', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await expect(
        credits.atomicDebit({
          userId: u.id, creditType: 'session', amount: 0, sourceId: uuidv7(),
        }),
      ).rejects.toThrow(/amount must be > 0/)
    })

    it('throws on empty sourceId', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await expect(
        credits.atomicDebit({
          userId: u.id, creditType: 'session', amount: 1, sourceId: '',
        }),
      ).rejects.toThrow(/sourceId required/)
    })

    it('throws UserNotFoundError when user does not exist', async () => {
      const credits = createCreditsRepo(pool)
      const fakeId = '019dccef-0000-7000-8000-000000000001'

      const { UserNotFoundError } = await import('../credits-errors.js')
      await expect(
        credits.atomicDebit({
          userId: fakeId, creditType: 'session', amount: 1, sourceId: uuidv7(),
        }),
      ).rejects.toBeInstanceOf(UserNotFoundError)
    })
  })
})
