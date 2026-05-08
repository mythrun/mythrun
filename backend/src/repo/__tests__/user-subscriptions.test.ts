import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { withTx, pool, ensureSchema } from './_helpers/with-tx.js'
import { resetData } from './_helpers/reset-data.js'
import { createTestUser } from './_helpers/create-test-user.js'
import { userSubscriptions, type UpsertFromStripeRow } from '../user-subscriptions.js'
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

/**
 * Build an UpsertFromStripeRow with sane defaults; tests override only the
 * fields they care about. Keeps each test focused on the contract it exercises.
 */
function makeRow(
  overrides: Partial<UpsertFromStripeRow> & Pick<UpsertFromStripeRow, 'user_id'>,
): UpsertFromStripeRow {
  return {
    id: uuidv7(),
    user_id: overrides.user_id,
    stripe_subscription_id: overrides.stripe_subscription_id ?? 'sub_test_1',
    tier_lookup_key: overrides.tier_lookup_key ?? 'tier_basic',
    status: overrides.status ?? 'active',
    current_period_start: overrides.current_period_start ?? new Date('2026-05-01T00:00:00Z'),
    current_period_end: overrides.current_period_end ?? new Date('2026-06-01T00:00:00Z'),
    cancel_at_period_end: overrides.cancel_at_period_end ?? false,
    cancel_at: overrides.cancel_at ?? null,
    cancellation_details: overrides.cancellation_details ?? null,
    stripe_event_created_at: overrides.stripe_event_created_at ?? new Date('2026-05-05T12:00:00Z'),
  }
}

describe('repo.userSubscriptions', () => {
  it('upsertFromStripe writes a fresh row with all fields', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      const row = makeRow({
        user_id: user.id,
        stripe_subscription_id: 'sub_fresh',
        tier_lookup_key: 'tier_basic',
        status: 'active',
        current_period_start: new Date('2026-05-01T00:00:00Z'),
        current_period_end: new Date('2026-06-01T00:00:00Z'),
        cancel_at_period_end: false,
        cancel_at: null,
        cancellation_details: null,
        stripe_event_created_at: new Date('2026-05-05T12:00:00Z'),
      })
      const got = await userSubscriptions.upsertFromStripe(tx, row)
      expect(got.id).toBe(row.id)
      expect(got.user_id).toBe(user.id)
      expect(got.stripe_subscription_id).toBe('sub_fresh')
      expect(got.tier_lookup_key).toBe('tier_basic')
      expect(got.status).toBe('active')
      expect(got.current_period_start.toISOString()).toBe('2026-05-01T00:00:00.000Z')
      expect(got.current_period_end.toISOString()).toBe('2026-06-01T00:00:00.000Z')
      expect(got.cancel_at_period_end).toBe(false)
      expect(got.cancel_at).toBeNull()
      expect(got.cancellation_details).toBeNull()
      expect(got.stripe_event_created_at.toISOString()).toBe('2026-05-05T12:00:00.000Z')
    })
  })

  it('upsertFromStripe rejects a stale event (T1 after T2 leaves T2 row in place)', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      const t2 = new Date('2026-05-05T12:00:02Z')
      const t1 = new Date('2026-05-05T12:00:01Z')
      // Insert T2 first (the "fresh" row).
      await userSubscriptions.upsertFromStripe(
        tx,
        makeRow({
          user_id: user.id,
          stripe_subscription_id: 'sub_stale',
          tier_lookup_key: 'tier_pro',
          stripe_event_created_at: t2,
        }),
      )
      // Now arrive an older T1 event that tries to overwrite tier_lookup_key.
      const got = await userSubscriptions.upsertFromStripe(
        tx,
        makeRow({
          user_id: user.id,
          stripe_subscription_id: 'sub_stale',
          tier_lookup_key: 'tier_basic', // would-be downgrade; must be ignored
          stripe_event_created_at: t1,
        }),
      )
      // Returned canonical row reflects T2, not T1.
      expect(got.tier_lookup_key).toBe('tier_pro')
      expect(got.stripe_event_created_at.toISOString()).toBe(t2.toISOString())
    })
  })

  it('upsertFromStripe applies a newer event (T3 after T2 updates the row)', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      const t2 = new Date('2026-05-05T12:00:02Z')
      const t3 = new Date('2026-05-05T12:00:03Z')
      await userSubscriptions.upsertFromStripe(
        tx,
        makeRow({
          user_id: user.id,
          stripe_subscription_id: 'sub_newer',
          tier_lookup_key: 'tier_basic',
          stripe_event_created_at: t2,
        }),
      )
      const got = await userSubscriptions.upsertFromStripe(
        tx,
        makeRow({
          user_id: user.id,
          stripe_subscription_id: 'sub_newer',
          tier_lookup_key: 'tier_pro', // legitimate upgrade
          stripe_event_created_at: t3,
        }),
      )
      expect(got.tier_lookup_key).toBe('tier_pro')
      expect(got.stripe_event_created_at.toISOString()).toBe(t3.toISOString())
    })
  })

  it('upsertFromStripe rejects same-second arrivals (strict > not >=)', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      const t = new Date('2026-05-05T12:00:00Z')
      await userSubscriptions.upsertFromStripe(
        tx,
        makeRow({
          user_id: user.id,
          stripe_subscription_id: 'sub_tied',
          tier_lookup_key: 'tier_basic',
          stripe_event_created_at: t,
        }),
      )
      // Same timestamp, different tier — strict > rejects this as no-op.
      const got = await userSubscriptions.upsertFromStripe(
        tx,
        makeRow({
          user_id: user.id,
          stripe_subscription_id: 'sub_tied',
          tier_lookup_key: 'tier_pro',
          stripe_event_created_at: t,
        }),
      )
      expect(got.tier_lookup_key).toBe('tier_basic')
    })
  })

  it('markCanceled preserves cancel_at_period_end=true (user-clicked path)', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      await userSubscriptions.upsertFromStripe(
        tx,
        makeRow({
          user_id: user.id,
          stripe_subscription_id: 'sub_user_cancel',
          status: 'active',
          cancel_at_period_end: false,
        }),
      )
      await userSubscriptions.markCanceled(tx, 'sub_user_cancel', {
        cancel_at_period_end: true,
        cancel_at: null,
        cancellation_details: { reason: 'cancellation_requested' },
      })
      const got = await userSubscriptions.getActiveForUser(tx, user.id)
      // 'canceled' is excluded from getActiveForUser, so row not visible there.
      expect(got).toBeNull()
      const result = await tx.query<{ status: string; cancel_at_period_end: boolean }>(
        `SELECT status, cancel_at_period_end FROM user_subscriptions WHERE stripe_subscription_id = $1`,
        ['sub_user_cancel'],
      )
      expect(result.rows[0]?.status).toBe('canceled')
      expect(result.rows[0]?.cancel_at_period_end).toBe(true)
    })
  })

  it('markCanceled preserves cancel_at_period_end=false (Stripe-initiated dunning path)', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      await userSubscriptions.upsertFromStripe(
        tx,
        makeRow({
          user_id: user.id,
          stripe_subscription_id: 'sub_dunning',
          status: 'past_due',
          cancel_at_period_end: false,
        }),
      )
      await userSubscriptions.markCanceled(tx, 'sub_dunning', {
        cancel_at_period_end: false,
        cancel_at: null,
        cancellation_details: { reason: 'payment_failed' },
      })
      const result = await tx.query<{ status: string; cancel_at_period_end: boolean }>(
        `SELECT status, cancel_at_period_end FROM user_subscriptions WHERE stripe_subscription_id = $1`,
        ['sub_dunning'],
      )
      expect(result.rows[0]?.status).toBe('canceled')
      expect(result.rows[0]?.cancel_at_period_end).toBe(false)
    })
  })

  it('markCanceled writes cancellation_details JSONB', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      await userSubscriptions.upsertFromStripe(
        tx,
        makeRow({
          user_id: user.id,
          stripe_subscription_id: 'sub_details',
          status: 'active',
        }),
      )
      const details = {
        reason: 'cancellation_requested',
        comment: 'too expensive',
        feedback: 'too_expensive',
      }
      await userSubscriptions.markCanceled(tx, 'sub_details', {
        cancel_at_period_end: true,
        cancel_at: null,
        cancellation_details: details,
      })
      const result = await tx.query<{ cancellation_details: unknown }>(
        `SELECT cancellation_details FROM user_subscriptions WHERE stripe_subscription_id = $1`,
        ['sub_details'],
      )
      expect(result.rows[0]?.cancellation_details).toEqual(details)
    })
  })

  it('markCanceled converts Unix-seconds cancel_at to TIMESTAMPTZ', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      await userSubscriptions.upsertFromStripe(
        tx,
        makeRow({
          user_id: user.id,
          stripe_subscription_id: 'sub_cancel_at',
          status: 'active',
        }),
      )
      // 1700000000 → 2023-11-14T22:13:20Z
      await userSubscriptions.markCanceled(tx, 'sub_cancel_at', {
        cancel_at_period_end: true,
        cancel_at: 1700000000,
        cancellation_details: null,
      })
      const result = await tx.query<{ cancel_at: Date }>(
        `SELECT cancel_at FROM user_subscriptions WHERE stripe_subscription_id = $1`,
        ['sub_cancel_at'],
      )
      expect(result.rows[0]?.cancel_at).toBeInstanceOf(Date)
      expect(result.rows[0]?.cancel_at.toISOString()).toBe('2023-11-14T22:13:20.000Z')
    })
  })

  it('getActiveForUser returns the row for active/trialing/past_due/unpaid/incomplete statuses', async () => {
    const activeStatuses = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'] as const
    for (const status of activeStatuses) {
      await withTx(async (tx) => {
        const user = await createTestUser(tx)
        await userSubscriptions.upsertFromStripe(
          tx,
          makeRow({
            user_id: user.id,
            stripe_subscription_id: `sub_${status}`,
            status,
          }),
        )
        const got = await userSubscriptions.getActiveForUser(tx, user.id)
        expect(got).not.toBeNull()
        expect(got?.status).toBe(status)
      })
    }
  })

  it('getActiveForUser returns null for canceled/incomplete_expired/paused statuses', async () => {
    const inactiveStatuses = ['canceled', 'incomplete_expired', 'paused'] as const
    for (const status of inactiveStatuses) {
      await withTx(async (tx) => {
        const user = await createTestUser(tx)
        await userSubscriptions.upsertFromStripe(
          tx,
          makeRow({
            user_id: user.id,
            stripe_subscription_id: `sub_${status}`,
            status,
          }),
        )
        const got = await userSubscriptions.getActiveForUser(tx, user.id)
        expect(got).toBeNull()
      })
    }
  })
})
