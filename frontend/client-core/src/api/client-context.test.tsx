import { renderHook } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import type { ReactNode } from 'react'
import type { ApiContext } from './endpoint.ts'
import { ApiClientProvider, useApiContext } from './client-context.tsx'

// `ApiClientProvider` carries the resolved `ApiContext` (where the backend lives
// + how to authenticate) down the React tree; `useApiContext()` is how the data
// hooks read it. The provider is the seam between the platform entry (which
// builds the concrete context with baseUrl + auth) and the platform-agnostic
// hooks. `useApiContext` throws a clear error when used outside the provider, so
// a missing-provider mistake fails loudly at the call site rather than silently
// running against `null`.

const testCtx: ApiContext = {
  baseUrl: 'http://api.test',
  getAuthHeaders: () => Promise.resolve({}),
}

describe('useApiContext', () => {
  it('returns the context value provided by ApiClientProvider', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ApiClientProvider value={testCtx}>{children}</ApiClientProvider>
    )
    const { result } = renderHook(() => useApiContext(), { wrapper })
    expect(result.current).toBe(testCtx)
  })

  it('throws a clear error when used outside an ApiClientProvider', () => {
    expect(() => renderHook(() => useApiContext())).toThrow(
      /ApiClientProvider/,
    )
  })
})
