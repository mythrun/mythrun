import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from 'pino'
import Stripe from 'stripe'
import {
  probeStripeContract,
  BillingProbeAuthError,
  BillingProbeStripeAPIChangeError,
} from '../probe.js'

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

function makeStripe(list: ReturnType<typeof vi.fn>): Stripe {
  return { prices: { list } } as unknown as Stripe
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
})
