import { render, screen } from '@testing-library/react'
import { useQueryClient } from '@tanstack/react-query'
import { HttpError, useApiContext, type SecureStorage } from '@mythrun/client-core'
import { beforeAll, describe, expect, it } from 'vitest'
import { AppProviders } from './providers.tsx'

// ENVIRONMENT shim (Node 25 vs jsdom), not production code. AppProviders now
// mounts @mythrun/ui's <ThemeProvider> at the composition root (MYT-84), which
// reads `localStorage` on mount to resolve the initial theme. Node 25 ships the
// experimental Web Storage API on by default, installing a non-functional builtin
// `localStorage` (no getItem/setItem) that SHADOWS the real `Storage` jsdom would
// provide. The provider legitimately uses the browser's real `localStorage`
// (works in a real browser); here we install a functional in-memory `Storage`
// onto the global so the stack renders. Mirrors the `secure-storage.test.ts`
// precedent in this package. (matchMedia is absent in jsdom too, but the provider
// guards it — `typeof window.matchMedia === 'function'` — so no shim is needed.)
class MemStorage {
  private readonly store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  clear(): void {
    this.store.clear()
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null
  }
  get length(): number {
    return this.store.size
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemStorage(),
    configurable: true,
    writable: true,
  })
})

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
// provider is wired). Either being absent THROWS on render. The probe also
// EXERCISES the QueryClient's retry predicate (this provider's default): the
// rule is "never retry a 4xx; otherwise one retry" — the only legitimate retry
// is the auth refresh, which defineEndpoint owns. `retry-ok-true` proves the
// predicate is the wired function AND behaves correctly; `base-url-*` proves
// client-core. (Surfaced via `data-testid`, read back by the assertions.)
function Probe(): React.JSX.Element {
  const queryClient = useQueryClient()
  const apiContext = useApiContext()
  const retry = queryClient.getDefaultOptions().queries?.retry
  const ok =
    typeof retry === 'function' &&
    retry(0, new HttpError(404, 'not found')) === false &&
    retry(0, new HttpError(500, 'boom')) === true &&
    retry(0, new Error('network')) === true &&
    retry(1, new Error('network')) === false
  return (
    <>
      <span data-testid={`retry-ok-${String(ok)}`} />
      <span data-testid={`base-url-${apiContext.baseUrl}`} />
    </>
  )
}

describe('AppProviders', () => {
  it('wires the QueryClient (retry skips 4xx, else one retry) + the ApiContext', () => {
    render(
      <AppProviders config={testConfig}>
        <Probe />
      </AppProviders>,
    )
    // The QueryClient carries this provider's retry predicate, wired + correct.
    expect(screen.getByTestId('retry-ok-true')).toBeDefined()
    // The ApiContext carries the configured baseUrl (proves client-core wired).
    expect(screen.getByTestId('base-url-http://api.test')).toBeDefined()
  })
})
