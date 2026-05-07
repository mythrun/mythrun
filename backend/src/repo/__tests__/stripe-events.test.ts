import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { withTx, pool, ensureSchema } from './_helpers/with-tx.js'
import { resetData } from './_helpers/reset-data.js'
import { stripeEvents } from '../stripe-events.js'

beforeAll(async () => {
  await ensureSchema()
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await resetData(pool)
})

describe('repo.stripeEvents.recordOrSkip', () => {
  it('returns "inserted" on first write and "duplicate" on second', async () => {
    await withTx(async (tx) => {
      const first = await stripeEvents.recordOrSkip(tx, 'evt_test_1', 'invoice.paid')
      expect(first).toBe('inserted')
      const second = await stripeEvents.recordOrSkip(tx, 'evt_test_1', 'invoice.paid')
      expect(second).toBe('duplicate')
    })
  })
})
