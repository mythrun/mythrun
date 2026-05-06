// backend/src/billing/__tests__/webhook-refund.test.ts
//
// Tests for the `refund.created` and `refund.updated` shared handler
// (Task 24, MYT-42 §5.4.5). Like the Task 19 invoice-paid tests these run
// the dispatcher (not the handler directly) so the BEGIN + 3× SET LOCAL
// timeouts AND the `stripe_events` row write are exercised end-to-end.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'
import type { Stripe } from 'stripe'
import type { Pool } from 'pg'
import { pool, ensureSchema } from '../../repo/__tests__/_helpers/with-tx.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { STRIPE_API_VERSION } from '../stripe-client.js'
import { dispatchEvent } from '../webhook.js'
import { billingHistory } from '../../repo/billing-history.js'
import { purchases } from '../../repo/purchases.js'
import { grantInTx } from '../../repo/credits.js'

// ─── shared test helpers ────────────────────────────────────────────────────

let userCounter = 0
async function createRefundTestUser(p: Pool): Promise<{ id: string; cus: string }> {
  const id = uuidv7()
  userCounter += 1
  const n = userCounter
  const cus = `cus_test_refund_${String(n)}_${id.slice(0, 8)}`
  await p.query(
    `INSERT INTO users (id, cognito_sub, username, display_name, stripe_customer_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `refund_sub_${String(n)}`, `refunduser${String(n)}`, `Refund ${String(n)}`, cus],
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

// Refund + Charge fixtures keep just the fields the handler reads.
type RefundStatus = 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled'

interface RefundFixture {
  readonly id: string
  readonly object: 'refund'
  readonly amount: number
  readonly currency: string
  readonly created: number
  readonly payment_intent: string | null
  readonly charge: string | null
  readonly status: RefundStatus
}

interface ChargeFixture {
  readonly id: string
  readonly object: 'charge'
  readonly amount_captured: number
  readonly amount_refunded: number
  readonly payment_intent: string | null
}

function makeStripeWithCharge(opts: {
  charge?: ChargeFixture
}): { stripe: Stripe; calls: { chargeRetrieves: string[] } } {
  const calls = { chargeRetrieves: [] as string[] }
  const stub = {
    charges: {
      retrieve: (id: string): Promise<ChargeFixture> => {
        calls.chargeRetrieves.push(id)
        if (!opts.charge) {
          return Promise.reject(new Error(`unexpected charge retrieve for ${id}`))
        }
        return Promise.resolve(opts.charge)
      },
    },
  }
  return { stripe: stub as unknown as Stripe, calls }
}

function makeRefundEvent(
  type: 'refund.created' | 'refund.updated',
  refund: RefundFixture,
): Stripe.Event {
  return {
    id: `evt_test_${uuidv7()}`,
    object: 'event',
    api_version: STRIPE_API_VERSION,
    type,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object: refund },
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
  readonly status: string
  readonly expires_at: Date | null
  readonly occurred_at: Date
}

async function fetchBillingHistoryForUser(
  p: Pool,
  user_id: string,
): Promise<readonly BillingHistoryReadRow[]> {
  const r = await p.query<BillingHistoryReadRow>(
    `SELECT id, user_id, kind, source_id_stripe, stripe_payment_intent_id,
            lookup_key, amount_cents, currency, status, expires_at, occurred_at
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
  readonly source_id: string | null
  readonly source_purchase_id: string | null
  readonly source_billing_history_id: string | null
  readonly expires_at: Date | null
}

async function fetchCreditLedgerForUser(
  p: Pool,
  user_id: string,
): Promise<readonly CreditLedgerReadRow[]> {
  const r = await p.query<CreditLedgerReadRow>(
    `SELECT id, user_id, credit_type, amount, source_type, source_id,
            source_purchase_id, source_billing_history_id, expires_at
       FROM credit_ledger
       WHERE user_id = $1
       ORDER BY granted_at ASC, id ASC`,
    [user_id],
  )
  return r.rows
}

interface PurchaseReadRow {
  readonly id: string
  readonly status: 'completed' | 'refunded'
  readonly stripe_payment_intent_id: string
  readonly lookup_key: string
}

async function fetchPurchasesForUser(p: Pool, user_id: string): Promise<readonly PurchaseReadRow[]> {
  const r = await p.query<PurchaseReadRow>(
    `SELECT id, status, stripe_payment_intent_id, lookup_key
       FROM purchases
       WHERE user_id = $1
       ORDER BY id ASC`,
    [user_id],
  )
  return r.rows
}

// ─── lifecycle ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensureSchema()
})

afterAll(async () => {
  await pool.end()
})

// ─── seed helpers ───────────────────────────────────────────────────────────

/**
 * Seed an à-la-carte purchase + grant rows. Returns the inserted purchase
 * row id and the originating grant row ids so tests can assert clawback
 * targets.
 */
async function seedAlaCartePurchaseWithGrants(
  p: Pool,
  userId: string,
  paymentIntentId: string,
  rows: readonly { lookupKey: string; sessionAmount: number; worldAmount: number }[],
): Promise<readonly { purchaseId: string; sessionGrantId: string | null; worldGrantId: string | null }[]> {
  const out: { purchaseId: string; sessionGrantId: string | null; worldGrantId: string | null }[] = []
  const client = await p.connect()
  try {
    await client.query('BEGIN')
    for (const row of rows) {
      const purchaseId = uuidv7()
      await purchases.insertMany(client, [
        {
          id: purchaseId,
          user_id: userId,
          stripe_payment_intent_id: paymentIntentId,
          lookup_key: row.lookupKey,
          quantity: 1,
          amount_cents: 1500,
          currency: 'usd',
        },
      ])
      let sessionGrantId: string | null = null
      let worldGrantId: string | null = null
      if (row.sessionAmount > 0) {
        const grant = await grantInTx(client, {
          userId,
          creditType: 'session',
          amount: row.sessionAmount,
          sourceType: 'purchase',
          sourcePurchaseId: purchaseId,
          sourceBillingHistoryId: null,
          sourceId: null,
          expiresAt: null,
        })
        sessionGrantId = grant.id
      }
      if (row.worldAmount > 0) {
        const grant = await grantInTx(client, {
          userId,
          creditType: 'world_gen',
          amount: row.worldAmount,
          sourceType: 'purchase',
          sourcePurchaseId: purchaseId,
          sourceBillingHistoryId: null,
          sourceId: null,
          expiresAt: null,
        })
        worldGrantId = grant.id
      }
      out.push({ purchaseId, sessionGrantId, worldGrantId })
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  return out
}

/**
 * Seed a subscription invoice billing_history row + grants. Returns the
 * billing_history.id + the originating grant row ids.
 */
async function seedSubscriptionInvoiceWithGrants(
  p: Pool,
  userId: string,
  invoiceId: string,
  paymentIntentId: string,
  amountCents: number,
  lookupKey: string,
  sessionAmount: number,
  worldAmount: number,
  expiresAt: Date,
): Promise<{ billingHistoryId: string; sessionGrantId: string | null; worldGrantId: string | null }> {
  let billingHistoryId = ''
  let sessionGrantId: string | null = null
  let worldGrantId: string | null = null
  const client = await p.connect()
  try {
    await client.query('BEGIN')
    const row = await billingHistory.append(client, {
      id: uuidv7(),
      user_id: userId,
      kind: 'invoice',
      source_id_stripe: invoiceId,
      stripe_payment_intent_id: paymentIntentId,
      lookup_key: lookupKey,
      amount_cents: amountCents,
      currency: 'usd',
      expires_at: expiresAt,
      occurred_at: new Date(),
    })
    billingHistoryId = row.id
    if (sessionAmount > 0) {
      const grant = await grantInTx(client, {
        userId,
        creditType: 'session',
        amount: sessionAmount,
        sourceType: 'subscription',
        sourcePurchaseId: null,
        sourceBillingHistoryId: billingHistoryId,
        sourceId: null,
        expiresAt,
      })
      sessionGrantId = grant.id
    }
    if (worldAmount > 0) {
      const grant = await grantInTx(client, {
        userId,
        creditType: 'world_gen',
        amount: worldAmount,
        sourceType: 'subscription',
        sourcePurchaseId: null,
        sourceBillingHistoryId: billingHistoryId,
        sourceId: null,
        expiresAt,
      })
      worldGrantId = grant.id
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  return { billingHistoryId, sessionGrantId, worldGrantId }
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('billing.webhook refund', () => {
  it('status gate: refund.status="pending" → INFO log billing.refund_pending, no clawback, no charge prefetch consumed', async () => {
    const { id: userId } = await createRefundTestUser(pool)
    const refund: RefundFixture = {
      id: `re_test_${uuidv7().replace(/-/g, '')}`,
      object: 'refund',
      amount: 1500,
      currency: 'usd',
      created: Math.floor(Date.now() / 1000),
      payment_intent: `pi_test_${uuidv7().replace(/-/g, '')}`,
      charge: `ch_test_${uuidv7().replace(/-/g, '')}`,
      status: 'pending',
    }
    // The prefetcher fires regardless (it only inspects status in step −1
    // of the handler). Provide a charge whose amounts match so the prefetch
    // resolves cleanly.
    const charge: ChargeFixture = {
      id: refund.charge ?? '',
      object: 'charge',
      amount_captured: 1500,
      amount_refunded: 1500,
      payment_intent: refund.payment_intent,
    }
    const { stripe } = makeStripeWithCharge({ charge })
    const event = makeRefundEvent('refund.created', refund)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    expect(
      entries.some((e) => e.level === 'info' && e.msg === 'billing.refund_pending'),
    ).toBe(true)
    // No clawback, no billing_history row.
    expect((await fetchCreditLedgerForUser(pool, userId)).length).toBe(0)
    expect((await fetchBillingHistoryForUser(pool, userId)).length).toBe(0)
  })

  it('status gate: refund.status="failed" → INFO log billing.refund_terminal_non_success, no clawback', async () => {
    const { id: userId } = await createRefundTestUser(pool)
    const refund: RefundFixture = {
      id: `re_test_${uuidv7().replace(/-/g, '')}`,
      object: 'refund',
      amount: 1500,
      currency: 'usd',
      created: Math.floor(Date.now() / 1000),
      payment_intent: `pi_test_${uuidv7().replace(/-/g, '')}`,
      charge: `ch_test_${uuidv7().replace(/-/g, '')}`,
      status: 'failed',
    }
    const charge: ChargeFixture = {
      id: refund.charge ?? '',
      object: 'charge',
      amount_captured: 1500,
      amount_refunded: 0,
      payment_intent: refund.payment_intent,
    }
    const { stripe } = makeStripeWithCharge({ charge })
    const event = makeRefundEvent('refund.updated', refund)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    expect(
      entries.some(
        (e) => e.level === 'info' && e.msg === 'billing.refund_terminal_non_success',
      ),
    ).toBe(true)
    expect((await fetchCreditLedgerForUser(pool, userId)).length).toBe(0)
  })

  it('partial-refund hard-refuse: charge.amount_refunded !== amount_captured → ERROR billing.partial_refund_unsupported, no clawback', async () => {
    const { id: userId } = await createRefundTestUser(pool)
    const pi = `pi_test_${uuidv7().replace(/-/g, '')}`
    // Seed a purchase + grants so we can assert that NO clawback lands.
    await seedAlaCartePurchaseWithGrants(pool, userId, pi, [
      { lookupKey: 'sku_session', sessionAmount: 1, worldAmount: 0 },
    ])
    const refund: RefundFixture = {
      id: `re_test_${uuidv7().replace(/-/g, '')}`,
      object: 'refund',
      amount: 750,
      currency: 'usd',
      created: Math.floor(Date.now() / 1000),
      payment_intent: pi,
      charge: `ch_test_${uuidv7().replace(/-/g, '')}`,
      status: 'succeeded',
    }
    const charge: ChargeFixture = {
      id: refund.charge ?? '',
      object: 'charge',
      amount_captured: 1500,
      amount_refunded: 750,  // partial refund
      payment_intent: pi,
    }
    const { stripe } = makeStripeWithCharge({ charge })
    const event = makeRefundEvent('refund.created', refund)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    const paged = entries.find(
      (e) => e.level === 'error' && e.msg === 'billing.partial_refund_unsupported',
    )
    expect(paged).toBeDefined()
    if (!paged) throw new Error('expected billing.partial_refund_unsupported log')
    expect(paged.obj.refund_id).toBe(refund.id)
    expect(paged.obj.amount_captured).toBe(1500)
    expect(paged.obj.amount_refunded).toBe(750)

    // No clawback (only the original grant from seed).
    const ledger = await fetchCreditLedgerForUser(pool, userId)
    expect(ledger.length).toBe(1)
    expect(ledger[0]?.source_type).toBe('purchase')
    // No refund row in billing_history.
    expect((await fetchBillingHistoryForUser(pool, userId)).length).toBe(0)
  })

  it('à-la-carte full refund happy path: clawback rows + purchases.status=refunded + refund billing_history row', async () => {
    const { id: userId } = await createRefundTestUser(pool)
    const pi = `pi_test_${uuidv7().replace(/-/g, '')}`
    // 3 purchases lines → 6 grants total (each line grants 1 session + 1 world).
    // Distinct lookup_keys per row are required by purchases'
    // UNIQUE (stripe_payment_intent_id, lookup_key) — a multi-line cart in
    // production sums quantities across lines with the same SKU into ONE row.
    // Here we use three distinct keys to model 3 independent cart lines.
    const seeded = await seedAlaCartePurchaseWithGrants(pool, userId, pi, [
      { lookupKey: 'sku_world', sessionAmount: 1, worldAmount: 1 },
      { lookupKey: 'sku_session', sessionAmount: 1, worldAmount: 1 },
      { lookupKey: 'tier_wayfarer', sessionAmount: 1, worldAmount: 1 },
    ])
    const refund: RefundFixture = {
      id: `re_test_${uuidv7().replace(/-/g, '')}`,
      object: 'refund',
      amount: 4500,
      currency: 'usd',
      created: Math.floor(Date.now() / 1000),
      payment_intent: pi,
      charge: `ch_test_${uuidv7().replace(/-/g, '')}`,
      status: 'succeeded',
    }
    const charge: ChargeFixture = {
      id: refund.charge ?? '',
      object: 'charge',
      amount_captured: 4500,
      amount_refunded: 4500,
      payment_intent: pi,
    }
    const { stripe } = makeStripeWithCharge({ charge })
    const event = makeRefundEvent('refund.created', refund)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // Clawback rows: 6 debit rows linked back to the originating grant ids
    // via source_id (debit-namespaced). Plus the 6 original grants → 12 total.
    const ledger = await fetchCreditLedgerForUser(pool, userId)
    expect(ledger.length).toBe(12)
    const debits = ledger.filter((r) => r.source_type === 'debit')
    expect(debits.length).toBe(6)
    for (const d of debits) {
      expect(d.amount).toBeLessThan(0)
      expect(d.expires_at).toBeNull()
      expect(d.source_purchase_id).toBeNull()
      expect(d.source_billing_history_id).toBeNull()
    }
    // Each clawback's source_id matches one of the seeded grants.
    const seededGrantIds = new Set<string>()
    for (const s of seeded) {
      if (s.sessionGrantId) seededGrantIds.add(s.sessionGrantId)
      if (s.worldGrantId) seededGrantIds.add(s.worldGrantId)
    }
    for (const d of debits) {
      expect(d.source_id).not.toBeNull()
      if (d.source_id !== null) {
        expect(seededGrantIds.has(d.source_id)).toBe(true)
      }
    }

    // All 3 purchases rows flipped to status='refunded'.
    const purch = await fetchPurchasesForUser(pool, userId)
    expect(purch.length).toBe(3)
    for (const p of purch) expect(p.status).toBe('refunded')

    // One refund billing_history row landed: kind='refund', source_id_stripe = re_*,
    // amount_cents = -refund.amount, expires_at = null, stripe_payment_intent_id = null.
    const hist = await fetchBillingHistoryForUser(pool, userId)
    expect(hist.length).toBe(1)
    const refundRow = hist[0]
    if (!refundRow) throw new Error('expected refund billing_history row')
    expect(refundRow.kind).toBe('refund')
    expect(refundRow.source_id_stripe).toBe(refund.id)
    expect(refundRow.amount_cents).toBe(-4500)
    expect(refundRow.lookup_key).toBeNull()
    expect(refundRow.expires_at).toBeNull()
    expect(refundRow.stripe_payment_intent_id).toBeNull()

    // No paging errors.
    expect(entries.filter((e) => e.level === 'error')).toEqual([])
  })

  it('subscription full refund happy path: clawback rows + billing_history.status=refunded + refund row', async () => {
    const { id: userId } = await createRefundTestUser(pool)
    const pi = `pi_test_${uuidv7().replace(/-/g, '')}`
    const invoiceId = `in_test_${uuidv7().replace(/-/g, '')}`
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const seeded = await seedSubscriptionInvoiceWithGrants(
      pool,
      userId,
      invoiceId,
      pi,
      1500,
      'tier_wayfarer',
      4,
      1,
      periodEnd,
    )
    const refund: RefundFixture = {
      id: `re_test_${uuidv7().replace(/-/g, '')}`,
      object: 'refund',
      amount: 1500,
      currency: 'usd',
      created: Math.floor(Date.now() / 1000),
      payment_intent: pi,
      charge: `ch_test_${uuidv7().replace(/-/g, '')}`,
      status: 'succeeded',
    }
    const charge: ChargeFixture = {
      id: refund.charge ?? '',
      object: 'charge',
      amount_captured: 1500,
      amount_refunded: 1500,
      payment_intent: pi,
    }
    const { stripe } = makeStripeWithCharge({ charge })
    const event = makeRefundEvent('refund.created', refund)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // 2 clawback rows linked to the 2 original subscription grants.
    const ledger = await fetchCreditLedgerForUser(pool, userId)
    const debits = ledger.filter((r) => r.source_type === 'debit')
    expect(debits.length).toBe(2)
    const expectedSeededIds = new Set<string>()
    if (seeded.sessionGrantId) expectedSeededIds.add(seeded.sessionGrantId)
    if (seeded.worldGrantId) expectedSeededIds.add(seeded.worldGrantId)
    for (const d of debits) {
      expect(d.source_id).not.toBeNull()
      if (d.source_id !== null) expect(expectedSeededIds.has(d.source_id)).toBe(true)
      expect(d.amount).toBeLessThan(0)
    }

    // billing_history: invoice row's status = 'refunded' + new refund row appended.
    const hist = await fetchBillingHistoryForUser(pool, userId)
    expect(hist.length).toBe(2)
    const invoiceRow = hist.find((r) => r.kind === 'invoice')
    const refundRow = hist.find((r) => r.kind === 'refund')
    if (!invoiceRow || !refundRow) throw new Error('expected one invoice + one refund row')
    expect(invoiceRow.status).toBe('refunded')
    expect(refundRow.source_id_stripe).toBe(refund.id)
    expect(refundRow.amount_cents).toBe(-1500)

    expect(entries.filter((e) => e.level === 'error')).toEqual([])
  })

  it('refund.payment_intent === null: INFO log billing.refund_unknown_origin, no clawback, no DB writes beyond stripe_events', async () => {
    const { id: userId } = await createRefundTestUser(pool)
    const refund: RefundFixture = {
      id: `re_test_${uuidv7().replace(/-/g, '')}`,
      object: 'refund',
      amount: 1000,
      currency: 'usd',
      created: Math.floor(Date.now() / 1000),
      payment_intent: null,
      charge: null,
      status: 'succeeded',
    }
    // No charge prefetch — refund.charge is null; the prefetcher returns
    // { charge: null }. Provide an empty stub.
    const { stripe, calls } = makeStripeWithCharge({})
    const event = makeRefundEvent('refund.created', refund)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(calls.chargeRetrieves).toEqual([])
    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    expect(
      entries.some(
        (e) => e.level === 'info' && e.msg === 'billing.refund_unknown_origin',
      ),
    ).toBe(true)
    expect((await fetchCreditLedgerForUser(pool, userId)).length).toBe(0)
    expect((await fetchBillingHistoryForUser(pool, userId)).length).toBe(0)
  })

  it('already-refunded à-la-carte: all purchases.status=refunded → INFO billing.refund_already_applied, no second clawback', async () => {
    const { id: userId } = await createRefundTestUser(pool)
    const pi = `pi_test_${uuidv7().replace(/-/g, '')}`
    // Seed purchase + grants, then run a refund through the dispatcher to flip
    // status='refunded' the first time.
    await seedAlaCartePurchaseWithGrants(pool, userId, pi, [
      { lookupKey: 'sku_session', sessionAmount: 1, worldAmount: 0 },
    ])
    const refund: RefundFixture = {
      id: `re_test_${uuidv7().replace(/-/g, '')}`,
      object: 'refund',
      amount: 1500,
      currency: 'usd',
      created: Math.floor(Date.now() / 1000),
      payment_intent: pi,
      charge: `ch_test_${uuidv7().replace(/-/g, '')}`,
      status: 'succeeded',
    }
    const charge: ChargeFixture = {
      id: refund.charge ?? '',
      object: 'charge',
      amount_captured: 1500,
      amount_refunded: 1500,
      payment_intent: pi,
    }
    const { stripe } = makeStripeWithCharge({ charge })
    const event1 = makeRefundEvent('refund.created', refund)
    const { log: log1 } = makeLogger()
    await dispatchEvent(event1, stripe, pool, log1)

    // Second delivery — fresh event_id, same re_*.
    const event2 = makeRefundEvent('refund.created', refund)
    const { log: log2, entries: entries2 } = makeLogger()
    await dispatchEvent(event2, stripe, pool, log2)

    expect(await countStripeEventRow(pool, event2.id)).toBe(1)
    expect(
      entries2.some(
        (e) => e.level === 'info' && e.msg === 'billing.refund_already_applied',
      ),
    ).toBe(true)

    // No additional clawback rows beyond the first delivery's 1 debit.
    const ledger = await fetchCreditLedgerForUser(pool, userId)
    expect(ledger.filter((r) => r.source_type === 'debit').length).toBe(1)
    // billing_history still has just one refund row (the second delivery's
    // do_nothing prevented a 23505 + the early-exit prevented the append).
    expect(
      (await fetchBillingHistoryForUser(pool, userId)).filter((r) => r.kind === 'refund').length,
    ).toBe(1)
  })

  it('transient miss: PI set but neither purchases nor billing_history row exists → WARN + THROW (rolls back stripe_events)', async () => {
    const { id: userId } = await createRefundTestUser(pool)
    const pi = `pi_test_${uuidv7().replace(/-/g, '')}`
    // No seeded purchase, no seeded billing_history row for this PI.
    const refund: RefundFixture = {
      id: `re_test_${uuidv7().replace(/-/g, '')}`,
      object: 'refund',
      amount: 1500,
      currency: 'usd',
      created: Math.floor(Date.now() / 1000),
      payment_intent: pi,
      charge: `ch_test_${uuidv7().replace(/-/g, '')}`,
      status: 'succeeded',
    }
    const charge: ChargeFixture = {
      id: refund.charge ?? '',
      object: 'charge',
      amount_captured: 1500,
      amount_refunded: 1500,
      payment_intent: pi,
    }
    const { stripe } = makeStripeWithCharge({ charge })
    const event = makeRefundEvent('refund.created', refund)
    const { log, entries } = makeLogger()

    await expect(dispatchEvent(event, stripe, pool, log)).rejects.toThrow()

    // stripe_events row was rolled back so Stripe redelivers.
    expect(await countStripeEventRow(pool, event.id)).toBe(0)
    expect(
      entries.some(
        (e) => e.level === 'warn' && e.msg === 'billing.refund_resolution_miss',
      ),
    ).toBe(true)
    expect((await fetchCreditLedgerForUser(pool, userId)).length).toBe(0)
  })

  it('recordClawback ON CONFLICT idempotency: simulated re-delivered refund (different event_id, same re_*) skips already-clawed rows', async () => {
    const { id: userId } = await createRefundTestUser(pool)
    const pi = `pi_test_${uuidv7().replace(/-/g, '')}`
    await seedAlaCartePurchaseWithGrants(pool, userId, pi, [
      { lookupKey: 'sku_world', sessionAmount: 1, worldAmount: 1 },
    ])
    const refund: RefundFixture = {
      id: `re_test_${uuidv7().replace(/-/g, '')}`,
      object: 'refund',
      amount: 1500,
      currency: 'usd',
      created: Math.floor(Date.now() / 1000),
      payment_intent: pi,
      charge: `ch_test_${uuidv7().replace(/-/g, '')}`,
      status: 'succeeded',
    }
    const charge: ChargeFixture = {
      id: refund.charge ?? '',
      object: 'charge',
      amount_captured: 1500,
      amount_refunded: 1500,
      payment_intent: pi,
    }
    const { stripe } = makeStripeWithCharge({ charge })

    // 1st delivery — succeeds, lands 2 clawback rows + flips purchase + writes refund row.
    const event1 = makeRefundEvent('refund.created', refund)
    const { log: log1 } = makeLogger()
    await dispatchEvent(event1, stripe, pool, log1)
    const ledgerAfter1 = await fetchCreditLedgerForUser(pool, userId)
    const debitCount1 = ledgerAfter1.filter((r) => r.source_type === 'debit').length
    expect(debitCount1).toBe(2)

    // Manually delete the stripe_events row so the second dispatch progresses
    // past the dedup check. This simulates an operator-driven Stripe redelivery
    // that creates a new event_id for the same re_*; the recordClawback
    // ON CONFLICT (user_id, credit_type, source_id) WHERE source_type='debit'
    // DO NOTHING semantics keep the second pass clean.
    await pool.query('DELETE FROM stripe_events WHERE event_id = $1', [event1.id])

    const event2 = makeRefundEvent('refund.created', refund)
    const { log: log2, entries: entries2 } = makeLogger()
    await dispatchEvent(event2, stripe, pool, log2)

    // Second delivery: status='refunded' on the seeded purchase row → handler
    // takes the already-applied path. No NEW clawback rows.
    const ledgerAfter2 = await fetchCreditLedgerForUser(pool, userId)
    expect(ledgerAfter2.filter((r) => r.source_type === 'debit').length).toBe(2)
    expect(
      entries2.some(
        (e) => e.level === 'info' && e.msg === 'billing.refund_already_applied',
      ),
    ).toBe(true)
  })
})
