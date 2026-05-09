import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { createPgPool } from '../../db/postgres.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createCreditsRepo } from '../credits.js'
import { uuidv7 } from '../uuidv7.js'
import { resetData, resetCreditsData } from './_helpers/reset-data.js'
import { ensureSchema, pool } from './_helpers/with-tx.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

const baseUserInput = {
  cognitoSub: 'google_credits_test',
  displayName: 'Credits Tester',
  username: 'creditstester',
}

describe('credits repo (integration)', () => {
  beforeAll(async () => {
    await ensureSchema()
  })

  beforeEach(async () => {
    await resetData(pool)
  })

  describe('balance()', () => {
    it('returns 0 for an empty ledger (both credit types)', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
      expect(await credits.balance(u.id, 'session')).toBe(0)
      expect(await credits.balance(u.id, 'world_gen')).toBe(0)
    })

    it('grant + balance returns the granted amount', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)

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
      const u = await users.create(pool, baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 3, sourceType: 'gift' })
      await credits.grant({ userId: u.id, creditType: 'session', amount: 2, sourceType: 'gift' })
      expect(await credits.balance(u.id, 'session')).toBe(5)
    })

    it('expired credits are excluded', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await credits.grant({
        userId: u.id,
        creditType: 'session',
        amount: 5,
        sourceType: 'gift',
        expiresAt: new Date(Date.now() - 86_400_000),
      })
      await credits.grant({
        userId: u.id,
        creditType: 'session',
        amount: 3,
        sourceType: 'gift',
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      expect(await credits.balance(u.id, 'session')).toBe(3)
    })

    it('credit-type isolation: session and world_gen do not bleed', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
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
      const u = await users.create(pool, baseUserInput)

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
      const u = await users.create(pool, baseUserInput)

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

    // Backwards-compat smoke test for the wrapper after the grantInTx extraction
    // (Task 8 of MYT-42). Re-validates that calling `grant` from the public
    // surface still opens its own tx + lock + INSERT and the row is visible
    // post-COMMIT. If this regresses, the wrapper has stopped delegating
    // correctly to grantInTx.
    it('still opens its own tx and commits (post-grantInTx-extraction)', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)

      const entry = await credits.grant({
        userId: u.id,
        creditType: 'world_gen',
        amount: 2,
        sourceType: 'gift',
      })

      expect(entry.creditType).toBe('world_gen')
      expect(entry.amount).toBe(2)
      // Visible from a fresh read on the pool — proves COMMIT happened.
      expect(await credits.balance(u.id, 'world_gen')).toBe(2)
    })
  })

  describe('grantInTx()', () => {
    it('writes a row when called inside an existing tx', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const entry = await credits.grantInTx(client, {
          userId: u.id,
          creditType: 'session',
          amount: 4,
          sourceType: 'gift',
        })
        expect(entry.amount).toBe(4)
        expect(entry.sourceType).toBe('gift')
        expect(entry.userId).toBe(u.id)
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {
          /* ignore */
        })
        throw err
      } finally {
        client.release()
      }

      // Row visible to a fresh pool read post-COMMIT.
      expect(await credits.balance(u.id, 'session')).toBe(4)
    })

    it('self-relock under existing user-row lock is a no-op (tuple re-entrancy)', async () => {
      const users = createUsersRepo(pool)
      // Tighten lock_timeout so a regression (genuine wait) would surface fast.
      const credits = createCreditsRepo(pool, { debitLockTimeoutMs: 500 })
      const u = await users.create(pool, baseUserInput)

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        // Caller takes the user-row lock first — webhook-handler discipline.
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [u.id])

        // grantInTx's internal SELECT FOR UPDATE on the same xid must be a no-op.
        const start = Date.now()
        const entry = await credits.grantInTx(client, {
          userId: u.id,
          creditType: 'session',
          amount: 7,
          sourceType: 'gift',
        })
        const elapsed = Date.now() - start

        expect(entry.amount).toBe(7)
        // Self-relock is instantaneous (Postgres tuple lock re-entrancy);
        // assert hard upper bound that's well under the lock_timeout setting.
        expect(elapsed).toBeLessThan(200)

        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {
          /* ignore */
        })
        throw err
      } finally {
        client.release()
      }

      expect(await credits.balance(u.id, 'session')).toBe(7)
    })
  })

  describe('recordClawback()', () => {
    it('rejects amount >= 0 (positive)', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await expect(
          credits.recordClawback(client, {
            userId: u.id,
            creditType: 'session',
            amount: 1,
            sourceId: uuidv7(),
          }),
        ).rejects.toThrow(/amount must be negative/)
        await expect(
          credits.recordClawback(client, {
            userId: u.id,
            creditType: 'session',
            amount: 0,
            sourceId: uuidv7(),
          }),
        ).rejects.toThrow(/amount must be negative/)
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
    })

    it('rejects empty sourceId', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await expect(
          credits.recordClawback(client, {
            userId: u.id,
            creditType: 'session',
            amount: -1,
            sourceId: '',
          }),
        ).rejects.toThrow(/sourceId required/)
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
    })

    it('writes a negative-polarity debit row with NULL FKs and NULL expires_at', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
      // Pre-grant some credits so the post-clawback balance is sensible.
      await credits.grant({
        userId: u.id,
        creditType: 'session',
        amount: 5,
        sourceType: 'gift',
      })

      const sourceId = uuidv7()
      const client = await pool.connect()
      let entry
      try {
        await client.query('BEGIN')
        entry = await credits.recordClawback(client, {
          userId: u.id,
          creditType: 'session',
          amount: -2,
          sourceId,
        })
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {
          /* ignore */
        })
        throw err
      } finally {
        client.release()
      }

      expect(entry.amount).toBe(-2)
      expect(entry.sourceType).toBe('debit')
      expect(entry.sourceId).toBe(sourceId)
      expect(entry.expiresAt).toBeNull()

      // Verify the FK columns are NULL via raw SQL (mapper doesn't expose them).
      const raw = await pool.query<{
        source_purchase_id: string | null
        source_billing_history_id: string | null
        expires_at: Date | null
      }>(
        `SELECT source_purchase_id, source_billing_history_id, expires_at
           FROM credit_ledger WHERE id = $1`,
        [entry.id],
      )
      const row = raw.rows[0]
      expect(row?.source_purchase_id).toBeNull()
      expect(row?.source_billing_history_id).toBeNull()
      expect(row?.expires_at).toBeNull()

      // Balance reflects clawback.
      expect(await credits.balance(u.id, 'session')).toBe(3)
    })

    it('ON CONFLICT idempotency: second call returns the same canonical row, no duplicate', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await credits.grant({
        userId: u.id,
        creditType: 'session',
        amount: 5,
        sourceType: 'gift',
      })

      const sourceId = uuidv7()

      // First call.
      const client1 = await pool.connect()
      let first
      try {
        await client1.query('BEGIN')
        first = await credits.recordClawback(client1, {
          userId: u.id,
          creditType: 'session',
          amount: -1,
          sourceId,
        })
        await client1.query('COMMIT')
      } finally {
        client1.release()
      }

      // Second call with the same (userId, creditType, sourceId).
      const client2 = await pool.connect()
      let second
      try {
        await client2.query('BEGIN')
        second = await credits.recordClawback(client2, {
          userId: u.id,
          creditType: 'session',
          amount: -1,
          sourceId,
        })
        await client2.query('COMMIT')
      } finally {
        client2.release()
      }

      // Same canonical row.
      expect(second.id).toBe(first.id)
      expect(second.amount).toBe(-1)
      expect(second.sourceType).toBe('debit')

      // Only one debit row exists for this sourceId.
      const count = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM credit_ledger
          WHERE user_id = $1 AND source_type = 'debit' AND source_id = $2`,
        [u.id, sourceId],
      )
      expect(Number(count.rows[0]?.count)).toBe(1)

      // Balance reflects exactly one clawback (-1), not two.
      expect(await credits.balance(u.id, 'session')).toBe(4)
    })
  })

  describe('atomicDebit()', () => {
    it('debits and returns the new entry; balance reflects it', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift' })

      const sourceId = uuidv7()
      const { entry } = await credits.atomicDebit({
        userId: u.id,
        creditType: 'session',
        amount: 1,
        sourceId,
      })

      expect(entry.amount).toBe(-1)
      expect(entry.sourceType).toBe('debit')
      expect(entry.sourceId).toBe(sourceId)
      expect(await credits.balance(u.id, 'session')).toBe(4)
    })

    it('throws InsufficientCreditsError when balance is too low', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 1, sourceType: 'gift' })

      const { InsufficientCreditsError } = await import('../credits-errors.js')
      await expect(
        credits.atomicDebit({
          userId: u.id,
          creditType: 'session',
          amount: 2,
          sourceId: uuidv7(),
        }),
      ).rejects.toBeInstanceOf(InsufficientCreditsError)

      const after = await credits.balance(u.id, 'session')
      expect(after).toBe(1)
    })

    it('throws InsufficientCreditsError on empty ledger', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)

      const { InsufficientCreditsError } = await import('../credits-errors.js')
      await expect(
        credits.atomicDebit({
          userId: u.id,
          creditType: 'session',
          amount: 1,
          sourceId: uuidv7(),
        }),
      ).rejects.toBeInstanceOf(InsufficientCreditsError)
      expect(await credits.balance(u.id, 'session')).toBe(0)
    })

    it('debit on world_gen does not see session credits', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift' })

      const { InsufficientCreditsError } = await import('../credits-errors.js')
      await expect(
        credits.atomicDebit({
          userId: u.id,
          creditType: 'world_gen',
          amount: 1,
          sourceId: uuidv7(),
        }),
      ).rejects.toBeInstanceOf(InsufficientCreditsError)
      expect(await credits.balance(u.id, 'session')).toBe(5)
    })

    it('throws on amount <= 0', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await expect(
        credits.atomicDebit({
          userId: u.id,
          creditType: 'session',
          amount: 0,
          sourceId: uuidv7(),
        }),
      ).rejects.toThrow(/amount must be > 0/)
    })

    it('throws on empty sourceId', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await expect(
        credits.atomicDebit({
          userId: u.id,
          creditType: 'session',
          amount: 1,
          sourceId: '',
        }),
      ).rejects.toThrow(/sourceId required/)
    })

    it('throws UserNotFoundError when user does not exist', async () => {
      const credits = createCreditsRepo(pool)
      const fakeId = '019dccef-0000-7000-8000-000000000001'

      const { UserNotFoundError } = await import('../credits-errors.js')
      await expect(
        credits.atomicDebit({
          userId: fakeId,
          creditType: 'session',
          amount: 1,
          sourceId: uuidv7(),
        }),
      ).rejects.toBeInstanceOf(UserNotFoundError)
    })

    it('idempotent retry returns the prior entry, no second insert', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift' })

      const sourceId = uuidv7()
      const { entry: first } = await credits.atomicDebit({
        userId: u.id,
        creditType: 'session',
        amount: 1,
        sourceId,
      })
      const { entry: second } = await credits.atomicDebit({
        userId: u.id,
        creditType: 'session',
        amount: 1,
        sourceId,
      })

      expect(second.id).toBe(first.id)
      expect(await credits.balance(u.id, 'session')).toBe(4)

      // Verify only one debit row exists.
      const count = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM credit_ledger
          WHERE user_id = $1 AND source_type = 'debit'`,
        [u.id],
      )
      expect(Number(count.rows[0]?.count)).toBe(1)
    })

    it('idempotency conflict on amount mismatch throws IdempotencyConflictError', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift' })

      const sourceId = uuidv7()
      await credits.atomicDebit({
        userId: u.id,
        creditType: 'session',
        amount: 1,
        sourceId,
      })

      const { IdempotencyConflictError } = await import('../credits-errors.js')
      await expect(
        credits.atomicDebit({
          userId: u.id,
          creditType: 'session',
          amount: 2,
          sourceId,
        }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError)

      // Ledger unchanged: still one debit row of -1.
      const result = await pool.query<{ amount: number }>(
        `SELECT amount FROM credit_ledger WHERE user_id = $1 AND source_type = 'debit'`,
        [u.id],
      )
      expect(result.rows.map((r) => r.amount)).toEqual([-1])
    })

    it('different sourceIds stay distinct', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift' })

      await credits.atomicDebit({
        userId: u.id,
        creditType: 'session',
        amount: 1,
        sourceId: uuidv7(),
      })
      await credits.atomicDebit({
        userId: u.id,
        creditType: 'session',
        amount: 1,
        sourceId: uuidv7(),
      })

      expect(await credits.balance(u.id, 'session')).toBe(3)
    })

    it('cross-credit-type same sourceId both succeed (sequential)', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift' })
      await credits.grant({ userId: u.id, creditType: 'world_gen', amount: 2, sourceType: 'gift' })

      const sharedSourceId = uuidv7()
      await credits.atomicDebit({
        userId: u.id,
        creditType: 'session',
        amount: 1,
        sourceId: sharedSourceId,
      })
      await credits.atomicDebit({
        userId: u.id,
        creditType: 'world_gen',
        amount: 1,
        sourceId: sharedSourceId,
      })

      expect(await credits.balance(u.id, 'session')).toBe(4)
      expect(await credits.balance(u.id, 'world_gen')).toBe(1)
    })
  })

  describe('listEntries()', () => {
    it('returns DESC by (granted_at, id), default limit 100', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)

      const a = await credits.grant({
        userId: u.id,
        creditType: 'session',
        amount: 5,
        sourceType: 'gift',
      })
      const b = await credits.grant({
        userId: u.id,
        creditType: 'session',
        amount: 3,
        sourceType: 'gift',
      })
      const c = await credits.atomicDebit({
        userId: u.id,
        creditType: 'session',
        amount: 1,
        sourceId: uuidv7(),
      })

      const entries = await credits.listEntries(u.id)
      const ids = entries.map((e) => e.id)
      expect(entries.length).toBe(3)
      // Most recent first.
      expect(ids[0]).toBe(c.entry.id)
      expect(ids).toContain(a.id)
      expect(ids).toContain(b.id)
    })

    it('credit-type filter narrows', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 1, sourceType: 'gift' })
      await credits.grant({ userId: u.id, creditType: 'world_gen', amount: 1, sourceType: 'gift' })

      const sessionOnly = await credits.listEntries(u.id, { type: 'session' })
      expect(sessionOnly.length).toBe(1)
      expect(sessionOnly[0]?.creditType).toBe('session')
    })

    it('includes expired entries (audit view, not balance view)', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await credits.grant({
        userId: u.id,
        creditType: 'session',
        amount: 5,
        sourceType: 'gift',
        expiresAt: new Date(Date.now() - 86_400_000),
      })
      const all = await credits.listEntries(u.id)
      expect(all.length).toBe(1)
      // Balance excludes expired.
      expect(await credits.balance(u.id, 'session')).toBe(0)
    })

    it('returns consumedSourceType="trial" when only trial credit exists', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 1, sourceType: 'trial' })
      const result = await credits.atomicDebit({
        userId: u.id,
        creditType: 'session',
        amount: 1,
        sourceId: uuidv7(),
      })
      expect(result.consumedSourceType).toBe('trial')
    })

    it('returns consumedSourceType="gift" when only gift credit exists', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 1, sourceType: 'gift' })
      const result = await credits.atomicDebit({
        userId: u.id,
        creditType: 'session',
        amount: 1,
        sourceId: uuidv7(),
      })
      expect(result.consumedSourceType).toBe('gift')
    })
  })

  describe('schema invariants (migration 004)', () => {
    it('polarity CHECK rejects positive amount with source_type=debit', async () => {
      const users = createUsersRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await expect(
        pool.query(
          `INSERT INTO credit_ledger
             (id, user_id, credit_type, amount, source_type, source_id)
           VALUES (gen_random_uuid(), $1, 'session', 1, 'debit', $2)`,
          [u.id, uuidv7()],
        ),
      ).rejects.toThrow(/credit_ledger_polarity_chk/)
    })

    it('polarity CHECK rejects negative amount with source_type=subscription', async () => {
      const users = createUsersRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await expect(
        pool.query(
          `INSERT INTO credit_ledger
             (id, user_id, credit_type, amount, source_type)
           VALUES (gen_random_uuid(), $1, 'session', -1, 'subscription')`,
          [u.id],
        ),
      ).rejects.toThrow(/credit_ledger_polarity_chk/)
    })

    it('debit_has_source_chk rejects NULL source_id with source_type=debit', async () => {
      const users = createUsersRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await expect(
        pool.query(
          `INSERT INTO credit_ledger
             (id, user_id, credit_type, amount, source_type, source_id)
           VALUES (gen_random_uuid(), $1, 'session', -1, 'debit', NULL)`,
          [u.id],
        ),
      ).rejects.toThrow(/credit_ledger_debit_has_source_chk/)
    })

    it('debit_no_expiry_chk rejects expires_at on a debit row', async () => {
      const users = createUsersRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await expect(
        pool.query(
          `INSERT INTO credit_ledger
             (id, user_id, credit_type, amount, source_type, source_id, expires_at)
           VALUES (gen_random_uuid(), $1, 'session', -1, 'debit', $2, now() + interval '1 day')`,
          [u.id, uuidv7()],
        ),
      ).rejects.toThrow(/credit_ledger_debit_no_expiry_chk/)
    })

    it('idempotency partial unique index rejects duplicate (user_id, credit_type, source_id) for debits', async () => {
      const users = createUsersRepo(pool)
      const u = await users.create(pool, baseUserInput)
      const sharedSourceId = uuidv7()
      await pool.query(
        `INSERT INTO credit_ledger
           (id, user_id, credit_type, amount, source_type, source_id)
         VALUES (gen_random_uuid(), $1, 'session', -1, 'debit', $2)`,
        [u.id, sharedSourceId],
      )
      await expect(
        pool.query(
          `INSERT INTO credit_ledger
             (id, user_id, credit_type, amount, source_type, source_id)
           VALUES (gen_random_uuid(), $1, 'session', -1, 'debit', $2)`,
          [u.id, sharedSourceId],
        ),
      ).rejects.toThrow(/uniq_credit_ledger_debit_idempotency/)
    })

    it('FK ON DELETE RESTRICT rejects user deletion when ledger rows exist', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(pool, baseUserInput)
      await credits.grant({
        userId: u.id,
        creditType: 'session',
        amount: 1,
        sourceType: 'gift',
      })
      await expect(pool.query('DELETE FROM users WHERE id = $1', [u.id])).rejects.toThrow(
        /credit_ledger_user_id_fkey/,
      )
    })

    it('idempotency SELECT plan uses the partial unique index (EXPLAIN)', async () => {
      const users = createUsersRepo(pool)
      const u = await users.create(pool, baseUserInput)
      // Insert one debit so the planner has stats to work with.
      await pool.query(
        `INSERT INTO credit_ledger
           (id, user_id, credit_type, amount, source_type, source_id)
         VALUES (gen_random_uuid(), $1, 'session', -1, 'debit', $2)`,
        [u.id, uuidv7()],
      )

      const result = await pool.query<{ 'QUERY PLAN': unknown[] }>(
        `EXPLAIN (FORMAT JSON)
         SELECT * FROM credit_ledger
          WHERE user_id = $1 AND credit_type = $2
            AND source_type = 'debit' AND source_id = $3`,
        [u.id, 'session', uuidv7()],
      )
      const plan = JSON.stringify(result.rows[0])
      expect(plan).toMatch(/uniq_credit_ledger_debit_idempotency/)
    })
  })
})

const RACE_ITERATIONS_CRITICAL = 100
const RACE_ITERATIONS_PAIRED = 50

describe('credits repo — concurrency (separate pool)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 4 })
    // Schema already prepared by the main suite's beforeAll. We only need a
    // fresh pool with concurrent-connection capacity.
  })

  afterAll(async () => {
    await pool.end()
  })

  // The concurrency tests only touch users + credit_ledger; resetCreditsData
  // is ~50x faster than the full TRUNCATE-38-tables resetData(). With 100
  // iterations per race test, the difference is the gap between hitting the
  // 60s timeout and finishing in ~10s.
  beforeEach(async () => {
    await resetCreditsData(pool)
  })

  it('two parallel debits on user with 1 credit — exactly one succeeds', async () => {
    const users = createUsersRepo(pool)
    const credits = createCreditsRepo(pool)

    for (let i = 0; i < RACE_ITERATIONS_CRITICAL; i++) {
      await resetCreditsData(pool)
      const u = await users.create(pool, {
        ...baseUserInput,
        cognitoSub: `sub-race-${String(i)}`,
        username: `race${String(i)}`,
      })
      await credits.grant({
        userId: u.id,
        creditType: 'session',
        amount: 1,
        sourceType: 'gift',
      })

      const { InsufficientCreditsError } = await import('../credits-errors.js')

      const results = await Promise.allSettled([
        credits.atomicDebit({
          userId: u.id,
          creditType: 'session',
          amount: 1,
          sourceId: uuidv7(),
        }),
        credits.atomicDebit({
          userId: u.id,
          creditType: 'session',
          amount: 1,
          sourceId: uuidv7(),
        }),
      ])

      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')
      expect(fulfilled.length).toBe(1)
      expect(rejected.length).toBe(1)
      expect(rejected[0]?.reason).toBeInstanceOf(InsufficientCreditsError)
      expect(await credits.balance(u.id, 'session')).toBe(0)
    }
  }, 60_000)

  it('empty-ledger race — both throw InsufficientCreditsError, ledger empty', async () => {
    const users = createUsersRepo(pool)
    const credits = createCreditsRepo(pool)

    for (let i = 0; i < RACE_ITERATIONS_CRITICAL; i++) {
      await resetCreditsData(pool)
      const u = await users.create(pool, {
        ...baseUserInput,
        cognitoSub: `sub-empty-${String(i)}`,
        username: `empty${String(i)}`,
      })

      const { InsufficientCreditsError } = await import('../credits-errors.js')

      const results = await Promise.allSettled([
        credits.atomicDebit({
          userId: u.id,
          creditType: 'session',
          amount: 1,
          sourceId: uuidv7(),
        }),
        credits.atomicDebit({
          userId: u.id,
          creditType: 'session',
          amount: 1,
          sourceId: uuidv7(),
        }),
      ])

      expect(results.every((r) => r.status === 'rejected')).toBe(true)
      expect(
        results.every(
          (r): boolean => r.status === 'rejected' && r.reason instanceof InsufficientCreditsError,
        ),
      ).toBe(true)

      const ledger = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM credit_ledger WHERE user_id = $1`,
        [u.id],
      )
      expect(Number(ledger.rows[0]?.count)).toBe(0)
    }
  }, 60_000)

  it('parallel same-sourceId debits — exactly one inserts, other returns same entry', async () => {
    const users = createUsersRepo(pool)
    const credits = createCreditsRepo(pool)

    for (let i = 0; i < RACE_ITERATIONS_PAIRED; i++) {
      await resetCreditsData(pool)
      const u = await users.create(pool, {
        ...baseUserInput,
        cognitoSub: `sub-same-${String(i)}`,
        username: `same${String(i)}`,
      })
      await credits.grant({
        userId: u.id,
        creditType: 'session',
        amount: 5,
        sourceType: 'gift',
      })

      const sourceId = uuidv7()
      const [r1, r2] = await Promise.all([
        credits.atomicDebit({
          userId: u.id,
          creditType: 'session',
          amount: 1,
          sourceId,
        }),
        credits.atomicDebit({
          userId: u.id,
          creditType: 'session',
          amount: 1,
          sourceId,
        }),
      ])

      expect(r1.entry.id).toBe(r2.entry.id)
      expect(await credits.balance(u.id, 'session')).toBe(4)

      const debitCount = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM credit_ledger
          WHERE user_id = $1 AND source_type = 'debit'`,
        [u.id],
      )
      expect(Number(debitCount.rows[0]?.count)).toBe(1)
    }
  }, 60_000)

  it('lock_timeout fires DebitTimeoutError with sqlstate=55P03', async () => {
    const users = createUsersRepo(pool)
    const credits = createCreditsRepo(pool)
    // Tighten the lock timeout for this test so we don't wait the full 1s default.
    const fastCredits = createCreditsRepo(pool, { debitLockTimeoutMs: 200 })

    const u = await users.create(pool, {
      ...baseUserInput,
      cognitoSub: 'sub-lock-timeout',
      username: 'locktimeout',
    })
    await credits.grant({ userId: u.id, creditType: 'session', amount: 1, sourceType: 'gift' })

    // Hold the users-row lock on a separate connection. Holder MUST NOT set
    // lock_timeout/statement_timeout — otherwise it self-cancels before the
    // racer can experience contention. (Pool defaults could re-enable them
    // implicitly; explicit unset on this connection.)
    const holder = await pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [u.id])

      const { DebitTimeoutError } = await import('../credits-errors.js')
      let caught: unknown
      const start = Date.now()
      try {
        await fastCredits.atomicDebit({
          userId: u.id,
          creditType: 'session',
          amount: 1,
          sourceId: uuidv7(),
        })
      } catch (e) {
        caught = e
      }
      const elapsed = Date.now() - start

      expect(caught).toBeInstanceOf(DebitTimeoutError)
      expect((caught as InstanceType<typeof DebitTimeoutError>).sqlstate).toBe('55P03')
      // Should have waited approximately the lock timeout (200ms), not the
      // full holder-held duration. Tight upper bound to catch a regression
      // where the lock_timeout doesn't fire and we wait until something else.
      expect(elapsed).toBeGreaterThanOrEqual(150)
      expect(elapsed).toBeLessThan(2000)
    } finally {
      // Release the holder cleanly even if the test failed.
      await holder.query('ROLLBACK').catch(() => {
        // Ignore — connection may already be in failed state.
      })
      holder.release()
    }
  }, 10_000)

  it('every error path issues ROLLBACK (no idle-in-transaction leaks)', async () => {
    const users = createUsersRepo(pool)
    const credits = createCreditsRepo(pool)
    const u = await users.create(pool, {
      ...baseUserInput,
      cognitoSub: 'sub-rollback',
      username: 'rollback',
    })
    await credits.grant({ userId: u.id, creditType: 'session', amount: 1, sourceType: 'gift' })

    // Trigger each error class once, in sequence.
    const fakeId = '019dccef-0000-7000-8000-000000000999'

    // UserNotFoundError — userId doesn't exist.
    await credits
      .atomicDebit({ userId: fakeId, creditType: 'session', amount: 1, sourceId: uuidv7() })
      .catch(() => {
        /* expected */
      })

    // InsufficientCreditsError — request more than available.
    await credits
      .atomicDebit({ userId: u.id, creditType: 'session', amount: 99, sourceId: uuidv7() })
      .catch(() => {
        /* expected */
      })

    // Successful debit (consumes the 1 credit).
    const okSourceId = uuidv7()
    await credits.atomicDebit({
      userId: u.id,
      creditType: 'session',
      amount: 1,
      sourceId: okSourceId,
    })

    // IdempotencyConflictError — same sourceId with different amount.
    await credits
      .atomicDebit({
        userId: u.id,
        creditType: 'session',
        amount: 2,
        sourceId: okSourceId,
      })
      .catch(() => {
        /* expected */
      })

    // After all that activity, no connection should be stuck "idle in transaction".
    // The query joins on the test database to scope the assertion to this run.
    const idleRes = await pool.query<{ count: string }>(
      `SELECT count(*)::text
         FROM pg_stat_activity
        WHERE state = 'idle in transaction'
          AND datname = current_database()`,
    )
    // Allow up to 1 idle (a pool client between queries can briefly look idle).
    expect(Number(idleRes.rows[0]?.count ?? 0)).toBeLessThanOrEqual(1)
  }, 10_000)
})
