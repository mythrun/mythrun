import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { renderHook, waitFor } from '@testing-library/react'
import { Suspense } from 'react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiContext } from './endpoint.ts'
import { ApiClientProvider } from './client-context.tsx'
import { useSessionRecap } from './session-recap.ts'

// `useSessionRecap` wires the recap read into a suspense query that background-
// polls ONLY while the async analysis is `pending` and stops once `ready` (a
// written recap is durable). These tests drive the real queryFn through MSW and
// pin both arms of the refetchInterval decision.

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

const readyRecap = {
  recap: {
    sessionNumber: 1,
    endedAt: '2026-07-24T18:00:00.000Z',
    status: 'ready',
    summary: 'Wren traced the missing children to the warming room ledger.',
    emergingThreads: ['Who is V.L.K.?'],
  },
}

const pendingRecap = {
  recap: { sessionNumber: 1, endedAt: '2026-07-24T18:00:00.000Z', status: 'pending' },
}

describe('useSessionRecap', () => {
  it('resolves the parsed ready recap and stops polling', async () => {
    server.use(
      http.get(`${BASE_URL}/api/sessions/c-1/recap`, () => HttpResponse.json(readyRecap)),
    )

    const { result } = renderHook(() => useSessionRecap('c-1'), { wrapper: makeWrapper() })

    await waitFor(() => {
      expect(result.current.data).toBeDefined()
    })
    expect(result.current.data).toEqual(readyRecap)
  })

  it('resolves a pending recap (facts only, analysis still being written)', async () => {
    server.use(
      http.get(`${BASE_URL}/api/sessions/c-2/recap`, () => HttpResponse.json(pendingRecap)),
    )

    const { result } = renderHook(() => useSessionRecap('c-2'), { wrapper: makeWrapper() })

    await waitFor(() => {
      expect(result.current.data).toBeDefined()
    })
    // `recap` is nullable in the contract (no ended session yet) — the optional
    // chain keeps strict-null happy; a null recap fails the expectation anyway.
    expect(result.current.data.recap?.status).toBe('pending')
  })

  it('polls while pending, then STOPS once the analysis lands', async () => {
    let calls = 0
    server.use(
      http.get(`${BASE_URL}/api/sessions/c-3/recap`, () => {
        calls += 1
        return HttpResponse.json(calls < 2 ? pendingRecap : readyRecap)
      }),
    )

    const { result } = renderHook(() => useSessionRecap('c-3'), { wrapper: makeWrapper() })

    // First fetch answers pending; the 3s refetchInterval re-asks; the second
    // answer is ready, after which the interval resolves to false (no more calls).
    await waitFor(
      () => {
        expect(result.current.data.recap?.status).toBe('ready')
      },
      { timeout: 8_000 },
    )
    const callsAtReady = calls
    // Give a would-be next interval a beat to (not) fire.
    await new Promise((r) => setTimeout(r, 3_500))
    expect(calls).toBe(callsAtReady)
  }, 15_000)
})
