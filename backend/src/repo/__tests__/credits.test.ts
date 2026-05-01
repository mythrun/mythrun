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

      // Direct INSERT bypassing grant() because grant() lands in Task 6.
      await pool.query(
        `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type, source_id)
         VALUES (gen_random_uuid(), $1, 'session', 5, 'gift', NULL)`,
        [u.id],
      )

      expect(await credits.balance(u.id, 'session')).toBe(5)
      expect(await credits.balance(u.id, 'world_gen')).toBe(0)
    })

    it('multiple grants sum', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await pool.query(
        `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type)
         VALUES
           (gen_random_uuid(), $1, 'session', 3, 'gift'),
           (gen_random_uuid(), $1, 'session', 2, 'gift')`,
        [u.id],
      )
      expect(await credits.balance(u.id, 'session')).toBe(5)
    })

    it('expired credits are excluded', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await pool.query(
        `INSERT INTO credit_ledger
           (id, user_id, credit_type, amount, source_type, expires_at)
         VALUES
           (gen_random_uuid(), $1, 'session', 5, 'gift', now() - interval '1 day'),
           (gen_random_uuid(), $1, 'session', 3, 'gift', now() + interval '1 day')`,
        [u.id],
      )
      expect(await credits.balance(u.id, 'session')).toBe(3)
    })

    it('credit-type isolation: session and world_gen do not bleed', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await pool.query(
        `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type)
         VALUES
           (gen_random_uuid(), $1, 'session', 5, 'gift'),
           (gen_random_uuid(), $1, 'world_gen', 2, 'gift')`,
        [u.id],
      )
      expect(await credits.balance(u.id, 'session')).toBe(5)
      expect(await credits.balance(u.id, 'world_gen')).toBe(2)
    })
  })
})
