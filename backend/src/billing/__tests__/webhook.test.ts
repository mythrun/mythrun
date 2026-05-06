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

// The dispatcher does not use the Stripe SDK directly except by passing
// it through to PREFETCHERS. With Task 16's empty PREFETCHERS map (all
// stub handlers), the SDK is never invoked from these tests. A minimal
// stub satisfies the parameter type.
function makeStripe(): Stripe {
  return {} as unknown as Stripe
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
