import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from 'pino'
import Stripe from 'stripe'
import {
  probeStripeContract,
  BillingProbeAuthError,
  BillingProbeStripeAPIChangeError,
  BillingProbePortalConfigError,
} from '../probe.js'
import { getSkuCache, _resetSkuCacheForTests } from '../sku-cache.js'

interface PriceFixture {
  id: string
  lookup_key: string
  currency: string
  unit_amount: number
  billing_scheme: 'per_unit' | 'tiered'
  transform_quantity: null | { divide_by: number; round: 'up' | 'down' }
  tax_behavior: 'unspecified' | 'inclusive' | 'exclusive' | null
  recurring:
    | null
    | {
        interval: 'month' | 'year' | 'week' | 'day'
        interval_count: number
        usage_type: 'licensed' | 'metered'
      }
  product: { id: string; active: boolean }
}

function tierFixture(overrides: Partial<PriceFixture> = {}): PriceFixture {
  return {
    id: 'price_tier_wayfarer',
    lookup_key: 'tier_wayfarer',
    currency: 'usd',
    unit_amount: 1500,
    billing_scheme: 'per_unit',
    transform_quantity: null,
    tax_behavior: 'unspecified',
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    product: { id: 'prod_wayfarer', active: true },
    ...overrides,
  }
}

function skuFixture(overrides: Partial<PriceFixture> = {}): PriceFixture {
  return {
    id: 'price_sku_session',
    lookup_key: 'sku_session',
    currency: 'usd',
    unit_amount: 500,
    billing_scheme: 'per_unit',
    transform_quantity: null,
    tax_behavior: 'unspecified',
    recurring: null,
    product: { id: 'prod_session', active: true },
    ...overrides,
  }
}

function allFiveFixtures(): PriceFixture[] {
  return [
    tierFixture({ id: 'price_w', lookup_key: 'tier_wayfarer', product: { id: 'p_w', active: true } }),
    tierFixture({ id: 'price_s', lookup_key: 'tier_sojourner', product: { id: 'p_s', active: true } }),
    tierFixture({ id: 'price_m', lookup_key: 'tier_mythwright', product: { id: 'p_m', active: true } }),
    skuFixture({ id: 'price_se', lookup_key: 'sku_session', product: { id: 'p_se', active: true } }),
    skuFixture({ id: 'price_wo', lookup_key: 'sku_world', product: { id: 'p_wo', active: true } }),
  ]
}

function listOk(data: PriceFixture[], hasMore = false): { data: PriceFixture[]; has_more: boolean } {
  return { data, has_more: hasMore }
}

interface LogEntry {
  level: 'info' | 'warn' | 'error'
  event: string
  bootId?: string
  attempt?: number
  attempts?: number
  err?: string
  mismatches?: readonly string[]
  count?: number
  mismatchCount?: number
  nextDelayMs?: number
}

function makeLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = []
  const make = (level: LogEntry['level']) => (obj: Record<string, unknown>) => {
    entries.push({ level, ...(obj as Omit<LogEntry, 'level'>) })
  }
  const logger = {
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
  } as unknown as Logger
  return { logger, entries }
}

interface PortalConfigFixture {
  id: string
  features: {
    subscription_update: {
      proration_behavior: 'create_prorations' | 'always_invoice' | 'none'
      schedule_at_period_end: {
        conditions: Array<{ type: 'decreasing_item_amount' | 'shortening_interval' }>
      }
      products: Array<{ product: string; prices: string[] }> | null
    }
  }
}

function portalConfigFixture(overrides: Partial<PortalConfigFixture> = {}): PortalConfigFixture {
  return {
    id: 'bpc_default',
    features: {
      subscription_update: {
        proration_behavior: 'create_prorations',
        schedule_at_period_end: {
          conditions: [{ type: 'decreasing_item_amount' }],
        },
        products: [
          { product: 'prod_w', prices: ['price_w'] },
          { product: 'prod_s', prices: ['price_s'] },
        ],
      },
    },
    ...overrides,
  }
}

function portalListOk(
  configs: PortalConfigFixture[],
): { data: PortalConfigFixture[]; has_more: boolean } {
  return { data: configs, has_more: false }
}

interface MakeStripeOptions {
  portalList?: ReturnType<typeof vi.fn>
}

function makeStripe(
  list: ReturnType<typeof vi.fn>,
  options: MakeStripeOptions = {},
): Stripe {
  const portalList =
    options.portalList ?? vi.fn().mockResolvedValue(portalListOk([portalConfigFixture()]))
  return {
    prices: { list },
    billingPortal: { configurations: { list: portalList } },
  } as unknown as Stripe
}

function stripeError(
  ctor: typeof Stripe.errors.StripeAuthenticationError,
  message: string,
  statusCode: number,
): Error {
  return new ctor({
    type: 'StripeAuthenticationError',
    message,
    raw: {},
    headers: {},
    requestId: 'req_test',
    statusCode,
  } as unknown as Stripe.StripeRawError)
}

describe('probeStripeContract', () => {
  beforeEach(() => {
    vi.useRealTimers()
    _resetSkuCacheForTests()
  })

  it('happy path — all 5 lookup_keys with correct shape → resolves', async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const { logger, entries } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).resolves.toBeUndefined()
    expect(entries.map((e) => e.event)).toContain('billing.probe_started')
    expect(entries.map((e) => e.event)).toContain('billing.probe_passed')
  })

  it('missing lookup_key → BillingProbeError with not-found message', async () => {
    const fixtures = allFiveFixtures().filter((p) => p.lookup_key !== 'tier_wayfarer')
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(
      /not found in active Stripe prices/,
    )
  })

  it('type mismatch — tier_* returned as one-time → BillingProbeError', async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'tier_wayfarer' ? { ...p, recurring: null } : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(
      /contract expects 'recurring'/,
    )
  })

  it("currency mismatch — 'eur' → BillingProbeError", async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'sku_session' ? { ...p, currency: 'eur' } : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(
      /currency 'eur'/,
    )
  })

  it('unit_amount = 0 → BillingProbeError', async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'sku_world' ? { ...p, unit_amount: 0 } : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(/unit_amount/)
  })

  it("billing_scheme = 'tiered' → BillingProbeError", async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'tier_sojourner' ? { ...p, billing_scheme: 'tiered' as const } : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(/billing_scheme/)
  })

  it('transform_quantity ≠ null → BillingProbeError', async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'sku_session'
        ? { ...p, transform_quantity: { divide_by: 2, round: 'up' as const } }
        : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(/transform_quantity/)
  })

  it("tax_behavior = 'inclusive' → BillingProbeError", async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'sku_world' ? { ...p, tax_behavior: 'inclusive' as const } : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(/tax_behavior/)
  })

  it("recurring.interval = 'year' → BillingProbeError", async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'tier_mythwright' && p.recurring
        ? { ...p, recurring: { ...p.recurring, interval: 'year' as const } }
        : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(/recurring\.interval/)
  })

  it('recurring.interval_count = 3 (quarterly) → BillingProbeError', async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'tier_wayfarer' && p.recurring
        ? { ...p, recurring: { ...p.recurring, interval_count: 3 } }
        : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(
      /recurring\.interval_count/,
    )
  })

  it("recurring.usage_type = 'metered' → BillingProbeError", async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'tier_sojourner' && p.recurring
        ? { ...p, recurring: { ...p.recurring, usage_type: 'metered' as const } }
        : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(/usage_type/)
  })

  it('archived product (product.active=false) → BillingProbeError', async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'sku_session' ? { ...p, product: { ...p.product, active: false } } : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(/archived/)
  })

  it('duplicate active lookup_key → BillingProbeError (no silent last-wins)', async () => {
    const fixtures = [
      ...allFiveFixtures(),
      tierFixture({ id: 'price_dup', lookup_key: 'tier_wayfarer', product: { id: 'p_dup', active: true } }),
    ]
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(
      /2 active Stripe prices/,
    )
  })

  it('multiple mismatches — all reported (no short-circuit)', async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'tier_sojourner' ? { ...p, currency: 'eur' } : p,
    )
    // also drop tier_mythwright entirely
    const filtered = fixtures.filter((p) => p.lookup_key !== 'tier_mythwright')
    const list = vi.fn().mockResolvedValue(listOk(filtered))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(/tier_mythwright/)
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(/tier_sojourner/)
  })

  it('has_more = true → BillingProbeStripeAPIChangeError', async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures(), true))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toBeInstanceOf(
      BillingProbeStripeAPIChangeError,
    )
  })

  it('StripeAuthenticationError (401) → BillingProbeAuthError, no retry', async () => {
    const authErr = stripeError(Stripe.errors.StripeAuthenticationError, 'Invalid API Key', 401)
    const list = vi.fn().mockRejectedValue(authErr)
    const { logger, entries } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toBeInstanceOf(
      BillingProbeAuthError,
    )
    expect(list).toHaveBeenCalledTimes(1)
    expect(entries.some((e) => e.event === 'billing.probe_auth_failed')).toBe(true)
  })

  it('StripePermissionError (403) → BillingProbeAuthError, no retry', async () => {
    const permErr = stripeError(
      Stripe.errors.StripePermissionError,
      'Restricted key missing Prices: read',
      403,
    )
    const list = vi.fn().mockRejectedValue(permErr)
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toBeInstanceOf(
      BillingProbeAuthError,
    )
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('transient error twice then success → resolves; emits 2 retry events', async () => {
    const apiErr = stripeError(Stripe.errors.StripeAPIError, '503', 503)
    const list = vi
      .fn()
      .mockRejectedValueOnce(apiErr)
      .mockRejectedValueOnce(apiErr)
      .mockResolvedValueOnce(listOk(allFiveFixtures()))
    const { logger, entries } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).resolves.toBeUndefined()
    expect(list).toHaveBeenCalledTimes(3)
    const retries = entries.filter((e) => e.event === 'billing.probe_transient_retry')
    expect(retries).toHaveLength(2)
    expect(entries.some((e) => e.event === 'billing.probe_passed')).toBe(true)
  }, 30_000)

  it('transient error 3 times → BillingProbeTransientError; emits transient_failed', async () => {
    const apiErr = stripeError(Stripe.errors.StripeAPIError, '503', 503)
    const list = vi.fn().mockRejectedValue(apiErr)
    const { logger, entries } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(/3 attempts/)
    expect(list).toHaveBeenCalledTimes(3)
    expect(entries.some((e) => e.event === 'billing.probe_transient_failed')).toBe(true)
  }, 30_000)

  it('every event emitted in a probe run carries the same bootId', async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const { logger, entries } = makeLogger()
    await probeStripeContract(makeStripe(list), logger)
    const ids = new Set(entries.map((e) => e.bootId).filter((v): v is string => typeof v === 'string'))
    expect(ids.size).toBe(1)
  })

  it('successful probe populates the SKU cache (byLookupKey, byPriceId, publicListing)', async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const { logger } = makeLogger()
    expect(getSkuCache()).toBeNull()
    await probeStripeContract(makeStripe(list), logger)
    const cache = getSkuCache()
    expect(cache).not.toBeNull()
    if (!cache) throw new Error('cache should be populated')

    expect(cache.byLookupKey.size).toBe(5)
    expect(cache.byPriceId.size).toBe(5)
    expect(cache.publicListing).toHaveLength(5)

    const wayfarer = cache.byLookupKey.get('tier_wayfarer')
    expect(wayfarer).toBeDefined()
    expect(wayfarer?.stripe_price_id).toBe('price_w')
    expect(wayfarer?.displayName).toBe('Wayfarer')
    expect(wayfarer?.type).toBe('recurring')
    expect(wayfarer?.sessionsGranted).toBe(4)
    expect(wayfarer?.worldsGranted).toBe(1)
    expect(wayfarer?.price).toEqual({ unit_amount_cents: 1500, currency: 'usd' })

    expect(cache.byPriceId.get('price_se')?.lookup_key).toBe('sku_session')

    // publicListing entries must NOT carry stripe_price_id
    for (const entry of cache.publicListing) {
      expect(Object.keys(entry)).not.toContain('stripe_price_id')
    }
  })

  it('Customer Portal config probe — happy path resolves and does not block SKU cache', async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const portalList = vi.fn().mockResolvedValue(portalListOk([portalConfigFixture()]))
    const { logger, entries } = makeLogger()
    await expect(
      probeStripeContract(makeStripe(list, { portalList }), logger),
    ).resolves.toBeUndefined()
    expect(portalList).toHaveBeenCalledTimes(1)
    expect(entries.some((e) => e.event === 'billing.probe_passed')).toBe(true)
    // SKU cache populated only after BOTH prices and portal pass
    expect(getSkuCache()).not.toBeNull()
  })

  it("Customer Portal config probe — proration_behavior 'none' → BillingProbePortalConfigError", async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const config = portalConfigFixture({
      features: {
        subscription_update: {
          proration_behavior: 'none',
          schedule_at_period_end: { conditions: [{ type: 'decreasing_item_amount' }] },
          products: [{ product: 'prod_w', prices: ['price_w'] }],
        },
      },
    })
    const portalList = vi.fn().mockResolvedValue(portalListOk([config]))
    const { logger } = makeLogger()
    await expect(
      probeStripeContract(makeStripe(list, { portalList }), logger),
    ).rejects.toBeInstanceOf(BillingProbePortalConfigError)
    await expect(
      probeStripeContract(makeStripe(list, { portalList }), logger),
    ).rejects.toThrow(/proration_behavior/)
    // cache must NOT be populated when portal probe fails
    expect(getSkuCache()).toBeNull()
  })

  it("Customer Portal config probe — schedule_at_period_end missing 'decreasing_item_amount' → BillingProbePortalConfigError", async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const config = portalConfigFixture({
      features: {
        subscription_update: {
          proration_behavior: 'create_prorations',
          schedule_at_period_end: { conditions: [{ type: 'shortening_interval' }] },
          products: [{ product: 'prod_w', prices: ['price_w'] }],
        },
      },
    })
    const portalList = vi.fn().mockResolvedValue(portalListOk([config]))
    const { logger } = makeLogger()
    await expect(
      probeStripeContract(makeStripe(list, { portalList }), logger),
    ).rejects.toBeInstanceOf(BillingProbePortalConfigError)
    await expect(
      probeStripeContract(makeStripe(list, { portalList }), logger),
    ).rejects.toThrow(/decreasing_item_amount/)
    expect(getSkuCache()).toBeNull()
  })

  it('Customer Portal config probe — empty configurations.list → BillingProbePortalConfigError', async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const portalList = vi.fn().mockResolvedValue(portalListOk([]))
    const { logger } = makeLogger()
    await expect(
      probeStripeContract(makeStripe(list, { portalList }), logger),
    ).rejects.toBeInstanceOf(BillingProbePortalConfigError)
    await expect(
      probeStripeContract(makeStripe(list, { portalList }), logger),
    ).rejects.toThrow(/no active default Customer Portal configuration/)
    expect(getSkuCache()).toBeNull()
  })
})
