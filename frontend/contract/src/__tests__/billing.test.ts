import { describe, it, expect } from 'vitest'
import { BalanceResponseSchema } from '../rest/index.js'

// Contract test for GET /api/billing/balance. Asserts the schema mirrors the
// REAL (snake_case) handler wire shape — both the subscription-present and the
// null-subscription variants — and that the WIRE shape (ISO string, never a
// Date) is enforced. The companion compile-time check is the handler's
// `satisfies BalanceResponse` (verified by the backend typecheck).
describe('@mythrun/contract/rest — BalanceResponseSchema', () => {
  it('parses the real handler shape with an active subscription present', () => {
    const parsed = BalanceResponseSchema.parse({
      session: 12,
      world_gen: 3,
      active_subscription: {
        tier_lookup_key: 'adventurer_monthly',
        current_period_end: '2026-07-01T00:00:00.000Z',
        cancel_at_period_end: false,
        status: 'active',
      },
    })
    expect(parsed.session).toBe(12)
    expect(parsed.world_gen).toBe(3)
    expect(parsed.active_subscription?.tier_lookup_key).toBe('adventurer_monthly')
    expect(parsed.active_subscription?.current_period_end).toBe('2026-07-01T00:00:00.000Z')
  })

  it('parses the real handler shape with active_subscription === null', () => {
    const parsed = BalanceResponseSchema.parse({
      session: 0,
      world_gen: 0,
      active_subscription: null,
    })
    expect(parsed.active_subscription).toBeNull()
  })

  it('REJECTS a Date for current_period_end (wire shape is an ISO string, never a Date)', () => {
    expect(() =>
      BalanceResponseSchema.parse({
        session: 1,
        world_gen: 1,
        active_subscription: {
          // A real Date — the handler calls `.toISOString()` before send, so the
          // WIRE value is always a string. Modeling the wire means this must fail.
          tier_lookup_key: 'adventurer_monthly',
          current_period_end: new Date(),
          cancel_at_period_end: false,
          status: 'active',
        },
      }),
    ).toThrow()
  })

  it('rejects a non-number session balance', () => {
    expect(() =>
      BalanceResponseSchema.parse({ session: '12', world_gen: 0, active_subscription: null }),
    ).toThrow()
  })

  it('rejects a missing active_subscription key (must be present, object-or-null)', () => {
    expect(() => BalanceResponseSchema.parse({ session: 1, world_gen: 1 })).toThrow()
  })
})
