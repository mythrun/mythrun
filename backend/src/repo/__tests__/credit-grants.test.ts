// Unit tests for insertCreditGrant — the dev-only `source_type='admin'`
// credit grant helper. Covers the input-validation guard, happy path,
// and the rollback branch when the INSERT throws mid-transaction.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { insertCreditGrant } from '../credit-grants.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: (): void => {
      // discard
    },
  }
  return pino({ base: { component: 'migrate' } }, sink)
}

describe('insertCreditGrant', () => {
  let pool: Pool
  let userId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
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
    await pool.query('DELETE FROM credit_ledger')
    await pool.query("DELETE FROM users WHERE cognito_sub != 'system:mythrun'")
    userId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, 'bypass:grant-test', 'GrantTest', `gt${userId.slice(-6)}`],
    )
  })

  describe('input validation', () => {
    it('throws when amount is not an integer', async () => {
      await expect(
        insertCreditGrant(pool, { userId, creditType: 'world_gen', amount: 1.5 }),
      ).rejects.toThrow(/positive integer/)
    })

    it('throws when amount is zero', async () => {
      await expect(
        insertCreditGrant(pool, { userId, creditType: 'world_gen', amount: 0 }),
      ).rejects.toThrow(/positive integer/)
    })

    it('throws when amount is negative', async () => {
      await expect(
        insertCreditGrant(pool, { userId, creditType: 'session', amount: -5 }),
      ).rejects.toThrow(/positive integer/)
    })

    it('throws when amount is NaN', async () => {
      await expect(
        insertCreditGrant(pool, { userId, creditType: 'session', amount: Number.NaN }),
      ).rejects.toThrow(/positive integer/)
    })
  })

  describe('happy path', () => {
    it('inserts an admin-source row and returns the new balance', async () => {
      const result = await insertCreditGrant(pool, {
        userId,
        creditType: 'world_gen',
        amount: 5,
      })
      expect(result.ledgerId).toMatch(/^[0-9a-f-]{36}$/)
      expect(result.newBalance).toBe(5)

      const row = await pool.query<{ source_type: string; amount: number }>(
        `SELECT source_type, amount::int AS amount FROM credit_ledger WHERE id = $1`,
        [result.ledgerId],
      )
      expect(row.rows[0]?.source_type).toBe('admin')
      expect(row.rows[0]?.amount).toBe(5)
    })

    it('sums non-expired balances per credit_type — expired entries excluded', async () => {
      // Seed an expired row directly; the helper's SELECT filters it.
      await pool.query(
        `INSERT INTO credit_ledger
           (id, user_id, credit_type, amount, source_type, granted_at, expires_at)
         VALUES ($1, $2, 'world_gen', 99, 'admin', now() - interval '1 hour', now() - interval '1 minute')`,
        [uuidv7(), userId],
      )
      const result = await insertCreditGrant(pool, {
        userId,
        creditType: 'world_gen',
        amount: 3,
      })
      expect(result.newBalance).toBe(3) // 99 expired + 3 new = 3 non-expired
    })

    it('returns newBalance: 0 if the SUM query yields no rows', async () => {
      // Hard to hit naturally — the COALESCE always returns a row in
      // postgres. Build an isolated scenario: mock the pool client so the
      // SELECT returns rows: []. Confirms the `row ? ... : 0` branch.
      const realClient = await pool.connect()
      try {
        await realClient.query('BEGIN')
        await realClient.query('ROLLBACK')
      } finally {
        realClient.release()
      }
      const fakePool = {
        connect: async (): Promise<PoolClient> => {
          const insertedId = uuidv7()
          const fake: Partial<PoolClient> = {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            query: ((..._args: unknown[]): Promise<unknown> => {
              return Promise.resolve({ rows: [], rowCount: 0 })
            }) as any,
            release: () => {
              /* no-op */
            },
          }
          // Stash the id so the assertion line below can read it.
          ;(fake as { _id?: string })._id = insertedId
          return fake as PoolClient
        },
      } as unknown as Pool
      const result = await insertCreditGrant(fakePool, {
        userId,
        creditType: 'world_gen',
        amount: 1,
      })
      expect(result.newBalance).toBe(0)
    })
  })

  describe('rollback path', () => {
    it('rolls back the transaction and rethrows when the INSERT fails (FK violation)', async () => {
      // userId points at a user that doesn't exist → credit_ledger.user_id
      // FK to users.id violates → INSERT throws → ROLLBACK runs → rethrow.
      const phantomUserId = uuidv7()
      await expect(
        insertCreditGrant(pool, { userId: phantomUserId, creditType: 'world_gen', amount: 5 }),
      ).rejects.toThrow()
      // No row landed.
      const rows = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM credit_ledger WHERE user_id = $1`,
        [phantomUserId],
      )
      expect(rows.rows[0]?.count).toBe('0')
    })

    it('swallows a rollback error and rethrows the original error', async () => {
      // Construct a Pool whose client.query throws on INSERT and again on
      // ROLLBACK — exercises the inner try/catch around the rollback.
      let insertCalled = false
      const fakePool = {
        connect: async (): Promise<PoolClient> => {
          const fake: Partial<PoolClient> = {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            query: ((sqlOrConfig: unknown): Promise<unknown> => {
              const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : ''
              if (sql.startsWith('BEGIN')) return Promise.resolve({ rows: [], rowCount: 0 })
              if (sql.startsWith('INSERT')) {
                insertCalled = true
                return Promise.reject(new Error('insert exploded'))
              }
              if (sql.startsWith('ROLLBACK')) {
                return Promise.reject(new Error('rollback also exploded'))
              }
              return Promise.resolve({ rows: [], rowCount: 0 })
            }) as any,
            release: () => {
              /* no-op */
            },
          }
          return fake as PoolClient
        },
      } as unknown as Pool
      await expect(
        insertCreditGrant(fakePool, { userId, creditType: 'world_gen', amount: 1 }),
      ).rejects.toThrow(/insert exploded/)
      expect(insertCalled).toBe(true)
    })
  })
})
