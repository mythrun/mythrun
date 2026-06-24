import { render, screen } from '@testing-library/react'
import { useQueryClient } from '@tanstack/react-query'
import { useApiContext, type SecureStorage } from '@mythrun/client-core'
import { describe, expect, it } from 'vitest'
import { AppProviders } from './providers.tsx'

// An in-memory SecureStorage fake (the real web impl lands in W3b). The
// provider only needs to construct `getAuthHeaders` from it; in `bypass` mode
// it is never read, but the stack must accept it.
function makeFakeStorage(): SecureStorage {
  const store = new Map<string, string>()
  return {
    get: (key) => Promise.resolve(store.get(key) ?? null),
    set: (key, value) => {
      store.set(key, value)
      return Promise.resolve()
    },
    remove: (key) => {
      store.delete(key)
      return Promise.resolve()
    },
  }
}

const testConfig = {
  baseUrl: 'http://api.test',
  authMode: 'bypass',
  devSub: 'dev-user-1',
  secureStorage: makeFakeStorage(),
} as const

// Probe proves both contexts resolve from inside the stack: a QueryClient is
// present (react-query is wired) AND the ApiContext is present (client-core's
// provider is wired). Either being absent THROWS on render — `useQueryClient`
// and `useApiContext` both throw without their provider — so a successful
// render is itself the proof. The resolved values are surfaced through
// `data-testid` (not literal UI text) so the assertions can read them back: the
// react-query default this provider sets (`retry: 1`) and the configured
// `baseUrl`, confirming the real wired instances reached the probe.
function Probe(): React.JSX.Element {
  const queryClient = useQueryClient()
  const apiContext = useApiContext()
  const retry = queryClient.getDefaultOptions().queries?.retry
  return (
    <>
      <span data-testid={`retry-${String(retry)}`} />
      <span data-testid={`base-url-${apiContext.baseUrl}`} />
    </>
  )
}

describe('AppProviders', () => {
  it('wires the QueryClient + ApiContext stack so both resolve without throwing', () => {
    render(
      <AppProviders config={testConfig}>
        <Probe />
      </AppProviders>,
    )
    // The QueryClient carries this provider's default (proves react-query wired).
    expect(screen.getByTestId('retry-1')).toBeDefined()
    // The ApiContext carries the configured baseUrl (proves client-core wired).
    expect(screen.getByTestId('base-url-http://api.test')).toBeDefined()
  })
})
