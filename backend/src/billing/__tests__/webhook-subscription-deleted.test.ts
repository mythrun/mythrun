// backend/src/billing/__tests__/webhook-subscription-deleted.test.ts
//
// Tests for `customer.subscription.deleted` handler (Task 21, MYT-42 §5.4.4).
//
// Handler contract:
//   1. Resolve user via subscription.customer → users.stripe_customer_id
//      (FOR UPDATE anchor lock per §5.3). On miss, fall back to
//      subscription.metadata.userId. Total miss → log INFO + 'ok'.
//   2. Call userSubscriptions.markCanceled with cancel_at_period_end
//      PRESERVED from the event payload (Kraken C3 round 2: do NOT collapse
//      to false on .deleted — user-vs-Stripe-cancel distinction needed for
//      UX + analytics).
//   3. No row matched (rowcount 0) → log INFO 'billing.subscription_deleted_unknown_id'
//      + return 'ok'.
//   4. credit_ledger rows are untouched (user pays for the period; credits
//      remain consumable through current_period_end per §3.3 + §10).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'
import type { Stripe } from 'stripe'
import type { Pool } from 'pg'
import { pool, ensureSchema } from '../../repo/__tests__/_helpers/with-tx.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { STRIPE_API_VERSION } from '../stripe-client.js'
import { dispatchEvent } from '../webhook.js'

// ─── shared test helpers ────────────────────────────────────────────────────

let userCounter = 0
async function createDeletedTestUser(p: Pool): Promise<{ id: string; cus: string }> {
  const id = uuidv7()
  userCounter += 1
  const n = userCounter
  const cus = `cus_test_subdel_${String(n)}_${id.slice(0, 8)}`
  await p.query(
    `INSERT INTO users (id, cognito_sub, username, display_name, stripe_customer_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `subdel_sub_${String(n)}`, `subdeluser${String(n)}`, `SubDel ${String(n)}`, cus],
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

// `customer.subscription.deleted` has no PREFETCHERS entry — handler reads
// event.data.object directly. Stripe client stub never invoked.
function makeStripe(): Stripe {
  return {} as unknown as Stripe
}

// ─── Subscription fixture ──────────────────────────────────────────────────

interface CancellationDetailsFixture {
  readonly reason: string | null
}

interface SubscriptionDeletedFixture {
  readonly id: string
  readonly object: 'subscription'
  readonly customer: string
  readonly status: string
  readonly cancel_at_period_end: boolean
  readonly cancel_at: number | null
  readonly cancellation_details: CancellationDetailsFixture | null
  readonly metadata: { readonly userId?: string }
}

interface BuildDeletedSubscriptionOpts {
  sub_id: string
  customer: string
  cancelAtPeriodEnd?: boolean
  cancelAt?: number | null
  cancellationDetails?: CancellationDetailsFixture | null
  metadataUserId?: string
}

function buildDeletedSubscriptionFixture(
  opts: BuildDeletedSubscriptionOpts,
): SubscriptionDeletedFixture {
  return {
    id: opts.sub_id,
    object: 'subscription',
    customer: opts.customer,
    status: 'canceled',
    cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
    cancel_at: opts.cancelAt ?? null,
    cancellation_details: opts.cancellationDetails ?? null,
    metadata: opts.metadataUserId ? { userId: opts.metadataUserId } : {},
  }
}

function makeDeletedSubscriptionEvent(
  subscription: SubscriptionDeletedFixture,
  eventCreated?: number,
): Stripe.Event {
  return {
    id: `evt_test_${uuidv7()}`,
    object: 'event',
    api_version: STRIPE_API_VERSION,
    type: 'customer.subscription.deleted',
    created: eventCreated ?? Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object: subscription },
  } as unknown as Stripe.Event
}

// ─── DB helpers ────────────────────────────────────────────────────────────

interface UserSubscriptionRow {
  readonly status: string
  readonly cancel_at_period_end: boolean
  readonly cancel_at: Date | null
  readonly cancellation_details: unknown
}

async function fetchUserSubscription(
  p: Pool,
  sub_id: string,
): Promise<UserSubscriptionRow | null> {
  const r = await p.query<UserSubscriptionRow>(
    `SELECT status, cancel_at_period_end, cancel_at, cancellation_details
       FROM user_subscriptions
       WHERE stripe_subscription_id = $1`,
    [sub_id],
  )
  return r.rows[0] ?? null
}

async function seedUserSubscription(
  p: Pool,
  opts: {
    sub_id: string
    user_id: string
    tier_lookup_key?: string
    status?: string
    cancel_at_period_end?: boolean
    stripe_event_created_at?: Date
  },
): Promise<void> {
  const periodStart = new Date('2026-05-01T00:00:00Z')
  const periodEnd = new Date('2026-06-01T00:00:00Z')
  await p.query(
    `INSERT INTO user_subscriptions
       (id, user_id, stripe_subscription_id, tier_lookup_key, status,
        current_period_start, current_period_end,
        cancel_at_period_end, stripe_event_created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      uuidv7(),
      opts.user_id,
      opts.sub_id,
      opts.tier_lookup_key ?? 'tier_wayfarer',
      opts.status ?? 'active',
      periodStart,
      periodEnd,
      opts.cancel_at_period_end ?? false,
      opts.stripe_event_created_at ?? new Date(),
    ],
  )
}

async function countCreditLedgerRows(p: Pool, sub_id: string): Promise<number> {
  // Credit ledger rows link to user_subscriptions via source_billing_history_id
  // or have user_id. Since these tests seed ledger rows directly by sub's
  // user_id (no billing_history row needed), we query by user_id stored on
  // the subscription row.
  const r = await p.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM credit_ledger
     WHERE user_id = (
       SELECT user_id FROM user_subscriptions
       WHERE stripe_subscription_id = $1
     )`,
    [sub_id],
  )
  return parseInt(r.rows[0]?.cnt ?? '0', 10)
}

async function seedCreditLedgerRow(
  p: Pool,
  opts: { user_id: string; amount: number; expires_at: Date },
): Promise<void> {
  // Use source_type='gift' so the source_link_chk passes without FK refs:
  // gift rows have source_purchase_id IS NULL AND source_billing_history_id IS NULL.
  await p.query(
    `INSERT INTO credit_ledger
       (id, user_id, credit_type, amount, source_type, expires_at)
     VALUES ($1, $2, 'session', $3, 'gift', $4)`,
    [uuidv7(), opts.user_id, opts.amount, opts.expires_at],
  )
}

async function countStripeEventRow(p: Pool, event_id: string): Promise<number> {
  const r = await p.query<{ event_id: string }>(
    'SELECT event_id FROM stripe_events WHERE event_id = $1',
    [event_id],
  )
  return r.rows.length
}

// ─── lifecycle ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensureSchema()
})

afterAll(async () => {
  await pool.end()
})

// ─── tests ──────────────────────────────────────────────────────────────────

describe('billing.webhook customer.subscription.deleted (handleSubscriptionDeleted)', () => {
  it('user-initiated cancel-at-period-end: status set to canceled, cancel_at_period_end=true PRESERVED', async () => {
    const { id: userId, cus } = await createDeletedTestUser(pool)
    const sub_id = `sub_delcape_${uuidv7().slice(0, 10)}`

    // Seed an active user_subscriptions row to update.
    await seedUserSubscription(pool, {
      sub_id,
      user_id: userId,
      status: 'active',
      cancel_at_period_end: false,
    })

    const subscription = buildDeletedSubscriptionFixture({
      sub_id,
      customer: cus,
      cancelAtPeriodEnd: true, // user clicked "Cancel at period end"
      cancellationDetails: { reason: 'cancellation_requested' },
    })
    const event = makeDeletedSubscriptionEvent(subscription)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, makeStripe(), pool, log)

    // stripe_events row committed.
    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // Row updated with status='canceled' and cancel_at_period_end=true PRESERVED.
    const row = await fetchUserSubscription(pool, sub_id)
    expect(row).not.toBeNull()
    if (!row) throw new Error('expected user_subscriptions row')
    expect(row.status).toBe('canceled')
    expect(row.cancel_at_period_end).toBe(true)
    expect(row.cancellation_details).toMatchObject({ reason: 'cancellation_requested' })

    // No error logs.
    expect(entries.filter((e) => e.level === 'error')).toEqual([])
  })

  it('Stripe-initiated dunning cancel: status set to canceled, cancel_at_period_end=false PRESERVED', async () => {
    const { id: userId, cus } = await createDeletedTestUser(pool)
    const sub_id = `sub_deldun_${uuidv7().slice(0, 10)}`

    await seedUserSubscription(pool, {
      sub_id,
      user_id: userId,
      status: 'past_due',
      cancel_at_period_end: false,
    })

    const subscription = buildDeletedSubscriptionFixture({
      sub_id,
      customer: cus,
      cancelAtPeriodEnd: false, // Stripe-initiated dunning — NOT user-initiated
      cancellationDetails: { reason: 'payment_failed' },
    })
    const event = makeDeletedSubscriptionEvent(subscription)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, makeStripe(), pool, log)

    // stripe_events row committed.
    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // Row updated: status='canceled', cancel_at_period_end=false PRESERVED
    // (not collapsed by the handler — the false here is meaningful: it
    // distinguishes Stripe-initiated from user-initiated).
    const row = await fetchUserSubscription(pool, sub_id)
    expect(row).not.toBeNull()
    if (!row) throw new Error('expected user_subscriptions row')
    expect(row.status).toBe('canceled')
    expect(row.cancel_at_period_end).toBe(false)
    expect(row.cancellation_details).toMatchObject({ reason: 'payment_failed' })

    // No error logs.
    expect(entries.filter((e) => e.level === 'error')).toEqual([])
  })

  it('existing credit_ledger rows untouched after .deleted arrives', async () => {
    const { id: userId, cus } = await createDeletedTestUser(pool)
    const sub_id = `sub_delcl_${uuidv7().slice(0, 10)}`

    await seedUserSubscription(pool, {
      sub_id,
      user_id: userId,
      status: 'active',
    })

    // Seed two credit_ledger rows before the .deleted arrives.
    const expiresAt = new Date('2026-06-01T00:00:00Z')
    await seedCreditLedgerRow(pool, { user_id: userId, amount: 100, expires_at: expiresAt })
    await seedCreditLedgerRow(pool, { user_id: userId, amount: 50, expires_at: expiresAt })

    const subscription = buildDeletedSubscriptionFixture({
      sub_id,
      customer: cus,
      cancelAtPeriodEnd: false,
      cancellationDetails: { reason: 'cancellation_requested' },
    })
    const event = makeDeletedSubscriptionEvent(subscription)
    const { log } = makeLogger()

    await dispatchEvent(event, makeStripe(), pool, log)

    // stripe_events row committed.
    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // user_subscriptions row updated to 'canceled'.
    const row = await fetchUserSubscription(pool, sub_id)
    expect(row?.status).toBe('canceled')

    // credit_ledger rows untouched — both rows still present.
    expect(await countCreditLedgerRows(pool, sub_id)).toBe(2)
  })

  it('no row matches stripe_subscription_id: logs INFO billing.subscription_deleted_unknown_id, returns ok', async () => {
    // User EXISTS (resolves fine via stripe_customer_id) but there is NO
    // matching user_subscriptions row for this stripe_subscription_id.
    // Covers: Stripe-side test event, deletion-before-creation race.
    const { cus } = await createDeletedTestUser(pool)
    const sub_id = `sub_delunk_${uuidv7().slice(0, 10)}`
    // No seedUserSubscription call — the subscription row does NOT exist.
    const subscription = buildDeletedSubscriptionFixture({
      sub_id,
      customer: cus,
    })
    const event = makeDeletedSubscriptionEvent(subscription)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, makeStripe(), pool, log)

    // stripe_events row committed (Stripe stops retrying).
    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // INFO log emitted with the spec'd shape.
    const unknownLog = entries.find(
      (e) => e.msg === 'billing.subscription_deleted_unknown_id',
    )
    expect(unknownLog).toBeDefined()
    if (!unknownLog) throw new Error('expected billing.subscription_deleted_unknown_id log')
    expect(unknownLog.level).toBe('info')
    expect(unknownLog.obj.subscription_id).toBe(sub_id)

    // No error logs.
    expect(entries.filter((e) => e.level === 'error')).toEqual([])
  })
})
