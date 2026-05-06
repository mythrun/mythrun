// backend/src/billing/__tests__/webhook-pending-update-applied.test.ts
//
// Tests for the `customer.subscription.pending_update_applied` handler
// (Task 22, MYT-42 §5.4.6). This is the canonical credit-grant path for
// tier-upgrade events under `pending_if_incomplete`. The companion
// `invoice.paid` `subscription_update` handler is billing-history-only;
// credits flow through THIS handler.
//
// Like the §5.4.2 invoice tests, the dispatcher manages its own pg
// transaction; tests use the shared test pool directly with fresh users +
// unique stripe ids so concurrent tests don't collide.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'
import type { Stripe } from 'stripe'
import type { Pool } from 'pg'
import { pool, ensureSchema } from '../../repo/__tests__/_helpers/with-tx.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { STRIPE_API_VERSION } from '../stripe-client.js'
import { dispatchEvent } from '../webhook.js'
import {
  setSkuCache,
  _resetSkuCacheForTests,
  type SkuCache,
  type SkuInternalEntry,
} from '../sku-cache.js'
import { LOOKUP_KEYS, type LookupKey } from '../lookup-keys.js'

// ─── shared helpers ─────────────────────────────────────────────────────────

let userCounter = 0
async function createPendingUpdateUser(p: Pool): Promise<{ id: string; cus: string }> {
  const id = uuidv7()
  userCounter += 1
  const n = userCounter
  const cus = `cus_test_pua_${String(n)}_${id.slice(0, 8)}`
  await p.query(
    `INSERT INTO users (id, cognito_sub, username, display_name, stripe_customer_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `pua_sub_${String(n)}`, `puauser${String(n)}`, `Pua ${String(n)}`, cus],
  )
  return { id, cus }
}

interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'debug'
  obj: Record<string, unknown>
  msg: string
}

function makeLogger(): { log: FastifyBaseLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = []
  const make =
    (level: LogEntry['level']) =>
    (obj: Record<string, unknown>, msg?: string): void => {
      entries.push({ level, obj, msg: msg ?? '' })
    }
  const noop = (): void => {
    // intentional no-op
  }
  const log = {
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    debug: make('debug'),
    trace: make('debug'),
    fatal: make('error'),
    level: 'info',
    silent: noop,
    child: () => log,
  } as unknown as FastifyBaseLogger
  return { log, entries }
}

// Subscription fixture — matches the shape the handler reads from
// `event.data.object` (the subscription with the pending_update applied).
interface PuaSubscriptionFixture {
  readonly id: string
  readonly status: string
  readonly customer: string
  readonly cancel_at_period_end: boolean
  readonly cancel_at: number | null
  readonly cancellation_details: unknown
  readonly metadata: { readonly userId?: string }
  readonly latest_invoice: string | null
  readonly items: {
    readonly data: readonly {
      readonly current_period_start: number
      readonly current_period_end: number
      readonly price: {
        readonly id: string
        readonly lookup_key: string | null
        readonly unit_amount: number | null
      }
    }[]
  }
}

interface InvoicePaymentFixture {
  readonly payment: {
    readonly payment_intent?: string | null
    readonly type: 'charge' | 'payment_intent' | 'payment_record'
  }
}

interface InvoiceLineFixture {
  readonly id: string
  readonly amount: number
  readonly pricing: {
    readonly type: 'price_details'
    readonly price_details?: { readonly price: string; readonly product?: string }
  } | null
}

interface PuaInvoiceFixture {
  readonly id: string
  readonly object: 'invoice'
  readonly customer: string | null
  readonly subtotal: number | null
  readonly subtotal_excluding_tax: number | null
  readonly currency: string
  readonly created: number
  readonly payments: { readonly data: readonly InvoicePaymentFixture[] } | null
  readonly lines: { readonly data: readonly InvoiceLineFixture[] }
}

// Stripe SDK stub — handler's prefetcher hits stripe.invoices.retrieve.
function makeStripeWithInvoice(opts: {
  invoice?: PuaInvoiceFixture
}): { stripe: Stripe; calls: { invoiceRetrieves: string[] } } {
  const calls = { invoiceRetrieves: [] as string[] }
  const stub = {
    invoices: {
      retrieve: (id: string): Promise<PuaInvoiceFixture> => {
        calls.invoiceRetrieves.push(id)
        if (!opts.invoice) {
          return Promise.reject(new Error(`unexpected invoice retrieve for ${id}`))
        }
        return Promise.resolve(opts.invoice)
      },
    },
  }
  return { stripe: stub as unknown as Stripe, calls }
}

function makePuaEvent(
  subscription: PuaSubscriptionFixture,
  eventCreated?: number,
): Stripe.Event {
  return {
    id: `evt_test_${uuidv7()}`,
    object: 'event',
    api_version: STRIPE_API_VERSION,
    type: 'customer.subscription.pending_update_applied',
    created: eventCreated ?? Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object: subscription },
  } as unknown as Stripe.Event
}

async function countStripeEventRow(p: Pool, event_id: string): Promise<number> {
  const r = await p.query<{ event_id: string }>(
    'SELECT event_id FROM stripe_events WHERE event_id = $1',
    [event_id],
  )
  return r.rows.length
}

interface BillingHistoryReadRow {
  readonly id: string
  readonly user_id: string
  readonly kind: string
  readonly source_id_stripe: string
  readonly stripe_payment_intent_id: string | null
  readonly lookup_key: string | null
  readonly amount_cents: number
  readonly currency: string
  readonly expires_at: Date | null
  readonly occurred_at: Date
}

async function fetchBillingHistoryForUser(
  p: Pool,
  user_id: string,
): Promise<readonly BillingHistoryReadRow[]> {
  const r = await p.query<BillingHistoryReadRow>(
    `SELECT id, user_id, kind, source_id_stripe, stripe_payment_intent_id,
            lookup_key, amount_cents, currency, expires_at, occurred_at
       FROM billing_history
       WHERE user_id = $1
       ORDER BY occurred_at ASC, id ASC`,
    [user_id],
  )
  return r.rows
}

interface CreditLedgerReadRow {
  readonly id: string
  readonly user_id: string
  readonly credit_type: string
  readonly amount: number
  readonly source_type: string
  readonly source_purchase_id: string | null
  readonly source_billing_history_id: string | null
  readonly expires_at: Date | null
}

async function fetchCreditLedgerForUser(
  p: Pool,
  user_id: string,
): Promise<readonly CreditLedgerReadRow[]> {
  const r = await p.query<CreditLedgerReadRow>(
    `SELECT id, user_id, credit_type, amount, source_type,
            source_purchase_id, source_billing_history_id, expires_at
       FROM credit_ledger
       WHERE user_id = $1
       ORDER BY granted_at ASC, id ASC`,
    [user_id],
  )
  return r.rows
}

async function fetchUserSub(
  p: Pool,
  sub_id: string,
): Promise<{ tier_lookup_key: string; user_id: string } | null> {
  const r = await p.query<{ tier_lookup_key: string; user_id: string }>(
    'SELECT tier_lookup_key, user_id FROM user_subscriptions WHERE stripe_subscription_id = $1',
    [sub_id],
  )
  return r.rows[0] ?? null
}

// SKU cache fixture: Wayfarer 1500¢ / Sojourner 3000¢ / Mythwright 6000¢.
const PRICE_ID_TIER_WAYFARER = 'price_test_pua_tier_wayfarer'
const PRICE_ID_TIER_SOJOURNER = 'price_test_pua_tier_sojourner'
const PRICE_ID_TIER_MYTHWRIGHT = 'price_test_pua_tier_mythwright'

function makeSkuEntry(
  lookup_key: LookupKey,
  stripe_price_id: string,
  unit_amount_cents: number,
): SkuInternalEntry {
  const spec = LOOKUP_KEYS[lookup_key]
  return {
    lookup_key,
    stripe_price_id,
    displayName: spec.displayName,
    type: spec.type,
    sessionsGranted: spec.sessionsGranted,
    worldsGranted: spec.worldsGranted,
    price: { unit_amount_cents, currency: 'usd' },
  }
}

function buildSkuCacheForPuaTests(): SkuCache {
  const wayfarer = makeSkuEntry('tier_wayfarer', PRICE_ID_TIER_WAYFARER, 1500)
  const sojourner = makeSkuEntry('tier_sojourner', PRICE_ID_TIER_SOJOURNER, 3000)
  const mythwright = makeSkuEntry('tier_mythwright', PRICE_ID_TIER_MYTHWRIGHT, 6000)
  return {
    byLookupKey: new Map([
      ['tier_wayfarer', wayfarer],
      ['tier_sojourner', sojourner],
      ['tier_mythwright', mythwright],
    ]),
    byPriceId: new Map([
      [wayfarer.stripe_price_id, wayfarer],
      [sojourner.stripe_price_id, sojourner],
      [mythwright.stripe_price_id, mythwright],
    ]),
    publicListing: [],
  }
}

// ─── lifecycle ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensureSchema()
})

afterAll(async () => {
  await pool.end()
})

beforeEach(() => {
  _resetSkuCacheForTests()
  setSkuCache(buildSkuCacheForPuaTests())
})

// ─── fixture builders ───────────────────────────────────────────────────────

const PERIOD_START_SEC = Math.floor(new Date('2026-05-01T00:00:00Z').getTime() / 1000)
const PERIOD_END_SEC = Math.floor(new Date('2026-06-01T00:00:00Z').getTime() / 1000)
const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000

function buildSubscriptionFixture(opts: {
  sub_id: string
  customer: string
  newTier: LookupKey
  newPriceId: string
  newUnitAmount: number
  latestInvoiceId: string | null
  metadataUserId?: string
}): PuaSubscriptionFixture {
  return {
    id: opts.sub_id,
    status: 'active',
    customer: opts.customer,
    cancel_at_period_end: false,
    cancel_at: null,
    cancellation_details: null,
    metadata: opts.metadataUserId ? { userId: opts.metadataUserId } : {},
    latest_invoice: opts.latestInvoiceId,
    items: {
      data: [
        {
          current_period_start: PERIOD_START_SEC,
          current_period_end: PERIOD_END_SEC,
          price: {
            id: opts.newPriceId,
            lookup_key: opts.newTier,
            unit_amount: opts.newUnitAmount,
          },
        },
      ],
    },
  }
}

interface BuildInvoiceOpts {
  invoiceId: string
  customer: string | null
  subtotalExcludingTax: number | null
  paymentIntent: string | null
  occurredAtSec?: number
  lines: readonly InvoiceLineFixture[]
}

function buildInvoice(opts: BuildInvoiceOpts): PuaInvoiceFixture {
  return {
    id: opts.invoiceId,
    object: 'invoice',
    customer: opts.customer,
    subtotal: opts.subtotalExcludingTax,
    subtotal_excluding_tax: opts.subtotalExcludingTax,
    currency: 'usd',
    created: opts.occurredAtSec ?? Math.floor(Date.now() / 1000),
    payments: opts.paymentIntent
      ? {
          data: [
            {
              payment: { payment_intent: opts.paymentIntent, type: 'payment_intent' },
            },
          ],
        }
      : { data: [] },
    lines: { data: opts.lines },
  }
}

// ─── test suite ─────────────────────────────────────────────────────────────

describe('billing.webhook customer.subscription.pending_update_applied', () => {
  it('happy path Wayfarer→Mythwright: upserts user_subscriptions to NEW tier, appends ONE billing_history row, grants DELTA credits with source_billing_history_id linked + expires_at = period_end + 1mo', async () => {
    const { id: userId, cus } = await createPendingUpdateUser(pool)
    const sub_id = `sub_pua_ok_${uuidv7().slice(0, 12)}`
    const invoice_id = `in_pua_ok_${uuidv7().slice(0, 12)}`
    const pi = `pi_pua_ok_${uuidv7().slice(0, 12)}`

    // Wayfarer (1500¢) → Mythwright (6000¢). Flat dollar delta = 4500¢.
    // Stripe's proration: -1500¢ refund (full Wayfarer) + 6000¢ charge
    // (full Mythwright) at the simple boundary case — net 4500¢.
    const subscription = buildSubscriptionFixture({
      sub_id,
      customer: cus,
      newTier: 'tier_mythwright',
      newPriceId: PRICE_ID_TIER_MYTHWRIGHT,
      newUnitAmount: 6000,
      latestInvoiceId: invoice_id,
      metadataUserId: userId,
    })
    const invoice = buildInvoice({
      invoiceId: invoice_id,
      customer: cus,
      subtotalExcludingTax: 4500,
      paymentIntent: pi,
      lines: [
        {
          id: 'il_old_refund',
          amount: -1500,
          pricing: {
            type: 'price_details',
            price_details: { price: PRICE_ID_TIER_WAYFARER },
          },
        },
        {
          id: 'il_new_charge',
          amount: 6000,
          pricing: {
            type: 'price_details',
            price_details: { price: PRICE_ID_TIER_MYTHWRIGHT },
          },
        },
      ],
    })
    const { stripe, calls } = makeStripeWithInvoice({ invoice })
    const event = makePuaEvent(subscription)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    // Prefetcher fired once with the latest_invoice id.
    expect(calls.invoiceRetrieves).toEqual([invoice_id])

    // stripe_events committed.
    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // user_subscriptions row landed at the NEW tier.
    const subRow = await fetchUserSub(pool, sub_id)
    expect(subRow?.tier_lookup_key).toBe('tier_mythwright')
    expect(subRow?.user_id).toBe(userId)

    // billing_history: one row, kind='invoice', lookup_key=mythwright,
    // amount = subtotal (4500), expires_at = period_end + 1mo.
    const histRows = await fetchBillingHistoryForUser(pool, userId)
    expect(histRows).toHaveLength(1)
    const hist = histRows[0]
    if (!hist) throw new Error('expected billing_history row')
    expect(hist.kind).toBe('invoice')
    expect(hist.source_id_stripe).toBe(invoice_id)
    expect(hist.stripe_payment_intent_id).toBe(pi)
    expect(hist.lookup_key).toBe('tier_mythwright')
    expect(hist.amount_cents).toBe(4500)
    expect(hist.currency).toBe('usd')
    const expectedExpires = PERIOD_END_SEC * 1000 + ONE_MONTH_MS
    expect(hist.expires_at?.getTime()).toBe(expectedExpires)

    // credit_ledger: DELTA grants (Mythwright 16/4 - Wayfarer 4/1 = 12 sessions + 3 worlds).
    const ledger = await fetchCreditLedgerForUser(pool, userId)
    expect(ledger).toHaveLength(2)
    for (const row of ledger) {
      expect(row.source_type).toBe('subscription')
      expect(row.source_purchase_id).toBeNull()
      expect(row.source_billing_history_id).toBe(hist.id)
      expect(row.expires_at?.getTime()).toBe(expectedExpires)
    }
    const sessionRow = ledger.find((r) => r.credit_type === 'session')
    const worldRow = ledger.find((r) => r.credit_type === 'world_gen')
    expect(sessionRow?.amount).toBe(12)
    expect(worldRow?.amount).toBe(3)

    // No paging error logs.
    expect(entries.filter((e) => e.level === 'error')).toEqual([])
  })

  it('customer not found: pages billing.upgrade_orphan, commits stripe_events, no DB writes', async () => {
    const sub_id = `sub_pua_orph_${uuidv7().slice(0, 12)}`
    const invoice_id = `in_pua_orph_${uuidv7().slice(0, 12)}`
    const orphanCustomer = `cus_pua_orph_${uuidv7().slice(0, 8)}`
    const orphanUserId = uuidv7()  // not in users

    const subscription = buildSubscriptionFixture({
      sub_id,
      customer: orphanCustomer,
      newTier: 'tier_mythwright',
      newPriceId: PRICE_ID_TIER_MYTHWRIGHT,
      newUnitAmount: 6000,
      latestInvoiceId: invoice_id,
      metadataUserId: orphanUserId,
    })
    // Provide a valid invoice — the prefetcher runs even on the orphan path
    // (it's outside the dispatch tx).
    const invoice = buildInvoice({
      invoiceId: invoice_id,
      customer: orphanCustomer,
      subtotalExcludingTax: 4500,
      paymentIntent: null,
      lines: [
        {
          id: 'il_old',
          amount: -1500,
          pricing: { type: 'price_details', price_details: { price: PRICE_ID_TIER_WAYFARER } },
        },
        {
          id: 'il_new',
          amount: 6000,
          pricing: { type: 'price_details', price_details: { price: PRICE_ID_TIER_MYTHWRIGHT } },
        },
      ],
    })
    const { stripe } = makeStripeWithInvoice({ invoice })
    const event = makePuaEvent(subscription)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    // stripe_events committed; orphan paged.
    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    const paged = entries.find(
      (e) => e.level === 'error' && e.msg === 'billing.upgrade_orphan',
    )
    expect(paged).toBeDefined()

    // No writes — sub_id has no row, invoice_id has no row.
    expect(await fetchUserSub(pool, sub_id)).toBeNull()
    const histAny = await pool.query<{ id: string }>(
      'SELECT id FROM billing_history WHERE source_id_stripe = $1',
      [invoice_id],
    )
    expect(histAny.rows.length).toBe(0)
  })

  it('latest_invoice missing on subscription: pages billing.upgrade_invoice_missing, commits, no writes', async () => {
    const { id: userId, cus } = await createPendingUpdateUser(pool)
    const sub_id = `sub_pua_noinv_${uuidv7().slice(0, 12)}`

    const subscription = buildSubscriptionFixture({
      sub_id,
      customer: cus,
      newTier: 'tier_mythwright',
      newPriceId: PRICE_ID_TIER_MYTHWRIGHT,
      newUnitAmount: 6000,
      latestInvoiceId: null,  // shouldn't happen for pending_update_applied; defensive
      metadataUserId: userId,
    })
    // Stripe stub provides no invoice fixture — prefetcher must not call retrieve.
    const { stripe, calls } = makeStripeWithInvoice({})
    const event = makePuaEvent(subscription)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    // Prefetcher did NOT call invoices.retrieve.
    expect(calls.invoiceRetrieves).toEqual([])
    // stripe_events committed; paging error fired.
    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    const paged = entries.find(
      (e) => e.level === 'error' && e.msg === 'billing.upgrade_invoice_missing',
    )
    expect(paged).toBeDefined()

    // No writes.
    expect(await fetchUserSub(pool, sub_id)).toBeNull()
    expect((await fetchBillingHistoryForUser(pool, userId)).length).toBe(0)
    expect((await fetchCreditLedgerForUser(pool, userId)).length).toBe(0)
  })

  it('multiple positive lines: returns validation_failed, pages billing.upgrade_unexpected_line_shape, no writes', async () => {
    const { id: userId, cus } = await createPendingUpdateUser(pool)
    const sub_id = `sub_pua_multi_${uuidv7().slice(0, 12)}`
    const invoice_id = `in_pua_multi_${uuidv7().slice(0, 12)}`

    const subscription = buildSubscriptionFixture({
      sub_id,
      customer: cus,
      newTier: 'tier_mythwright',
      newPriceId: PRICE_ID_TIER_MYTHWRIGHT,
      newUnitAmount: 6000,
      latestInvoiceId: invoice_id,
      metadataUserId: userId,
    })
    // TWO positive lines + one negative — handler must reject.
    const invoice = buildInvoice({
      invoiceId: invoice_id,
      customer: cus,
      subtotalExcludingTax: 9000,
      paymentIntent: null,
      lines: [
        {
          id: 'il_neg',
          amount: -1500,
          pricing: { type: 'price_details', price_details: { price: PRICE_ID_TIER_WAYFARER } },
        },
        {
          id: 'il_pos1',
          amount: 6000,
          pricing: { type: 'price_details', price_details: { price: PRICE_ID_TIER_MYTHWRIGHT } },
        },
        {
          id: 'il_pos2',
          amount: 3000,
          pricing: { type: 'price_details', price_details: { price: PRICE_ID_TIER_SOJOURNER } },
        },
      ],
    })
    const { stripe } = makeStripeWithInvoice({ invoice })
    const event = makePuaEvent(subscription)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    // stripe_events committed (validation_failed sentinel commits).
    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    // Both the per-handler msg and dispatcher's sentinel logged.
    expect(
      entries.some(
        (e) => e.level === 'error' && e.msg === 'billing.upgrade_unexpected_line_shape',
      ),
    ).toBe(true)
    expect(
      entries.some(
        (e) => e.level === 'error' && e.msg === 'billing.handler_validation_failed_committed',
      ),
    ).toBe(true)

    // No writes.
    expect(await fetchUserSub(pool, sub_id)).toBeNull()
    expect((await fetchBillingHistoryForUser(pool, userId)).length).toBe(0)
    expect((await fetchCreditLedgerForUser(pool, userId)).length).toBe(0)
  })

  it('unknown price ID in line: returns validation_failed, pages billing.upgrade_unknown_price_id, no writes', async () => {
    const { id: userId, cus } = await createPendingUpdateUser(pool)
    const sub_id = `sub_pua_unkn_${uuidv7().slice(0, 12)}`
    const invoice_id = `in_pua_unkn_${uuidv7().slice(0, 12)}`
    const stalePriceId = 'price_stripe_old_archived_xyz'  // not in SKU cache

    const subscription = buildSubscriptionFixture({
      sub_id,
      customer: cus,
      newTier: 'tier_mythwright',
      newPriceId: PRICE_ID_TIER_MYTHWRIGHT,
      newUnitAmount: 6000,
      latestInvoiceId: invoice_id,
      metadataUserId: userId,
    })
    const invoice = buildInvoice({
      invoiceId: invoice_id,
      customer: cus,
      subtotalExcludingTax: 4500,
      paymentIntent: null,
      lines: [
        {
          id: 'il_old',
          amount: -1500,
          pricing: { type: 'price_details', price_details: { price: stalePriceId } },
        },
        {
          id: 'il_new',
          amount: 6000,
          pricing: { type: 'price_details', price_details: { price: PRICE_ID_TIER_MYTHWRIGHT } },
        },
      ],
    })
    const { stripe } = makeStripeWithInvoice({ invoice })
    const event = makePuaEvent(subscription)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    expect(
      entries.some(
        (e) => e.level === 'error' && e.msg === 'billing.upgrade_unknown_price_id',
      ),
    ).toBe(true)
    expect(
      entries.some(
        (e) => e.level === 'error' && e.msg === 'billing.handler_validation_failed_committed',
      ),
    ).toBe(true)

    expect(await fetchUserSub(pool, sub_id)).toBeNull()
    expect((await fetchBillingHistoryForUser(pool, userId)).length).toBe(0)
    expect((await fetchCreditLedgerForUser(pool, userId)).length).toBe(0)
  })

  it('subtotal vs delta mismatch: returns validation_failed, pages billing.amount_validation_failed, no writes', async () => {
    const { id: userId, cus } = await createPendingUpdateUser(pool)
    const sub_id = `sub_pua_amt_${uuidv7().slice(0, 12)}`
    const invoice_id = `in_pua_amt_${uuidv7().slice(0, 12)}`

    const subscription = buildSubscriptionFixture({
      sub_id,
      customer: cus,
      newTier: 'tier_mythwright',
      newPriceId: PRICE_ID_TIER_MYTHWRIGHT,
      newUnitAmount: 6000,
      latestInvoiceId: invoice_id,
      metadataUserId: userId,
    })
    // Wayfarer→Mythwright expected delta = 4500; the invoice claims 9999.
    const invoice = buildInvoice({
      invoiceId: invoice_id,
      customer: cus,
      subtotalExcludingTax: 9999,
      paymentIntent: null,
      lines: [
        {
          id: 'il_old',
          amount: -1500,
          pricing: { type: 'price_details', price_details: { price: PRICE_ID_TIER_WAYFARER } },
        },
        {
          id: 'il_new',
          amount: 6000,
          pricing: { type: 'price_details', price_details: { price: PRICE_ID_TIER_MYTHWRIGHT } },
        },
      ],
    })
    const { stripe } = makeStripeWithInvoice({ invoice })
    const event = makePuaEvent(subscription)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    const paged = entries.find(
      (e) => e.level === 'error' && e.msg === 'billing.amount_validation_failed',
    )
    expect(paged).toBeDefined()
    if (!paged) throw new Error('expected billing.amount_validation_failed log')
    expect(paged.obj.expected).toBe(4500)
    expect(paged.obj.actual).toBe(9999)
    expect(
      entries.some(
        (e) => e.level === 'error' && e.msg === 'billing.handler_validation_failed_committed',
      ),
    ).toBe(true)

    expect(await fetchUserSub(pool, sub_id)).toBeNull()
    expect((await fetchBillingHistoryForUser(pool, userId)).length).toBe(0)
    expect((await fetchCreditLedgerForUser(pool, userId)).length).toBe(0)
  })
})
