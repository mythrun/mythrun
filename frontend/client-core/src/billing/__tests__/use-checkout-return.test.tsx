import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { delay, http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { BalanceResponse } from '@mythrun/contract/rest'
import type { ApiContext } from '../../api/endpoint.ts'
import { ApiClientProvider } from '../../api/client-context.tsx'
import { useCheckoutReturn } from '../use-checkout-return.ts'

// `useCheckoutReturn` polls GET /api/billing/balance after a Stripe redirect: the
// webhook is the source of truth for the credit grant, so the hook snapshots the
// balance at the first poll and waits for it to CHANGE (→ settled, invalidating the
// cached balance) or for the budget to expire (→ processing — a calm NON-error).
// The tests drive the real `getBalance` through a stateful MSW handler; the poll
// interval/budget are tiny so real timers resolve fast.

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

const baseBalance: BalanceResponse = { session: 3, world_gen: 1, active_subscription: null }

function makeWrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ApiClientProvider value={testCtx}>{children}</ApiClientProvider>
    </QueryClientProvider>
  )
}

/** A balance handler that returns `first` on the initial poll and `rest` after. */
function changingBalance(first: BalanceResponse, rest: BalanceResponse) {
  let calls = 0
  return http.get(`${BASE_URL}/api/billing/balance`, () => {
    calls += 1
    return HttpResponse.json(calls <= 1 ? first : rest)
  })
}

describe('useCheckoutReturn', () => {
  it('starts in the polling state', () => {
    server.use(http.get(`${BASE_URL}/api/billing/balance`, () => HttpResponse.json(baseBalance)))
    const { result, unmount } = renderHook(
      () => useCheckoutReturn({ intervalMs: 5, budgetMs: 500 }),
      { wrapper: makeWrapper(new QueryClient()) },
    )
    expect(result.current.status).toBe('polling')
    unmount()
  })

  it('applies the default interval/budget when no config is given', () => {
    server.use(http.get(`${BASE_URL}/api/billing/balance`, () => HttpResponse.json(baseBalance)))
    const { result, unmount } = renderHook(() => useCheckoutReturn(), {
      wrapper: makeWrapper(new QueryClient()),
    })
    expect(result.current.status).toBe('polling')
    unmount()
  })

  it('settles + invalidates the cached balance when SESSION credits change', async () => {
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    server.use(changingBalance(baseBalance, { ...baseBalance, session: 4 }))
    const { result } = renderHook(() => useCheckoutReturn({ intervalMs: 5, budgetMs: 500 }), {
      wrapper: makeWrapper(client),
    })
    await waitFor(() => {
      expect(result.current.status).toBe('settled')
    })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['billing', 'balance'] })
  })

  it('settles when WORLD-GEN credits change (session unchanged)', async () => {
    server.use(changingBalance(baseBalance, { ...baseBalance, world_gen: 2 }))
    const { result } = renderHook(() => useCheckoutReturn({ intervalMs: 5, budgetMs: 500 }), {
      wrapper: makeWrapper(new QueryClient()),
    })
    await waitFor(() => {
      expect(result.current.status).toBe('settled')
    })
  })

  it('settles when the SUBSCRIPTION changes (both credit buckets unchanged)', async () => {
    const withSub = {
      ...baseBalance,
      active_subscription: {
        tier_lookup_key: 'tier_wayfarer',
        current_period_end: '2026-08-01T00:00:00.000Z',
        cancel_at_period_end: false,
        status: 'active',
      },
    }
    server.use(changingBalance(baseBalance, withSub))
    const { result } = renderHook(() => useCheckoutReturn({ intervalMs: 5, budgetMs: 500 }), {
      wrapper: makeWrapper(new QueryClient()),
    })
    await waitFor(() => {
      expect(result.current.status).toBe('settled')
    })
  })

  it('resolves to processing (calm non-error) when the balance never changes', async () => {
    server.use(http.get(`${BASE_URL}/api/billing/balance`, () => HttpResponse.json(baseBalance)))
    const { result } = renderHook(() => useCheckoutReturn({ intervalMs: 5, budgetMs: 20 }), {
      wrapper: makeWrapper(new QueryClient()),
    })
    await waitFor(() => {
      expect(result.current.status).toBe('processing')
    })
  })

  it('resolves to processing when the balance fetch keeps failing (transient errors)', async () => {
    server.use(
      http.get(`${BASE_URL}/api/billing/balance`, () => new HttpResponse(null, { status: 500 })),
    )
    const { result } = renderHook(() => useCheckoutReturn({ intervalMs: 5, budgetMs: 20 }), {
      wrapper: makeWrapper(new QueryClient()),
    })
    await waitFor(() => {
      expect(result.current.status).toBe('processing')
    })
  })

  it('stops polling when unmounted mid-flight (a resolved balance is ignored)', async () => {
    let calls = 0
    server.use(
      http.get(`${BASE_URL}/api/billing/balance`, async () => {
        calls += 1
        await delay(40)
        return HttpResponse.json(baseBalance)
      }),
    )
    const { unmount } = renderHook(() => useCheckoutReturn({ intervalMs: 5, budgetMs: 1000 }), {
      wrapper: makeWrapper(new QueryClient()),
    })
    await new Promise((r) => setTimeout(r, 10))
    const callsAtUnmount = calls
    unmount()
    await new Promise((r) => setTimeout(r, 80))
    expect(calls).toBe(callsAtUnmount)
  })

  it('stops polling when unmounted mid-flight during a FAILING fetch', async () => {
    let calls = 0
    server.use(
      http.get(`${BASE_URL}/api/billing/balance`, async () => {
        calls += 1
        await delay(40)
        return new HttpResponse(null, { status: 500 })
      }),
    )
    const { unmount } = renderHook(() => useCheckoutReturn({ intervalMs: 5, budgetMs: 1000 }), {
      wrapper: makeWrapper(new QueryClient()),
    })
    await new Promise((r) => setTimeout(r, 10))
    const callsAtUnmount = calls
    unmount()
    await new Promise((r) => setTimeout(r, 80))
    expect(calls).toBe(callsAtUnmount)
  })
})
