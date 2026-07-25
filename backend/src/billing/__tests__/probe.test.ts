import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from 'pino'
import Stripe from 'stripe'
import {
  probeStripeContract,
  BillingProbeAuthError,
  BillingProbeStripeAPIChangeError,
  BillingProbePortalConfigError,
  BillingProbeWebhookVersionError,
} from '../probe.js'
import { STRIPE_API_VERSION } from '../stripe-client.js'
import { getSkuCache, _resetSkuCacheForTests } from '../sku-cache.js'

interface PriceFixture {
  id: string
  lookup_key: string
  currency: string
  unit_amount: number
  billing_scheme: 'per_unit' | 'tiered'
  transform_quantity: null | { divide_by: number; round: 'up' | 'down' }
  tax_behavior: 'unspecified' | 'inclusive' | 'exclusive' | null
  recurring: null | {
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
    tierFixture({
      id: 'price_w',
      lookup_key: 'tier_wayfarer',
      product: { id: 'p_w', active: true },
    }),
    tierFixture({
      id: 'price_s',
      lookup_key: 'tier_sojourner',
      product: { id: 'p_s', active: true },
    }),
    tierFixture({
      id: 'price_m',
      lookup_key: 'tier_mythwright',
      product: { id: 'p_m', active: true },
    }),
    skuFixture({
      id: 'price_se',
      lookup_key: 'sku_session',
      product: { id: 'p_se', active: true },
    }),
    skuFixture({ id: 'price_wo', lookup_key: 'sku_world', product: { id: 'p_wo', active: true } }),
  ]
}

function listOk(
  data: PriceFixture[],
  hasMore = false,
): { data: PriceFixture[]; has_more: boolean } {
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
  classification?: string
  remedy?: string
  expected_api_version?: string
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
        conditions: { type: 'decreasing_item_amount' | 'shortening_interval' }[]
      }
      products: { product: string; prices: string[] }[] | null
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

function portalListOk(configs: PortalConfigFixture[]): {
  data: PortalConfigFixture[]
  has_more: boolean
} {
  return { data: configs, has_more: false }
}

interface WebhookEndpointFixture {
  id: string
  url: string
  status: 'enabled' | 'disabled'
  api_version: string | null
}

function endpointFixture(overrides: Partial<WebhookEndpointFixture> = {}): WebhookEndpointFixture {
  return {
    id: 'we_default',
    url: 'https://api.mythrun.dev/webhooks/stripe',
    status: 'enabled',
    api_version: STRIPE_API_VERSION,
    ...overrides,
  }
}

function endpointListOk(endpoints: WebhookEndpointFixture[]): {
  data: WebhookEndpointFixture[]
  has_more: boolean
} {
  return { data: endpoints, has_more: false }
}

interface MakeStripeOptions {
  portalList?: ReturnType<typeof vi.fn>
  endpointList?: ReturnType<typeof vi.fn>
}

function makeStripe(list: ReturnType<typeof vi.fn>, options: MakeStripeOptions = {}): Stripe {
  const portalList =
    options.portalList ?? vi.fn().mockResolvedValue(portalListOk([portalConfigFixture()]))
  // Default: no v1 webhook endpoints registered. That is the normal dev
  // shape (the Stripe CLI forwards without creating one), so every
  // pre-existing probe test keeps passing unchanged.
  const endpointList = options.endpointList ?? vi.fn().mockResolvedValue(endpointListOk([]))
  return {
    prices: { list },
    billingPortal: { configurations: { list: portalList } },
    webhookEndpoints: { list: endpointList },
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
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(/currency 'eur'/)
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
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(
      /transform_quantity/,
    )
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
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(
      /recurring\.interval/,
    )
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
      tierFixture({
        id: 'price_dup',
        lookup_key: 'tier_wayfarer',
        product: { id: 'p_dup', active: true },
      }),
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
    const ids = new Set(
      entries.map((e) => e.bootId).filter((v): v is string => typeof v === 'string'),
    )
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
    await expect(probeStripeContract(makeStripe(list, { portalList }), logger)).rejects.toThrow(
      /proration_behavior/,
    )
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
    await expect(probeStripeContract(makeStripe(list, { portalList }), logger)).rejects.toThrow(
      /decreasing_item_amount/,
    )
    expect(getSkuCache()).toBeNull()
  })

  it('Customer Portal config probe — empty configurations.list → BillingProbePortalConfigError', async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const portalList = vi.fn().mockResolvedValue(portalListOk([]))
    const { logger } = makeLogger()
    await expect(
      probeStripeContract(makeStripe(list, { portalList }), logger),
    ).rejects.toBeInstanceOf(BillingProbePortalConfigError)
    await expect(probeStripeContract(makeStripe(list, { portalList }), logger)).rejects.toThrow(
      /no active default Customer Portal configuration/,
    )
    expect(getSkuCache()).toBeNull()
  })

  it('Customer Portal probe StripeAuthenticationError → BillingProbeAuthError, no retry', async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const authErr = stripeError(Stripe.errors.StripeAuthenticationError, 'Invalid API Key', 401)
    const portalList = vi.fn().mockRejectedValue(authErr)
    const { logger, entries } = makeLogger()
    await expect(
      probeStripeContract(makeStripe(list, { portalList }), logger),
    ).rejects.toBeInstanceOf(BillingProbeAuthError)
    expect(portalList).toHaveBeenCalledTimes(1)
    expect(entries.some((e) => e.event === 'billing.probe_auth_failed')).toBe(true)
    // SKU cache must NOT be populated when portal probe blows up at auth.
    expect(getSkuCache()).toBeNull()
  })

  it('Customer Portal probe StripePermissionError → BillingProbeAuthError, no retry', async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const permErr = stripeError(
      Stripe.errors.StripePermissionError,
      'Restricted key missing BillingPortal: read',
      403,
    )
    const portalList = vi.fn().mockRejectedValue(permErr)
    const { logger } = makeLogger()
    await expect(
      probeStripeContract(makeStripe(list, { portalList }), logger),
    ).rejects.toBeInstanceOf(BillingProbeAuthError)
    expect(portalList).toHaveBeenCalledTimes(1)
    expect(getSkuCache()).toBeNull()
  })

  it('Customer Portal probe transient Stripe API error → BillingProbeTransientError (no retry on portal)', async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const apiErr = stripeError(Stripe.errors.StripeAPIError, '503 service unavailable', 503)
    const portalList = vi.fn().mockRejectedValue(apiErr)
    const { logger, entries } = makeLogger()
    await expect(probeStripeContract(makeStripe(list, { portalList }), logger)).rejects.toThrow(
      /failed transiently after 1 attempts/,
    )
    // Portal probe is single-shot (no retry loop), so portalList runs once.
    expect(portalList).toHaveBeenCalledTimes(1)
    expect(entries.some((e) => e.event === 'billing.probe_portal_transient_failed')).toBe(true)
    expect(getSkuCache()).toBeNull()
  })

  it('non-Error rejection from prices.list → retry log emits String(err); exhaust → transient error', async () => {
    // Branch coverage for probe.ts:416/428 — the `err instanceof Error ?
    // err.message : String(err)` else paths fire when the SDK / network
    // rejects with a non-Error value (string, plain object). Same retry
    // loop as the Error case but a different log shape.
    const list = vi.fn().mockRejectedValue('opaque non-Error rejection')
    const { logger, entries } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(/3 attempts/)
    expect(list).toHaveBeenCalledTimes(3)
    expect(entries.some((e) => e.event === 'billing.probe_transient_failed')).toBe(true)
  }, 30_000)

  it('unexpanded product (price.product is a string ID) → BillingProbeError', async () => {
    // Branch coverage for probe.ts:215 — `typeof product === 'string'`
    // (unexpanded). The probe requests expand: ['data.product'] but a
    // future Stripe-side regression could ignore that hint.
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'tier_wayfarer'
        ? { ...p, product: 'prod_wayfarer_string_only' as unknown as PriceFixture['product'] }
        : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toThrow(
      /unexpanded or deleted product field/,
    )
  })

  it('Customer Portal probe non-Stripe error → BillingProbeTransientError (covers String(err) branch)', async () => {
    // The portal transient-error logger has a `err instanceof Error` guard
    // at probe.ts line 310. A plain (non-Error) rejection exercises the
    // `String(err)` else branch.
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const portalList = vi.fn().mockRejectedValue('network blew up')
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list, { portalList }), logger)).rejects.toThrow(
      /failed transiently after 1 attempts/,
    )
    expect(getSkuCache()).toBeNull()
  })
})

// ─── webhook-endpoint api_version gate (myth-e3ary) ─────────────────────────
//
// A Stripe Event is immutable: it is rendered once, at the endpoint's pinned
// api_version, and no re-fetch can re-render it. So the ONLY place a drift
// between the endpoint version and STRIPE_API_VERSION can be caught before it
// silently drops paid customers' events is at boot, against the endpoint
// itself. A positively-observed drift crashloops the boot so ECS rolls the
// deploy back; absence and insufficient key scope do NOT hard-fail (see the
// individual cases for why).

describe('probeStripeContract — webhook endpoint api_version', () => {
  beforeEach(() => {
    vi.useRealTimers()
    _resetSkuCacheForTests()
  })

  it('enabled endpoint pinned to STRIPE_API_VERSION → passes, logs the verified endpoint', async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const endpointList = vi.fn().mockResolvedValue(endpointListOk([endpointFixture()]))
    const { logger, entries } = makeLogger()
    await expect(
      probeStripeContract(makeStripe(list, { endpointList }), logger),
    ).resolves.toBeUndefined()
    expect(entries.map((e) => e.event)).toContain('billing.probe_webhook_version_passed')
  })

  it('enabled endpoint on a DIFFERENT api_version → BillingProbeWebhookVersionError (boot fails)', async () => {
    // The exact production hole: the endpoint delivers 2026-03-25.dahlia,
    // the SDK is pinned to 2026-04-22.dahlia, every paid checkout is
    // dropped with a 200. Refusing to boot is what keeps it out of prod.
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const endpointList = vi
      .fn()
      .mockResolvedValue(endpointListOk([endpointFixture({ api_version: '2026-03-25.dahlia' })]))
    const { logger, entries } = makeLogger()
    await expect(probeStripeContract(makeStripe(list, { endpointList }), logger)).rejects.toThrow(
      BillingProbeWebhookVersionError,
    )
    const failed = entries.find((e) => e.event === 'billing.probe_webhook_version_failed')
    expect(failed?.level).toBe('error')
    expect(failed?.mismatches?.[0]).toMatch(/2026-03-25\.dahlia/)
    expect(failed?.mismatches?.[0]).toMatch(new RegExp(STRIPE_API_VERSION.replace(/\./g, '\\.')))
    // Classified CONFIG, not transient: the crashloop this causes is
    // intentional and retrying will never clear it. An operator reading the
    // restart loop must not mistake it for a flaky dependency to wait out.
    expect(failed?.classification).toBe('config')
    expect(failed?.expected_api_version).toBe(STRIPE_API_VERSION)
    expect(failed?.remedy).toBeDefined()
    // Boot-blocking failure ⇒ the SKU cache must not be published.
    expect(getSkuCache()).toBeNull()
  })

  it('endpoint with a null api_version (follows account default) → boot fails', async () => {
    // `api_version: null` means "whatever the account default happens to
    // be" — unpinned, so it can drift under us without any deploy. That is
    // not a safe configuration even when the current default matches.
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const endpointList = vi
      .fn()
      .mockResolvedValue(endpointListOk([endpointFixture({ api_version: null })]))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list, { endpointList }), logger)).rejects.toThrow(
      /account default/,
    )
  })

  it('DISABLED endpoint on a wrong version → ignored (delivers nothing, cannot drop revenue)', async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const endpointList = vi
      .fn()
      .mockResolvedValue(
        endpointListOk([
          endpointFixture({ id: 'we_old', status: 'disabled', api_version: '2020-08-27' }),
          endpointFixture(),
        ]),
      )
    const { logger } = makeLogger()
    await expect(
      probeStripeContract(makeStripe(list, { endpointList }), logger),
    ).resolves.toBeUndefined()
  })

  it('every enabled endpoint is checked, not just the first', async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const endpointList = vi.fn().mockResolvedValue(
      endpointListOk([
        endpointFixture(),
        endpointFixture({
          id: 'we_second',
          url: 'https://old.example/hook',
          api_version: '2020-08-27',
        }),
      ]),
    )
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list, { endpointList }), logger)).rejects.toThrow(
      /we_second/,
    )
  })

  it('no v1 endpoints registered → does NOT fail the boot (dev CLI forwarding / v2 event destinations)', async () => {
    // `stripe listen` forwards without creating an endpoint, and Stripe's
    // newer v2 event destinations do not appear in this list at all. An
    // empty list is therefore not evidence of misconfiguration, and
    // crashlooping on it would break every local boot.
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const endpointList = vi.fn().mockResolvedValue(endpointListOk([]))
    const { logger, entries } = makeLogger()
    await expect(
      probeStripeContract(makeStripe(list, { endpointList }), logger),
    ).resolves.toBeUndefined()
    expect(entries.map((e) => e.event)).toContain('billing.probe_webhook_version_skipped')
  })

  it('restricted key lacking webhook_endpoints:read → warns, does NOT fail the boot', async () => {
    // Production runs a restricted key. If it has no webhook_endpoints
    // scope this probe must degrade, not take the service down — the
    // runtime mismatch log + its alarm still cover the drift. Note this
    // deliberately diverges from the prices/portal probes, where a
    // permission error IS fatal (they gate core checkout correctness).
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const permErr = stripeError(
      Stripe.errors.StripePermissionError,
      'The provided key does not have access to webhook endpoints',
      403,
    )
    const endpointList = vi.fn().mockRejectedValue(permErr)
    const { logger, entries } = makeLogger()
    await expect(
      probeStripeContract(makeStripe(list, { endpointList }), logger),
    ).resolves.toBeUndefined()
    const warned = entries.find((e) => e.event === 'billing.probe_webhook_version_unavailable')
    expect(warned?.level).toBe('warn')
    // Classified so the operator is told the actual fix (grant the scope)
    // rather than being left to guess from a raw Stripe error string.
    expect(warned?.classification).toBe('permission')
    expect(warned?.remedy).toMatch(/webhook_endpoints: read/)
  })

  it('transient Stripe error listing endpoints → warns as transient, does NOT fail the boot', async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const apiErr = stripeError(Stripe.errors.StripeAPIError, '503 service unavailable', 503)
    const endpointList = vi.fn().mockRejectedValue(apiErr)
    const { logger, entries } = makeLogger()
    await expect(
      probeStripeContract(makeStripe(list, { endpointList }), logger),
    ).resolves.toBeUndefined()
    const warned = entries.find((e) => e.event === 'billing.probe_webhook_version_unavailable')
    expect(warned?.classification).toBe('transient')
  })

  it('non-Error rejection listing endpoints → warns via String(err), does NOT fail the boot', async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const endpointList = vi.fn().mockRejectedValue('opaque non-Error rejection')
    const { logger, entries } = makeLogger()
    await expect(
      probeStripeContract(makeStripe(list, { endpointList }), logger),
    ).resolves.toBeUndefined()
    const warned = entries.find((e) => e.event === 'billing.probe_webhook_version_unavailable')
    expect(warned?.err).toBe('opaque non-Error rejection')
  })
})
