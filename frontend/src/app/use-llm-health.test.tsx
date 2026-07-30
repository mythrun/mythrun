import type { ReactNode } from 'react'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiClientProvider,
  getLlmHealth,
  type ApiContext,
  type LlmHealthResponse,
} from '@mythrun/client-core'
import { useLlmHealth } from './use-llm-health.ts'

// useLlmHealth — the sitewide LLM-health poll behind the frame's NoticeStrip
// (outage-resilience design §4.2). The pin is POSITIVE ASSERTION ONLY:
// `degraded` is true iff the last completed poll succeeded AND said
// "degraded" — a failed health query (network blip, backend down) reads as
// ok, never arming a sitewide banner off local noise. That includes a failed
// REFETCH after a real degraded reading: stale positive data does not survive
// a poll that errored.

// Mock the client-core barrel's getLlmHealth at the import boundary (the
// use-header-display-name pattern); everything else stays real.
vi.mock('@mythrun/client-core', async (importActual) => {
  const actual = await importActual<typeof import('@mythrun/client-core')>()
  return { ...actual, getLlmHealth: vi.fn() }
})

const getLlmHealthMock = vi.mocked(getLlmHealth)

const TEST_CTX: ApiContext = {
  baseUrl: 'http://api.test',
  getAuthHeaders: () => Promise.resolve({}),
}

const OK: LlmHealthResponse = { state: 'ok', since: null }
const DEGRADED: LlmHealthResponse = { state: 'degraded', since: 1_722_300_000_000 }

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }): React.JSX.Element {
    return (
      <QueryClientProvider client={client}>
        <ApiClientProvider value={TEST_CTX}>{children}</ApiClientProvider>
      </QueryClientProvider>
    )
  }
}

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useLlmHealth', () => {
  it('is ok while the first poll is in flight (no strip during a cold fetch)', () => {
    getLlmHealthMock.mockReturnValueOnce(new Promise<LlmHealthResponse>(() => undefined))
    const { result } = renderHook(() => useLlmHealth(), { wrapper: makeWrapper(makeClient()) })
    expect(result.current.degraded).toBe(false)
  })

  it('stays ok on an ok reading', async () => {
    getLlmHealthMock.mockResolvedValueOnce(OK)
    const client = makeClient()
    const { result } = renderHook(() => useLlmHealth(), { wrapper: makeWrapper(client) })
    await waitFor(() => {
      expect(client.getQueryState(['llm-health'])?.status).toBe('success')
    })
    expect(result.current.degraded).toBe(false)
  })

  it('flips degraded on a degraded reading', async () => {
    getLlmHealthMock.mockResolvedValueOnce(DEGRADED)
    const { result } = renderHook(() => useLlmHealth(), { wrapper: makeWrapper(makeClient()) })
    await waitFor(() => {
      expect(result.current.degraded).toBe(true)
    })
  })

  it('reads ok when the health query itself fails — positive assertion only', async () => {
    getLlmHealthMock.mockRejectedValueOnce(new Error('503'))
    const client = makeClient()
    const { result } = renderHook(() => useLlmHealth(), { wrapper: makeWrapper(client) })
    await waitFor(() => {
      expect(client.getQueryState(['llm-health'])?.status).toBe('error')
    })
    expect(result.current.degraded).toBe(false)
  })

  it('drops a stale degraded reading when a later poll fails (no banner off dead polling)', async () => {
    getLlmHealthMock.mockResolvedValueOnce(DEGRADED).mockRejectedValueOnce(new Error('down'))
    const client = makeClient()
    const { result } = renderHook(() => useLlmHealth(), { wrapper: makeWrapper(client) })
    await waitFor(() => {
      expect(result.current.degraded).toBe(true)
    })
    await client.refetchQueries({ queryKey: ['llm-health'] })
    await waitFor(() => {
      expect(result.current.degraded).toBe(false)
    })
  })
})
