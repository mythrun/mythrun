import { getAccessToken } from '../auth/token-manager.ts'

// `getAuthHeaders` is the auth seam between the client brain and the backend:
// `defineEndpoint`'s `ApiContext.getAuthHeaders` is exactly the producer this
// factory returns. Built once (with the mode), invoked per request, so a token
// stored AFTER construction is still picked up — the jwt producer reads the
// in-memory token manager on every call (MYT-84: the access token lives in
// memory, never secure storage).

/**
 * `bypass` — local/dev: the backend trusts an `x-mythrun-dev-sub` header; no
 * real auth. `jwt` — the live path: a Bearer token read from the in-memory
 * token manager (empty headers before one is acquired).
 */
export type AuthHeaderOptions = { mode: 'bypass'; devSub: string } | { mode: 'jwt' }

export function getAuthHeaders(opts: AuthHeaderOptions): () => Promise<Record<string, string>> {
  if (opts.mode === 'bypass') {
    const headers: Record<string, string> = { 'x-mythrun-dev-sub': opts.devSub }
    return () => Promise.resolve(headers)
  }
  return () => {
    const token = getAccessToken()
    return Promise.resolve(token === null ? {} : { Authorization: `Bearer ${token}` })
  }
}
