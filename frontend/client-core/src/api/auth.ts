import type { SecureStorage } from '../platform/secure-storage.ts'

// `getAuthHeaders` is the auth seam between the client brain and the backend:
// `defineEndpoint`'s `ApiContext.getAuthHeaders` is exactly the producer this
// factory returns. It is built once (with the mode + storage handle) and
// invoked per request, so a token persisted AFTER construction is still picked
// up — the factory closes over the storage, not over a snapshotted token.

/** Where the backend stores the JWT inside the platform's secure storage. */
const AUTH_TOKEN_KEY = 'auth_token'

/**
 * `bypass` — local/dev: the backend trusts an `x-mythrun-dev-sub` header; no
 * real auth. `jwt` — the live path: a Bearer token read from secure storage.
 */
export type AuthHeaderOptions =
  | { mode: 'bypass'; devSub: string; secureStorage: SecureStorage }
  | { mode: 'jwt'; secureStorage: SecureStorage }

/**
 * Builds the per-request header producer for `ApiContext`. In `bypass` mode it
 * resolves the dev-sub header synchronously; in `jwt` mode it reads the token
 * from secure storage on every call, returning a Bearer header when a token is
 * present and an empty object before one has been acquired (MYT-84 fills
 * acquisition). Optional headers are conditionally built so no key is ever
 * present with an explicit `undefined` value (`exactOptionalPropertyTypes`).
 */
export function getAuthHeaders(opts: AuthHeaderOptions): () => Promise<Record<string, string>> {
  if (opts.mode === 'bypass') {
    const headers: Record<string, string> = { 'x-mythrun-dev-sub': opts.devSub }
    return () => Promise.resolve(headers)
  }
  const { secureStorage } = opts
  return async () => {
    const token = await secureStorage.get(AUTH_TOKEN_KEY)
    return token === null ? {} : { Authorization: `Bearer ${token}` }
  }
}
