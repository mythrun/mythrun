// backend/src/billing/__tests__/webhook-subscription-upsert.test.ts
//
// Tests for the shared `customer.subscription.created` /
// `customer.subscription.updated` handler (Task 20, MYT-42 §5.4.3).
//
// The dispatcher manages its own pg transaction; like the other webhook
// handler suites these use the shared test pool directly. Each test
// builds a fresh users row + unique stripe_subscription_id so persisted
// writes from one test don't collide with another.
//
// Critical regression test: the **pending-update gate** (round-7
// + research findings). When `event.data.object.pending_update !== null`
// the handler must log INFO and write nothing — the items have NOT
// advanced yet, and the `pending_update_applied` handler (Task 22) is
// the canonical place that lands the upgrade.

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
async function createSubscriptionTestUser(p: Pool): Promise<{ id: string; cus: string }> {
  const id = uuidv7()
  userCounter += 1
  const n = userCounter
  const cus = `cus_test_subupsert_${String(n)}_${id.slice(0, 8)}`
  await p.query(
    `INSERT INTO users (id, cognito_sub, username, display_name, stripe_customer_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `subupsert_sub_${String(n)}`, `subupsertuser${String(n)}`, `SubUpsert ${String(n)}`, cus],
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

// `customer.subscription.*` events don't go through a prefetcher (the
// handler reads `event.data.object` directly), so the Stripe client stub
// only needs to be `Stripe`-typed — never invoked during dispatch.
function makeStripe(): Stripe {
  return {} as unknown as Stripe
}

// ─── Subscription fixture ──────────────────────────────────────────────────

interface PendingUpdateFixture {
  readonly expires_at: number
}

interface SubscriptionItemFixture {
  readonly id: string
  readonly current_period_start: number
  readonly current_period_end: number
  readonly price: {
    readonly id: string
    readonly lookup_key: string | null
  }
}

interface SubscriptionFixture {
  readonly id: string
  readonly object: 'subscription'
  readonly customer: string
  readonly status: string
  readonly cancel_at_period_end: boolean
  readonly cancel_at: number | null
  readonly cancellation_details: unknown
  readonly metadata: { readonly userId?: string }
  readonly pending_update: PendingUpdateFixture | null
  readonly latest_invoice: string | null
  readonly items: { readonly data: readonly SubscriptionItemFixture[] }
}

interface BuildSubscriptionOpts {
  sub_id: string
  customer: string
  status?: string
  cancelAtPeriodEnd?: boolean
  cancelAt?: number | null
  cancellationDetails?: unknown
  metadataUserId?: string
  pendingUpdate?: PendingUpdateFixture | null
  latestInvoice?: string | null
  tierLookupKey?: string | null
  priceId?: string
  periodStart?: number
  periodEnd?: number
  itemCount?: number
}

const PERIOD_START_SEC = Math.floor(new Date('2026-05-01T00:00:00Z').getTime() / 1000)
const PERIOD_END_SEC = Math.floor(new Date('2026-06-01T00:00:00Z').getTime() / 1000)

function buildSubscriptionFixture(opts: BuildSubscriptionOpts): SubscriptionFixture {
  const periodStart = opts.periodStart ?? PERIOD_START_SEC
  const periodEnd = opts.periodEnd ?? PERIOD_END_SEC
  const tierLookupKey =
    opts.tierLookupKey === undefined ? 'tier_wayfarer' : opts.tierLookupKey
  const priceId = opts.priceId ?? 'price_test_wayfarer'
  const itemCount = opts.itemCount ?? 1
  const items: SubscriptionItemFixture[] = []
  for (let i = 0; i < itemCount; i += 1) {
    items.push({
      id: `si_${String(i)}_${opts.sub_id.slice(-6)}`,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      price: { id: priceId, lookup_key: tierLookupKey },
    })
  }
  return {
    id: opts.sub_id,
    object: 'subscription',
    customer: opts.customer,
    status: opts.status ?? 'active',
    cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
    cancel_at: opts.cancelAt ?? null,
    cancellation_details: opts.cancellationDetails ?? null,
    metadata: opts.metadataUserId ? { userId: opts.metadataUserId } : {},
    pending_update: opts.pendingUpdate ?? null,
    latest_invoice: opts.latestInvoice ?? null,
    items: { data: items },
  }
}

function makeSubscriptionEvent(
  subscription: SubscriptionFixture,
  type: 'customer.subscription.created' | 'customer.subscription.updated',
  eventCreated?: number,
): Stripe.Event {
  return {
    id: `evt_test_${uuidv7()}`,
    object: 'event',
    api_version: STRIPE_API_VERSION,
    type,
    created: eventCreated ?? Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object: subscription },
  } as unknown as Stripe.Event
}

interface UserSubscriptionRow {
  readonly user_id: string
  readonly tier_lookup_key: string
  readonly status: string
  readonly current_period_start: Date
  readonly current_period_end: Date
  readonly cancel_at_period_end: boolean
  readonly cancel_at: Date | null
  readonly cancellation_details: unknown
  readonly stripe_event_created_at: Date
}

async function fetchUserSubscription(
  p: Pool,
  sub_id: string,
): Promise<UserSubscriptionRow | null> {
  const r = await p.query<UserSubscriptionRow>(
    `SELECT user_id, tier_lookup_key, status,
            current_period_start, current_period_end,
            cancel_at_period_end, cancel_at, cancellation_details,
            stripe_event_created_at
       FROM user_subscriptions
       WHERE stripe_subscription_id = $1`,
    [sub_id],
  )
  return r.rows[0] ?? null
}

async function countUserSubs(p: Pool, sub_id: string): Promise<number> {
  const r = await p.query<{ id: string }>(
    'SELECT id FROM user_subscriptions WHERE stripe_subscription_id = $1',
    [sub_id],
  )
  return r.rows.length
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

describe('billing.webhook customer.subscription.created/updated (handleSubscriptionUpsert)', () => {
  it("fresh '.created' event with pending_update=null: upserts user_subscriptions with tier + period dates + cancel_at_period_end", async () => {
    const { id: userId, cus } = await createSubscriptionTestUser(pool)
    const sub_id = `sub_create_${uuidv7().slice(0, 12)}`
    const subscription = buildSubscriptionFixture({
      sub_id,
      customer: cus,
      tierLookupKey: 'tier_wayfarer',
      cancelAtPeriodEnd: false,
    })
    const event = makeSubscriptionEvent(subscription, 'customer.subscription.created')
    const { log, entries } = makeLogger()

    await dispatchEvent(event, makeStripe(), pool, log)

    // stripe_events row committed.
    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // user_subscriptions row landed with the right shape.
    const row = await fetchUserSubscription(pool, sub_id)
    expect(row).not.toBeNull()
    if (!row) throw new Error('expected user_subscriptions row')
    expect(row.user_id).toBe(userId)
    expect(row.tier_lookup_key).toBe('tier_wayfarer')
    expect(row.status).toBe('active')
    expect(row.current_period_start.toISOString()).toBe('2026-05-01T00:00:00.000Z')
    expect(row.current_period_end.toISOString()).toBe('2026-06-01T00:00:00.000Z')
    expect(row.cancel_at_period_end).toBe(false)
    expect(row.cancel_at).toBeNull()
    expect(row.cancellation_details).toBeNull()
    expect(row.stripe_event_created_at).toBeInstanceOf(Date)

    // No paging-grade error logs and no pending-update log.
    expect(entries.filter((e) => e.level === 'error')).toEqual([])
    expect(
      entries.find((e) => e.msg === 'billing.subscription_pending_update_visible'),
    ).toBeUndefined()
  })

  it("'.updated' event with pending_update populated: logs INFO, writes nothing (round-7 pending-update gate)", async () => {
    const { id: userId, cus } = await createSubscriptionTestUser(pool)
    const sub_id = `sub_pend_${uuidv7().slice(0, 12)}`
    const expiresAt = Math.floor(new Date('2026-05-07T00:00:00Z').getTime() / 1000)
    const latestInvoiceId = `in_pend_${uuidv7().slice(0, 12)}`
    // Subscription items + tier still reflect the OLD tier — the
    // upgrade has NOT advanced. The handler must NOT upsert.
    const subscription = buildSubscriptionFixture({
      sub_id,
      customer: cus,
      tierLookupKey: 'tier_wayfarer',
      pendingUpdate: { expires_at: expiresAt },
      latestInvoice: latestInvoiceId,
    })
    const event = makeSubscriptionEvent(subscription, 'customer.subscription.updated')
    const { log, entries } = makeLogger()

    await dispatchEvent(event, makeStripe(), pool, log)

    // stripe_events row committed (Stripe stops retrying).
    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // NO user_subscriptions row (the gate fires before the upsert).
    expect(await countUserSubs(pool, sub_id)).toBe(0)

    // Pending-update INFO log emitted with the spec'd shape.
    const gate = entries.find((e) => e.msg === 'billing.subscription_pending_update_visible')
    expect(gate).toBeDefined()
    if (!gate) throw new Error('expected billing.subscription_pending_update_visible log')
    expect(gate.level).toBe('info')
    expect(gate.obj.subscription_id).toBe(sub_id)
    expect((gate.obj as { pending_update_expires_at?: number }).pending_update_expires_at).toBe(
      expiresAt,
    )
    expect((gate.obj as { latest_invoice_id?: string }).latest_invoice_id).toBe(latestInvoiceId)

    // No paging-grade errors.
    expect(entries.filter((e) => e.level === 'error')).toEqual([])

    // userId is referenced via row creation but not asserted further (no
    // user_subscriptions row was written — the existence-check above is
    // the load-bearing assertion).
    expect(userId).toMatch(/^[0-9a-f-]+$/)
  })

  it("stale '.updated' event (lower event.created than existing row): row unchanged via repo's strict-> filter", async () => {
    const { id: userId, cus } = await createSubscriptionTestUser(pool)
    const sub_id = `sub_stale_${uuidv7().slice(0, 12)}`

    // First: a `.created` event at T2 lands the canonical row.
    const T1 = Math.floor(new Date('2026-05-01T12:00:00Z').getTime() / 1000)
    const T2 = Math.floor(new Date('2026-05-02T12:00:00Z').getTime() / 1000)
    const freshSubscription = buildSubscriptionFixture({
      sub_id,
      customer: cus,
      tierLookupKey: 'tier_sojourner',
      status: 'active',
    })
    const freshEvent = makeSubscriptionEvent(
      freshSubscription,
      'customer.subscription.created',
      T2,
    )
    await dispatchEvent(freshEvent, makeStripe(), pool, makeLogger().log)

    const beforeRow = await fetchUserSubscription(pool, sub_id)
    expect(beforeRow).not.toBeNull()
    if (!beforeRow) throw new Error('expected pre-stale row')
    expect(beforeRow.tier_lookup_key).toBe('tier_sojourner')
    expect(beforeRow.user_id).toBe(userId)

    // Now: a `.updated` event at T1 (BEFORE the existing row's
    // stripe_event_created_at) carries different tier_lookup_key. The
    // repo's strict-> filter must reject the UPDATE; the row must
    // retain its original values.
    const staleSubscription = buildSubscriptionFixture({
      sub_id,
      customer: cus,
      tierLookupKey: 'tier_wayfarer', // different on purpose
      status: 'past_due',
    })
    const staleEvent = makeSubscriptionEvent(
      staleSubscription,
      'customer.subscription.updated',
      T1,
    )
    const { log, entries } = makeLogger()

    await dispatchEvent(staleEvent, makeStripe(), pool, log)

    // stripe_events row committed for the second delivery (Stripe stops retrying).
    expect(await countStripeEventRow(pool, staleEvent.id)).toBe(1)

    // Row still reflects the FIRST event's payload — the strict-> WHERE
    // rejected the stale UPDATE.
    const afterRow = await fetchUserSubscription(pool, sub_id)
    expect(afterRow).not.toBeNull()
    if (!afterRow) throw new Error('expected post-stale row')
    expect(afterRow.tier_lookup_key).toBe('tier_sojourner')
    expect(afterRow.status).toBe('active')

    // No paging-grade error logs (stale event is a normal idempotent path).
    expect(entries.filter((e) => e.level === 'error')).toEqual([])
  })

  it("unknown customer (no users.stripe_customer_id match, no metadata.userId): logs INFO 'billing.subscription_unknown_customer', writes nothing", async () => {
    // `cus` is a Stripe-side test customer that has no Mythrun users row
    // and the subscription metadata has no userId fallback.
    const sub_id = `sub_unk_${uuidv7().slice(0, 12)}`
    const subscription = buildSubscriptionFixture({
      sub_id,
      customer: `cus_orphan_${uuidv7().slice(0, 8)}`,
      // no metadataUserId — total miss
    })
    const event = makeSubscriptionEvent(subscription, 'customer.subscription.created')
    const { log, entries } = makeLogger()

    await dispatchEvent(event, makeStripe(), pool, log)

    // stripe_events row committed (Stripe stops retrying).
    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // No user_subscriptions row.
    expect(await countUserSubs(pool, sub_id)).toBe(0)

    // INFO log with the unknown-customer shape.
    const orphan = entries.find((e) => e.msg === 'billing.subscription_unknown_customer')
    expect(orphan).toBeDefined()
    if (!orphan) throw new Error('expected billing.subscription_unknown_customer log')
    expect(orphan.level).toBe('info')
    expect(orphan.obj.subscription_id).toBe(sub_id)

    // No paging-grade errors.
    expect(entries.filter((e) => e.level === 'error')).toEqual([])
  })

  it("multi-item subscription returns 'validation_failed' + paging 'billing.subscription_multi_item'", async () => {
    const { id: userId, cus } = await createSubscriptionTestUser(pool)
    const sub_id = `sub_multi_${uuidv7().slice(0, 12)}`
    const subscription = buildSubscriptionFixture({
      sub_id,
      customer: cus,
      itemCount: 2, // multi-line — operator error
    })
    const event = makeSubscriptionEvent(subscription, 'customer.subscription.updated')
    const { log, entries } = makeLogger()

    await dispatchEvent(event, makeStripe(), pool, log)

    // stripe_events row committed (validation_failed sentinel still COMMITs
    // the dispatch tx; only handler-side writes are skipped).
    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // No user_subscriptions row.
    expect(await countUserSubs(pool, sub_id)).toBe(0)

    // Paging-grade error log emitted by the handler.
    const paged = entries.find((e) => e.msg === 'billing.subscription_multi_item')
    expect(paged).toBeDefined()
    if (!paged) throw new Error('expected billing.subscription_multi_item log')
    expect(paged.level).toBe('error')
    expect(paged.obj.subscription_id).toBe(sub_id)
    expect((paged.obj as { items_count?: number }).items_count).toBe(2)

    // Dispatcher emits its own validation_failed paging log on top of the
    // handler's paging log.
    const sentinel = entries.find(
      (e) => e.msg === 'billing.handler_validation_failed_committed',
    )
    expect(sentinel).toBeDefined()

    // userId referenced via row creation; the load-bearing assertion is
    // "no user_subscriptions row landed."
    expect(userId).toMatch(/^[0-9a-f-]+$/)
  })
})
