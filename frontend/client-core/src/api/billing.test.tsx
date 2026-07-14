import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { renderHook, waitFor } from '@testing-library/react'
import { Component, Suspense } from 'react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiContext } from './endpoint.ts'
import { ApiClientProvider } from './client-context.tsx'
import { isContractValidationError, isHttpError, HttpError } from './errors.ts'
import {
  getBalance,
  useBalance,
  getSkus,
  useSkus,
  getHistory,
  useHistory,
  createCheckout,
  openPortal,
  upgradeTier,
} from './billing.ts'

// `useBalance` wires `getBalance` (GET /api/billing/balance, response validated
// against the contract's BalanceResponseSchema) into a TanStack suspense query
// keyed `['billing','balance']` — the same thin wiring shell as useMyCampaigns /
// useMe. These tests drive the real queryFn through MSW: a valid balance resolves
// the parsed snake_case body; a malformed balance (wrong-typed field) makes the
// suspense query surface a `ContractValidationError` (asserted off the query's
// cached error after waitFor, with retry:false so it errors immediately).

const BASE_URL = 'http://api.test'
const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

const testCtx: ApiContext = {
  baseUrl: BASE_URL,
  getAuthHeaders: () => Promise.resolve({}),
}

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ApiClientProvider value={testCtx}>
        <Suspense fallback={<span>loading</span>}>{children}</Suspense>
      </ApiClientProvider>
    </QueryClientProvider>
  )
}

const validBalance = {
  session: 3,
  world_gen: 1,
  active_subscription: {
    tier_lookup_key: 'pro_monthly',
    current_period_end: '2026-07-24T10:00:00.000Z',
    cancel_at_period_end: false,
    status: 'active',
  },
}

describe('useBalance', () => {
  it('resolves the parsed balance from a valid payload', async () => {
    server.use(
      http.get(`${BASE_URL}/api/billing/balance`, () => HttpResponse.json(validBalance)),
    )

    const { result } = renderHook(() => useBalance(), { wrapper: makeWrapper() })

    await waitFor(() => {
      expect(result.current.data).toBeDefined()
    })
    expect(result.current.data).toEqual(validBalance)
  })

  it('resolves a balance with no active subscription (null)', async () => {
    server.use(
      http.get(`${BASE_URL}/api/billing/balance`, () =>
        HttpResponse.json({ session: 0, world_gen: 0, active_subscription: null }),
      ),
    )

    const { result } = renderHook(() => useBalance(), { wrapper: makeWrapper() })

    await waitFor(() => {
      expect(result.current.data).toBeDefined()
    })
    expect(result.current.data).toEqual({ session: 0, world_gen: 0, active_subscription: null })
  })

  it('surfaces a ContractValidationError for a malformed balance', async () => {
    server.use(
      // `session` is a string here — the contract requires a number, so the
      // response fails to parse and the suspense query errors.
      http.get(`${BASE_URL}/api/billing/balance`, () =>
        HttpResponse.json({ session: '3', world_gen: 1, active_subscription: null }),
      ),
    )

    // An errored `useSuspenseQuery` THROWS during render; without a real
    // ErrorBoundary a bare Suspense wrapper lets the thrown error escape as an
    // async unhandled rejection that vitest mis-attributes to the next-running
    // suspense test. Absorb it here (mirrors campaigns.test.tsx's SwallowBoundary)
    // — we assert the cached query error, not the rendered tree.
    class SwallowBoundary extends Component<{ children: ReactNode }, { caught: boolean }> {
      override state = { caught: false }
      static getDerivedStateFromError(): { caught: boolean } {
        return { caught: true }
      }
      override render(): ReactNode {
        return this.state.caught ? <span>boundary</span> : this.props.children
      }
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ApiClientProvider value={testCtx}>
          <SwallowBoundary>
            <Suspense fallback={<span>loading</span>}>{children}</Suspense>
          </SwallowBoundary>
        </ApiClientProvider>
      </QueryClientProvider>
    )

    renderHook(() => useBalance(), { wrapper })

    await waitFor(() => {
      const state = client.getQueryState(['billing', 'balance'])
      expect(state?.error).toBeDefined()
    })
    const error = client.getQueryState(['billing', 'balance'])?.error
    expect(isContractValidationError(error)).toBe(true)
  })
})

describe('getBalance', () => {
  it('fetches and validates /api/billing/balance directly', async () => {
    server.use(
      http.get(`${BASE_URL}/api/billing/balance`, () => HttpResponse.json(validBalance)),
    )
    await expect(getBalance(undefined, testCtx)).resolves.toEqual(validBalance)
  })
})

// --- MYT-95: the rest of the billing surface ---
//
// Fixtures are grounded in the live probe (tmp/sdd/myt95-verify-notes.md): the
// SKU catalogue carries NO stripe_price_id; a history feed mixes an à-la-carte
// PACK row (lookup_key: null — pack rows cannot name credit counts) with a
// subscription INVOICE row (lookup_key populated). checkout/portal/upgrade
// return the exact Stripe-redirect shapes the routes emit.

const validSkus = [
  {
    lookup_key: 'tier_wayfarer',
    displayName: 'Wayfarer',
    type: 'recurring',
    sessionsGranted: 4,
    worldsGranted: 1,
    price: { unit_amount_cents: 1500, currency: 'usd' },
  },
  {
    lookup_key: 'sku_session',
    displayName: 'Session',
    type: 'one_time',
    sessionsGranted: 1,
    worldsGranted: 0,
    price: { unit_amount_cents: 500, currency: 'usd' },
  },
]

const validHistory = {
  events: [
    {
      id: 'evt-pack',
      kind: 'purchase',
      occurred_at: '2026-07-01T10:00:00.000Z',
      amount_cents: 500,
      currency: 'usd',
      lookup_key: null,
      status: 'completed',
      source_id_stripe: 'pi_123',
    },
    {
      id: 'evt-invoice',
      kind: 'invoice',
      occurred_at: '2026-07-02T10:00:00.000Z',
      amount_cents: 4500,
      currency: 'usd',
      lookup_key: 'tier_mythwright',
      status: 'completed',
      source_id_stripe: 'in_456',
    },
  ],
  nextCursor: null,
}

const validCheckout = {
  checkout_session_id: 'cs_test_abc123',
  url: 'https://checkout.stripe.com/c/pay/cs_test_abc123',
}
const validPortal = { url: 'https://billing.stripe.com/p/session/test_abc123' }

describe('getSkus / useSkus', () => {
  it('fetches and validates the public SKU catalogue', async () => {
    server.use(http.get(`${BASE_URL}/api/billing/skus`, () => HttpResponse.json(validSkus)))
    await expect(getSkus(undefined, testCtx)).resolves.toEqual(validSkus)
  })

  it('resolves the parsed skus via suspense', async () => {
    server.use(http.get(`${BASE_URL}/api/billing/skus`, () => HttpResponse.json(validSkus)))

    const { result } = renderHook(() => useSkus(), { wrapper: makeWrapper() })

    await waitFor(() => {
      expect(result.current.data).toBeDefined()
    })
    expect(result.current.data).toEqual(validSkus)
  })
})

describe('getHistory / useHistory', () => {
  it('GETs /api/billing/history with no query string when no cursor is given', async () => {
    let requestedSearch: string | undefined
    server.use(
      http.get(`${BASE_URL}/api/billing/history`, ({ request }) => {
        requestedSearch = new URL(request.url).search
        return HttpResponse.json(validHistory)
      }),
    )
    await expect(getHistory({}, testCtx)).resolves.toEqual(validHistory)
    expect(requestedSearch).toBe('')
  })

  it('appends an encoded ?cursor= when a cursor is given', async () => {
    let requestedUrl: string | undefined
    let decodedCursor: string | null | undefined
    server.use(
      http.get(`${BASE_URL}/api/billing/history`, ({ request }) => {
        requestedUrl = request.url
        decodedCursor = new URL(request.url).searchParams.get('cursor')
        return HttpResponse.json(validHistory)
      }),
    )
    // A cursor with a space + slash proves encodeURIComponent ran on the wire.
    await expect(getHistory({ cursor: 'a b/c' }, testCtx)).resolves.toEqual(validHistory)
    expect(requestedUrl).toContain('cursor=a%20b%2Fc')
    expect(decodedCursor).toBe('a b/c')
  })

  it('resolves the parsed history via suspense (no cursor)', async () => {
    server.use(http.get(`${BASE_URL}/api/billing/history`, () => HttpResponse.json(validHistory)))

    const { result } = renderHook(() => useHistory(), { wrapper: makeWrapper() })

    await waitFor(() => {
      expect(result.current.data).toBeDefined()
    })
    expect(result.current.data).toEqual(validHistory)
  })
})

describe('createCheckout', () => {
  it('POSTs the checkout body and returns { checkout_session_id, url }', async () => {
    let posted: unknown
    server.use(
      http.post(`${BASE_URL}/api/billing/checkout`, async ({ request }) => {
        posted = await request.json()
        return HttpResponse.json(validCheckout)
      }),
    )
    const body = {
      items: [{ lookup_key: 'sku_session' as const, quantity: 1 }],
      success_url: 'http://localhost:5173/billing/return',
      cancel_url: 'http://localhost:5173/billing/cancelled',
    }
    await expect(createCheckout(testCtx, body)).resolves.toEqual(validCheckout)
    expect(posted).toEqual(body)
  })
})

describe('openPortal', () => {
  it('POSTs { return_url } and returns { url }', async () => {
    let posted: unknown
    server.use(
      http.post(`${BASE_URL}/api/billing/portal`, async ({ request }) => {
        posted = await request.json()
        return HttpResponse.json(validPortal)
      }),
    )
    await expect(
      openPortal(testCtx, { return_url: 'http://localhost:5173/settings' }),
    ).resolves.toEqual(validPortal)
    expect(posted).toEqual({ return_url: 'http://localhost:5173/settings' })
  })
})

describe('upgradeTier', () => {
  it('POSTs { target_tier_lookup_key } and returns { invoice_id }', async () => {
    let posted: unknown
    server.use(
      http.post(`${BASE_URL}/api/billing/upgrade-tier`, async ({ request }) => {
        posted = await request.json()
        return HttpResponse.json({ invoice_id: 'in_789' })
      }),
    )
    await expect(
      upgradeTier(testCtx, { target_tier_lookup_key: 'tier_mythwright' }),
    ).resolves.toEqual({ invoice_id: 'in_789' })
    expect(posted).toEqual({ target_tier_lookup_key: 'tier_mythwright' })
  })

  it('throws a typed HttpError 409 upgrade_already_pending', async () => {
    server.use(
      http.post(`${BASE_URL}/api/billing/upgrade-tier`, () =>
        HttpResponse.json(
          {
            code: 'upgrade_already_pending',
            detail: {
              pending_update_expires_at: '2026-07-14T18:00:00.000Z',
              latest_invoice_id: 'in_prior',
            },
          },
          { status: 409 },
        ),
      ),
    )
    const error = await upgradeTier(testCtx, { target_tier_lookup_key: 'tier_mythwright' }).catch(
      (e: unknown) => e,
    )
    expect(isHttpError(error)).toBe(true)
    expect((error as HttpError).status).toBe(409)
    expect((error as HttpError).code).toBe('upgrade_already_pending')
  })
})
