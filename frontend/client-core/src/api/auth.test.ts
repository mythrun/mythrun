import { afterEach, describe, expect, it } from 'vitest'
import { getAuthHeaders } from './auth.ts'
import {
  clearAccessToken,
  resetTokenManager,
  setAccessToken,
} from '../auth/token-manager.ts'

// `getAuthHeaders` is the auth seam `defineEndpoint`'s `ApiContext` calls before
// every request. `bypass` (dev) → an `x-mythrun-dev-sub` header. `jwt` (real) →
// a Bearer header read from the in-memory token manager (MYT-84: NOT secure
// storage — the access token lives in memory only).

afterEach(() => {
  resetTokenManager()
})

describe('getAuthHeaders — bypass mode', () => {
  it('produces the dev-sub header', async () => {
    const headers = await getAuthHeaders({ mode: 'bypass', devSub: 'dev-user-1' })()
    expect(headers).toEqual({ 'x-mythrun-dev-sub': 'dev-user-1' })
  })
})

describe('getAuthHeaders — jwt mode', () => {
  it('produces a Bearer header when a token is present', async () => {
    setAccessToken('tkn', 3600)
    const headers = await getAuthHeaders({ mode: 'jwt' })()
    expect(headers).toEqual({ Authorization: 'Bearer tkn' })
  })

  it('produces no headers when no token has been acquired yet', async () => {
    const headers = await getAuthHeaders({ mode: 'jwt' })()
    expect(headers).toEqual({})
  })

  it('re-reads the token on every call (a token set later is picked up; a clear drops it)', async () => {
    const produce = getAuthHeaders({ mode: 'jwt' })
    expect(await produce()).toEqual({})
    setAccessToken('late', 3600)
    expect(await produce()).toEqual({ Authorization: 'Bearer late' })
    clearAccessToken()
    expect(await produce()).toEqual({})
  })
})
