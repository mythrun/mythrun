import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { renderHook, waitFor } from '@testing-library/react'
import { Suspense } from 'react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiContext } from './endpoint.ts'
import { ApiClientProvider } from './client-context.tsx'
import { getMe, useMe } from './users.ts'

// `useMe` wires `getMe` (GET /api/users/me, response validated against the
// contract's MeResponseSchema) into a TanStack suspense query keyed `['me']`.
// The hook is intentionally thin: it reads the per-call `ApiContext` from
// `useApiContext()` and hands the endpoint to `useSuspenseQuery` — no logic
// beyond that wiring. These tests drive the real queryFn (so `getMe` is
// covered) through MSW: a valid /me payload resolves the parsed user.

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

// retry:false so a malformed-response error surfaces immediately instead of
// being retried; the Suspense boundary gives the suspense query somewhere to
// suspend during the in-flight fetch.
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

const validUser = {
  user: {
    id: 'u-1',
    username: 'tess',
    displayName: 'Tess',
    freeTrialUsed: false,
    createdAt: '2026-06-24T10:00:00.000Z',
  },
}

describe('useMe', () => {
  it('resolves the parsed MeResponse from a valid /me payload', async () => {
    server.use(http.get(`${BASE_URL}/api/users/me`, () => HttpResponse.json(validUser)))

    const { result } = renderHook(() => useMe(), { wrapper: makeWrapper() })

    await waitFor(() => {
      expect(result.current.data).toBeDefined()
    })
    expect(result.current.data).toEqual(validUser)
  })
})

describe('getMe', () => {
  it('fetches and validates /api/users/me directly', async () => {
    server.use(http.get(`${BASE_URL}/api/users/me`, () => HttpResponse.json(validUser)))
    await expect(getMe(undefined, testCtx)).resolves.toEqual(validUser)
  })
})
