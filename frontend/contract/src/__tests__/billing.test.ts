import { describe, it, expect } from 'vitest'
import {
  BalanceResponseSchema,
  LookupKeySchema,
  SkuListingSchema,
  SkuListingResponseSchema,
  BillingHistoryEventSchema,
  BillingHistoryResponseSchema,
  CheckoutResponseSchema,
  PortalResponseSchema,
  UpgradeTierResponseSchema,
} from '../rest/index.js'

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

// MYT-95 — the billing-screens response contract. Each schema mirrors the EXACT
// wire shape the shipped route sends (grounded in backend/src/billing/sku-cache.ts,
// backend/src/repo/billing-history.ts, and the GET/POST handlers in
// backend/src/routes/billing.ts). snake_case throughout — the routes are
// hand-shaped and emit snake_case keys.
describe('@mythrun/contract/rest — LookupKeySchema', () => {
  it('parses every backend lookup_key (the closed SKU enum)', () => {
    for (const key of [
      'tier_wayfarer',
      'tier_sojourner',
      'tier_mythwright',
      'sku_session',
      'sku_world',
    ]) {
      expect(LookupKeySchema.parse(key)).toBe(key)
    }
  })

  it('exposes the enum values via `.options` (the drift-pin surface)', () => {
    expect(new Set(LookupKeySchema.options)).toEqual(
      new Set(['tier_wayfarer', 'tier_sojourner', 'tier_mythwright', 'sku_session', 'sku_world']),
    )
  })

  it('rejects an unknown lookup_key', () => {
    expect(() => LookupKeySchema.parse('tier_legend')).toThrow()
  })
})

describe('@mythrun/contract/rest — SkuListing / SkuListingResponse', () => {
  const recurringSku = {
    lookup_key: 'tier_wayfarer',
    displayName: 'Wayfarer',
    type: 'recurring',
    sessionsGranted: 4,
    worldsGranted: 1,
    price: { unit_amount_cents: 1200, currency: 'usd' },
  }
  const oneTimeSku = {
    lookup_key: 'sku_session',
    displayName: 'Session',
    type: 'one_time',
    sessionsGranted: 1,
    worldsGranted: 0,
    price: { unit_amount_cents: 500, currency: 'usd' },
  }

  it('parses a valid public listing array (recurring + one_time)', () => {
    const parsed = SkuListingResponseSchema.parse([recurringSku, oneTimeSku])
    expect(parsed).toHaveLength(2)
    expect(parsed[0]?.lookup_key).toBe('tier_wayfarer')
    expect(parsed[0]?.price.unit_amount_cents).toBe(1200)
    expect(parsed[1]?.type).toBe('one_time')
  })

  it('parses a single valid listing', () => {
    expect(SkuListingSchema.parse(recurringSku).displayName).toBe('Wayfarer')
  })

  it('REJECTS a listing missing the price object', () => {
    const noPrice = {
      lookup_key: 'tier_wayfarer',
      displayName: 'Wayfarer',
      type: 'recurring',
      sessionsGranted: 4,
      worldsGranted: 1,
    }
    expect(() => SkuListingSchema.parse(noPrice)).toThrow()
  })

  it('REJECTS a listing carrying stripe_price_id-only shape (no unit_amount_cents)', () => {
    expect(() =>
      SkuListingSchema.parse({ ...recurringSku, price: { currency: 'usd' } }),
    ).toThrow()
  })

  it('rejects an unknown lookup_key inside a listing', () => {
    expect(() => SkuListingSchema.parse({ ...recurringSku, lookup_key: 'tier_legend' })).toThrow()
  })

  it('rejects an unknown type', () => {
    expect(() => SkuListingSchema.parse({ ...recurringSku, type: 'metered' })).toThrow()
  })
})

describe('@mythrun/contract/rest — BillingHistoryEvent / BillingHistoryResponse', () => {
  const invoiceRow = {
    id: '019827c5-0000-7000-8000-000000000001',
    kind: 'invoice',
    occurred_at: '2026-07-01T00:00:00.000Z',
    amount_cents: 1600,
    currency: 'usd',
    lookup_key: 'tier_mythwright',
    status: 'completed',
    source_id_stripe: 'in_123',
  }
  const packRow = {
    id: '019827c5-0000-7000-8000-000000000002',
    kind: 'purchase',
    occurred_at: '2026-07-02T00:00:00.000Z',
    amount_cents: 500,
    currency: 'usd',
    lookup_key: null,
    status: 'completed',
    source_id_stripe: 'pi_123',
  }

  it('parses a valid history response (invoice row + à-la-carte pack row)', () => {
    const parsed = BillingHistoryResponseSchema.parse({
      events: [invoiceRow, packRow],
      nextCursor: null,
    })
    expect(parsed.events).toHaveLength(2)
    expect(parsed.nextCursor).toBeNull()
  })

  it('parses an à-la-carte pack row with lookup_key === null', () => {
    const parsed = BillingHistoryEventSchema.parse(packRow)
    expect(parsed.lookup_key).toBeNull()
    expect(parsed.kind).toBe('purchase')
  })

  it('parses an invoice row carrying a tier lookup_key', () => {
    expect(BillingHistoryEventSchema.parse(invoiceRow).lookup_key).toBe('tier_mythwright')
  })

  it('parses a refunded row (status:refunded)', () => {
    expect(BillingHistoryEventSchema.parse({ ...invoiceRow, status: 'refunded' }).status).toBe(
      'refunded',
    )
  })

  it('parses a populated (base64url) nextCursor', () => {
    const parsed = BillingHistoryResponseSchema.parse({
      events: [invoiceRow],
      nextCursor: 'eyJ0IjoiMjAyNi0wNy0wMSJ9',
    })
    expect(parsed.nextCursor).toBe('eyJ0IjoiMjAyNi0wNy0wMSJ9')
  })

  it('REJECTS a Date for occurred_at (wire shape is an ISO string)', () => {
    expect(() => BillingHistoryEventSchema.parse({ ...invoiceRow, occurred_at: new Date() })).toThrow()
  })

  it('rejects an unknown kind', () => {
    expect(() => BillingHistoryEventSchema.parse({ ...invoiceRow, kind: 'chargeback' })).toThrow()
  })

  it('rejects an unknown status', () => {
    expect(() => BillingHistoryEventSchema.parse({ ...invoiceRow, status: 'pending' })).toThrow()
  })

  it('rejects a missing nextCursor key (must be present, string-or-null)', () => {
    expect(() => BillingHistoryResponseSchema.parse({ events: [] })).toThrow()
  })
})

describe('@mythrun/contract/rest — Checkout / Portal / UpgradeTier', () => {
  it('CheckoutResponseSchema parses { checkout_session_id, url }', () => {
    const parsed = CheckoutResponseSchema.parse({
      checkout_session_id: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    })
    expect(parsed.checkout_session_id).toBe('cs_test_123')
    expect(parsed.url).toContain('checkout.stripe.com')
  })

  it('CheckoutResponseSchema rejects a missing url', () => {
    expect(() => CheckoutResponseSchema.parse({ checkout_session_id: 'cs_test_123' })).toThrow()
  })

  it('PortalResponseSchema parses { url }', () => {
    expect(
      PortalResponseSchema.parse({ url: 'https://billing.stripe.com/p/session/abc' }).url,
    ).toContain('billing.stripe.com')
  })

  it('UpgradeTierResponseSchema parses { invoice_id: null } (items advanced, no invoice id)', () => {
    expect(UpgradeTierResponseSchema.parse({ invoice_id: null }).invoice_id).toBeNull()
  })

  it('UpgradeTierResponseSchema parses { invoice_id: <string> }', () => {
    expect(UpgradeTierResponseSchema.parse({ invoice_id: 'in_123' }).invoice_id).toBe('in_123')
  })

  it('UpgradeTierResponseSchema rejects a missing invoice_id key', () => {
    expect(() => UpgradeTierResponseSchema.parse({})).toThrow()
  })
})
