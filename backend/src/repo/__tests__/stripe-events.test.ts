import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { makeTestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'
import { stripeEventsNs } from '../stripe-events.js'

// myth-oehx wave 4e: resetData + withTx removed. stripe_events rows aren't
// reachable by cleanupTestScope (they have no user_id link), so we delete
// them by scope-prefixed event_id pattern.
const pool = createTestPool(process.env.DATABASE_URL ?? '')
const scope = makeTestScope('stripeevt')

async function cleanupStripeEventsScope(): Promise<void> {
  await pool.query(`DELETE FROM stripe_events WHERE event_id LIKE $1`, [`evt_${scope.id}%`])
}

afterAll(async () => {
  await cleanupStripeEventsScope()
  await pool.end()
})

beforeEach(async () => {
  await cleanupStripeEventsScope()
})

describe('repo.stripeEvents.recordOrSkip', () => {
  it('returns "inserted" on first write and "duplicate" on second', async () => {
    const eventId = `evt_${scope.id}_1`
    const first = await stripeEventsNs(pool).recordOrSkip(eventId, 'invoice.paid')
    expect(first).toBe('inserted')
    const second = await stripeEventsNs(pool).recordOrSkip(eventId, 'invoice.paid')
    expect(second).toBe('duplicate')
  })
})
