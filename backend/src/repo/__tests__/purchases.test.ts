import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { withTx, pool, ensureSchema } from './_helpers/with-tx.js'
import { resetData } from './_helpers/reset-data.js'
import { createTestUser } from './_helpers/create-test-user.js'
import { makeTestScope } from './_helpers/test-scope.js'
import { purchases } from '../purchases.js'
import type { ClientLike } from '../_types.js'
import { uuidv7 } from '../uuidv7.js'

const scope = makeTestScope('purchases')

beforeAll(async () => {
  await ensureSchema()
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await resetData(pool)
})

describe('repo.purchases', () => {
  it('insertMany writes one row per (PI, lookup_key); composite UNIQUE blocks duplicates', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx, scope, { sub: scope.userSub(0) })
      await purchases.insertMany(tx, [
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
      const got = await purchases.getByPaymentIntent(tx, 'pi_test_1')
      expect(got).toHaveLength(2)
      // Inserting (pi_test_1, sku_session) again raises 23505
      await expect(
        purchases.insertMany(tx, [
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
  })

  it('getByPaymentIntent returns rows ORDER BY id ASC for deterministic concurrent-handler iteration', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx, scope, { sub: scope.userSub(0) })
      const ids = [uuidv7(), uuidv7(), uuidv7()]
      const lookupKeys: string[] = ['sku_session', 'sku_world', 'sku_session_pack_3']
      await purchases.insertMany(
        tx,
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
      const got = await purchases.getByPaymentIntent(tx, 'pi_test_2')
      const sorted = [...ids].sort()
      expect(got.map((r) => r.id)).toEqual(sorted)
    })
  })

  it('insertMany returns immediately on an empty rows array (no DB call)', async () => {
    // No tx needed — the function must early-return before issuing any query.
    // Pass a fake ClientLike whose .query would throw to prove no call lands.
    const fakeTx = {
      query: () => {
        throw new Error('should not be called for empty rows')
      },
    }
     
    await purchases.insertMany(fakeTx, [])
  })

  it('markRefunded normalizes a null pg rowCount to 0 (defensive ?? branch)', async () => {
    // Construct a fake ClientLike whose UPDATE returns rowCount=null.
    // (Real pg never does this for UPDATE, but the `?? 0` exists for safety.)
    const fakeTx = {
      query: () => Promise.resolve({ rows: [], rowCount: null }),
    }
    const result = await purchases.markRefunded(fakeTx as unknown as ClientLike, uuidv7())
    expect(result.rowsAffected).toBe(0)
  })

  it('markRefunded is idempotent — second call sees status=refunded already, returns rowcount 0 cleanly', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx, scope, { sub: scope.userSub(0) })
      const id = uuidv7()
      await purchases.insertMany(tx, [
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
      const r1 = await purchases.markRefunded(tx, id)
      expect(r1.rowsAffected).toBe(1)
      const r2 = await purchases.markRefunded(tx, id)
      expect(r2.rowsAffected).toBe(0) // status='completed' predicate filters out the already-refunded row
    })
  })
})
