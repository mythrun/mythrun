// Runs once per boot, after loadEnv() succeeds and before app.listen().
//
// Verifies every lookup_key in LOOKUP_KEYS resolves to exactly one active
// Stripe price with the right type, currency, billing-shape dimensions,
// and (for recurring) interval + interval_count + usage_type. Distinguishes
// auth errors (fail fast — fix the secret), contract mismatches (fail
// loud — fix Dashboard), and transient Stripe-API errors (retry with
// backoff).
//
// Read-only: only stripe.prices.list. Restricted API key in production
// rejects any mutation regardless.

import { randomUUID } from 'node:crypto'
import Stripe from 'stripe'
import type { Logger } from 'pino'
import { LOOKUP_KEYS, type LookupKey } from './lookup-keys.js'
import { setSkuCache, type SkuCache, type SkuInternalEntry, type SkuPublicListing } from './sku-cache.js'

const PROBE_TIMEOUT_MS = 7000
const PROBE_MAX_ATTEMPTS = 3
const PROBE_BACKOFF_MS = [1000, 2000, 4000]
const PROBE_JITTER_MS = 1000

// Static guardrail: lookup_keys filter has a Stripe-API hard ceiling at 100.
// If LOOKUP_KEYS ever grows past this, the probe needs pagination.
if (Object.keys(LOOKUP_KEYS).length > 100) {
  throw new Error(
    'BillingProbe: LOOKUP_KEYS exceeds 100 entries; Stripe prices.list lookup_keys filter caps at 100 — redesign required.',
  )
}

export class BillingProbeError extends Error {
  readonly code = 'BILLING_PROBE_FAILED'
  constructor(readonly mismatches: readonly string[], readonly bootId: string) {
    super(`Stripe billing probe failed (contract mismatch) [boot=${bootId}]:\n  ${mismatches.join('\n  ')}`)
    this.name = 'BillingProbeError'
  }
}

export class BillingProbeAuthError extends Error {
  readonly code = 'BILLING_PROBE_AUTH'
  constructor(readonly cause: unknown, readonly bootId: string) {
    super(`Stripe billing probe failed at authentication [boot=${bootId}]: ${String(cause)} — rotate STRIPE_SECRET_KEY`)
    this.name = 'BillingProbeAuthError'
  }
}

export class BillingProbeStripeAPIChangeError extends Error {
  readonly code = 'BILLING_PROBE_API_CHANGE'
  constructor(readonly bootId: string) {
    super(`Stripe billing probe got has_more=true on a lookup_keys-bounded query [boot=${bootId}]; Stripe API contract changed.`)
    this.name = 'BillingProbeStripeAPIChangeError'
  }
}

export class BillingProbeTransientError extends Error {
  readonly code = 'BILLING_PROBE_TRANSIENT'
  constructor(readonly cause: unknown, readonly attempts: number, readonly bootId: string) {
    super(`Stripe billing probe failed transiently after ${String(attempts)} attempts [boot=${bootId}]: ${String(cause)}`)
    this.name = 'BillingProbeTransientError'
  }
}

export class BillingProbePortalConfigError extends Error {
  readonly code = 'BILLING_PROBE_PORTAL_CONFIG'
  constructor(readonly mismatches: readonly string[], readonly bootId: string) {
    super(
      `Stripe billing probe failed (Customer Portal config drift) [boot=${bootId}]:\n  ${mismatches.join('\n  ')}`,
    )
    this.name = 'BillingProbePortalConfigError'
  }
}

export async function probeStripeContract(
  stripe: Stripe,
  logger: Logger,
): Promise<void> {
  const bootId = randomUUID()
  const lookupKeys = Object.keys(LOOKUP_KEYS) as LookupKey[]

  logger.info({ event: 'billing.probe_started', bootId, count: lookupKeys.length }, 'Stripe billing probe started')

  const result = await fetchPricesWithRetry(stripe, lookupKeys, logger, bootId)

  if (result.has_more) {
    throw new BillingProbeStripeAPIChangeError(bootId)
  }

  const mismatches: string[] = []
  const fetched = result.data

  // Duplicate detection — fail loud, not silent last-wins.
  const counts = new Map<string, number>()
  for (const p of fetched) {
    if (p.lookup_key) counts.set(p.lookup_key, (counts.get(p.lookup_key) ?? 0) + 1)
  }
  for (const [k, n] of counts) {
    if (n > 1) {
      mismatches.push(
        `lookup_key '${k}' has ${String(n)} active Stripe prices — archive duplicates in Dashboard`,
      )
    }
  }

  // Build a map only after duplicate-detection.
  const byLookup = new Map<string, Stripe.Price>()
  for (const p of fetched) {
    if (p.lookup_key && (counts.get(p.lookup_key) ?? 0) === 1) {
      byLookup.set(p.lookup_key, p)
    }
  }

  for (const key of lookupKeys) {
    const spec = LOOKUP_KEYS[key]
    if ((counts.get(spec.lookupKey) ?? 0) > 1) continue

    const price = byLookup.get(spec.lookupKey)
    if (!price) {
      mismatches.push(`lookup_key '${spec.lookupKey}' not found in active Stripe prices`)
      continue
    }

    if (price.currency !== 'usd') {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has currency '${price.currency}' in Stripe; contract expects 'usd'`,
      )
    }

    const stripeType: 'recurring' | 'one_time' = price.recurring ? 'recurring' : 'one_time'
    if (stripeType !== spec.type) {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has type '${stripeType}' in Stripe but contract expects '${spec.type}'`,
      )
      continue
    }

    if (typeof price.unit_amount !== 'number' || price.unit_amount <= 0) {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has unit_amount '${String(price.unit_amount)}' in Stripe; contract expects > 0`,
      )
    }

    if (price.billing_scheme !== 'per_unit') {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has billing_scheme '${price.billing_scheme}' in Stripe; contract expects 'per_unit'`,
      )
    }

    if (price.transform_quantity !== null) {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has non-null transform_quantity in Stripe; contract requires null (no quantity transformation)`,
      )
    }

    if (price.tax_behavior && price.tax_behavior !== 'unspecified') {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has tax_behavior '${price.tax_behavior}' in Stripe; contract expects 'unspecified' (no tax handling at launch)`,
      )
    }

    const product = price.product
    if (typeof product === 'string' || !('active' in product)) {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has unexpanded or deleted product field; probe expected expand: ['data.product']`,
      )
    } else if (!product.active) {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' resolves to a price whose product is archived (product.id='${product.id}'); checkout will fail at session-create. Reactivate the product in Dashboard or rotate the lookup_key onto a price under an active product.`,
      )
    }

    if (spec.type === 'recurring') {
      if (price.recurring?.interval !== 'month') {
        mismatches.push(
          `lookup_key '${spec.lookupKey}' has recurring.interval '${String(price.recurring?.interval)}' in Stripe; contract expects 'month'`,
        )
      }
      if (price.recurring?.interval_count !== 1) {
        mismatches.push(
          `lookup_key '${spec.lookupKey}' has recurring.interval_count '${String(price.recurring?.interval_count)}' in Stripe; contract expects 1 (monthly, not multi-month)`,
        )
      }
      if (price.recurring?.usage_type !== 'licensed') {
        mismatches.push(
          `lookup_key '${spec.lookupKey}' has recurring.usage_type '${String(price.recurring?.usage_type)}' in Stripe; contract expects 'licensed'`,
        )
      }
    }
  }

  if (mismatches.length > 0) {
    logger.error(
      { event: 'billing.probe_failed', bootId, mismatchCount: mismatches.length, mismatches },
      'Stripe billing contract mismatch',
    )
    throw new BillingProbeError(mismatches, bootId)
  }

  await probePortalConfig(stripe, logger, bootId)

  populateSkuCache(lookupKeys, byLookup)

  logger.info(
    { event: 'billing.probe_passed', bootId, count: lookupKeys.length },
    'Stripe billing contract verified',
  )
}

function populateSkuCache(
  lookupKeys: readonly LookupKey[],
  byLookup: ReadonlyMap<string, Stripe.Price>,
): void {
  const publicListing: SkuPublicListing[] = []
  const byLookupKey = new Map<LookupKey, SkuInternalEntry>()
  const byPriceId = new Map<string, SkuInternalEntry>()
  for (const key of lookupKeys) {
    const spec = LOOKUP_KEYS[key]
    const price = byLookup.get(spec.lookupKey)
    if (!price) {
      // Probe asserted presence above; this branch is unreachable on a passing probe.
      throw new Error(
        `BillingProbe: unreachable — lookup_key '${spec.lookupKey}' missing from byLookup after probe passed`,
      )
    }
    if (typeof price.unit_amount !== 'number') {
      // Probe validated unit_amount > 0 above; this branch is also unreachable on a passing probe.
      throw new Error(
        `BillingProbe: unreachable — price for '${spec.lookupKey}' has non-numeric unit_amount after probe passed`,
      )
    }
    const internal: SkuInternalEntry = {
      lookup_key: spec.lookupKey,
      stripe_price_id: price.id,
      displayName: spec.displayName,
      type: spec.type,
      sessionsGranted: spec.sessionsGranted,
      worldsGranted: spec.worldsGranted,
      price: { unit_amount_cents: price.unit_amount, currency: price.currency },
    }
    byLookupKey.set(internal.lookup_key, internal)
    byPriceId.set(internal.stripe_price_id, internal)
    // Public projection: omit stripe_price_id explicitly via TS rest-omit.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { stripe_price_id: _omit, ...publicEntry } = internal
    publicListing.push(publicEntry)
  }
  const snapshot: SkuCache = { byLookupKey, byPriceId, publicListing }
  setSkuCache(snapshot)
}

async function probePortalConfig(
  stripe: Stripe,
  logger: Logger,
  bootId: string,
): Promise<void> {
  let result: Stripe.ApiList<Stripe.BillingPortal.Configuration>
  try {
    result = await stripe.billingPortal.configurations.list(
      { active: true, is_default: true, limit: 1 },
      { timeout: PROBE_TIMEOUT_MS },
    )
  } catch (err) {
    if (
      err instanceof Stripe.errors.StripeAuthenticationError ||
      err instanceof Stripe.errors.StripePermissionError
    ) {
      logger.error(
        { event: 'billing.probe_auth_failed', bootId, err: err.message },
        'Stripe billing probe auth/permission failure during portal config check',
      )
      throw new BillingProbeAuthError(err, bootId)
    }
    logger.error(
      {
        event: 'billing.probe_portal_transient_failed',
        bootId,
        err: err instanceof Error ? err.message : String(err),
      },
      'Stripe billing probe portal-config transient failure',
    )
    throw new BillingProbeTransientError(err, 1, bootId)
  }

  const mismatches: string[] = []
  const config = result.data[0]
  if (!config) {
    mismatches.push('no active default Customer Portal configuration found')
    logger.error(
      { event: 'billing.probe_portal_failed', bootId, mismatchCount: mismatches.length, mismatches },
      'Stripe billing probe Customer Portal config drift',
    )
    throw new BillingProbePortalConfigError(mismatches, bootId)
  }

  const subUpdate = config.features.subscription_update
  if (subUpdate.proration_behavior !== 'create_prorations') {
    mismatches.push(
      `Customer Portal subscription_update.proration_behavior is '${subUpdate.proration_behavior}'; contract expects 'create_prorations'`,
    )
  }
  const conditions = subUpdate.schedule_at_period_end.conditions
  const hasDecreasing = conditions.some((c) => c.type === 'decreasing_item_amount')
  if (!hasDecreasing) {
    mismatches.push(
      `Customer Portal subscription_update.schedule_at_period_end.conditions missing { type: 'decreasing_item_amount' }; contract requires asymmetric upgrade-immediate / downgrade-at-renewal behavior`,
    )
  }
  // The per-tier downgrade-only matrix from MYT-42 spec §15.2 was paranoia
  // layered on top of safety Stripe already provides. With
  // `schedule_at_period_end: decreasing_item_amount` set above, downgrades
  // defer to period end — no refund-arbitrage. And our credit-grant code
  // (webhook-invoice-paid.ts handleSubscriptionUpdate) is billing-history-
  // only on subscription_update; credit grants flow through subscription_cycle
  // (full new period at full price) or pending_update_applied (the
  // /upgrade-tier path). Portal-initiated upgrades have looser timing but
  // are not exploitable. So we no longer assert anything about the
  // products allowlist — Portal can offer any tier as a switch target.

  if (mismatches.length > 0) {
    logger.error(
      { event: 'billing.probe_portal_failed', bootId, mismatchCount: mismatches.length, mismatches },
      'Stripe billing probe Customer Portal config drift',
    )
    throw new BillingProbePortalConfigError(mismatches, bootId)
  }

  logger.info(
    { event: 'billing.probe_portal_passed', bootId, configId: config.id },
    'Stripe Customer Portal config verified',
  )
}

async function fetchPricesWithRetry(
  stripe: Stripe,
  lookupKeys: readonly LookupKey[],
  logger: Logger,
  bootId: string,
): Promise<Stripe.ApiList<Stripe.Price>> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= PROBE_MAX_ATTEMPTS; attempt++) {
    try {
      return await stripe.prices.list(
        {
          lookup_keys: [...lookupKeys],
          active: true,
          expand: ['data.product'],
          limit: Math.min(lookupKeys.length * 10, 100),
        },
        { timeout: PROBE_TIMEOUT_MS },
      )
    } catch (err) {
      if (
        err instanceof Stripe.errors.StripeAuthenticationError ||
        err instanceof Stripe.errors.StripePermissionError
      ) {
        logger.error(
          { event: 'billing.probe_auth_failed', bootId, err: err.message },
          'Stripe billing probe auth/permission failure',
        )
        throw new BillingProbeAuthError(err, bootId)
      }
      lastErr = err
      if (attempt === PROBE_MAX_ATTEMPTS) break
      const base =
        PROBE_BACKOFF_MS[attempt - 1] ??
        PROBE_BACKOFF_MS[PROBE_BACKOFF_MS.length - 1] ??
        1000
      const jitter = Math.floor(Math.random() * PROBE_JITTER_MS)
      logger.warn(
        {
          event: 'billing.probe_transient_retry',
          bootId,
          attempt,
          nextDelayMs: base + jitter,
          err: err instanceof Error ? err.message : String(err),
        },
        'Stripe billing probe transient error; retrying',
      )
      await new Promise((r) => setTimeout(r, base + jitter))
    }
  }
  logger.error(
    {
      event: 'billing.probe_transient_failed',
      bootId,
      attempts: PROBE_MAX_ATTEMPTS,
      err: lastErr instanceof Error ? lastErr.message : String(lastErr),
    },
    'Stripe billing probe transient failure after retries',
  )
  throw new BillingProbeTransientError(lastErr, PROBE_MAX_ATTEMPTS, bootId)
}
