import { describe, it, expect } from 'vitest'
import type { SecureStorage } from '../platform/secure-storage.ts'
import { getAuthHeaders } from './auth.ts'

// `getAuthHeaders` is the auth seam `defineEndpoint`'s `ApiContext` calls before
// every request. Two modes: `bypass` (local/dev — the backend trusts an
// `x-mythrun-dev-sub` header) and `jwt` (real auth — a Bearer token read from
// secure storage). The factory returns the async header-producer the transport
// invokes per call, so a token persisted after construction is still seen.

// An in-memory `SecureStorage` for the test — a Map-backed object that satisfies
// the interface, NOT the web impl (that lands in W3b). `seed` pre-populates it.
function fakeSecureStorage(seed?: Record<string, string>): SecureStorage {
  const map = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    get: (key) => Promise.resolve(map.get(key) ?? null),
    set: (key, value) => {
      map.set(key, value)
      return Promise.resolve()
    },
    remove: (key) => {
      map.delete(key)
      return Promise.resolve()
    },
  }
}

describe('getAuthHeaders — bypass mode', () => {
  it('produces the dev-sub header', async () => {
    const headers = await getAuthHeaders({
      mode: 'bypass',
      devSub: 'dev-user-1',
      secureStorage: fakeSecureStorage(),
    })()
    expect(headers).toEqual({ 'x-mythrun-dev-sub': 'dev-user-1' })
  })

  it('does not read secure storage in bypass mode', async () => {
    let getCalls = 0
    const spyStorage: SecureStorage = {
      get: (key) => {
        getCalls += 1
        return fakeSecureStorage().get(key)
      },
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    }
    await getAuthHeaders({ mode: 'bypass', devSub: 'dev-user-1', secureStorage: spyStorage })()
    expect(getCalls).toBe(0)
  })
})

describe('getAuthHeaders — jwt mode', () => {
  it('produces a Bearer header when a token is present', async () => {
    const headers = await getAuthHeaders({
      mode: 'jwt',
      secureStorage: fakeSecureStorage({ auth_token: 'tkn' }),
    })()
    expect(headers).toEqual({ Authorization: 'Bearer tkn' })
  })

  it('reads the token from the auth_token key', async () => {
    let requestedKey: string | undefined
    const storage: SecureStorage = {
      get: (key) => {
        requestedKey = key
        return Promise.resolve('tkn')
      },
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    }
    await getAuthHeaders({ mode: 'jwt', secureStorage: storage })()
    expect(requestedKey).toBe('auth_token')
  })

  it('produces no headers when no token has been acquired yet', async () => {
    const headers = await getAuthHeaders({
      mode: 'jwt',
      secureStorage: fakeSecureStorage(),
    })()
    expect(headers).toEqual({})
  })

  it('re-reads storage on every call (a token persisted later is picked up)', async () => {
    const storage = fakeSecureStorage()
    const produce = getAuthHeaders({ mode: 'jwt', secureStorage: storage })

    expect(await produce()).toEqual({})

    await storage.set('auth_token', 'late-tkn')
    expect(await produce()).toEqual({ Authorization: 'Bearer late-tkn' })
  })
})
