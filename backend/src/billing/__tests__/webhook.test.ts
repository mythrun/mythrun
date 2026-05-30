// backend/src/billing/__tests__/webhook.test.ts
//
// Tests for the Stripe webhook dispatcher (Task 16, MYT-42 §5.3).
//
// The dispatcher manages its own pg transaction (BEGIN + 3× SET LOCAL),
// so these tests use the shared test pool directly via `pool.connect()`
// rather than the standard `withTx` helper. Test isolation is achieved
// via unique event_ids per test (uuidv7-prefixed) so the committed
// `stripe_events` rows from one test do not collide with another's.

import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'
import type { Stripe } from 'stripe'
import type { Pool } from 'pg'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { STRIPE_API_VERSION } from '../stripe-client.js'
import {
  dispatchEvent,
  DISPATCH_TX_OPTS,
  HANDLERS,
  PREFETCHERS,
  type EventHandler,
  type KnownStripeEventType,
  type PrefetchFn,
} from '../webhook.js'
import { runTransaction } from '../../repo/_client.js'
import type { ClientLike } from '../../repo/_types.js'
import {
  setSkuCache,
  _resetSkuCacheForTests,
  type SkuCache,
  type SkuInternalEntry,
} from '../sku-cache.js'
import { LOOKUP_KEYS, type LookupKey } from '../lookup-keys.js'

// Short label to fit makeTestScope.username()'s 28-char cap.
const pool = createTestPool(process.env.DATABASE_URL ?? '')
const scope = makeTestScope('webhook')

/**
 * Insert a users row directly via the shared pool. Returns the new id and
 * the stripe_customer_id we wrote, so the caller can build a
 * checkout.session.completed fixture whose `customer` matches (or doesn't
 * match, for the mismatch test).
 *
 * Each call generates a unique cognito_sub / username / cus_* so tests can
 * run sequentially against a non-truncated `users` table.
 */
let userCounter = 0
async function createWebhookTestUser(
  p: Pool,
  s: TestScope,
): Promise<{ id: string; cus: string }> {
  const id = uuidv7()
  const n = userCounter
  userCounter += 1
  const cus = `cus_${s.id}_${String(n)}`
  await p.query(
    `INSERT INTO users (id, cognito_sub, username, display_name, stripe_customer_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, s.userSub(n), s.username(n), s.displayName(n), cus],
  )
  return { id, cus }
}

afterAll(async () => {
  // credit_ledger has RESTRICT-FK to purchases and billing_history. Delete
  // it first, then purchases (no CASCADE on users), then cleanupTestScope.
  await pool.query(`DELETE FROM stripe_events WHERE event_id LIKE $1`, [`evt_${scope.id}_%`])
  const userScope = `${scope.id}%`
  await pool.query(
    `DELETE FROM credit_ledger
       WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
    [userScope],
  )
  await pool.query(
    `DELETE FROM purchases
       WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
    [userScope],
  )
  await cleanupTestScope(pool, scope)
  await pool.end()
})

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
  // Cast through unknown — FastifyBaseLogger has many methods we do not
  // exercise here. The dispatcher only calls .info / .warn / .error.
  // Logger surface: dispatcher uses .info/.warn/.error. Other fields
  // are present only because FastifyBaseLogger requires them.
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

let eventCounter = 0
function nextEventId(): string {
  const idx = eventCounter
  eventCounter += 1
  return `evt_${scope.id}_${String(idx)}`
}

function makeEvent(overrides: Partial<Stripe.Event> = {}): Stripe.Event {
  // The dispatcher only reads .id, .type, .api_version. We construct a
  // minimally-shaped object and cast through unknown rather than build a
  // full Stripe.Event fixture.
  const base = {
    id: nextEventId(),
    object: 'event',
    api_version: STRIPE_API_VERSION,
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object: { id: 'cs_test', metadata: {} } },
  }
  return { ...base, ...overrides } as unknown as Stripe.Event
}

// Tests in this block override the HANDLERS entry to inject test
// behavior; the prefetcher still runs (Task 17 registered one for
// checkout.session.completed). Returning a session with `subscription:
// null` means the prefetcher's subscription-fetch branch is skipped, so
// these dispatcher-shape tests don't depend on a real Stripe client.
function makeStripe(): Stripe {
  const stub = {
    checkout: {
      sessions: {
        retrieve: (id: string) =>
          Promise.resolve({
            id,
            mode: 'subscription',
            customer: null,
            subscription: null,
            payment_intent: null,
            payment_status: 'paid',
            metadata: {},
            line_items: { data: [] },
            amount_subtotal: 0,
          }),
      },
    },
    subscriptions: {
      retrieve: (): Promise<never> =>
        Promise.reject(new Error('makeStripe(): subscriptions.retrieve not stubbed for this test')),
    },
  }
  return stub as unknown as Stripe
}

async function countStripeEventRow(p: Pool, event_id: string): Promise<number> {
  const r = await p.query<{ event_id: string }>(
    'SELECT event_id FROM stripe_events WHERE event_id = $1',
    [event_id],
  )
  return r.rows.length
}

/**
 * Replace one entry in the HANDLERS map for the duration of `fn`. The
 * dispatcher reads HANDLERS by reference, so a temporary swap is enough
 * to inject test-specific behavior without recompiling the module.
 */
async function withHandlerOverride(
  type: KnownStripeEventType,
  override: EventHandler,
  fn: () => Promise<void>,
): Promise<void> {
  const original = HANDLERS[type]
  HANDLERS[type] = override
  try {
    await fn()
  } finally {
    HANDLERS[type] = original
  }
}

// Synchronous handler bodies wrapped in Promise.resolve avoid the
// `async function has no await` ESLint rule while preserving the
// EventHandler signature exactly.
function countingOk(counter: { n: number }): EventHandler {
  return () => {
    counter.n += 1
    return Promise.resolve('ok')
  }
}

const handlerOk: EventHandler = () => Promise.resolve('ok')
const handlerValidationFailed: EventHandler = () => Promise.resolve('validation_failed')
function handlerThrowing(err: Error): EventHandler {
  return () => Promise.reject(err)
}

describe('billing.webhook.dispatchEvent', () => {
  it('first delivery → handler invoked, COMMIT, stripe_events row persisted', async () => {
    const event = makeEvent()
    const counter = { n: 0 }
    const { log } = makeLogger()
    await withHandlerOverride('checkout.session.completed', countingOk(counter), async () => {
      await dispatchEvent(event, makeStripe(), pool, log)
    })
    expect(counter.n).toBe(1)
    expect(await countStripeEventRow(pool, event.id)).toBe(1)
  })

  it('duplicate event_id → handler NOT invoked, ROLLBACK', async () => {
    const event = makeEvent()
    const counter = { n: 0 }
    const { log } = makeLogger()
    await withHandlerOverride('checkout.session.completed', countingOk(counter), async () => {
      await dispatchEvent(event, makeStripe(), pool, log)
      await dispatchEvent(event, makeStripe(), pool, log)
    })
    expect(counter.n).toBe(1)
    expect(await countStripeEventRow(pool, event.id)).toBe(1)
  })

  it('unknown event type → COMMITs stripe_events row, handler NOT invoked, INFO log emitted', async () => {
    const event = makeEvent({ type: 'coupon.created' })
    const { log, entries } = makeLogger()
    await dispatchEvent(event, makeStripe(), pool, log)
    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    expect(entries.some((e) => e.level === 'info' && e.msg === 'stripe_webhook_unknown_type')).toBe(
      true,
    )
  })

  it('api_version mismatch → handler NOT invoked, stripe_events row IS committed (fail-closed), error logged', async () => {
    const event = makeEvent({ api_version: '2020-08-27' })
    const counter = { n: 0 }
    const { log, entries } = makeLogger()
    await withHandlerOverride('checkout.session.completed', countingOk(counter), async () => {
      await dispatchEvent(event, makeStripe(), pool, log)
    })
    expect(counter.n).toBe(0)
    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    expect(
      entries.some((e) => e.level === 'error' && e.msg === 'stripe_webhook_api_version_mismatch'),
    ).toBe(true)
  })

  it("handler returns 'validation_failed' → COMMIT stripe_events, error log emitted", async () => {
    const event = makeEvent()
    const { log, entries } = makeLogger()
    await withHandlerOverride('checkout.session.completed', handlerValidationFailed, async () => {
      await dispatchEvent(event, makeStripe(), pool, log)
    })
    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    expect(
      entries.some(
        (e) => e.level === 'error' && e.msg === 'billing.handler_validation_failed_committed',
      ),
    ).toBe(true)
  })

  it("handler returns 'ok' → COMMIT, stripe_events row survives", async () => {
    const event = makeEvent()
    const { log } = makeLogger()
    await withHandlerOverride('checkout.session.completed', handlerOk, async () => {
      await dispatchEvent(event, makeStripe(), pool, log)
    })
    expect(await countStripeEventRow(pool, event.id)).toBe(1)
  })

  it('handler throws → ROLLBACK, error rethrown, stripe_events row gone', async () => {
    const event = makeEvent()
    const { log } = makeLogger()
    const boom = new Error('handler exploded')
    await withHandlerOverride('checkout.session.completed', handlerThrowing(boom), async () => {
      await expect(dispatchEvent(event, makeStripe(), pool, log)).rejects.toBe(boom)
    })
    expect(await countStripeEventRow(pool, event.id)).toBe(0)
  })

  it('SET LOCAL triple is applied (transaction_isolation, lock_timeout, statement_timeout)', async () => {
    // dispatchEvent runs its Phase-2 tx through `repo.transaction(fn,
    // DISPATCH_TX_OPTS)`. The opts dispatchEvent uses ARE the billing recipe
    // (isolation 'read committed', lock 1s, statement 5s) — assert that first.
    expect(DISPATCH_TX_OPTS).toEqual({
      isolation: 'read committed',
      lockTimeoutMs: 1000,
      statementTimeoutMs: 5000,
    })

    // Then prove that recipe, applied via the SAME engine `repo.transaction`
    // uses (`runTransaction`), yields the expected `current_setting` values
    // INSIDE the callback. (The handler signature is now TxRepo — no `.query`
    // — so we read the live settings through runTransaction with a SHOW-bind,
    // mirroring the repo.transaction primitive's own SET LOCAL test.)
    const showBind = (c: ClientLike) => ({
      show: async (name: string): Promise<string> => {
        const res = await c.query<Record<string, string>>(`SHOW ${name}`)
        return Object.values(res.rows[0] ?? {})[0] ?? ''
      },
    })
    const settings = await runTransaction(
      pool,
      showBind,
      async (tx) => ({
        isolation: await tx.show('transaction_isolation'),
        lock: await tx.show('lock_timeout'),
        statement: await tx.show('statement_timeout'),
      }),
      DISPATCH_TX_OPTS,
    )
    if (typeof settings === 'symbol') throw new Error('unreachable: callback returned ROLLBACK')
    expect(settings.isolation).toBe('read committed')
    expect(settings.lock).toBe('1s')
    expect(settings.statement).toBe('5s')
  })
})

// ─── checkout.session.completed (subscription mode, Task 17) ────────────────
//
// The dispatcher invokes the prefetcher (one Stripe API call to retrieve the
// session, optionally a second to retrieve the subscription) before opening
// the dispatch tx, then runs the handler inside the tx with the prefetched
// state. These tests stub the Stripe SDK at the prefetch boundary so the
// handler's tx body never touches a real network client.
//
// Test isolation note: each test creates a fresh users row with its own
// stripe_customer_id and stripe_subscription_id, so the persisted writes
// from one test do not collide with another's.

interface SessionFixture {
  readonly id: string
  readonly mode: 'subscription' | 'payment'
  readonly customer: string | null
  readonly subscription: string | null
  readonly payment_intent: string | null
  readonly payment_status: 'paid' | 'unpaid' | 'no_payment_required'
  readonly metadata: { readonly userId?: string }
  readonly line_items: {
    readonly data: readonly {
      readonly id: string
      readonly quantity: number | null
      readonly amount_total: number
      readonly price: {
        readonly id: string
        readonly lookup_key: string | null
        readonly currency: string
      } | null
    }[]
  }
  readonly amount_subtotal: number | null
  readonly currency: string | null
}

interface SubscriptionFixture {
  readonly id: string
  readonly status: string
  readonly cancel_at_period_end: boolean
  readonly cancel_at: number | null
  readonly cancellation_details: unknown
  readonly items: {
    readonly data: readonly {
      readonly current_period_start: number
      readonly current_period_end: number
      readonly price: { readonly id: string; readonly lookup_key: string | null }
    }[]
  }
}

/**
 * Build a stub Stripe SDK satisfying the narrow surface the prefetcher uses:
 * `stripe.checkout.sessions.retrieve(id, { expand: [...] })` and
 * `stripe.subscriptions.retrieve(id, { expand: [...] })`. Returns the
 * supplied fixtures verbatim. Tests that want to assert "subscription
 * retrieve was NOT called" can pass `subscription: undefined` and check
 * `calls.subscriptionRetrieves` after dispatch.
 */
function makeStripeWithFixtures(opts: {
  session: SessionFixture
  subscription?: SubscriptionFixture
}): { stripe: Stripe; calls: { sessionRetrieves: string[]; subscriptionRetrieves: string[] } } {
  const calls = { sessionRetrieves: [] as string[], subscriptionRetrieves: [] as string[] }
  const stub = {
    checkout: {
      sessions: {
        retrieve: (id: string): Promise<SessionFixture> => {
          calls.sessionRetrieves.push(id)
          return Promise.resolve(opts.session)
        },
      },
    },
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

function makeCheckoutEvent(session: SessionFixture, eventCreated?: number): Stripe.Event {
  return {
    id: nextEventId(),
    object: 'event',
    api_version: STRIPE_API_VERSION,
    type: 'checkout.session.completed',
    created: eventCreated ?? Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object: session },
  } as unknown as Stripe.Event
}

async function countUserSubs(p: Pool, sub_id: string): Promise<number> {
  const r = await p.query<{ id: string }>(
    'SELECT id FROM user_subscriptions WHERE stripe_subscription_id = $1',
    [sub_id],
  )
  return r.rows.length
}

async function countBillingHistoryFor(p: Pool, user_id: string): Promise<number> {
  const r = await p.query<{ id: string }>('SELECT id FROM billing_history WHERE user_id = $1', [
    user_id,
  ])
  return r.rows.length
}

async function countCreditLedgerFor(p: Pool, user_id: string): Promise<number> {
  const r = await p.query<{ id: string }>('SELECT id FROM credit_ledger WHERE user_id = $1', [
    user_id,
  ])
  return r.rows.length
}

/**
 * Minimal valid Subscription fixture for tests where the prefetcher
 * still calls `subscriptions.retrieve(...)` but the handler bails out
 * before reading the subscription's fields (orphan / mismatch /
 * multi-line paths).
 */
function placeholderSubscription(sub_id: string): SubscriptionFixture {
  return {
    id: sub_id,
    status: 'active',
    cancel_at_period_end: false,
    cancel_at: null,
    cancellation_details: null,
    items: {
      data: [
        {
          current_period_start: 1_780_000_000,
          current_period_end: 1_790_000_000,
          price: { id: 'price_placeholder', lookup_key: 'tier_wayfarer' },
        },
      ],
    },
  }
}

describe('billing.webhook checkout.session.completed (subscription mode)', () => {
  it('happy path: upserts user_subscriptions, writes ZERO billing_history, ZERO credit_ledger', async () => {
    const { id: userId, cus } = await createWebhookTestUser(pool, scope)
    const sub_id = `sub_test_${uuidv7().slice(0, 12)}`
    const session: SessionFixture = {
      id: `cs_test_${uuidv7().slice(0, 12)}`,
      mode: 'subscription',
      customer: cus,
      subscription: sub_id,
      payment_intent: null,
      payment_status: 'paid',
      metadata: { userId },
      line_items: {
        data: [
          {
            id: 'li_1',
            quantity: 1,
            amount_total: 1500,
            price: { id: 'price_wayfarer', lookup_key: 'tier_wayfarer', currency: 'usd' },
          },
        ],
      },
      amount_subtotal: 1500,
      currency: 'usd',
    }
    const periodStart = Math.floor(new Date('2026-05-05T00:00:00Z').getTime() / 1000)
    const periodEnd = Math.floor(new Date('2026-06-05T00:00:00Z').getTime() / 1000)
    const subscription: SubscriptionFixture = {
      id: sub_id,
      status: 'active',
      cancel_at_period_end: false,
      cancel_at: null,
      cancellation_details: null,
      items: {
        data: [
          {
            current_period_start: periodStart,
            current_period_end: periodEnd,
            price: { id: 'price_wayfarer', lookup_key: 'tier_wayfarer' },
          },
        ],
      },
    }
    const { stripe, calls } = makeStripeWithFixtures({ session, subscription })
    const event = makeCheckoutEvent(session)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    // Stripe-side: prefetched both session and subscription.
    expect(calls.sessionRetrieves).toEqual([session.id])
    expect(calls.subscriptionRetrieves).toEqual([sub_id])

    // DB-side: stripe_events row committed (acks delivery to Stripe).
    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // user_subscriptions row written with the right fields.
    const subs = await pool.query<{
      user_id: string
      tier_lookup_key: string
      status: string
      current_period_start: Date
      current_period_end: Date
      cancel_at_period_end: boolean
      cancel_at: Date | null
      cancellation_details: unknown
    }>(
      `SELECT user_id, tier_lookup_key, status,
              current_period_start, current_period_end,
              cancel_at_period_end, cancel_at, cancellation_details
         FROM user_subscriptions
         WHERE stripe_subscription_id = $1`,
      [sub_id],
    )
    expect(subs.rows).toHaveLength(1)
    const row = subs.rows[0]
    if (!row) throw new Error('expected user_subscriptions row')
    expect(row.user_id).toBe(userId)
    expect(row.tier_lookup_key).toBe('tier_wayfarer')
    expect(row.status).toBe('active')
    expect(row.current_period_start.toISOString()).toBe('2026-05-05T00:00:00.000Z')
    expect(row.current_period_end.toISOString()).toBe('2026-06-05T00:00:00.000Z')
    expect(row.cancel_at_period_end).toBe(false)
    expect(row.cancel_at).toBeNull()
    expect(row.cancellation_details).toBeNull()

    // Subscription mode does NOT write billing_history or credit_ledger
    // (per Decision 1 + Manchego M2 round 3 — invoice.paid owns those).
    expect(await countBillingHistoryFor(pool, userId)).toBe(0)
    expect(await countCreditLedgerFor(pool, userId)).toBe(0)

    // No paging error log lines.
    expect(entries.filter((e) => e.level === 'error')).toEqual([])
  })

  it("metadata.userId orphan: pages 'billing.checkout_orphan', commits stripe_events, writes nothing", async () => {
    // userId points at a row that doesn't exist.
    const orphanUserId = uuidv7()
    const sub_id = `sub_orphan_${uuidv7().slice(0, 12)}`
    const session: SessionFixture = {
      id: `cs_orphan_${uuidv7().slice(0, 12)}`,
      mode: 'subscription',
      customer: 'cus_orphan_99',
      subscription: sub_id,
      payment_intent: null,
      payment_status: 'paid',
      metadata: { userId: orphanUserId },
      line_items: {
        data: [
          {
            id: 'li_1',
            quantity: 1,
            amount_total: 1500,
            price: { id: 'price_wayfarer', lookup_key: 'tier_wayfarer', currency: 'usd' },
          },
        ],
      },
      amount_subtotal: 1500,
      currency: 'usd',
    }
    const { stripe } = makeStripeWithFixtures({
      session,
      subscription: placeholderSubscription(sub_id),
    })
    const event = makeCheckoutEvent(session)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    // stripe_events row IS committed — Stripe stops retrying.
    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // Paging-grade error log emitted with the IDs spec §5.4.1 mandates.
    const paged = entries.find((e) => e.level === 'error' && e.msg === 'billing.checkout_orphan')
    expect(paged).toBeDefined()
    if (!paged) throw new Error('expected billing.checkout_orphan log')
    expect(paged.obj.session_id).toBe(session.id)
    expect(paged.obj.subscription).toBe(sub_id)
    expect(paged.obj.customer).toBe('cus_orphan_99')
    expect((paged.obj as { metadata_user_id?: string }).metadata_user_id).toBe(orphanUserId)

    // No user_subscriptions row landed (orphan path skips the upsert).
    expect(await countUserSubs(pool, sub_id)).toBe(0)
  })

  it("customer-id mismatch: pages 'billing.checkout_customer_mismatch', commits stripe_events, writes nothing", async () => {
    const { id: userId, cus } = await createWebhookTestUser(pool, scope)
    // Wrong customer id on the event.
    const sub_id = `sub_mism_${uuidv7().slice(0, 12)}`
    const session: SessionFixture = {
      id: `cs_mism_${uuidv7().slice(0, 12)}`,
      mode: 'subscription',
      customer: 'cus_DIFFERENT_FROM_USER',
      subscription: sub_id,
      payment_intent: null,
      payment_status: 'paid',
      metadata: { userId },
      line_items: {
        data: [
          {
            id: 'li_1',
            quantity: 1,
            amount_total: 1500,
            price: { id: 'price_wayfarer', lookup_key: 'tier_wayfarer', currency: 'usd' },
          },
        ],
      },
      amount_subtotal: 1500,
      currency: 'usd',
    }
    const { stripe } = makeStripeWithFixtures({
      session,
      subscription: placeholderSubscription(sub_id),
    })
    const event = makeCheckoutEvent(session)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    const paged = entries.find(
      (e) => e.level === 'error' && e.msg === 'billing.checkout_customer_mismatch',
    )
    expect(paged).toBeDefined()
    if (!paged) throw new Error('expected billing.checkout_customer_mismatch log')
    expect(paged.obj.session_id).toBe(session.id)
    expect((paged.obj as { metadata_user_id?: string }).metadata_user_id).toBe(userId)
    expect(paged.obj.customer).toBe('cus_DIFFERENT_FROM_USER')
    expect(paged.obj.users_stripe_customer_id).toBe(cus)

    // Mismatch path skips the upsert.
    expect(await countUserSubs(pool, sub_id)).toBe(0)
    expect(await countBillingHistoryFor(pool, userId)).toBe(0)
    expect(await countCreditLedgerFor(pool, userId)).toBe(0)
  })

  it('subscription session with undefined line_items: lineCount falls back to 0 → validation_failed', async () => {
    // Stripe's checkout session payload doesn't always include line_items
    // (depends on expand). Our prefetcher requests expand for line_items,
    // but a future API regression / Stripe outage could return a session
    // sans line_items. The handler treats the missing field as lineCount=0
    // → multi-line guard fires.
    const { id: userId, cus } = await createWebhookTestUser(pool, scope)
    const sub_id = `sub_noli_${uuidv7().slice(0, 12)}`
    // Cast to skip the required line_items field — production Stripe types
    // allow undefined; the test fixture type tightens for happy-path usage.
    const session = {
      id: `cs_noli_${uuidv7().slice(0, 12)}`,
      mode: 'subscription',
      customer: cus,
      subscription: sub_id,
      payment_intent: null,
      payment_status: 'paid',
      metadata: { userId },
      // line_items intentionally omitted.
      amount_subtotal: 1500,
      currency: 'usd',
    } as unknown as SessionFixture
    const { stripe } = makeStripeWithFixtures({
      session,
      subscription: placeholderSubscription(sub_id),
    })
    const event = makeCheckoutEvent(session)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    expect(
      entries.some(
        (e) => e.level === 'error' && e.msg === 'billing.checkout_subscription_multi_line',
      ),
    ).toBe(true)
    expect(await countUserSubs(pool, sub_id)).toBe(0)
  })

  it('malformed prefetch shape: asCheckoutPrefetch throws → ROLLBACK', async () => {
    // The asCheckoutPrefetch shape-gate at webhook.ts:296-304 protects the
    // handler from a dispatcher → prefetcher mis-wiring. Reaching it requires
    // overriding PREFETCHERS so a non-object value reaches the real handler.
    const original = PREFETCHERS['checkout.session.completed']
    const malformedPrefetcher: PrefetchFn = () => Promise.resolve('not an object')
    PREFETCHERS['checkout.session.completed'] = malformedPrefetcher
    try {
      const session: SessionFixture = {
        id: `cs_malformed_${uuidv7().slice(0, 12)}`,
        mode: 'subscription',
        customer: null,
        subscription: null,
        payment_intent: null,
        payment_status: 'paid',
        metadata: {},
        line_items: { data: [] },
        amount_subtotal: 0,
        currency: 'usd',
      }
      const { stripe } = makeStripeWithFixtures({ session })
      const event = makeCheckoutEvent(session)
      const { log } = makeLogger()

      await expect(dispatchEvent(event, stripe, pool, log)).rejects.toThrow(
        /prefetch shape unexpected/,
      )
      expect(await countStripeEventRow(pool, event.id)).toBe(0)
    } finally {
      if (original) {
        PREFETCHERS['checkout.session.completed'] = original
      }
    }
  })

  it("metadata.userId missing entirely: pages 'billing.checkout_orphan' (null branch), commits stripe_events", async () => {
    // The orphan-row test above sets metadata.userId to a UUID that doesn't
    // resolve. This covers the EARLIER branch at webhook.ts:363-366: the
    // metadata.userId field itself is absent, so `ids.metadata_user_id`
    // is null and the handler skips the users lookup entirely.
    const sub_id = `sub_nometa_${uuidv7().slice(0, 12)}`
    const session: SessionFixture = {
      id: `cs_nometa_${uuidv7().slice(0, 12)}`,
      mode: 'subscription',
      // Also covers the customer-null branch in checkoutLogIds.
      customer: null,
      subscription: sub_id,
      payment_intent: null,
      payment_status: 'paid',
      // Intentionally omit userId so checkoutLogIds() returns null.
      metadata: {},
      line_items: {
        data: [
          {
            id: 'li_1',
            quantity: 1,
            amount_total: 1500,
            price: { id: 'price_wayfarer', lookup_key: 'tier_wayfarer', currency: 'usd' },
          },
        ],
      },
      amount_subtotal: 1500,
      currency: 'usd',
    }
    const { stripe } = makeStripeWithFixtures({
      session,
      subscription: placeholderSubscription(sub_id),
    })
    const event = makeCheckoutEvent(session)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    const paged = entries.find(
      (e) => e.level === 'error' && e.msg === 'billing.checkout_orphan',
    )
    expect(paged).toBeDefined()
    if (!paged) throw new Error('expected billing.checkout_orphan log')
    expect(paged.obj.metadata_user_id).toBeNull()
    expect(await countUserSubs(pool, sub_id)).toBe(0)
  })

  it("session.mode='setup' (unhandled mode) → INFO log, commits stripe_events, no writes", async () => {
    // Branch for the trailing `log.info('billing.checkout_unhandled_mode')`
    // path at webhook.ts:404-408. Stripe `setup` mode sessions don't
    // generate revenue events; the handler logs and exits clean.
    const { id: userId, cus } = await createWebhookTestUser(pool, scope)
    // Cast: setup is a real Stripe.Checkout.Session mode, but our test
    // fixture type only lists 'subscription' | 'payment' because those
    // are the only ones the handler does real work for.
    const session = {
      id: `cs_setup_${uuidv7().slice(0, 12)}`,
      mode: 'setup',
      customer: cus,
      subscription: null,
      payment_intent: null,
      payment_status: 'no_payment_required',
      metadata: { userId },
      line_items: { data: [] },
      amount_subtotal: 0,
      currency: 'usd',
    } as unknown as SessionFixture
    const { stripe } = makeStripeWithFixtures({ session })
    const event = makeCheckoutEvent(session)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    expect(
      entries.some((e) => e.level === 'info' && e.msg === 'billing.checkout_unhandled_mode'),
    ).toBe(true)
    expect(await countBillingHistoryFor(pool, userId)).toBe(0)
    expect(await countCreditLedgerFor(pool, userId)).toBe(0)
  })

  it('subscription mode but prefetch.subscription is null → handler throws → ROLLBACK', async () => {
    // The prefetcher returns subscription=null when session.subscription is
    // not a non-empty string. The handler's `if (!subscription)` guard
    // at webhook.ts:445-449 then throws, which bubbles out of the
    // dispatcher's try block → ROLLBACK → stripe_events row gone.
    const { id: userId, cus } = await createWebhookTestUser(pool, scope)
    const session: SessionFixture = {
      id: `cs_nosub_${uuidv7().slice(0, 12)}`,
      mode: 'subscription',
      customer: cus,
      // null forces prefetcher to skip subscription retrieve, leaving
      // prefetch.subscription === null at handler-invocation time.
      subscription: null,
      payment_intent: null,
      payment_status: 'paid',
      metadata: { userId },
      line_items: {
        data: [
          {
            id: 'li_1',
            quantity: 1,
            amount_total: 1500,
            price: { id: 'price_wayfarer', lookup_key: 'tier_wayfarer', currency: 'usd' },
          },
        ],
      },
      amount_subtotal: 1500,
      currency: 'usd',
    }
    const { stripe } = makeStripeWithFixtures({ session })
    const event = makeCheckoutEvent(session)
    const { log } = makeLogger()

    await expect(dispatchEvent(event, stripe, pool, log)).rejects.toThrow(
      /subscription mode but prefetch\.subscription is null/,
    )
    // ROLLBACK on throw — stripe_events row not committed.
    expect(await countStripeEventRow(pool, event.id)).toBe(0)
  })

  it('subscription with multi-item subscription.items: returns validation_failed, commits stripe_events, writes nothing', async () => {
    // Distinct from the multi-line session check: the dispatched subscription
    // itself has > 1 item. This is the second guard in
    // handleCheckoutCompletedSubscription (webhook.ts:450-460). Reaching
    // this branch requires a single line_item AND a subscription with
    // multi-item data.
    const { id: userId, cus } = await createWebhookTestUser(pool, scope)
    const sub_id = `sub_multiitem_${uuidv7().slice(0, 12)}`
    const session: SessionFixture = {
      id: `cs_multiitem_${uuidv7().slice(0, 12)}`,
      mode: 'subscription',
      customer: cus,
      subscription: sub_id,
      payment_intent: null,
      payment_status: 'paid',
      metadata: { userId },
      line_items: {
        data: [
          {
            id: 'li_1',
            quantity: 1,
            amount_total: 1500,
            price: { id: 'price_wayfarer', lookup_key: 'tier_wayfarer', currency: 'usd' },
          },
        ],
      },
      amount_subtotal: 1500,
      currency: 'usd',
    }
    const subscription: SubscriptionFixture = {
      id: sub_id,
      status: 'active',
      cancel_at_period_end: false,
      cancel_at: null,
      cancellation_details: null,
      items: {
        data: [
          {
            current_period_start: 1_780_000_000,
            current_period_end: 1_790_000_000,
            price: { id: 'price_a', lookup_key: 'tier_wayfarer' },
          },
          {
            current_period_start: 1_780_000_000,
            current_period_end: 1_790_000_000,
            price: { id: 'price_b', lookup_key: 'tier_sojourner' },
          },
        ],
      },
    }
    const { stripe } = makeStripeWithFixtures({ session, subscription })
    const event = makeCheckoutEvent(session)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    const paged = entries.find(
      (e) => e.level === 'error' && e.msg === 'billing.checkout_subscription_multi_item',
    )
    expect(paged).toBeDefined()
    if (!paged) throw new Error('expected billing.checkout_subscription_multi_item log')
    expect(paged.obj.subscription_id).toBe(sub_id)
    expect(paged.obj.items_count).toBe(2)
    expect(
      entries.some(
        (e) => e.level === 'error' && e.msg === 'billing.handler_validation_failed_committed',
      ),
    ).toBe(true)
    expect(await countUserSubs(pool, sub_id)).toBe(0)
  })

  it('subscription with missing lookup_key on price: returns validation_failed, commits stripe_events, writes nothing', async () => {
    // Hits webhook.ts:467-478 — single line_item, single subscription item,
    // but the price has no lookup_key. Operator-error guard: tier resolution
    // must NOT silently fall back to anything.
    const { id: userId, cus } = await createWebhookTestUser(pool, scope)
    const sub_id = `sub_nolk_${uuidv7().slice(0, 12)}`
    const session: SessionFixture = {
      id: `cs_nolk_${uuidv7().slice(0, 12)}`,
      mode: 'subscription',
      customer: cus,
      subscription: sub_id,
      payment_intent: null,
      payment_status: 'paid',
      metadata: { userId },
      line_items: {
        data: [
          {
            id: 'li_1',
            quantity: 1,
            amount_total: 1500,
            price: { id: 'price_wayfarer', lookup_key: 'tier_wayfarer', currency: 'usd' },
          },
        ],
      },
      amount_subtotal: 1500,
      currency: 'usd',
    }
    const subscription: SubscriptionFixture = {
      id: sub_id,
      status: 'active',
      cancel_at_period_end: false,
      cancel_at: null,
      cancellation_details: null,
      items: {
        data: [
          {
            current_period_start: 1_780_000_000,
            current_period_end: 1_790_000_000,
            // Empty lookup_key triggers the validation_failed branch.
            price: { id: 'price_no_lookup', lookup_key: null },
          },
        ],
      },
    }
    const { stripe } = makeStripeWithFixtures({ session, subscription })
    const event = makeCheckoutEvent(session)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    const paged = entries.find(
      (e) => e.level === 'error' && e.msg === 'billing.checkout_subscription_missing_lookup_key',
    )
    expect(paged).toBeDefined()
    if (!paged) throw new Error('expected billing.checkout_subscription_missing_lookup_key log')
    expect(paged.obj.subscription_id).toBe(sub_id)
    expect(paged.obj.price_id).toBe('price_no_lookup')
    expect(
      entries.some(
        (e) => e.level === 'error' && e.msg === 'billing.handler_validation_failed_committed',
      ),
    ).toBe(true)
    expect(await countUserSubs(pool, sub_id)).toBe(0)
  })

  it('subscription with empty-string lookup_key: returns validation_failed (length-zero branch)', async () => {
    // Exercises the second half of the typeof-or-length-zero condition at
    // webhook.ts:468 — lookup_key is a string but empty.
    const { id: userId, cus } = await createWebhookTestUser(pool, scope)
    const sub_id = `sub_emptylk_${uuidv7().slice(0, 12)}`
    const session: SessionFixture = {
      id: `cs_emptylk_${uuidv7().slice(0, 12)}`,
      mode: 'subscription',
      customer: cus,
      subscription: sub_id,
      payment_intent: null,
      payment_status: 'paid',
      metadata: { userId },
      line_items: {
        data: [
          {
            id: 'li_1',
            quantity: 1,
            amount_total: 1500,
            price: { id: 'price_wayfarer', lookup_key: 'tier_wayfarer', currency: 'usd' },
          },
        ],
      },
      amount_subtotal: 1500,
      currency: 'usd',
    }
    const subscription: SubscriptionFixture = {
      id: sub_id,
      status: 'active',
      cancel_at_period_end: false,
      cancel_at: null,
      cancellation_details: null,
      items: {
        data: [
          {
            current_period_start: 1_780_000_000,
            current_period_end: 1_790_000_000,
            price: { id: 'price_empty_lookup', lookup_key: '' },
          },
        ],
      },
    }
    const { stripe } = makeStripeWithFixtures({ session, subscription })
    const event = makeCheckoutEvent(session)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    expect(
      entries.some(
        (e) =>
          e.level === 'error' && e.msg === 'billing.checkout_subscription_missing_lookup_key',
      ),
    ).toBe(true)
    expect(await countUserSubs(pool, sub_id)).toBe(0)
  })

  it('multi-line subscription session: returns validation_failed, commits stripe_events, writes nothing', async () => {
    const { id: userId, cus } = await createWebhookTestUser(pool, scope)
    const sub_id = `sub_multi_${uuidv7().slice(0, 12)}`
    const session: SessionFixture = {
      id: `cs_multi_${uuidv7().slice(0, 12)}`,
      mode: 'subscription',
      customer: cus,
      subscription: sub_id,
      payment_intent: null,
      payment_status: 'paid',
      metadata: { userId },
      line_items: {
        data: [
          {
            id: 'li_1',
            quantity: 1,
            amount_total: 1500,
            price: { id: 'price_wayfarer', lookup_key: 'tier_wayfarer', currency: 'usd' },
          },
          {
            id: 'li_2',
            quantity: 1,
            amount_total: 1500,
            price: { id: 'price_sojourner', lookup_key: 'tier_sojourner', currency: 'usd' },
          },
        ],
      },
      amount_subtotal: 3000,
      currency: 'usd',
    }
    const { stripe } = makeStripeWithFixtures({
      session,
      subscription: placeholderSubscription(sub_id),
    })
    const event = makeCheckoutEvent(session)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    // stripe_events row IS committed (validation_failed sentinel commits).
    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // Dispatcher logs the sentinel pattern.
    expect(
      entries.some(
        (e) => e.level === 'error' && e.msg === 'billing.handler_validation_failed_committed',
      ),
    ).toBe(true)

    // Nothing else landed.
    expect(await countUserSubs(pool, sub_id)).toBe(0)
    expect(await countBillingHistoryFor(pool, userId)).toBe(0)
    expect(await countCreditLedgerFor(pool, userId)).toBe(0)
  })
})

// ─── checkout.session.completed (payment mode, Task 18) ─────────────────────
//
// Spec §5.4.1 payment-mode bullets (lines 590-596):
//   - Walk session.line_items.data; resolve each line.price.id via the SKU
//     cache reverse map → lookup_key → LookupKeySpec.
//   - Amount validation: sum(price.unit_amount_cents * quantity) per line
//     must equal session.amount_subtotal. Mismatch → 'validation_failed'.
//   - Defensive payment_status === 'paid' assertion (always true at launch
//     under payment_method_types: ['card', 'link']).
//   - One purchases row per line_item.
//   - One billing_history row (kind='purchase', lookup_key=NULL,
//     amount_cents=amount_subtotal).
//   - One credit_ledger row per (line, credit_type) where the spec's
//     sessionsGranted/worldsGranted is > 0; source_type='purchase',
//     source_purchase_id linked back to the purchases row inserted above.
//
// SKU-cache fixtures cover sku_session and sku_world (the two one-time
// SKUs in lookup-keys.ts). Tests that exercise the unknown-price-id branch
// build a price.id that the cache doesn't know.

const PRICE_ID_SKU_SESSION = 'price_test_sku_session'
const PRICE_ID_SKU_WORLD = 'price_test_sku_world'

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

function buildSkuCacheForPaymentTests(): SkuCache {
  // 500¢ for sku_session, 1500¢ for sku_world — the validation tests rely on
  // these specific unit prices to construct a mismatch fixture.
  const sessionEntry = makeSkuEntry('sku_session', PRICE_ID_SKU_SESSION, 500)
  const worldEntry = makeSkuEntry('sku_world', PRICE_ID_SKU_WORLD, 1500)
  return {
    byLookupKey: new Map([
      ['sku_session', sessionEntry],
      ['sku_world', worldEntry],
    ]),
    byPriceId: new Map([
      [sessionEntry.stripe_price_id, sessionEntry],
      [worldEntry.stripe_price_id, worldEntry],
    ]),
    publicListing: [],
  }
}

interface PurchaseRow {
  readonly id: string
  readonly user_id: string
  readonly stripe_payment_intent_id: string
  readonly lookup_key: string
  readonly quantity: number
  readonly amount_cents: number
  readonly currency: string
  readonly status: string
}

async function fetchPurchasesByPi(p: Pool, pi: string): Promise<readonly PurchaseRow[]> {
  const r = await p.query<PurchaseRow>(
    `SELECT id, user_id, stripe_payment_intent_id, lookup_key, quantity, amount_cents, currency, status
       FROM purchases
       WHERE stripe_payment_intent_id = $1
       ORDER BY id ASC`,
    [pi],
  )
  return r.rows
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

describe('billing.webhook checkout.session.completed (payment mode)', () => {
  beforeEach(() => {
    _resetSkuCacheForTests()
    setSkuCache(buildSkuCacheForPaymentTests())
  })

  it('multi-line cart happy path: sku_session × qty 2 + sku_world × qty 1 produces 2 purchases, 1 billing_history, credit_ledger rows linked via source_purchase_id', async () => {
    // Stripe's Checkout consolidates duplicate SKUs into a single line with
    // quantity > 1, AND the purchases composite UNIQUE on (PI, lookup_key)
    // structurally enforces the same rule on our side. The fixture below
    // matches what real Stripe sends: one line per distinct lookup_key,
    // quantity multiplies the per-row grant.
    const { id: userId, cus } = await createWebhookTestUser(pool, scope)
    const pi = `pi_test_${uuidv7().slice(0, 12)}`
    const session: SessionFixture = {
      id: `cs_pay_${uuidv7().slice(0, 12)}`,
      mode: 'payment',
      customer: cus,
      subscription: null,
      payment_intent: pi,
      payment_status: 'paid',
      metadata: { userId },
      line_items: {
        data: [
          {
            id: 'li_1',
            quantity: 2,
            // line.amount_total is post-tax/discount per-line: 500 × 2 = 1000.
            amount_total: 1000,
            price: { id: PRICE_ID_SKU_SESSION, lookup_key: 'sku_session', currency: 'usd' },
          },
          {
            id: 'li_2',
            quantity: 1,
            amount_total: 1500,
            price: { id: PRICE_ID_SKU_WORLD, lookup_key: 'sku_world', currency: 'usd' },
          },
        ],
      },
      // expected_subtotal = 500*2 + 1500*1 = 2500
      amount_subtotal: 2500,
      currency: 'usd',
    }
    const { stripe } = makeStripeWithFixtures({ session })
    // Use a stable event.created for the occurred_at field assertion below.
    const eventCreated = Math.floor(new Date('2026-05-06T12:34:56Z').getTime() / 1000)
    const event = makeCheckoutEvent(session, eventCreated)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    // stripe_events row committed.
    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // Two purchases rows landed (one per line_item), sharing the PaymentIntent.
    const purchases = await fetchPurchasesByPi(pool, pi)
    expect(purchases).toHaveLength(2)
    const byKey = new Map(purchases.map((p) => [p.lookup_key, p] as const))
    const sessionPurchase = byKey.get('sku_session')
    const worldPurchase = byKey.get('sku_world')
    if (!sessionPurchase || !worldPurchase) {
      throw new Error('expected one purchases row per lookup_key')
    }
    expect(sessionPurchase.user_id).toBe(userId)
    expect(sessionPurchase.quantity).toBe(2)
    expect(sessionPurchase.amount_cents).toBe(1000)
    expect(sessionPurchase.currency).toBe('usd')
    expect(sessionPurchase.status).toBe('completed')
    expect(worldPurchase.quantity).toBe(1)
    expect(worldPurchase.amount_cents).toBe(1500)
    expect(worldPurchase.status).toBe('completed')

    // billing_history: exactly one row, kind='purchase', lookup_key=NULL,
    // amount_cents=amount_subtotal, expires_at=NULL.
    const histRows = await fetchBillingHistoryForUser(pool, userId)
    expect(histRows).toHaveLength(1)
    const hist = histRows[0]
    if (!hist) throw new Error('expected billing_history row')
    expect(hist.kind).toBe('purchase')
    expect(hist.source_id_stripe).toBe(pi)
    expect(hist.stripe_payment_intent_id).toBe(pi)
    expect(hist.lookup_key).toBeNull()
    expect(hist.amount_cents).toBe(2500)
    expect(hist.currency).toBe('usd')
    expect(hist.expires_at).toBeNull()
    expect(hist.occurred_at.toISOString()).toBe('2026-05-06T12:34:56.000Z')

    // credit_ledger: one row per (line, credit_type with grant > 0).
    //   - sku_session line: sessionsGranted=1 × qty 2 → 1 row, amount=2 (session)
    //   - sku_world line:   sessionsGranted=1 × qty 1 → 1 row, amount=1 (session)
    //                       worldsGranted=1   × qty 1 → 1 row, amount=1 (world_gen)
    // Total: 3 rows.
    const ledger = await fetchCreditLedgerForUser(pool, userId)
    expect(ledger).toHaveLength(3)

    // Every row: source_type='purchase', source_purchase_id NOT NULL,
    // source_billing_history_id NULL, expires_at NULL (à-la-carte never expires).
    for (const row of ledger) {
      expect(row.source_type).toBe('purchase')
      expect(row.source_purchase_id).not.toBeNull()
      expect(row.source_billing_history_id).toBeNull()
      expect(row.expires_at).toBeNull()
    }

    // FK linkage: every credit_ledger.source_purchase_id should be one of the
    // purchases rows we just inserted.
    const purchaseIds = new Set(purchases.map((p) => p.id))
    for (const row of ledger) {
      const linkedId = row.source_purchase_id ?? ''
      expect(purchaseIds.has(linkedId)).toBe(true)
    }

    // Per-row amounts:
    //   - row linked to sessionPurchase (sku_session × qty 2): credit_type='session', amount=2
    //   - row linked to worldPurchase   (sku_world   × qty 1): credit_type='session', amount=1
    //   - row linked to worldPurchase   (sku_world   × qty 1): credit_type='world_gen', amount=1
    const sessionRowsForSessionPurchase = ledger.filter(
      (r) => r.source_purchase_id === sessionPurchase.id && r.credit_type === 'session',
    )
    expect(sessionRowsForSessionPurchase).toHaveLength(1)
    expect(sessionRowsForSessionPurchase[0]?.amount).toBe(2)

    const sessionRowsForWorldPurchase = ledger.filter(
      (r) => r.source_purchase_id === worldPurchase.id && r.credit_type === 'session',
    )
    expect(sessionRowsForWorldPurchase).toHaveLength(1)
    expect(sessionRowsForWorldPurchase[0]?.amount).toBe(1)

    const worldRowsForWorldPurchase = ledger.filter(
      (r) => r.source_purchase_id === worldPurchase.id && r.credit_type === 'world_gen',
    )
    expect(worldRowsForWorldPurchase).toHaveLength(1)
    expect(worldRowsForWorldPurchase[0]?.amount).toBe(1)

    // No paging error logs on the happy path.
    expect(entries.filter((e) => e.level === 'error')).toEqual([])

    // Replay: same event.id → stripe_events PK dedupes; no second writes.
    const ledgerCountBefore = ledger.length
    const purchasesCountBefore = purchases.length
    const histCountBefore = histRows.length
    await dispatchEvent(event, stripe, pool, log)
    expect((await fetchPurchasesByPi(pool, pi)).length).toBe(purchasesCountBefore)
    expect((await fetchBillingHistoryForUser(pool, userId)).length).toBe(histCountBefore)
    expect((await fetchCreditLedgerForUser(pool, userId)).length).toBe(ledgerCountBefore)
  })

  it('amount validation mismatch: returns validation_failed, commits stripe_events, writes nothing else', async () => {
    const { id: userId, cus } = await createWebhookTestUser(pool, scope)
    const pi = `pi_amtfail_${uuidv7().slice(0, 12)}`
    const session: SessionFixture = {
      id: `cs_amtfail_${uuidv7().slice(0, 12)}`,
      mode: 'payment',
      customer: cus,
      subscription: null,
      payment_intent: pi,
      payment_status: 'paid',
      metadata: { userId },
      line_items: {
        data: [
          {
            id: 'li_1',
            quantity: 1,
            amount_total: 500,
            price: { id: PRICE_ID_SKU_SESSION, lookup_key: 'sku_session', currency: 'usd' },
          },
        ],
      },
      // expected_subtotal from cache = 500 × 1 = 500. Setting amount_subtotal
      // to 999 forces the mismatch.
      amount_subtotal: 999,
      currency: 'usd',
    }
    const { stripe } = makeStripeWithFixtures({ session })
    const event = makeCheckoutEvent(session)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    // stripe_events row commits (sentinel acks delivery).
    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    // Paging-grade error log emitted.
    const paged = entries.find(
      (e) => e.level === 'error' && e.msg === 'billing.amount_validation_failed',
    )
    expect(paged).toBeDefined()
    if (!paged) throw new Error('expected billing.amount_validation_failed log')
    expect(paged.obj.event_id).toBe(event.id)
    expect(paged.obj.expected).toBe(500)
    expect(paged.obj.actual).toBe(999)

    // Dispatcher's "validation_failed committed" sentinel log also fires.
    expect(
      entries.some(
        (e) => e.level === 'error' && e.msg === 'billing.handler_validation_failed_committed',
      ),
    ).toBe(true)

    // No purchases / billing_history / credit_ledger writes landed.
    expect((await fetchPurchasesByPi(pool, pi)).length).toBe(0)
    expect(await countBillingHistoryFor(pool, userId)).toBe(0)
    expect(await countCreditLedgerFor(pool, userId)).toBe(0)
  })

  it('unknown price ID: returns validation_failed, commits stripe_events, writes nothing else', async () => {
    const { id: userId, cus } = await createWebhookTestUser(pool, scope)
    const pi = `pi_unkprice_${uuidv7().slice(0, 12)}`
    const session: SessionFixture = {
      id: `cs_unkprice_${uuidv7().slice(0, 12)}`,
      mode: 'payment',
      customer: cus,
      subscription: null,
      payment_intent: pi,
      payment_status: 'paid',
      metadata: { userId },
      line_items: {
        data: [
          {
            id: 'li_1',
            quantity: 1,
            amount_total: 500,
            price: { id: 'price_NOT_IN_CACHE', lookup_key: 'sku_session', currency: 'usd' },
          },
        ],
      },
      amount_subtotal: 500,
      currency: 'usd',
    }
    const { stripe } = makeStripeWithFixtures({ session })
    const event = makeCheckoutEvent(session)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    const paged = entries.find(
      (e) => e.level === 'error' && e.msg === 'billing.checkout_unknown_price_id',
    )
    expect(paged).toBeDefined()
    if (!paged) throw new Error('expected billing.checkout_unknown_price_id log')
    expect(paged.obj.event_id).toBe(event.id)
    expect(paged.obj.price_id).toBe('price_NOT_IN_CACHE')

    expect((await fetchPurchasesByPi(pool, pi)).length).toBe(0)
    expect(await countBillingHistoryFor(pool, userId)).toBe(0)
    expect(await countCreditLedgerFor(pool, userId)).toBe(0)
  })

  it("payment_status non-'paid': returns validation_failed, pages 'billing.payment_status_unexpected', writes nothing else", async () => {
    const { id: userId, cus } = await createWebhookTestUser(pool, scope)
    const pi = `pi_unpaid_${uuidv7().slice(0, 12)}`
    const session: SessionFixture = {
      id: `cs_unpaid_${uuidv7().slice(0, 12)}`,
      mode: 'payment',
      customer: cus,
      subscription: null,
      payment_intent: pi,
      payment_status: 'unpaid',
      metadata: { userId },
      line_items: {
        data: [
          {
            id: 'li_1',
            quantity: 1,
            amount_total: 500,
            price: { id: PRICE_ID_SKU_SESSION, lookup_key: 'sku_session', currency: 'usd' },
          },
        ],
      },
      amount_subtotal: 500,
      currency: 'usd',
    }
    const { stripe } = makeStripeWithFixtures({ session })
    const event = makeCheckoutEvent(session)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    const paged = entries.find(
      (e) => e.level === 'error' && e.msg === 'billing.payment_status_unexpected',
    )
    expect(paged).toBeDefined()
    if (!paged) throw new Error('expected billing.payment_status_unexpected log')
    expect(paged.obj.event_id).toBe(event.id)
    expect(paged.obj.payment_status).toBe('unpaid')

    expect((await fetchPurchasesByPi(pool, pi)).length).toBe(0)
    expect(await countBillingHistoryFor(pool, userId)).toBe(0)
    expect(await countCreditLedgerFor(pool, userId)).toBe(0)
  })

  it('null payment_intent in payment mode: returns validation_failed, pages billing.checkout_payment_no_payment_intent, writes nothing else', async () => {
    // payment-mode sessions ALWAYS carry payment_intent at the Stripe side;
    // a null here would be a Stripe-side anomaly. The handler logs and
    // returns the validation_failed sentinel rather than crashing the tx
    // (which would force-redeliver an event Stripe can't fix).
    const { id: userId, cus } = await createWebhookTestUser(pool, scope)
    const session: SessionFixture = {
      id: `cs_nopi_${uuidv7().slice(0, 12)}`,
      mode: 'payment',
      customer: cus,
      subscription: null,
      payment_intent: null,
      payment_status: 'paid',
      metadata: { userId },
      line_items: {
        data: [
          {
            id: 'li_1',
            quantity: 1,
            amount_total: 500,
            price: { id: PRICE_ID_SKU_SESSION, lookup_key: 'sku_session', currency: 'usd' },
          },
        ],
      },
      amount_subtotal: 500,
      currency: 'usd',
    }
    const { stripe } = makeStripeWithFixtures({ session })
    const event = makeCheckoutEvent(session)
    const { log, entries } = makeLogger()

    await dispatchEvent(event, stripe, pool, log)

    expect(await countStripeEventRow(pool, event.id)).toBe(1)

    const paged = entries.find(
      (e) => e.level === 'error' && e.msg === 'billing.checkout_payment_no_payment_intent',
    )
    expect(paged).toBeDefined()
    if (!paged) throw new Error('expected billing.checkout_payment_no_payment_intent log')
    expect(paged.obj.event_id).toBe(event.id)
    expect(paged.obj.session_id).toBe(session.id)

    expect(await countBillingHistoryFor(pool, userId)).toBe(0)
    expect(await countCreditLedgerFor(pool, userId)).toBe(0)
  })
})
