import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { renderHook, waitFor } from '@testing-library/react'
import { Suspense } from 'react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiContext } from './endpoint.ts'
import { ApiClientProvider } from './client-context.tsx'
import { isContractValidationError } from './errors.ts'
import { getBalance, useBalance, useLowSessionCredits } from './billing.ts'

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

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ApiClientProvider value={testCtx}>
          <Suspense fallback={<span>loading</span>}>{children}</Suspense>
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

// ── useLowSessionCredits (MYT-95 T13) — the FAIL-OPEN decorative signal ─────
describe('useLowSessionCredits', () => {
  it('true when the session bucket is at the threshold', async () => {
    server.use(
      http.get(`${BASE_URL}/api/billing/balance`, () =>
        HttpResponse.json({ session: 1, world_gen: 5, active_subscription: null }),
      ),
    )
    const { result } = renderHook(() => useLowSessionCredits(), { wrapper: makeWrapper() })
    await waitFor(() => {
      expect(result.current).toBe(true)
    })
  })

  it('false above the threshold', async () => {
    server.use(
      http.get(`${BASE_URL}/api/billing/balance`, () =>
        HttpResponse.json({ session: 2, world_gen: 0, active_subscription: null }),
      ),
    )
    const { result } = renderHook(() => useLowSessionCredits(), { wrapper: makeWrapper() })
    // settles false and stays false
    await waitFor(() => {
      expect(result.current).toBe(false)
    })
  })

  it('FAILS OPEN: reports false while loading and false on a fetch error (never throws, never suspends)', async () => {
    server.use(
      http.get(`${BASE_URL}/api/billing/balance`, () => new HttpResponse(null, { status: 500 })),
    )
    const { result } = renderHook(() => useLowSessionCredits(), { wrapper: makeWrapper() })
    expect(result.current).toBe(false)
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current).toBe(false)
  })
})
