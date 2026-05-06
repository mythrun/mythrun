// backend/src/billing/__tests__/webhook.test.ts
//
// Tests for the Stripe webhook dispatcher (Task 16, MYT-42 §5.3).
//
// The dispatcher manages its own pg transaction (BEGIN + 3× SET LOCAL),
// so these tests use the shared test pool directly via `pool.connect()`
// rather than the standard `withTx` helper. Test isolation is achieved
// via unique event_ids per test (uuidv7-prefixed) so the committed
// `stripe_events` rows from one test do not collide with another's.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'
import type { Stripe } from 'stripe'
import type { Pool } from 'pg'
import { pool, ensureSchema } from '../../repo/__tests__/_helpers/with-tx.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { STRIPE_API_VERSION } from '../stripe-client.js'
import {
  dispatchEvent,
  HANDLERS,
  type EventHandler,
  type KnownStripeEventType,
} from '../webhook.js'

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
async function createWebhookTestUser(p: Pool): Promise<{ id: string; cus: string }> {
  const id = uuidv7()
  userCounter += 1
  const n = userCounter
  const cus = `cus_test_webhook_${String(n)}_${id.slice(0, 8)}`
  await p.query(
    `INSERT INTO users (id, cognito_sub, username, display_name, stripe_customer_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `webhook_sub_${String(n)}`, `webhookuser${String(n)}`, `Webhook ${String(n)}`, cus],
  )
  return { id, cus }
}

beforeAll(async () => {
  await ensureSchema()
})

afterAll(async () => {
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

function makeEvent(overrides: Partial<Stripe.Event> = {}): Stripe.Event {
  // The dispatcher only reads .id, .type, .api_version. We construct a
  // minimally-shaped object and cast through unknown rather than build a
  // full Stripe.Event fixture.
  const base = {
    id: `evt_test_${uuidv7()}`,
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
    await withHandlerOverride(
      'checkout.session.completed',
      countingOk(counter),
      async () => {
        await dispatchEvent(event, makeStripe(), pool, log)
      },
    )
    expect(counter.n).toBe(1)
    expect(await countStripeEventRow(pool, event.id)).toBe(1)
  })

  it('duplicate event_id → handler NOT invoked, ROLLBACK', async () => {
    const event = makeEvent()
    const counter = { n: 0 }
    const { log } = makeLogger()
    await withHandlerOverride(
      'checkout.session.completed',
      countingOk(counter),
      async () => {
        await dispatchEvent(event, makeStripe(), pool, log)
        await dispatchEvent(event, makeStripe(), pool, log)
      },
    )
    expect(counter.n).toBe(1)
    expect(await countStripeEventRow(pool, event.id)).toBe(1)
  })

  it('unknown event type → COMMITs stripe_events row, handler NOT invoked, INFO log emitted', async () => {
    const event = makeEvent({ type: 'coupon.created' })
    const { log, entries } = makeLogger()
    await dispatchEvent(event, makeStripe(), pool, log)
    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    expect(
      entries.some((e) => e.level === 'info' && e.msg === 'stripe_webhook_unknown_type'),
    ).toBe(true)
  })

  it('api_version mismatch → handler NOT invoked, stripe_events row IS committed (fail-closed), error logged', async () => {
    const event = makeEvent({ api_version: '2020-08-27' })
    const counter = { n: 0 }
    const { log, entries } = makeLogger()
    await withHandlerOverride(
      'checkout.session.completed',
      countingOk(counter),
      async () => {
        await dispatchEvent(event, makeStripe(), pool, log)
      },
    )
    expect(counter.n).toBe(0)
    expect(await countStripeEventRow(pool, event.id)).toBe(1)
    expect(
      entries.some(
        (e) => e.level === 'error' && e.msg === 'stripe_webhook_api_version_mismatch',
      ),
    ).toBe(true)
  })

  it("handler returns 'validation_failed' → COMMIT stripe_events, error log emitted", async () => {
    const event = makeEvent()
    const { log, entries } = makeLogger()
    await withHandlerOverride(
      'checkout.session.completed',
      handlerValidationFailed,
      async () => {
        await dispatchEvent(event, makeStripe(), pool, log)
      },
    )
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
    await withHandlerOverride(
      'checkout.session.completed',
      handlerThrowing(boom),
      async () => {
        await expect(dispatchEvent(event, makeStripe(), pool, log)).rejects.toBe(boom)
      },
    )
    expect(await countStripeEventRow(pool, event.id)).toBe(0)
  })

  it('SET LOCAL triple is applied (transaction_isolation, lock_timeout, statement_timeout)', async () => {
    const event = makeEvent()
    const { log } = makeLogger()
    // Captured per-setting via an array push so TypeScript's flow analysis
    // doesn't narrow the post-handler value to `never` (a `let x = null`
    // mutated only inside a nested closure trips the
    // `no-unnecessary-condition` rule).
    const captured: { isolation: string; lock: string; statement: string }[] = []
    const handler: EventHandler = async (_event, _prefetch, client) => {
      const iso = await client.query<{ current_setting: string }>(
        "SELECT current_setting('transaction_isolation') AS current_setting",
      )
      const lock = await client.query<{ current_setting: string }>(
        "SELECT current_setting('lock_timeout') AS current_setting",
      )
      const stmt = await client.query<{ current_setting: string }>(
        "SELECT current_setting('statement_timeout') AS current_setting",
      )
      captured.push({
        isolation: iso.rows[0]?.current_setting ?? '',
        lock: lock.rows[0]?.current_setting ?? '',
        statement: stmt.rows[0]?.current_setting ?? '',
      })
      return 'ok'
    }
    await withHandlerOverride('checkout.session.completed', handler, async () => {
      await dispatchEvent(event, makeStripe(), pool, log)
    })
    expect(captured).toHaveLength(1)
    const c = captured[0]
    if (!c) throw new Error('handler did not run')
    expect(c.isolation).toBe('read committed')
    expect(c.lock).toBe('1s')
    expect(c.statement).toBe('5s')
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
      readonly price: { readonly id: string; readonly lookup_key: string | null } | null
    }[]
  }
  readonly amount_subtotal: number | null
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
    id: `evt_test_${uuidv7()}`,
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
  const r = await p.query<{ id: string }>(
    'SELECT id FROM billing_history WHERE user_id = $1',
    [user_id],
  )
  return r.rows.length
}

async function countCreditLedgerFor(p: Pool, user_id: string): Promise<number> {
  const r = await p.query<{ id: string }>(
    'SELECT id FROM credit_ledger WHERE user_id = $1',
    [user_id],
  )
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
    const { id: userId, cus } = await createWebhookTestUser(pool)
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
            price: { id: 'price_wayfarer', lookup_key: 'tier_wayfarer' },
          },
        ],
      },
      amount_subtotal: 1500,
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
          { id: 'li_1', quantity: 1, price: { id: 'price_wayfarer', lookup_key: 'tier_wayfarer' } },
        ],
      },
      amount_subtotal: 1500,
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
    const paged = entries.find(
      (e) => e.level === 'error' && e.msg === 'billing.checkout_orphan',
    )
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
    const { id: userId, cus } = await createWebhookTestUser(pool)
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
          { id: 'li_1', quantity: 1, price: { id: 'price_wayfarer', lookup_key: 'tier_wayfarer' } },
        ],
      },
      amount_subtotal: 1500,
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

  it('multi-line subscription session: returns validation_failed, commits stripe_events, writes nothing', async () => {
    const { id: userId, cus } = await createWebhookTestUser(pool)
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
          { id: 'li_1', quantity: 1, price: { id: 'price_wayfarer', lookup_key: 'tier_wayfarer' } },
          { id: 'li_2', quantity: 1, price: { id: 'price_sojourner', lookup_key: 'tier_sojourner' } },
        ],
      },
      amount_subtotal: 3000,
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
