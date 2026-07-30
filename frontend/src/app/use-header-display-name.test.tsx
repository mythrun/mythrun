import type { ReactNode } from 'react'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClientProvider, getMe, type ApiContext, type MeResponse } from '@mythrun/client-core'
import { useHeaderDisplayName } from './use-header-display-name.ts'

// useHeaderDisplayName — the frame's identity data path, lifted out of the old
// <HeaderIdentity/> slot (navbar redesign: the name now lives ON the desktop
// menu trigger, so the frame needs a VALUE, not a rendered slot). The pin is
// the boundary semantics: `null` while the /me fetch is in flight AND after a
// failure — HeaderMenu maps null to the icon trigger, so Log out is never
// unreachable and a failed fetch never throws into the route error boundary
// (the old slot's HeaderSlot Suspense/error-boundary contract, restated as a
// non-suspense query's status flags).

// Mock the client-core barrel's getMe at the import boundary (the header-menu
// pattern); everything else (useApiContext, ApiClientProvider) stays real.
vi.mock('@mythrun/client-core', async (importActual) => {
  const actual = await importActual<typeof import('@mythrun/client-core')>()
  return { ...actual, getMe: vi.fn() }
})

const getMeMock = vi.mocked(getMe)

const TEST_CTX: ApiContext = {
  baseUrl: 'http://api.test',
  getAuthHeaders: () => Promise.resolve({}),
}

const ME: MeResponse = {
  user: {
    id: 'dev-user-1',
    username: 'idrisa',
    displayName: 'Idrisa the Bold',
    freeTrialUsed: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
}

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

describe('useHeaderDisplayName', () => {
  it('is null while /me is in flight — the menu keeps its reachable icon trigger during a cold fetch', () => {
    getMeMock.mockReturnValueOnce(new Promise<MeResponse>(() => undefined))
    const { result } = renderHook(() => useHeaderDisplayName(), {
      wrapper: makeWrapper(makeClient()),
    })
    expect(result.current).toBeNull()
  })

  it('resolves to the display name once /me lands', async () => {
    getMeMock.mockResolvedValueOnce(ME)
    const { result } = renderHook(() => useHeaderDisplayName(), {
      wrapper: makeWrapper(makeClient()),
    })
    await waitFor(() => {
      expect(result.current).toBe('Idrisa the Bold')
    })
  })

  it('stays null when /me fails — degrades to the icon trigger, never throws to a boundary', async () => {
    getMeMock.mockRejectedValueOnce(new Error('503'))
    const client = makeClient()
    const { result } = renderHook(() => useHeaderDisplayName(), { wrapper: makeWrapper(client) })
    await waitFor(() => {
      expect(client.getQueryState(['me'])?.status).toBe('error')
    })
    expect(result.current).toBeNull()
  })

  it("reads a pre-seeded ['me'] cache synchronously (the screen-harness seed path)", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    client.setQueryData(['me'], ME)
    const { result } = renderHook(() => useHeaderDisplayName(), { wrapper: makeWrapper(client) })
    expect(result.current).toBe('Idrisa the Bold')
  })
})
