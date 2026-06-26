// The client brain's single holder of the Cognito ACCESS token. In-memory only
// (module-scoped) — never localStorage/sessionStorage, so an XSS payload cannot
// exfiltrate it; it is lost on reload and re-acquired via the httpOnly refresh
// cookie (the on-load bootstrap calls runRefresh). The jwt `getAuthHeaders`
// reads getAccessToken(); `defineEndpoint`'s 401 retry awaits runRefresh().
//
// runRefresh is single-flight: ONE module-level promise coalesces concurrent
// 401s so N parallel calls trigger exactly one /api/auth/refresh round-trip. The
// refresh transport itself is INJECTED (configureTokenRefresh) so this module
// has no import of api/session.ts — keeping the import graph acyclic
// (endpoint.ts → token-manager.ts is the only edge).

/** Injected by the app bootstrap: performs the actual /api/auth/refresh call. */
type RefreshFn = () => Promise<{ accessToken: string; expiresIn: number }>

let accessToken: string | null = null
let accessTokenExpiresAtMs: number | null = null
let refreshFn: RefreshFn | null = null
let refreshPromise: Promise<boolean> | null = null

export function configureTokenRefresh(fn: RefreshFn): void {
  refreshFn = fn
}

export function getAccessToken(): string | null {
  return accessToken
}

export function getAccessTokenExpiresAtMs(): number | null {
  return accessTokenExpiresAtMs
}

export function setAccessToken(token: string, expiresIn: number): void {
  accessToken = token
  accessTokenExpiresAtMs = Date.now() + expiresIn * 1000
}

export function clearAccessToken(): void {
  accessToken = null
  accessTokenExpiresAtMs = null
}

async function performRefresh(): Promise<boolean> {
  if (refreshFn === null) {
    clearAccessToken()
    return false
  }
  try {
    const res = await refreshFn()
    setAccessToken(res.accessToken, res.expiresIn)
    return true
  } catch {
    clearAccessToken()
    return false
  }
}

/** Single-flight refresh. Concurrent callers share ONE in-flight promise; the
 *  shared promise is cleared on settle so the next 401 re-arms a fresh refresh. */
export function runRefresh(): Promise<boolean> {
  if (refreshPromise !== null) return refreshPromise
  const p = performRefresh().finally(() => {
    refreshPromise = null
  })
  refreshPromise = p
  return p
}

/** TEST-ONLY: reset module state between tests. Intentionally NOT exported from
 *  the client-core barrel (imported via the direct module path in tests). */
export function resetTokenManager(): void {
  accessToken = null
  accessTokenExpiresAtMs = null
  refreshFn = null
  refreshPromise = null
}
