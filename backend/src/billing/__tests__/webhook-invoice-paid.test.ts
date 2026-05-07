// backend/src/billing/__tests__/webhook-invoice-paid.test.ts
//
// Tests for the `invoice.paid` handler (Task 19, MYT-42 §5.4.2).
//
// The dispatcher manages its own pg transaction; like the Task 17/18 tests,
// these use the shared test pool directly. Each test creates a fresh users
// row + unique stripe_subscription_id / invoice_id so the persisted writes
// from one test don't collide with another.

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

// ─── shared test helpers ────────────────────────────────────────────────────

let userCounter = 0
async function createInvoiceTestUser(p: Pool): Promise<{ id: string; cus: string }> {
  const id = uuidv7()
  userCounter += 1
  const n = userCounter
  const cus = `cus_test_invoice_${String(n)}_${id.slice(0, 8)}`
  await p.query(
    `INSERT INTO users (id, cognito_sub, username, display_name, stripe_customer_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `invoice_sub_${String(n)}`, `invoiceuser${String(n)}`, `Invoice ${String(n)}`, cus],
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
    // intentional no-op for unused logger methods
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

// Stripe SDK test stub that the prefetcher hits. Returns the supplied
// subscription fixture verbatim from `subscriptions.retrieve`.
interface SubscriptionFixture {
  readonly id: string
  readonly status: string
  readonly cancel_at_period_end: boolean
  readonly cancel_at: number | null
  readonly cancellation_details: unknown
  readonly metadata: { readonly userId?: string }
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

function makeStripeWithSubscription(opts: {
  subscription?: SubscriptionFixture
}): { stripe: Stripe; calls: { subscriptionRetrieves: string[] } } {
  const calls = { subscriptionRetrieves: [] as string[] }
  const stub = {
    subscriptions: {
      retrieve: (id: string): Promise<SubscriptionFixture> => {
        calls.subscriptionRetrieves.push(id)
        if (!opts.subscription) {
          return Promise.reject(new Error(`unexpected subscription retrieve for ${id}`))
        }
        return Promise.resolve(opts.subscription)
      },
    },
  }
  return { stripe: stub as unknown as Stripe, calls }
}

// Minimal-shape Invoice fixture covering the fields the handler reads. The
// optional `parent` shape mirrors basil — `subscription_details.subscription`
// is the parent-sub pointer; `parent === null` represents a non-subscription
// invoice (admin-issued, etc.).
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

interface InvoiceFixture {
  readonly id: string
  readonly object: 'invoice'
  readonly customer: string | null
  readonly billing_reason:
    | 'subscription_cycle'
    | 'subscription_create'
    | 'subscription_update'
    | 'manual'
    | 'quote_accept'
    | 'subscription_threshold'
    | null
  readonly amount_paid: number
  readonly subtotal: number | null
  readonly subtotal_excluding_tax: number | null
  readonly currency: string
  readonly created: number
  readonly parent: {
    readonly type: 'subscription_details' | 'quote_details'
    readonly subscription_details?: { readonly subscription: string | null }
  } | null
  readonly payments: { readonly data: readonly InvoicePaymentFixture[] } | null
  readonly lines: { readonly data: readonly InvoiceLineFixture[] }
}

function makeInvoiceEvent(invoice: InvoiceFixture, eventCreated?: number): Stripe.Event {
  return {
    id: `evt_test_${uuidv7()}`,
    object: 'event',
    api_version: STRIPE_API_VERSION,
    type: 'invoice.paid',
    created: eventCreated ?? Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object: invoice },
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

async function countUserSubs(p: Pool, sub_id: string): Promise<number> {
  const r = await p.query<{ id: string }>(
    'SELECT id FROM user_subscriptions WHERE stripe_subscription_id = $1',
    [sub_id],
  )
  return r.rows.length
}

// SKU cache shape for the subscription_update test (price-id reverse map).
const PRICE_ID_TIER_WAYFARER = 'price_test_tier_wayfarer'
const PRICE_ID_TIER_SOJOURNER = 'price_test_tier_sojourner'
const PRICE_ID_TIER_MYTHWRIGHT = 'price_test_tier_mythwright'

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

function buildSkuCacheForInvoiceTests(): SkuCache {
  // Wayfarer: 1500¢ / Sojourner: 3000¢ / Mythwright: 6000¢. The cycle/create
  // tests use Wayfarer; the update test upgrades Wayfarer → Sojourner.
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
  setSkuCache(buildSkuCacheForInvoiceTests())
})

// ─── helpers to build well-shaped fixtures ──────────────────────────────────

function buildSubscriptionFixture(opts: {
  sub_id: string
  tierLookupKey: LookupKey
  priceId: string
  unitAmount: number
  periodStart: number
  periodEnd: number
  metadataUserId?: string
}): SubscriptionFixture {
  return {
    id: opts.sub_id,
    status: 'active',
    cancel_at_period_end: false,
    cancel_at: null,
    cancellation_details: null,
    metadata: opts.metadataUserId ? { userId: opts.metadataUserId } : {},
    items: {
      data: [
        {
          current_period_start: opts.periodStart,
          current_period_end: opts.periodEnd,
          price: {
            id: opts.priceId,
            lookup_key: opts.tierLookupKey,
            unit_amount: opts.unitAmount,
          },
        },
      ],
    },
  }
}

interface BuildInvoiceOpts {
  invoiceId: string
  customer: string | null
  billingReason: InvoiceFixture['billing_reason']
  amountPaid: number
  subtotalExcludingTax: number | null
  subscription: string | null
  paymentIntent: string | null
  lineAmount?: number
  linePriceId?: string
  occurredAtSec?: number
  parentNull?: boolean
}

function buildInvoice(opts: BuildInvoiceOpts): InvoiceFixture {
  const lineAmount = opts.lineAmount ?? opts.amountPaid
  const linePriceId = opts.linePriceId ?? PRICE_ID_TIER_WAYFARER
  return {
    id: opts.invoiceId,
    object: 'invoice',
    customer: opts.customer,
    billing_reason: opts.billingReason,
    amount_paid: opts.amountPaid,
    subtotal: opts.subtotalExcludingTax,
    subtotal_excluding_tax: opts.subtotalExcludingTax,
    currency: 'usd',
    created: opts.occurredAtSec ?? Math.floor(Date.now() / 1000),
    parent: opts.parentNull
      ? null
      : {
          type: 'subscription_details',
          subscription_details: { subscription: opts.subscription },
        },
    payments: opts.paymentIntent
      ? {
          data: [
            {
              payment: { payment_intent: opts.paymentIntent, type: 'payment_intent' },
            },
          ],
        }
      : { data: [] },
    lines: {
      data: [
        {
          id: 'il_1',
          amount: lineAmount,
          pricing: {
            type: 'price_details',
            price_details: { price: linePriceId },
          },
        },
      ],
    },
  }
}

const PERIOD_START_SEC = Math.floor(new Date('2026-05-01T00:00:00Z').getTime() / 1000)
const PERIOD_END_SEC = Math.floor(new Date('2026-06-01T00:00:00Z').getTime() / 1000)

// ─── test suite ─────────────────────────────────────────────────────────────

describe('billing.webhook invoice.paid', () => {
  it('subscription_cycle happy path: appends billing_history with PI, grants tier credits with source_billing_history_id linked + expires_at = period_end; replay dedupes', async () => {
    const { id: userId, cus } = await createInvoiceTestUser(pool)
    const sub_id = `sub_cyc_${uuidv7().slice(0, 12)}`
    const invoice_id = `in_cyc_${uuidv7().slice(0, 12)}`
    const pi = `pi_cyc_${uuidv7().slice(0, 12)}`

    const subscription = buildSubscriptionFixture({
      sub_id,
      tierLookupKey: 'tier_wayfarer',
      priceId: PRICE_ID_TIER_WAYFARER,
      unitAmount: 1500,
      periodStart: PERIOD_START_SEC,
      periodEnd: PERIOD_END_SEC,
      metadataUserId: userId,
    })
    const invoice = buildInvoice({
      invoiceId: invoice_id,
      customer: cus,
      billingReason: 'subscription_cycle',
      amountPaid: 1500,
      subtotalExcludingTax: 1500,
      subscription: sub_id,
      paymentIntent: pi,
    })
    const { stripe, calls } = makeStripeWithSubscription({ subscription })
    const event = makeInvoiceEvent(invoice)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    // Prefetcher fired once.
    expect(calls.subscriptionRetrieves).toEqual([sub_id])

    // stripe_events committed.
    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // billing_history row written: kind='invoice', PI populated, expires_at = period_end.
    const histRows = await fetchBillingHistoryForUser(pool, userId)
    expect(histRows).toHaveLength(1)
    const hist = histRows[0]
    if (!hist) throw new Error('expected billing_history row')
    expect(hist.kind).toBe('invoice')
    expect(hist.source_id_stripe).toBe(invoice_id)
    expect(hist.stripe_payment_intent_id).toBe(pi)
    expect(hist.lookup_key).toBe('tier_wayfarer')
    expect(hist.amount_cents).toBe(1500)
    expect(hist.currency).toBe('usd')
    expect(hist.expires_at?.toISOString()).toBe('2026-06-01T00:00:00.000Z')

    // credit_ledger: tier_wayfarer = 4 sessions + 1 world; both rows linked
    // back to the billing_history row via source_billing_history_id.
    const ledger = await fetchCreditLedgerForUser(pool, userId)
    expect(ledger).toHaveLength(2)
    for (const row of ledger) {
      expect(row.source_type).toBe('subscription')
      expect(row.source_purchase_id).toBeNull()
      expect(row.source_billing_history_id).toBe(hist.id)
      expect(row.expires_at?.toISOString()).toBe('2026-06-01T00:00:00.000Z')
    }
    const sessionRow = ledger.find((r) => r.credit_type === 'session')
    const worldRow = ledger.find((r) => r.credit_type === 'world_gen')
    if (!sessionRow || !worldRow) throw new Error('expected session and world_gen rows')
    expect(sessionRow.amount).toBe(4)
    expect(worldRow.amount).toBe(1)

    // No paging error logs.
    expect(entries.filter((e) => e.level === 'error')).toEqual([])

    // Replay: same event.id → stripe_events PK dedupes; counts unchanged.
    const histCountBefore = histRows.length
    const ledgerCountBefore = ledger.length
    await dispatchEvent(event, stripe, pool, log)
    expect((await fetchBillingHistoryForUser(pool, userId)).length).toBe(histCountBefore)
    expect((await fetchCreditLedgerForUser(pool, userId)).length).toBe(ledgerCountBefore)
  })

  it('subscription_create: upserts user_subscriptions FIRST when no row exists, THEN appends billing_history, THEN grants credits', async () => {
    const { id: userId, cus } = await createInvoiceTestUser(pool)
    const sub_id = `sub_crt_${uuidv7().slice(0, 12)}`
    const invoice_id = `in_crt_${uuidv7().slice(0, 12)}`
    const pi = `pi_crt_${uuidv7().slice(0, 12)}`

    const subscription = buildSubscriptionFixture({
      sub_id,
      tierLookupKey: 'tier_sojourner',
      priceId: PRICE_ID_TIER_SOJOURNER,
      unitAmount: 3000,
      periodStart: PERIOD_START_SEC,
      periodEnd: PERIOD_END_SEC,
      metadataUserId: userId,
    })
    const invoice = buildInvoice({
      invoiceId: invoice_id,
      customer: cus,
      billingReason: 'subscription_create',
      amountPaid: 3000,
      subtotalExcludingTax: 3000,
      subscription: sub_id,
      paymentIntent: pi,
      linePriceId: PRICE_ID_TIER_SOJOURNER,
    })
    const { stripe } = makeStripeWithSubscription({ subscription })
    const event = makeInvoiceEvent(invoice)
    const { log } = makeLogger()

    // No user_subscriptions row exists yet — confirms the race-shape fix.
    expect(await countUserSubs(pool, sub_id)).toBe(0)

    await dispatchEvent(event, stripe, pool, log)

    // user_subscriptions row landed with the right tier.
    expect(await countUserSubs(pool, sub_id)).toBe(1)
    const subRow = await pool.query<{ tier_lookup_key: string; user_id: string; status: string }>(
      'SELECT tier_lookup_key, user_id, status FROM user_subscriptions WHERE stripe_subscription_id = $1',
      [sub_id],
    )
    expect(subRow.rows[0]?.tier_lookup_key).toBe('tier_sojourner')
    expect(subRow.rows[0]?.user_id).toBe(userId)
    expect(subRow.rows[0]?.status).toBe('active')

    // billing_history + credit_ledger as in the cycle case.
    const histRows = await fetchBillingHistoryForUser(pool, userId)
    expect(histRows).toHaveLength(1)
    const hist = histRows[0]
    if (!hist) throw new Error('expected billing_history row')
    expect(hist.lookup_key).toBe('tier_sojourner')
    expect(hist.amount_cents).toBe(3000)
    expect(hist.stripe_payment_intent_id).toBe(pi)

    const ledger = await fetchCreditLedgerForUser(pool, userId)
    // tier_sojourner: 8 sessions + 2 worlds → 2 credit_ledger rows.
    expect(ledger).toHaveLength(2)
    const sessionRow = ledger.find((r) => r.credit_type === 'session')
    const worldRow = ledger.find((r) => r.credit_type === 'world_gen')
    expect(sessionRow?.amount).toBe(8)
    expect(worldRow?.amount).toBe(2)
    for (const row of ledger) {
      expect(row.source_billing_history_id).toBe(hist.id)
    }
  })

  it('subscription_update: appends billing_history-only with do_update_coalesce; NO credits, NO user_subscriptions upsert; lookup_key derived from positive-amount line', async () => {
    const { id: userId, cus } = await createInvoiceTestUser(pool)
    const sub_id = `sub_upd_${uuidv7().slice(0, 12)}`
    const invoice_id = `in_upd_${uuidv7().slice(0, 12)}`
    const pi = `pi_upd_${uuidv7().slice(0, 12)}`

    // The subscription's tier in the prefetched object is what user_subscriptions
    // was at; the new tier on the invoice is derived from the line item.
    // Here we simulate Wayfarer (the subscription is already-recorded as the
    // OLD tier in our fixture) → Sojourner (the positive-amount line carries
    // the NEW tier price).
    const subscription = buildSubscriptionFixture({
      sub_id,
      tierLookupKey: 'tier_wayfarer',
      priceId: PRICE_ID_TIER_WAYFARER,
      unitAmount: 1500,
      periodStart: PERIOD_START_SEC,
      periodEnd: PERIOD_END_SEC,
      metadataUserId: userId,
    })

    // Build an invoice with two lines: one negative (credit for the old tier
    // proration) and one positive (charge for the new tier proration). The
    // handler should pick the positive one.
    const invoice: InvoiceFixture = {
      id: invoice_id,
      object: 'invoice',
      customer: cus,
      billing_reason: 'subscription_update',
      amount_paid: 750,
      subtotal: 750,
      subtotal_excluding_tax: 750,
      currency: 'usd',
      created: Math.floor(Date.now() / 1000),
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: sub_id },
      },
      payments: {
        data: [
          {
            payment: { payment_intent: pi, type: 'payment_intent' },
          },
        ],
      },
      lines: {
        data: [
          {
            id: 'il_credit',
            amount: -750,  // credit for the old tier (Wayfarer prorated unused)
            pricing: {
              type: 'price_details',
              price_details: { price: PRICE_ID_TIER_WAYFARER },
            },
          },
          {
            id: 'il_charge',
            amount: 1500,  // charge for the new tier (Sojourner prorated)
            pricing: {
              type: 'price_details',
              price_details: { price: PRICE_ID_TIER_SOJOURNER },
            },
          },
        ],
      },
    }
    const { stripe } = makeStripeWithSubscription({ subscription })
    const event = makeInvoiceEvent(invoice)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // billing_history row landed with the NEW tier's lookup_key (Sojourner).
    const histRows = await fetchBillingHistoryForUser(pool, userId)
    expect(histRows).toHaveLength(1)
    const hist = histRows[0]
    if (!hist) throw new Error('expected billing_history row')
    expect(hist.kind).toBe('invoice')
    expect(hist.source_id_stripe).toBe(invoice_id)
    expect(hist.stripe_payment_intent_id).toBe(pi)
    expect(hist.lookup_key).toBe('tier_sojourner')
    expect(hist.amount_cents).toBe(750)
    // expires_at is period_end + (period_end - period_start). For our fixture
    // (May→June, ~31 days) the projected end is ~July 1.
    expect(hist.expires_at).not.toBeNull()
    const expectedExpiresMs = PERIOD_END_SEC * 1000 + (PERIOD_END_SEC - PERIOD_START_SEC) * 1000
    expect(hist.expires_at?.getTime()).toBe(expectedExpiresMs)

    // ZERO credits granted; pending_update_applied owns that.
    const ledger = await fetchCreditLedgerForUser(pool, userId)
    expect(ledger).toHaveLength(0)

    // ZERO user_subscriptions rows touched (handler skips upsert on this branch).
    expect(await countUserSubs(pool, sub_id)).toBe(0)

    // No paging errors.
    expect(entries.filter((e) => e.level === 'error')).toEqual([])
  })

  it('billing_reason="manual": billing_history-only audit row, no credits, no validation', async () => {
    const { id: userId, cus } = await createInvoiceTestUser(pool)
    const sub_id = `sub_man_${uuidv7().slice(0, 12)}`
    const invoice_id = `in_man_${uuidv7().slice(0, 12)}`
    const pi = `pi_man_${uuidv7().slice(0, 12)}`

    // Even an admin-issued invoice can carry a parent.subscription_details if
    // the operator picked the subscription from the dashboard. Here we let it
    // resolve normally; the handler's billing_reason gate decides the branch.
    const subscription = buildSubscriptionFixture({
      sub_id,
      tierLookupKey: 'tier_wayfarer',
      priceId: PRICE_ID_TIER_WAYFARER,
      unitAmount: 1500,
      periodStart: PERIOD_START_SEC,
      periodEnd: PERIOD_END_SEC,
      metadataUserId: userId,
    })
    const invoice = buildInvoice({
      invoiceId: invoice_id,
      customer: cus,
      billingReason: 'manual',
      amountPaid: 1234,  // arbitrary; intentionally NOT matching tier price
      subtotalExcludingTax: 1234,
      subscription: sub_id,
      paymentIntent: pi,
    })
    const { stripe } = makeStripeWithSubscription({ subscription })
    const event = makeInvoiceEvent(invoice)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    // Audit row landed with lookup_key=NULL (no tier resolved for non-cycle/create/update).
    const histRows = await fetchBillingHistoryForUser(pool, userId)
    expect(histRows).toHaveLength(1)
    const hist = histRows[0]
    if (!hist) throw new Error('expected billing_history row')
    expect(hist.kind).toBe('invoice')
    expect(hist.source_id_stripe).toBe(invoice_id)
    expect(hist.amount_cents).toBe(1234)
    expect(hist.lookup_key).toBeNull()
    expect(hist.expires_at).toBeNull()

    // No credits granted.
    const ledger = await fetchCreditLedgerForUser(pool, userId)
    expect(ledger).toHaveLength(0)

    // INFO log emitted.
    expect(
      entries.some(
        (e) => e.level === 'info' && e.msg === 'billing.invoice_audit_only',
      ),
    ).toBe(true)
    // No paging errors.
    expect(entries.filter((e) => e.level === 'error')).toEqual([])
  })

  it('zero-amount invoice: billing_history audit row with amount_cents=0, no credits, no validation', async () => {
    const { id: userId, cus } = await createInvoiceTestUser(pool)
    const sub_id = `sub_zer_${uuidv7().slice(0, 12)}`
    const invoice_id = `in_zer_${uuidv7().slice(0, 12)}`

    // Zero-amount invoices typically don't carry a payments[] array (no
    // PaymentIntent was needed). The handler still appends an audit row; PI is
    // null on the row.
    const subscription = buildSubscriptionFixture({
      sub_id,
      tierLookupKey: 'tier_wayfarer',
      priceId: PRICE_ID_TIER_WAYFARER,
      unitAmount: 1500,
      periodStart: PERIOD_START_SEC,
      periodEnd: PERIOD_END_SEC,
      metadataUserId: userId,
    })
    const invoice = buildInvoice({
      invoiceId: invoice_id,
      customer: cus,
      billingReason: 'subscription_cycle',  // zero-amount renewal (e.g., 100% coupon)
      amountPaid: 0,
      subtotalExcludingTax: 0,
      subscription: sub_id,
      paymentIntent: null,
    })
    const { stripe } = makeStripeWithSubscription({ subscription })
    const event = makeInvoiceEvent(invoice)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    const histRows = await fetchBillingHistoryForUser(pool, userId)
    expect(histRows).toHaveLength(1)
    const hist = histRows[0]
    if (!hist) throw new Error('expected billing_history row')
    expect(hist.amount_cents).toBe(0)
    expect(hist.stripe_payment_intent_id).toBeNull()

    // No credits, no validation_failed.
    expect((await fetchCreditLedgerForUser(pool, userId)).length).toBe(0)
    expect(
      entries.some(
        (e) => e.level === 'error' && e.msg === 'billing.handler_validation_failed_committed',
      ),
    ).toBe(false)
    // INFO audit log emitted with the zero-amount reason.
    const audit = entries.find(
      (e) => e.level === 'info' && e.msg === 'billing.invoice_audit_only',
    )
    expect(audit).toBeDefined()
    expect((audit?.obj as { reason?: string } | undefined)?.reason).toBe('zero_or_negative_amount')
  })

  it('customer not found + subscription_cycle + amount_paid > 0: pages "billing.invoice_orphan", commits stripe_events, no writes', async () => {
    // No users row matches this customer, and the subscription metadata.userId
    // also doesn't resolve.
    const sub_id = `sub_orph_${uuidv7().slice(0, 12)}`
    const invoice_id = `in_orph_${uuidv7().slice(0, 12)}`
    const pi = `pi_orph_${uuidv7().slice(0, 12)}`
    const orphanCustomer = `cus_orph_${uuidv7().slice(0, 8)}`
    const orphanUserId = uuidv7()  // not in users

    const subscription = buildSubscriptionFixture({
      sub_id,
      tierLookupKey: 'tier_wayfarer',
      priceId: PRICE_ID_TIER_WAYFARER,
      unitAmount: 1500,
      periodStart: PERIOD_START_SEC,
      periodEnd: PERIOD_END_SEC,
      metadataUserId: orphanUserId,
    })
    const invoice = buildInvoice({
      invoiceId: invoice_id,
      customer: orphanCustomer,
      billingReason: 'subscription_cycle',
      amountPaid: 1500,
      subtotalExcludingTax: 1500,
      subscription: sub_id,
      paymentIntent: pi,
    })
    const { stripe } = makeStripeWithSubscription({ subscription })
    const event = makeInvoiceEvent(invoice)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    // stripe_events committed.
    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // Paging-grade error log.
    const paged = entries.find(
      (e) => e.level === 'error' && e.msg === 'billing.invoice_orphan',
    )
    expect(paged).toBeDefined()
    if (!paged) throw new Error('expected billing.invoice_orphan log')
    expect(paged.obj.invoice_id).toBe(invoice_id)
    expect(paged.obj.customer).toBe(orphanCustomer)
    expect(paged.obj.amount_paid).toBe(1500)

    // No billing_history / credit_ledger / user_subscriptions rows landed.
    // (Can't filter by user_id on a non-existent user; spot-check by sub_id.)
    expect(await countUserSubs(pool, sub_id)).toBe(0)
    const histAny = await pool.query<{ id: string }>(
      'SELECT id FROM billing_history WHERE source_id_stripe = $1',
      [invoice_id],
    )
    expect(histAny.rows.length).toBe(0)
  })

  it('non-subscription invoice (parent === null): prefetch returns subscription=null; INFO log; no writes', async () => {
    const { id: userId, cus } = await createInvoiceTestUser(pool)
    const invoice_id = `in_nonsub_${uuidv7().slice(0, 12)}`
    const pi = `pi_nonsub_${uuidv7().slice(0, 12)}`

    // parent === null → admin-issued / standalone invoice.
    const invoice = buildInvoice({
      invoiceId: invoice_id,
      customer: cus,
      billingReason: 'manual',
      amountPaid: 500,
      subtotalExcludingTax: 500,
      subscription: null,
      paymentIntent: pi,
      parentNull: true,
    })
    // Provide no subscription fixture — the prefetcher must NOT call
    // subscriptions.retrieve.
    const { stripe, calls } = makeStripeWithSubscription({})
    const event = makeInvoiceEvent(invoice)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    // stripe_events committed.
    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // Prefetcher did NOT call subscriptions.retrieve (parent.type !== 'subscription_details').
    expect(calls.subscriptionRetrieves).toEqual([])

    // INFO log emitted.
    expect(
      entries.some(
        (e) => e.level === 'info' && e.msg === 'billing.invoice_non_subscription',
      ),
    ).toBe(true)

    // No paging errors.
    expect(entries.filter((e) => e.level === 'error')).toEqual([])

    // No writes (handler returned 'ok' BEFORE resolving user / writing rows).
    expect((await fetchBillingHistoryForUser(pool, userId)).length).toBe(0)
    expect((await fetchCreditLedgerForUser(pool, userId)).length).toBe(0)
  })

  it('multi-item subscription: returns validation_failed, commits stripe_events, no writes', async () => {
    const { id: userId, cus } = await createInvoiceTestUser(pool)
    const sub_id = `sub_multi_${uuidv7().slice(0, 12)}`
    const invoice_id = `in_multi_${uuidv7().slice(0, 12)}`
    const pi = `pi_multi_${uuidv7().slice(0, 12)}`

    // Two items in subscription.items.data → loud abort.
    const subscription: SubscriptionFixture = {
      id: sub_id,
      status: 'active',
      cancel_at_period_end: false,
      cancel_at: null,
      cancellation_details: null,
      metadata: { userId },
      items: {
        data: [
          {
            current_period_start: PERIOD_START_SEC,
            current_period_end: PERIOD_END_SEC,
            price: {
              id: PRICE_ID_TIER_WAYFARER,
              lookup_key: 'tier_wayfarer',
              unit_amount: 1500,
            },
          },
          {
            current_period_start: PERIOD_START_SEC,
            current_period_end: PERIOD_END_SEC,
            price: {
              id: PRICE_ID_TIER_SOJOURNER,
              lookup_key: 'tier_sojourner',
              unit_amount: 3000,
            },
          },
        ],
      },
    }
    const invoice = buildInvoice({
      invoiceId: invoice_id,
      customer: cus,
      billingReason: 'subscription_cycle',
      amountPaid: 4500,
      subtotalExcludingTax: 4500,
      subscription: sub_id,
      paymentIntent: pi,
    })
    const { stripe } = makeStripeWithSubscription({ subscription })
    const event = makeInvoiceEvent(invoice)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    // stripe_events committed (sentinel).
    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // Paging error log emitted (both the per-handler msg and the dispatcher's sentinel).
    expect(
      entries.some(
        (e) => e.level === 'error' && e.msg === 'billing.invoice_subscription_invalid_items',
      ),
    ).toBe(true)
    expect(
      entries.some(
        (e) => e.level === 'error' && e.msg === 'billing.handler_validation_failed_committed',
      ),
    ).toBe(true)

    // No writes.
    expect((await fetchBillingHistoryForUser(pool, userId)).length).toBe(0)
    expect((await fetchCreditLedgerForUser(pool, userId)).length).toBe(0)
  })
})
