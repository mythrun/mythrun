import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { createTestUser } from './_helpers/create-test-user.js'
import { cleanupTestScope, makeTestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'
import { purchasesNs } from '../purchases.js'
import type { ClientLike } from '../_types.js'
import { uuidv7 } from '../uuidv7.js'

// myth-oehx wave 4e: resetData + withTx removed. credit_ledger has RESTRICT-FK
// to purchases; we don't insert into credit_ledger here, so a local delete of
// purchases keyed on this scope's users (before cleanupTestScope removes the
// users) is sufficient.
const pool = createTestPool(process.env.DATABASE_URL ?? '')
const scope = makeTestScope('purchases')

async function cleanupPurchasesScope(): Promise<void> {
  await pool.query(
    `DELETE FROM purchases
       WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
    [`${scope.id}%`],
  )
  await cleanupTestScope(pool, scope)
}

afterAll(async () => {
  await cleanupPurchasesScope()
  await pool.end()
})

beforeEach(async () => {
  await cleanupPurchasesScope()
})

describe('repo.purchases', () => {
  it('insertMany writes one row per (PI, lookup_key); composite UNIQUE blocks duplicates', async () => {
    const user = await createTestUser(pool, scope, { sub: scope.userSub(0) })
    await purchasesNs(pool).insertMany([
      {
        id: uuidv7(),
        user_id: user.id,
        stripe_payment_intent_id: 'pi_test_1',
        lookup_key: 'sku_session',
        quantity: 3,
        amount_cents: 1500,
        currency: 'usd',
      },
      {
        id: uuidv7(),
        user_id: user.id,
        stripe_payment_intent_id: 'pi_test_1',
        lookup_key: 'sku_world',
        quantity: 1,
        amount_cents: 1000,
        currency: 'usd',
      },
    ])
    const got = await purchasesNs(pool).getByPaymentIntent('pi_test_1')
    expect(got).toHaveLength(2)
    // Inserting (pi_test_1, sku_session) again raises 23505
    await expect(
      purchasesNs(pool).insertMany([
        {
          id: uuidv7(),
          user_id: user.id,
          stripe_payment_intent_id: 'pi_test_1',
          lookup_key: 'sku_session',
          quantity: 1,
          amount_cents: 500,
          currency: 'usd',
        },
      ]),
    ).rejects.toThrow(/duplicate key/)
  })

  it('getByPaymentIntent returns rows ORDER BY id ASC for deterministic concurrent-handler iteration', async () => {
    const user = await createTestUser(pool, scope, { sub: scope.userSub(0) })
    const ids = [uuidv7(), uuidv7(), uuidv7()]
    const lookupKeys: string[] = ['sku_session', 'sku_world', 'sku_session_pack_3']
    await purchasesNs(pool).insertMany(
      ids.map((id, i) => ({
        id,
        user_id: user.id,
        stripe_payment_intent_id: 'pi_test_2',
        lookup_key: lookupKeys[i] ?? 'sku_fallback',
        quantity: 1,
        amount_cents: 500,
        currency: 'usd',
      })),
    )
    const got = await purchasesNs(pool).getByPaymentIntent('pi_test_2')
    const sorted = [...ids].sort()
    expect(got.map((r) => r.id)).toEqual(sorted)
  })

  it('insertMany returns immediately on an empty rows array (no DB call)', async () => {
    // No tx needed — the function must early-return before issuing any query.
    // Pass a fake ClientLike whose .query would throw to prove no call lands.
    const fakeTx = {
      query: () => {
        throw new Error('should not be called for empty rows')
      },
    }

    await purchasesNs(fakeTx).insertMany([])
  })

  it('markRefunded normalizes a null pg rowCount to 0 (defensive ?? branch)', async () => {
    // Construct a fake ClientLike whose UPDATE returns rowCount=null.
    // (Real pg never does this for UPDATE, but the `?? 0` exists for safety.)
    const fakeTx = {
      query: () => Promise.resolve({ rows: [], rowCount: null }),
    }
    const result = await purchasesNs(fakeTx as unknown as ClientLike).markRefunded(uuidv7())
    expect(result.rowsAffected).toBe(0)
  })

  it('markRefunded is idempotent — second call sees status=refunded already, returns rowcount 0 cleanly', async () => {
    const user = await createTestUser(pool, scope, { sub: scope.userSub(0) })
    const id = uuidv7()
    await purchasesNs(pool).insertMany([
      {
        id,
        user_id: user.id,
        stripe_payment_intent_id: 'pi_test_3',
        lookup_key: 'sku_session',
        quantity: 1,
        amount_cents: 500,
        currency: 'usd',
      },
    ])
    const r1 = await purchasesNs(pool).markRefunded(id)
    expect(r1.rowsAffected).toBe(1)
    const r2 = await purchasesNs(pool).markRefunded(id)
    expect(r2.rowsAffected).toBe(0) // status='completed' predicate filters out the already-refunded row
  })
})
