// Integration tests for the repo.transaction mechanics (Plan Phase 1, Task 1):
// beginPrelude / runTransaction / makeSettlingClient / ROLLBACK sentinel.
//
// Targets mythrun_test via createTestPool + scoped fixtures (see CONVENTIONS.md).
// These exercise the real BEGIN/COMMIT/ROLLBACK + SET LOCAL prelude against
// Postgres — the prelude ordering (SET LOCAL must follow BEGIN) and the
// use-after-settle guard can only be verified against a live connection.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createRepo, ROLLBACK, type TxRepo } from '../index.js'
import { runTransaction } from '../_client.js'
import type { ClientLike } from '../_types.js'
import { beginPrelude } from '../../db/transaction.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestUser } from './_helpers/create-test-user.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('repo.transaction mechanics (integration)', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('repo-transaction')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  describe('beginPrelude (unit)', () => {
    it('defaults isolation to read committed and omits unset timeouts', () => {
      expect(beginPrelude()).toBe(
        "BEGIN;\nSET LOCAL transaction_isolation = 'read committed';",
      )
    })

    it('emits SET LOCAL statements for each provided opt', () => {
      expect(
        beginPrelude({
          isolation: 'serializable',
          lockTimeoutMs: 250,
          statementTimeoutMs: 5000,
        }),
      ).toBe(
        "BEGIN;\n" +
          "SET LOCAL transaction_isolation = 'serializable';\n" +
          "SET LOCAL lock_timeout = '250ms';\n" +
          "SET LOCAL statement_timeout = '5000ms';",
      )
    })
  })

  describe('repo.transaction', () => {
    it('commits writes from the callback (grant 5 → balance 5)', async () => {
      const repo = createRepo(pool)
      const { id: userId } = await createTestUser(pool, scope, { sub: scope.userSub(0) })

      await repo.transaction(async (tx) => {
        await tx.credits.grantInTx({
          userId,
          creditType: 'world_gen',
          amount: 5,
          sourceType: 'gift',
        })
      })

      expect(await repo.credits.balance(userId, 'world_gen')).toBe(5)
    })

    it('rolls back all writes when the callback throws (balance stays 0)', async () => {
      const repo = createRepo(pool)
      const { id: userId } = await createTestUser(pool, scope, { sub: scope.userSub(1) })

      await expect(
        repo.transaction(async (tx) => {
          await tx.credits.grantInTx({
            userId,
            creditType: 'world_gen',
            amount: 5,
            sourceType: 'gift',
          })
          throw new Error('boom — should roll back the grant above')
        }),
      ).rejects.toThrow('boom')

      expect(await repo.credits.balance(userId, 'world_gen')).toBe(0)
    })

    it('returns the ROLLBACK sentinel and commits nothing on no-op discard', async () => {
      const repo = createRepo(pool)
      const { id: userId } = await createTestUser(pool, scope, { sub: scope.userSub(2) })

      const result = await repo.transaction(async (tx) => {
        await tx.credits.grantInTx({
          userId,
          creditType: 'world_gen',
          amount: 5,
          sourceType: 'gift',
        })
        return ROLLBACK
      })

      expect(result).toBe(ROLLBACK)
      expect(await repo.credits.balance(userId, 'world_gen')).toBe(0)
    })

    it('throws if a captured tx is used after the transaction settles', async () => {
      const repo = createRepo(pool)
      const { id: userId } = await createTestUser(pool, scope, { sub: scope.userSub(3) })

      let captured: TxRepo | undefined
      // Capture the tx handle (after a real read through it) and let the
      // transaction settle.
      const result = await repo.transaction(async (tx) => {
        await tx.credits.getWorldGenBalance(userId)
        captured = tx
        return ROLLBACK
      })
      expect(result).toBe(ROLLBACK)
      expect(captured).toBeDefined()

      await expect(
        captured?.credits.getWorldGenBalance(userId),
      ).rejects.toThrow(/used after the transaction settled/)
    })

    it('applies opts as SET LOCAL inside the callback', async () => {
      // Probe through runTransaction directly with a bind that surfaces a
      // raw SHOW reader — the temporary TxRepo only exposes credits, so the
      // SET LOCAL values can't be read via repo.transaction's bound surface.
      const showBind = (c: ClientLike) => ({
        show: async (name: string): Promise<string> => {
          const res = await c.query<Record<string, string>>(`SHOW ${name}`)
          // SHOW returns a single row keyed by the setting name.
          return Object.values(res.rows[0] ?? {})[0] ?? ''
        },
      })

      const settings = await runTransaction(
        pool,
        showBind,
        async (tx) => ({
          lockTimeout: await tx.show('lock_timeout'),
          isolation: await tx.show('transaction_isolation'),
        }),
        { isolation: 'repeatable read', lockTimeoutMs: 1234 },
      )

      expect(settings).not.toBe(ROLLBACK)
      if (settings === ROLLBACK) throw new Error('unreachable')
      expect(settings.lockTimeout).toBe('1234ms')
      expect(settings.isolation).toBe('repeatable read')
    })
  })
})
