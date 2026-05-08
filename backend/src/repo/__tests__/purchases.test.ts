import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { withTx, pool, ensureSchema } from './_helpers/with-tx.js'
import { resetData } from './_helpers/reset-data.js'
import { createTestUser } from './_helpers/create-test-user.js'
import { purchases } from '../purchases.js'
import { uuidv7 } from '../uuidv7.js'

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
      const user = await createTestUser(tx)
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
      const user = await createTestUser(tx)
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

  it('markRefunded is idempotent — second call sees status=refunded already, returns rowcount 0 cleanly', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
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
