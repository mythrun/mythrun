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
import { getMyCampaigns, useMyCampaigns } from './campaigns.ts'

// `useMyCampaigns` wires `getMyCampaigns` (GET /api/campaigns/mine, response
// validated against the contract's MyCampaignsResponseSchema) into a TanStack
// suspense query keyed `['campaigns','mine']`. As with useMe the hook is a thin
// wiring shell. These tests drive the real queryFn through MSW: a valid list
// resolves the parsed campaigns; a malformed campaign (missing required fields)
// makes the suspense query surface a `ContractValidationError` (asserted via the
// query's error after waitFor, with retry:false so it errors immediately).

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

const validCampaign = {
  id: 'c-1',
  worldId: 'w-1',
  name: 'The Sunken Coast',
  status: 'active' as const,
  language: 'en',
  createdAt: '2026-06-24T10:00:00.000Z',
  updatedAt: '2026-06-24T11:00:00.000Z',
}

describe('useMyCampaigns', () => {
  it('resolves the parsed campaign array from a valid payload', async () => {
    server.use(
      http.get(`${BASE_URL}/api/campaigns/mine`, () =>
        HttpResponse.json({ campaigns: [validCampaign] }),
      ),
    )

    const { result } = renderHook(() => useMyCampaigns(), { wrapper: makeWrapper() })

    await waitFor(() => {
      expect(result.current.data).toBeDefined()
    })
    expect(result.current.data).toEqual({ campaigns: [validCampaign] })
  })

  it('surfaces a ContractValidationError for a malformed campaign', async () => {
    server.use(
      http.get(`${BASE_URL}/api/campaigns/mine`, () =>
        HttpResponse.json({ campaigns: [{ id: 'x' }] }),
      ),
    )

    // useSuspenseQuery throws into the error boundary; using the non-suspense
    // path here would still surface .error, but to read the error legibly we
    // capture it via the query result after it settles. A bare Suspense wrapper
    // (no ErrorBoundary) would let the thrown error escape render, so we assert
    // the error directly off the QueryClient cache instead of rendering it.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ApiClientProvider value={testCtx}>
          <Suspense fallback={<span>loading</span>}>{children}</Suspense>
        </ApiClientProvider>
      </QueryClientProvider>
    )

    renderHook(() => useMyCampaigns(), { wrapper })

    await waitFor(() => {
      const state = client.getQueryState(['campaigns', 'mine'])
      expect(state?.error).toBeDefined()
    })
    const error = client.getQueryState(['campaigns', 'mine'])?.error
    expect(isContractValidationError(error)).toBe(true)
  })
})

describe('getMyCampaigns', () => {
  it('fetches and validates /api/campaigns/mine directly', async () => {
    server.use(
      http.get(`${BASE_URL}/api/campaigns/mine`, () =>
        HttpResponse.json({ campaigns: [validCampaign] }),
      ),
    )
    await expect(getMyCampaigns(undefined, testCtx)).resolves.toEqual({
      campaigns: [validCampaign],
    })
  })
})
