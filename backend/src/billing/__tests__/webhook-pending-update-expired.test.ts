import { describe, it, expect } from 'vitest'
import type { Stripe } from 'stripe'
import type { FastifyBaseLogger } from 'fastify'
import { handlePendingUpdateExpired } from '../webhook-pending-update-expired.js'
import type { ClientLike } from '../../repo/_types.js'

interface CapturedLogCall {
  readonly level: 'info' | 'warn' | 'error'
  readonly obj: Record<string, unknown>
  readonly msg: string
}

function makeLog(): {
  calls: CapturedLogCall[]
  logger: {
    info: (o: object, msg: string) => void
    warn: (o: object, msg: string) => void
    error: (o: object, msg: string) => void
    debug: (o: object, msg: string) => void
    fatal: (o: object, msg: string) => void
    trace: (o: object, msg: string) => void
    child: () => unknown
    level: string
    silent: () => void
  }
} {
  const calls: CapturedLogCall[] = []
  const push =
    (level: CapturedLogCall['level']) =>
    (obj: object, msg: string): void => {
      calls.push({ level, obj: obj as Record<string, unknown>, msg })
    }
  return {
    calls,
    logger: {
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
      debug: () => undefined,
      fatal: () => undefined,
      trace: () => undefined,
      child: () => ({}),
      level: 'info',
      silent: () => undefined,
    },
  }
}

function makeEvent(overrides: Partial<Stripe.Subscription> = {}): Stripe.Event {
  const sub = {
    id: 'sub_test_expired',
    object: 'subscription' as const,
    customer: 'cus_test_expired',
    status: 'past_due' as const,
    items: {
      data: [
        {
          id: 'si_test',
          price: { id: 'price_test', lookup_key: 'mythwright' },
        },
      ],
    },
    latest_invoice: 'in_test_voided',
    pending_update: null,
    ...overrides,
  } as unknown as Stripe.Subscription
  return {
    id: 'evt_test_expired_1',
    type: 'customer.subscription.pending_update_expired',
    api_version: '2026-04-22.dahlia',
    created: 1700000000,
    data: { object: sub },
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    object: 'event',
  } as unknown as Stripe.Event
}

// Stub client — handler should not touch it.
const noopClient: ClientLike = {
  query: () => {
    throw new Error('handler should not query the database')
  },
}

describe('webhook handler — customer.subscription.pending_update_expired', () => {
  it('logs INFO billing.upgrade_expired with subscription_id, customer_id, latest_invoice_id, target_tier_lookup_key — and performs ZERO DB writes', async () => {
    const { calls, logger } = makeLog()
    const event = makeEvent()
    const result = await handlePendingUpdateExpired(
      event,
      undefined,
      noopClient,
      logger as unknown as FastifyBaseLogger,
    )
    expect(result).toBe('ok')
    expect(calls).toHaveLength(1)
    const first = calls[0]
    expect(first?.level).toBe('info')
    expect(first?.msg).toBe('billing.upgrade_expired')
    expect(first?.obj.subscription_id).toBe('sub_test_expired')
    expect(first?.obj.customer_id).toBe('cus_test_expired')
    expect(first?.obj.latest_invoice_id).toBe('in_test_voided')
    expect(first?.obj.target_tier_lookup_key).toBe('mythwright')
    expect(first?.obj.event_id).toBe('evt_test_expired_1')
  })

  it('handles null latest_invoice without throwing', async () => {
    const { logger } = makeLog()
    const event = makeEvent({ latest_invoice: null })
    const result = await handlePendingUpdateExpired(
      event,
      undefined,
      noopClient,
      logger as unknown as FastifyBaseLogger,
    )
    expect(result).toBe('ok')
  })
})
