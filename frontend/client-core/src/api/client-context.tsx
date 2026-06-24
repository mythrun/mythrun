import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { ApiContext } from './endpoint.ts'

// `ApiClientProvider` carries the resolved `ApiContext` — where the backend
// lives (`baseUrl`) and how to authenticate (`getAuthHeaders`) — down the React
// tree. The platform entry builds the concrete context (web today, native
// later) and provides it here; the platform-agnostic data hooks read it via
// `useApiContext()`. This is React-only (no DOM globals), so it stays R1-clean
// and lives in the client brain alongside the hooks it feeds.

const ApiClientContext = createContext<ApiContext | null>(null)

export function ApiClientProvider({
  value,
  children,
}: {
  value: ApiContext
  children: ReactNode
}) {
  return <ApiClientContext.Provider value={value}>{children}</ApiClientContext.Provider>
}

/**
 * Reads the ambient `ApiContext`. Throws a clear error when called outside an
 * `ApiClientProvider` so a missing-provider mistake fails loudly at the call
 * site rather than silently running against `null`.
 */
export function useApiContext(): ApiContext {
  const ctx = useContext(ApiClientContext)
  if (ctx === null) {
    throw new Error('useApiContext must be used within an ApiClientProvider')
  }
  return ctx
}
