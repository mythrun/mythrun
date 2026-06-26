# MYT-84 Auth Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the real OAuth→Cognito→JWT sign-in flow (in-memory access + httpOnly-cookie refresh) plus the onboarding moment, theme mode, and the two genesis-crown auth screens.

**Architecture:** BFF — the backend exchanges the OAuth code and sets the httpOnly refresh cookie; the SPA holds only an in-memory access token and refreshes through the backend. Frontend logic lives in DOM-free `@mythrun/client-core` (reaching the web through `platform/` ports); UI in `@mythrun/ui`; screens in `@mythrun/web`.

**Tech Stack:** Fastify + @fastify/cookie + aws-jwt-verify (Cognito) | React + Vite + Tailwind v4 + Zustand + TanStack Query | Vitest | pnpm.

## Global Constraints
- Core auth/security infra — NO shortcuts.
- Refresh token: httpOnly + Secure + SameSite=Lax + Path=/api/auth + host-only cookie `mythrun_refresh` (Max-Age 2592000). Access token IN-MEMORY only — never localStorage/sessionStorage. The SPA never persists the refresh token.
- `client-core` is DOM-free (R1): no window/document/localStorage/sessionStorage/location/navigator/EventSource — reach platform capability through a `platform/` port (secureStorage, OAuthStateStore, navigation). `src/routes/**` reach web globals only through `src/platform/web/*` carve-outs.
- `credentials:'include'` on the 3 auth fetches (createSession/refreshSession/logout); each also `skipAuthRetry`. CORS `credentials:true`, single origin = frontendBaseUrl.
- Auth endpoints are `config.auth:'public'` AND listed in `PUBLIC_ROUTE_ALLOWLIST`; `/api/auth/session` is application/json-only (415 otherwise); each is per-IP rate-limited. They mount in `authMode==='real'` only (dev/bypass 404s `/api/auth/*` by design).
- `redirect_uri` is derived server-side = `${frontendBaseUrl}/auth/callback`; the router collapses `/auth/callback/:provider` → bare `/auth/callback`.
- All Cognito OAuth calls go through one abstraction (`cognito-oauth-client.ts`); all DB access through the repository layer.
- TDD (failing test first); strict TS (no `any`/assertions); named exports; functions <50 lines; modules <400 lines; conventional commits.
- Frontend: ALL UI from `@mythrun/ui` (no ad-hoc UI); i18n only (no hardcoded strings — `[ph_*]` for prose, real values for generic chrome); responsive 375/1280; custom CSS uses semantic vars (`var(--ink)`/`var(--bg)`/`var(--surface)`), never `var(--color-*)` (the `@theme inline` freeze); theme via `.dark` on `<html>`; onboard input = `Input` size lg; provider buttons text-only (marks deferred).
- Cross-task shared files (land in task order; each edit additive/non-overlapping; controller commits serially): `frontend/src/app/providers.tsx`, `frontend/src/main.tsx`, `frontend/client-core/src/index.ts`.
- Implementers STAGE files but do NOT git add/commit/push — the controller commits each task after spec + code-quality review. All subagents Opus.
- The Miklos visual audit (BOTH light + dark) HOLDS the frontend push. The real Google + Discord E2E smoke against `staging.mythrun.com` (needs Task 1's `terraform apply` — a human gate) is the done-when.

---

### Task 1: Infra — staging Cognito callback/logout URLs (GAP-A) + refresh-rotation grace window (GAP-E)

A Terraform-only change: add the staging HTTPS callback/logout URLs to the Cognito app client (matched pair with the flow cluster's bare `/auth/callback` router edit), and widen the refresh-rotation retry grace window so a concurrent multi-tab refresh doesn't log the second tab out. **Applied by Miklos / the controller, not the implementer** — the implementer prepares + validates the change.

**Files**
- Modify: `infra/environments/staging/main.tf` (the `module "auth"` block — `callback_urls`, `logout_urls`)
- Modify: `infra/modules/auth/main.tf` (`refresh_token_rotation.retry_grace_period_seconds`)

**Interfaces**
- Consumes: nothing. Produces: the exact-match `redirect_uri` `https://staging.mythrun.com/auth/callback` that the backend derives server-side (`${frontendBaseUrl}/auth/callback`) and the SPA sends.

#### Steps

- [ ] **Step 1 — add the staging URLs.** In `infra/environments/staging/main.tf`, in the `module "auth"` block, replace the localhost-only lists with localhost + the staging HTTPS pair:

```hcl
  # MYT-84 GAP-A: localhost (dev) + the staging SPA. The callback URL must match
  # the SPA router's bare /auth/callback exactly (Cognito does exact-match on
  # redirect_uri) and the backend's server-derived `${frontendBaseUrl}/auth/callback`.
  # Production composition adds the production mythrun.com URLs on a separate client.
  callback_urls = [
    "http://localhost:5173/auth/callback",
    "https://staging.mythrun.com/auth/callback",
  ]
  logout_urls = [
    "http://localhost:5173",
    "https://staging.mythrun.com",
  ]
```

- [ ] **Step 2 — widen the rotation grace window.** In `infra/modules/auth/main.tf`, in the `refresh_token_rotation` block, change `retry_grace_period_seconds = 0` to `60` and update the comment:

```hcl
  # Refresh-token rotation per Auth spec §6.3 — each use mints a new refresh token
  # and invalidates the previous one. MYT-84 GAP-E: a 60s grace window absorbs the
  # multi-tab race (two tabs refreshing near-simultaneously would otherwise log the
  # second out — the prior token is invalidated the instant the first rotates).
  # An explicit non-zero value (not null) also avoids the provider plan/apply
  # consistency quirk where TF plans null but AWS returns 0.
  refresh_token_rotation {
    feature                    = "ENABLED"
    retry_grace_period_seconds = 60
  }
```

- [ ] **Step 3 — validate (the "tests" for this task; no unit test).** From `infra/environments/staging`:
  - `terraform fmt -check` (both files clean)
  - `terraform validate` (config valid)
  - `terraform plan` — expect an **in-place update** of `aws_cognito_user_pool_client.main` showing: `callback_urls`/`logout_urls` gaining the staging entries, and `refresh_token_rotation.retry_grace_period_seconds: 0 -> 60`. **No** resource replacement. Capture the plan output for the controller.

- [ ] **Step 4 — stage (do NOT apply).** Stage: `git add infra/environments/staging/main.tf infra/modules/auth/main.tf`. The controller / Miklos applies (`terraform apply`) — this is the human-action gate; the apply is a precondition for the real-OAuth E2E in §8/§10 (Task 14).

---

### Task 2: In-memory token manager + rewire the jwt `getAuthHeaders`

Builds the module-scoped access-token holder with a single-flight `runRefresh`, and repoints the jwt auth-header producer at it (dropping `secureStorage` from the jwt path). New `src/auth/**` logic joins the client-core 100% coverage gate.

**Files**
- Create: `frontend/client-core/src/auth/token-manager.ts`
- Create: `frontend/client-core/src/auth/token-manager.test.ts`
- Modify: `frontend/client-core/src/api/auth.ts` (jwt path reads `getAccessToken()`; drop `secureStorage`)
- Modify: `frontend/client-core/src/api/auth.test.ts` (jwt tests now drive the token manager)
- Modify: `frontend/client-core/src/app/providers.tsx` → **does not exist in client-core**; the file is `frontend/src/app/providers.tsx` (web shell). Modify `toAuthHeaderOptions` to stop forwarding `secureStorage`.
- Modify: `frontend/client-core/vitest.config.ts` (add `src/auth/**` to the coverage `include`)
- Modify: `frontend/client-core/src/index.ts` (export the token-manager surface)

**Interfaces**
- Produces (token-manager): `getAccessToken(): string|null`, `setAccessToken(token: string, expiresIn: number): void`, `getAccessTokenExpiresAtMs(): number|null`, `clearAccessToken(): void`, `runRefresh(): Promise<boolean>`, `configureTokenRefresh(fn: () => Promise<{ accessToken: string; expiresIn: number }>): void`, and a module-only `resetTokenManager(): void` (test isolation — **not** re-exported from the barrel).
- Produces (auth.ts): `AuthHeaderOptions = { mode: 'bypass'; devSub: string } | { mode: 'jwt' }` (secureStorage removed from BOTH variants — it is now unused by the auth path).
- Consumes: nothing app-level (the injected refresh fn is a structural type, so token-manager has **no** import of `api/session.ts` → no import cycle).

#### Steps

- [ ] **Step 1 — failing test: token manager basics + single-flight + getAuthHeaders rewire.** Create `frontend/client-core/src/auth/token-manager.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearAccessToken,
  configureTokenRefresh,
  getAccessToken,
  getAccessTokenExpiresAtMs,
  resetTokenManager,
  runRefresh,
  setAccessToken,
} from './token-manager.ts'

afterEach(() => {
  resetTokenManager()
  vi.restoreAllMocks()
})

describe('token-manager — in-memory access token', () => {
  it('holds and clears the token', () => {
    expect(getAccessToken()).toBeNull()
    setAccessToken('tok', 3600)
    expect(getAccessToken()).toBe('tok')
    clearAccessToken()
    expect(getAccessToken()).toBeNull()
    expect(getAccessTokenExpiresAtMs()).toBeNull()
  })

  it('records an expiry derived from expiresIn (seconds → ms-from-now)', () => {
    const now = 1_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    setAccessToken('tok', 60)
    expect(getAccessTokenExpiresAtMs()).toBe(now + 60_000)
  })
})

describe('token-manager — runRefresh single-flight', () => {
  it('returns false (and clears) when no refresh fn is configured', async () => {
    setAccessToken('stale', 3600)
    await expect(runRefresh()).resolves.toBe(false)
    expect(getAccessToken()).toBeNull()
  })

  it('coalesces concurrent refreshes into ONE call and stores the new token', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    configureTokenRefresh(async () => {
      calls += 1
      await gate
      return { accessToken: 'fresh', expiresIn: 3600 }
    })
    const a = runRefresh()
    const b = runRefresh()
    release()
    await expect(Promise.all([a, b])).resolves.toEqual([true, true])
    expect(calls).toBe(1)
    expect(getAccessToken()).toBe('fresh')
  })

  it('re-arms after the in-flight promise settles (a later refresh calls the fn again)', async () => {
    let calls = 0
    configureTokenRefresh(async () => {
      calls += 1
      return { accessToken: `t${String(calls)}`, expiresIn: 3600 }
    })
    await runRefresh()
    await runRefresh()
    expect(calls).toBe(2)
  })

  it('returns false and clears the token when the refresh fn rejects', async () => {
    setAccessToken('stale', 3600)
    configureTokenRefresh(() => Promise.reject(new Error('401')))
    await expect(runRefresh()).resolves.toBe(false)
    expect(getAccessToken()).toBeNull()
  })
})
```

Run (expect: cannot find module / red): `pnpm --filter @mythrun/client-core test src/auth/token-manager.test.ts`

- [ ] **Step 2 — implement `frontend/client-core/src/auth/token-manager.ts`:**

```ts
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
```

Run (expect: green): `pnpm --filter @mythrun/client-core test src/auth/token-manager.test.ts`

- [ ] **Step 3 — rewrite the jwt-mode tests in `frontend/client-core/src/api/auth.test.ts`** (the jwt path no longer reads `secureStorage`; it reads the token manager). Replace the WHOLE file:

```ts
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
```

Run (expect: red — auth.ts still requires secureStorage): `pnpm --filter @mythrun/client-core test src/api/auth.test.ts`

- [ ] **Step 4 — rewrite `frontend/client-core/src/api/auth.ts`:**

```ts
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
```

Run (expect: green): `pnpm --filter @mythrun/client-core test src/api/auth.test.ts`

- [ ] **Step 5 — update `frontend/src/app/providers.tsx`'s `toAuthHeaderOptions`** so it no longer forwards `secureStorage` (the jwt + bypass variants dropped it). Edit only that function:

```ts
/** Maps the flat app config to `getAuthHeaders`' discriminated-union options. */
function toAuthHeaderOptions(config: AppProvidersConfig): AuthHeaderOptions {
  if (config.authMode === 'bypass') {
    return { mode: 'bypass', devSub: config.devSub }
  }
  return { mode: 'jwt' }
}
```

> NOTE for the flow/UI tasks: `AppProvidersConfig` still carries `secureStorage` (shape in `main.tsx`); it is now **vestigial** for the auth path. Leave it untouched here (removing it ripples into `main.tsx`); flagged in the controller notes for a later cleanup.

- [ ] **Step 6 — add `src/auth/**` to the client-core coverage gate.** In `frontend/client-core/vitest.config.ts`, extend the `coverage.include` array:

```ts
      include: [
        'src/tokens/scales.ts',
        'src/api/**',
        'src/auth/**',
        'src/stores/**',
        'src/platform/**',
        'eslint-rules/**/*.js',
      ],
```

- [ ] **Step 7 — export the token-manager surface from the barrel.** In `frontend/client-core/src/index.ts`, after the `getAuthHeaders` export block, add:

```ts
// In-memory access-token manager (MYT-84). The jwt getAuthHeaders + the
// defineEndpoint 401-retry read this; the app bootstrap wires configureTokenRefresh.
export {
  getAccessToken,
  setAccessToken,
  clearAccessToken,
  getAccessTokenExpiresAtMs,
  runRefresh,
  configureTokenRefresh,
} from './auth/token-manager.ts'
```

- [ ] **Step 8 — verify + stage.** Run:
  - `pnpm --filter @mythrun/client-core typecheck`
  - `pnpm --filter @mythrun/client-core test`
  - `pnpm --filter @mythrun/client-core test:coverage` (expect 100% on `src/auth/token-manager.ts` + `src/api/auth.ts`)
  - `pnpm --filter @mythrun/web typecheck` (providers.tsx still compiles)

  Stage: `git add frontend/client-core/src/auth/token-manager.ts frontend/client-core/src/auth/token-manager.test.ts frontend/client-core/src/api/auth.ts frontend/client-core/src/api/auth.test.ts frontend/client-core/src/index.ts frontend/client-core/vitest.config.ts frontend/src/app/providers.tsx` — **do not commit; the controller commits.**

---

### Task 3: `defineEndpoint` transport — error `code`/`body`, `credentials`, `skipAuthRetry`, refresh-on-401 retry, 204; QueryClient 4xx-skip predicate

Adds the opt-in transport fields + the single-flight refresh-and-retry to the one network seam, surfaces the server error `code` (+ raw `body`) on `HttpError`, handles a 204 (no-body) response, and teaches the QueryClient retry predicate to leave `HttpError` 4xx un-retried (so the auth retry is the only retry).

**Files**
- Modify: `frontend/client-core/src/api/errors.ts` (`HttpError.code` + `HttpError.body`)
- Modify: `frontend/client-core/src/api/errors.test.ts`
- Modify: `frontend/client-core/src/api/endpoint.ts`
- Modify: `frontend/client-core/src/api/endpoint.test.ts`
- Modify: `frontend/src/app/providers.tsx` (QueryClient `retry` predicate)

**Interfaces**
- Produces: `HttpError(status, message, code?, body?)` with `readonly code?: string` (contract field) + `readonly body?: unknown` (**addition to the shared contract** — the raw parsed error payload, so callers needing `currentUsername` (§6 register taxonomy) can read them; see controller notes).
- Produces: `EndpointSpec` gains `credentials?: 'include'` and `skipAuthRetry?: boolean`.
- Consumes: `runRefresh` from `../auth/token-manager.ts` (Task 2). The edge `endpoint.ts → token-manager.ts` is the only value import; acyclic.

#### Steps

- [ ] **Step 1 — failing test: HttpError carries code + body.** Append to `frontend/client-core/src/api/errors.test.ts`:

```ts
import { HttpError } from './errors.ts'

describe('HttpError — code + body', () => {
  it('carries the parsed code + raw body when provided', () => {
    const e = new HttpError(409, 'Conflict', 'username_taken', { code: 'username_taken', suggestion: 'bob123' })
    expect(e.status).toBe(409)
    expect(e.code).toBe('username_taken')
    expect(e.body).toEqual({ code: 'username_taken', suggestion: 'bob123' })
  })

  it('leaves code/body undefined when omitted (back-compat 2-arg construction)', () => {
    const e = new HttpError(503, 'HTTP 503')
    expect(e.code).toBeUndefined()
    expect(e.body).toBeUndefined()
  })
})
```

> If `errors.test.ts` has no `describe` import/structure, add `import { describe, it, expect } from 'vitest'` at the top (match the existing file's imports — it currently imports the guards). Keep existing tests intact.

Run (expect: red): `pnpm --filter @mythrun/client-core test src/api/errors.test.ts`

- [ ] **Step 2 — extend `HttpError` in `frontend/client-core/src/api/errors.ts`:** replace the `HttpError` class:

```ts
/** A non-2xx HTTP response. Carries the status + (for typed error bodies) the
 *  server `code` and the raw parsed `body`. `code` is the contract-blessed
 *  discriminator (`{ code: '...' }`); `body` is the whole payload for richer
 *  taxonomies (e.g. register's `currentUsername`). Both are
 *  conditionally set so neither is ever present as an explicit `undefined`
 *  (exactOptionalPropertyTypes). */
export class HttpError extends Error {
  readonly status: number
  readonly code?: string
  readonly body?: unknown

  constructor(status: number, message: string, code?: string, body?: unknown) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    if (code !== undefined) this.code = code
    if (body !== undefined) this.body = body
  }
}
```

Run (expect: green): `pnpm --filter @mythrun/client-core test src/api/errors.test.ts`

- [ ] **Step 3 — failing tests: transport credentials, error code/body, 401 retry, skipAuthRetry, 204.** Append a new `describe` block to `frontend/client-core/src/api/endpoint.test.ts` (keep existing tests). Add these imports at the top of the file (next to the existing ones):

```ts
import {
  configureTokenRefresh,
  resetTokenManager,
  setAccessToken,
  getAccessToken,
} from '../auth/token-manager.ts'
import { HttpError } from './errors.ts'
```

Then append:

```ts
describe('defineEndpoint — MYT-84 transport', () => {
  afterEach(() => {
    resetTokenManager()
  })

  it('threads credentials:"include" into the request init', async () => {
    let seenCredentials: RequestCredentials | undefined
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      seenCredentials = (init as RequestInit | undefined)?.credentials
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    })
    const ep = defineEndpoint({
      method: 'POST',
      path: () => '/x',
      response: z.object({ ok: z.boolean() }),
      credentials: 'include',
      skipAuthRetry: true,
    })
    await ep(undefined, ctx)
    expect(seenCredentials).toBe('include')
    fetchSpy.mockRestore()
  })

  it('attaches the server `code` + raw `body` to HttpError on a typed 4xx', async () => {
    server.use(
      http.post(`${BASE_URL}/reg`, () =>
        HttpResponse.json({ code: 'username_taken', suggestion: 'bob123' }, { status: 409 }),
      ),
    )
    const ep = defineEndpoint({
      method: 'POST',
      path: () => '/reg',
      response: z.object({ ok: z.boolean() }),
      skipAuthRetry: true,
    })
    await expect(ep(undefined, ctx)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof HttpError &&
        e.status === 409 &&
        e.code === 'username_taken' &&
        (e.body as { suggestion?: string }).suggestion === 'bob123',
    )
  })

  it('leaves code undefined for a non-string code, an absent code, a non-object body, and a non-JSON body', async () => {
    const cases: { path: string; res: () => Response }[] = [
      { path: '/e1', res: () => HttpResponse.json({ code: 123 }, { status: 400 }) },
      { path: '/e2', res: () => HttpResponse.json({ message: 'x' }, { status: 400 }) },
      { path: '/e3', res: () => HttpResponse.json(42, { status: 400 }) },
      { path: '/e4', res: () => new HttpResponse('not json', { status: 500 }) },
    ]
    for (const c of cases) {
      server.use(http.post(`${BASE_URL}${c.path}`, c.res))
      const ep = defineEndpoint({
        method: 'POST',
        path: () => c.path,
        response: z.object({ ok: z.boolean() }),
        skipAuthRetry: true,
      })
      await expect(ep(undefined, ctx)).rejects.toSatisfy(
        (e: unknown) => e instanceof HttpError && e.code === undefined,
      )
    }
  })

  it('on a 401 (non-skip): refreshes, rebuilds the init with a FRESH Bearer, retries once → resolves', async () => {
    const seenAuth: (string | null)[] = []
    let call = 0
    server.use(
      http.get(`${BASE_URL}/guarded`, ({ request }) => {
        seenAuth.push(request.headers.get('authorization'))
        call += 1
        return call === 1
          ? HttpResponse.json({ code: 'unauthenticated' }, { status: 401 })
          : HttpResponse.json({ ok: true })
      }),
    )
    configureTokenRefresh(() => Promise.resolve({ accessToken: 'fresh', expiresIn: 3600 }))
    const refreshCtx: ApiContext = {
      baseUrl: BASE_URL,
      getAuthHeaders: () => {
        const t = getAccessToken()
        return Promise.resolve(t === null ? {} : { authorization: `Bearer ${t}` })
      },
    }
    const ep = defineEndpoint({
      method: 'GET',
      path: () => '/guarded',
      response: z.object({ ok: z.boolean() }),
    })
    await expect(ep(undefined, refreshCtx)).resolves.toEqual({ ok: true })
    expect(seenAuth[0]).toBeNull()
    expect(seenAuth[1]).toBe('Bearer fresh')
  })

  it('on a 401 (non-skip) where refresh FAILS: does not retry, throws the 401', async () => {
    let calls = 0
    server.use(
      http.get(`${BASE_URL}/guarded2`, () => {
        calls += 1
        return HttpResponse.json({ code: 'unauthenticated' }, { status: 401 })
      }),
    )
    configureTokenRefresh(() => Promise.reject(new Error('no cookie')))
    const ep = defineEndpoint({
      method: 'GET',
      path: () => '/guarded2',
      response: z.object({ ok: z.boolean() }),
    })
    await expect(ep(undefined, ctx)).rejects.toSatisfy(
      (e: unknown) => e instanceof HttpError && e.status === 401,
    )
    expect(calls).toBe(1)
  })

  it('on a 401 from a skipAuthRetry endpoint: never refreshes, throws immediately', async () => {
    let refreshCalls = 0
    server.use(
      http.post(`${BASE_URL}/auth/refresh`, () =>
        HttpResponse.json({ code: 'no_refresh_token' }, { status: 401 }),
      ),
    )
    configureTokenRefresh(() => {
      refreshCalls += 1
      return Promise.resolve({ accessToken: 'x', expiresIn: 1 })
    })
    const ep = defineEndpoint({
      method: 'POST',
      path: () => '/auth/refresh',
      response: z.object({ ok: z.boolean() }),
      credentials: 'include',
      skipAuthRetry: true,
    })
    await expect(ep(undefined, ctx)).rejects.toSatisfy(
      (e: unknown) => e instanceof HttpError && e.status === 401,
    )
    expect(refreshCalls).toBe(0)
  })

  it('resolves void on a 204 (no body) response', async () => {
    server.use(http.post(`${BASE_URL}/logout`, () => new HttpResponse(null, { status: 204 })))
    const ep = defineEndpoint<void>({
      method: 'POST',
      path: () => '/logout',
      response: z.void(),
      credentials: 'include',
      skipAuthRetry: true,
    })
    await expect(ep(undefined, ctx)).resolves.toBeUndefined()
  })
})
```

> `setAccessToken` is imported but may be unused depending on which assertions you keep — drop the import if lint flags it. The `ctx` + `BASE_URL` + msw `server` are already defined at the top of the existing file.

Run (expect: red): `pnpm --filter @mythrun/client-core test src/api/endpoint.test.ts`

- [ ] **Step 4 — rewrite `frontend/client-core/src/api/endpoint.ts`:**

```ts
import type { ZodType } from 'zod'
import { ContractValidationError, HttpError, NetworkError } from './errors.ts'
import { runRefresh } from '../auth/token-manager.ts'

// `defineEndpoint` is the load-bearing primitive of the client brain: the ONLY
// sanctioned way the app reaches the backend. Every endpoint is declared with a
// method, a typed path builder, and Zod request/response schemas — contract
// conformance is structural, not a convention.
//
// MYT-84 adds the cookie-auth seam: `credentials:'include'` (threaded into the
// fetch init) + `skipAuthRetry` (the auth endpoints exempt themselves from the
// 401 refresh), and the refresh-on-401 retry itself — which lives HERE because
// it observes the RESPONSE status, which `getAuthHeaders` cannot.

/** Per-call ambient state: where the backend lives + how to authenticate. */
export interface ApiContext {
  baseUrl: string
  getAuthHeaders: () => Promise<Record<string, string>>
}

/**
 * A declarative endpoint. `In` is the caller-supplied input (defaults to `void`);
 * `Res` is the validated response type.
 */
export interface EndpointSpec<Res, In> {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** Builds the path (appended to `ctx.baseUrl`) from the typed input. */
  path: (input: In) => string
  /** Optional request-body schema. When present, the input is validated + sent as JSON. */
  request?: ZodType
  /** Required response schema. The parsed body is what the caller receives. */
  response: ZodType<Res>
  /** When set, threaded into the fetch RequestInit (the cookie-bearing auth calls). */
  credentials?: 'include'
  /** When true, a 401 is NOT retried via the single-flight refresh. The auth
   *  endpoints (session/refresh/logout) MUST set this — else a failed refresh
   *  would recurse through the refresh call itself. */
  skipAuthRetry?: boolean
}

async function buildInit<Res, In>(
  spec: EndpointSpec<Res, In>,
  input: In,
  ctx: ApiContext,
): Promise<RequestInit> {
  const headers = await ctx.getAuthHeaders()
  const base: RequestInit = { method: spec.method, headers }
  if (spec.credentials !== undefined) base.credentials = spec.credentials
  if (spec.request === undefined) return base
  const validated = spec.request.safeParse(input)
  if (!validated.success) {
    throw new ContractValidationError('request did not match contract', validated.error)
  }
  return {
    ...base,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(validated.data),
  }
}

/** Performs the transport, normalising any thrown/rejected fetch to `NetworkError`. */
async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (cause) {
    throw new NetworkError(cause instanceof Error ? cause.message : 'request failed')
  }
}

/** Reads the typed `code` (+ raw body) off a non-2xx response. Never throws — a
 *  non-JSON / empty error body yields `{}` so the HttpError still carries status. */
async function readErrorPayload(res: Response): Promise<{ code?: string; body?: unknown }> {
  try {
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null && 'code' in body) {
      const code = (body as { code?: unknown }).code
      return typeof code === 'string' ? { body, code } : { body }
    }
    return { body }
  } catch {
    return {}
  }
}

function parseResponse<Res>(response: ZodType<Res>, json: unknown): Res {
  const parsed = response.safeParse(json)
  if (!parsed.success) {
    throw new ContractValidationError('response did not match contract', parsed.error)
  }
  return parsed.data
}

/**
 * Compiles an `EndpointSpec` into a caller `(input, ctx) => Promise<Res>`.
 */
export function defineEndpoint<Res, In = void>(
  spec: EndpointSpec<Res, In>,
): (input: In, ctx: ApiContext) => Promise<Res> {
  return async (input, ctx) => {
    const url = ctx.baseUrl + spec.path(input)
    let res = await send(url, await buildInit(spec, input, ctx))
    if (res.status === 401 && spec.skipAuthRetry !== true && (await runRefresh())) {
      // Refresh succeeded → rebuild the init so getAuthHeaders re-reads the
      // FRESH access token (a stale init would resend the dead Bearer), retry once.
      res = await send(url, await buildInit(spec, input, ctx))
    }
    if (!res.ok) {
      const { code, body } = await readErrorPayload(res)
      throw new HttpError(res.status, res.statusText || `HTTP ${String(res.status)}`, code, body)
    }
    if (res.status === 204) return parseResponse(spec.response, undefined)
    return parseResponse(spec.response, await res.json())
  }
}
```

Run (expect: green): `pnpm --filter @mythrun/client-core test src/api/endpoint.test.ts`

- [ ] **Step 5 — QueryClient 4xx-skip predicate in `frontend/src/app/providers.tsx`.** Add `isHttpError` to the `@mythrun/client-core` import, and replace the `defaultOptions` queries config:

```ts
      new QueryClient({
        defaultOptions: {
          queries: {
            // A 4xx is the server's terminal answer — never retry it (the only
            // legitimate retry is the auth refresh, which defineEndpoint owns).
            // Other failures (network blips, 5xx) keep the single retry.
            retry: (failureCount, error) => {
              if (isHttpError(error) && error.status >= 400 && error.status < 500) return false
              return failureCount < 1
            },
            refetchOnWindowFocus: false,
          },
        },
      }),
```

- [ ] **Step 6 — verify + stage.** Run:
  - `pnpm --filter @mythrun/client-core typecheck`
  - `pnpm --filter @mythrun/client-core test`
  - `pnpm --filter @mythrun/client-core test:coverage` (100% on `endpoint.ts` + `errors.ts`)
  - `pnpm --filter @mythrun/web typecheck`

  Stage: `git add frontend/client-core/src/api/errors.ts frontend/client-core/src/api/errors.test.ts frontend/client-core/src/api/endpoint.ts frontend/client-core/src/api/endpoint.test.ts frontend/src/app/providers.tsx` — do not commit.

---

### Task 4: Contract schemas + client-core endpoints (register / checkUsername / createSession / refreshSession / logout) + refresh wiring

Adds the four contract schemas (+ a `SessionRequestSchema` the body needs) and the five client-core endpoints, then wires the token manager's `configureTokenRefresh` to the real `refreshSession` call.

**Files**
- Create: `frontend/contract/src/rest/auth.ts`
- Modify: `frontend/contract/src/rest/users.ts` (export `USERNAME_REGEX`; add register/check schemas; share a `PublicUserSchema`)
- Modify: `frontend/contract/src/rest/index.ts` (barrel: `export * from './auth.js'`)
- Modify: `frontend/contract/src/__tests__/rest.test.ts` (accept/reject tests for the new schemas)
- Modify: `frontend/client-core/src/api/users.ts` (add `register`, `checkUsername`)
- Create: `frontend/client-core/src/api/session.ts` (`createSession`, `refreshSession`, `logout`)
- Create: `frontend/client-core/src/api/session.test.ts`
- Modify: `frontend/client-core/src/api/users.test.tsx` (add register/checkUsername definition tests)
- Modify: `frontend/client-core/src/index.ts` (export the new endpoints + re-export the new contract types)
- Modify: `frontend/src/app/providers.tsx` (`configureTokenRefresh` wiring)

**Interfaces (exact)**
- Contract: `USERNAME_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9_]{1,18}[a-zA-Z0-9])?$/`; `RegisterRequestSchema = { username: string().min(3).max(20).regex(USERNAME_REGEX), displayName: string().min(1).max(40) }`; `RegisterResponseSchema = { user: PublicUserSchema, created: boolean }`; `CheckUsernameResponseSchema = { available: boolean, reason?: string }`; `SessionRequestSchema = { code: string().min(1), codeVerifier: string().min(1) }`; `SessionResponseSchema = { accessToken: string, expiresIn: int>0, name: string|null }`; `RefreshResponseSchema = { accessToken: string, expiresIn: int>0 }`.
- client-core endpoints: `register(RegisterRequest, ctx) → Promise<RegisterResponse>` (normal jwt path, retry-eligible); `checkUsername(username: string, ctx) → Promise<CheckUsernameResponse>`; `createSession({code, codeVerifier}, ctx) → Promise<SessionResponse>` (`credentials:'include'`, `skipAuthRetry`); `refreshSession(void, ctx) → Promise<RefreshResponse>` (same); `logout(void, ctx) → Promise<void>` (same, 204).

> **Real backend shapes confirmed by reading the routes** (`backend/src/routes/users.ts`):
> - `POST /api/users/register` success body is `{ user: <public projection>, created: boolean }` (201 created=true; 200 already_onboarded_same created=false). Task 6 narrows the backend response to the SAME public projection `/me` uses, so the row no longer leaks `cognitoSub/stripeCustomerId/suspendedAt/updatedAt`. `RegisterResponseSchema` models the **public projection** (`PublicUserSchema`); Zod's default object parse stripping the same four fields is now defense-in-depth on both ends (the leak is fixed server-side in Task 6).
> - `GET /api/users/check-username` body is `{ available: boolean }` or `{ available: boolean, reason: string }` (`reason ∈ format|taken|<profanity reason>`). `CheckUsernameResponseSchema` mirrors that exactly (NO `suggestion`).

#### Steps

- [ ] **Step 1 — failing contract tests.** Append to `frontend/contract/src/__tests__/rest.test.ts`. Extend the top import to also pull the new symbols from `../rest/index.js`:

```ts
import {
  RegisterRequestSchema,
  RegisterResponseSchema,
  CheckUsernameResponseSchema,
  SessionRequestSchema,
  SessionResponseSchema,
  RefreshResponseSchema,
  USERNAME_REGEX,
} from '../rest/index.js'
```

Then append:

```ts
describe('RegisterRequestSchema', () => {
  it('accepts a regex-valid username + 1..40 display name', () => {
    const ok = RegisterRequestSchema.parse({ username: 'bob_the_brave', displayName: 'Bob' })
    expect(ok.username).toBe('bob_the_brave')
  })
  it('rejects a length-2, a leading underscore, and an over-20 username', () => {
    for (const u of ['ab', '_bob', 'a'.repeat(21)]) {
      expect(() => RegisterRequestSchema.parse({ username: u, displayName: 'X' })).toThrow()
    }
  })
  it('rejects an empty and an over-40 display name', () => {
    expect(() => RegisterRequestSchema.parse({ username: 'bobby', displayName: '' })).toThrow()
    expect(() => RegisterRequestSchema.parse({ username: 'bobby', displayName: 'x'.repeat(41) })).toThrow()
  })
  it('exports the canonical USERNAME_REGEX', () => {
    expect(USERNAME_REGEX.test('bob')).toBe(true)
    expect(USERNAME_REGEX.test('_bob')).toBe(false)
  })
})

describe('RegisterResponseSchema', () => {
  it('parses { user (public projection), created } and strips leaked row fields', () => {
    const parsed = RegisterResponseSchema.parse({
      user: {
        id: 'u', username: 'a', displayName: 'A', freeTrialUsed: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        cognitoSub: 'leak', stripeCustomerId: 'leak', suspendedAt: null, updatedAt: '2026-01-01T00:00:00.000Z',
      },
      created: true,
    })
    expect(parsed.created).toBe(true)
    expect(parsed.user).not.toHaveProperty('cognitoSub')
    expect(parsed.user).not.toHaveProperty('stripeCustomerId')
  })
})

describe('CheckUsernameResponseSchema', () => {
  it('parses available with and without a reason', () => {
    expect(CheckUsernameResponseSchema.parse({ available: true }).available).toBe(true)
    expect(CheckUsernameResponseSchema.parse({ available: false, reason: 'taken' }).reason).toBe('taken')
  })
  it('rejects a non-boolean available', () => {
    expect(() => CheckUsernameResponseSchema.parse({ available: 'yes' })).toThrow()
  })
})

describe('SessionRequestSchema / SessionResponseSchema / RefreshResponseSchema', () => {
  it('SessionRequest requires non-empty code + codeVerifier', () => {
    expect(SessionRequestSchema.parse({ code: 'c', codeVerifier: 'v' }).code).toBe('c')
    expect(() => SessionRequestSchema.parse({ code: '', codeVerifier: 'v' })).toThrow()
  })
  it('SessionResponse accepts a string OR null name + positive int expiresIn', () => {
    expect(SessionResponseSchema.parse({ accessToken: 't', expiresIn: 3600, name: 'Ada' }).name).toBe('Ada')
    expect(SessionResponseSchema.parse({ accessToken: 't', expiresIn: 3600, name: null }).name).toBeNull()
    expect(() => SessionResponseSchema.parse({ accessToken: 't', expiresIn: 0, name: null })).toThrow()
    expect(() => SessionResponseSchema.parse({ accessToken: 't', expiresIn: 1.5, name: null })).toThrow()
  })
  it('RefreshResponse accepts { accessToken, expiresIn }', () => {
    expect(RefreshResponseSchema.parse({ accessToken: 't', expiresIn: 60 }).expiresIn).toBe(60)
  })
})
```

Run (expect: red): `pnpm --filter @mythrun/contract test`

- [ ] **Step 2 — rewrite `frontend/contract/src/rest/users.ts`** (export `USERNAME_REGEX`, share `PublicUserSchema`, add register + check schemas; `MeResponseSchema` behavior unchanged):

```ts
// REST contract for the user-scoped endpoints.
//
//  1. WIRE shape ≠ domain type. The backend `User.createdAt` is a `Date`, but it
//     serializes to an ISO-8601 string over JSON, so `createdAt` is
//     `z.iso.datetime()` (a string validator), NEVER `z.date()`.
//  2. Public projection. `PublicUserSchema` carries only the wire-safe fields
//     (`cognitoSub/stripeCustomerId/suspendedAt/updatedAt` are stripped by Zod's
//     default object parse). `/me` returns this shape; `register` also returns this
//     shape (Task 6 narrows the backend), and the client validates against this
//     projection so a leaked field is stripped client-side too.
import { z } from 'zod'

/** 3–20 chars; alphanumeric + underscore; first/last char alphanumeric; no
 *  length-2. Canonical mirror of the backend regex in routes/users.ts. */
export const USERNAME_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9_]{1,18}[a-zA-Z0-9])?$/

const PublicUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  freeTrialUsed: z.boolean(),
  createdAt: z.iso.datetime(),
})

export const MeResponseSchema = z.object({ user: PublicUserSchema })
export type MeResponse = z.infer<typeof MeResponseSchema>

/** Structure-only mirror of the backend register body (length + regex; profanity
 *  is a server-only gate). The frontend derives a valid-by-construction handle
 *  (§6), so a local rejection here is rare — the contract still encodes it. */
export const RegisterRequestSchema = z.object({
  username: z.string().min(3).max(20).regex(USERNAME_REGEX),
  displayName: z.string().min(1).max(40),
})
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>

export const RegisterResponseSchema = z.object({
  user: PublicUserSchema,
  created: z.boolean(),
})
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>

export const CheckUsernameResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
})
export type CheckUsernameResponse = z.infer<typeof CheckUsernameResponseSchema>
```

- [ ] **Step 3 — create `frontend/contract/src/rest/auth.ts`:**

```ts
// REST contract for the BFF session endpoints (MYT-84). The SPA hands the
// backend only { code, codeVerifier } and receives only the access token + the
// pre-fill `name`; the refresh token never enters JS (httpOnly cookie).
import { z } from 'zod'

export const SessionRequestSchema = z.object({
  code: z.string().min(1),
  codeVerifier: z.string().min(1),
})
export type SessionRequest = z.infer<typeof SessionRequestSchema>

export const SessionResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  /** Parsed backend-side from the id_token `name` claim; null when absent. */
  name: z.string().nullable(),
})
export type SessionResponse = z.infer<typeof SessionResponseSchema>

export const RefreshResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
})
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>
```

- [ ] **Step 4 — add the auth barrel export.** In `frontend/contract/src/rest/index.ts`, add the line:

```ts
export * from './auth.js'
```

Run (expect: green): `pnpm --filter @mythrun/contract test && pnpm --filter @mythrun/contract typecheck`

- [ ] **Step 5 — failing client-core endpoint tests.** Create `frontend/client-core/src/api/session.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { createSession, refreshSession, logout } from './session.ts'
import type { ApiContext } from './endpoint.ts'

const BASE_URL = 'http://api.test'
const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const ctx: ApiContext = { baseUrl: BASE_URL, getAuthHeaders: () => Promise.resolve({}) }

describe('createSession', () => {
  it('POSTs { code, codeVerifier } with credentials:include and returns the session', async () => {
    let seenCredentials: string | undefined
    let seenBody: unknown
    server.use(
      http.post(`${BASE_URL}/api/auth/session`, async ({ request }) => {
        seenCredentials = request.credentials
        seenBody = await request.json()
        return HttpResponse.json({ accessToken: 'a', expiresIn: 3600, name: 'Ada' })
      }),
    )
    const res = await createSession({ code: 'c', codeVerifier: 'v' }, ctx)
    expect(res).toEqual({ accessToken: 'a', expiresIn: 3600, name: 'Ada' })
    expect(seenBody).toEqual({ code: 'c', codeVerifier: 'v' })
    expect(seenCredentials).toBe('include')
  })
})

describe('refreshSession', () => {
  it('POSTs /api/auth/refresh (no body) and returns the rotated access token', async () => {
    server.use(
      http.post(`${BASE_URL}/api/auth/refresh`, () =>
        HttpResponse.json({ accessToken: 'fresh', expiresIn: 3600 }),
      ),
    )
    await expect(refreshSession(undefined, ctx)).resolves.toEqual({ accessToken: 'fresh', expiresIn: 3600 })
  })
})

describe('logout', () => {
  it('POSTs /api/auth/logout and resolves void on 204', async () => {
    server.use(http.post(`${BASE_URL}/api/auth/logout`, () => new HttpResponse(null, { status: 204 })))
    await expect(logout(undefined, ctx)).resolves.toBeUndefined()
  })
})
```

Add register/checkUsername definition tests to `frontend/client-core/src/api/users.test.tsx` (a `describe` near the existing getMe tests — mirror the file's msw setup; if it has its own server, reuse it):

```ts
describe('register / checkUsername endpoints', () => {
  it('register POSTs the validated body and returns the parsed RegisterResponse', async () => {
    server.use(
      http.post(`${BASE_URL}/api/users/register`, () =>
        HttpResponse.json({
          user: { id: 'u', username: 'bob', displayName: 'Bob', freeTrialUsed: true, createdAt: '2026-01-01T00:00:00.000Z' },
          created: true,
        }, { status: 201 }),
      ),
    )
    const res = await register({ username: 'bob', displayName: 'Bob' }, ctx)
    expect(res.created).toBe(true)
    expect(res.user.username).toBe('bob')
  })

  it('checkUsername encodes the username into the query and returns availability', async () => {
    let seenUrl = ''
    server.use(
      http.get(`${BASE_URL}/api/users/check-username`, ({ request }) => {
        seenUrl = request.url
        return HttpResponse.json({ available: false, reason: 'taken' })
      }),
    )
    const res = await checkUsername('bo b', ctx)
    expect(res).toEqual({ available: false, reason: 'taken' })
    expect(seenUrl).toContain('username=bo%20b')
  })
})
```

> `register`, `checkUsername`, `BASE_URL`, `ctx`, `server`, `http`, `HttpResponse` must be imported in `users.test.tsx` (add `register, checkUsername` to the `./users.ts` import; the file already wires msw for `getMe` — reuse it).

Run (expect: red — modules/exports missing): `pnpm --filter @mythrun/client-core test src/api/session.test.ts src/api/users.test.tsx`

- [ ] **Step 6 — add `register` + `checkUsername` to `frontend/client-core/src/api/users.ts`.** Extend the contract import and append the two endpoints (keep `getMe`/`useMe`):

```ts
import { useSuspenseQuery } from '@tanstack/react-query'
import {
  MeResponseSchema,
  type MeResponse,
  RegisterRequestSchema,
  RegisterResponseSchema,
  type RegisterRequest,
  type RegisterResponse,
  CheckUsernameResponseSchema,
  type CheckUsernameResponse,
} from '@mythrun/contract/rest'
import { defineEndpoint } from './endpoint.ts'
import { useApiContext } from './client-context.tsx'

// ... getMe + useMe unchanged ...

/** POST /api/users/register — first-login onboarding. Normal jwt path (Bearer +
 *  401-refresh retry); the auth endpoints are the only `skipAuthRetry` ones. */
export const register = defineEndpoint<RegisterResponse, RegisterRequest>({
  method: 'POST',
  path: () => '/api/users/register',
  request: RegisterRequestSchema,
  response: RegisterResponseSchema,
})

/** GET /api/users/check-username — advisory availability probe. */
export const checkUsername = defineEndpoint<CheckUsernameResponse, string>({
  method: 'GET',
  path: (username) => `/api/users/check-username?username=${encodeURIComponent(username)}`,
  response: CheckUsernameResponseSchema,
})
```

- [ ] **Step 7 — create `frontend/client-core/src/api/session.ts`:**

```ts
import { z } from 'zod'
import {
  SessionRequestSchema,
  SessionResponseSchema,
  RefreshResponseSchema,
  type SessionRequest,
  type SessionResponse,
  type RefreshResponse,
} from '@mythrun/contract/rest'
import { defineEndpoint } from './endpoint.ts'

// The BFF session endpoints. All three send `credentials:'include'` (the
// cross-origin half of the httpOnly-refresh-cookie model) and `skipAuthRetry`
// (they are the refresh path — a 401 here must NOT recurse into another refresh).

export const createSession = defineEndpoint<SessionResponse, SessionRequest>({
  method: 'POST',
  path: () => '/api/auth/session',
  request: SessionRequestSchema,
  response: SessionResponseSchema,
  credentials: 'include',
  skipAuthRetry: true,
})

export const refreshSession = defineEndpoint<RefreshResponse>({
  method: 'POST',
  path: () => '/api/auth/refresh',
  response: RefreshResponseSchema,
  credentials: 'include',
  skipAuthRetry: true,
})

export const logout = defineEndpoint<void>({
  method: 'POST',
  path: () => '/api/auth/logout',
  response: z.void(),
  credentials: 'include',
  skipAuthRetry: true,
})
```

Run (expect: green): `pnpm --filter @mythrun/client-core test src/api/session.test.ts src/api/users.test.tsx`

- [ ] **Step 8 — barrel exports.** In `frontend/client-core/src/index.ts`: extend the existing users export to include `register, checkUsername`; add the session endpoints; re-export the new contract types:

```ts
export { getMe, useMe, register, checkUsername } from './api/users.ts'
export { createSession, refreshSession, logout } from './api/session.ts'
```

and add to the contract-types re-export block:

```ts
export type {
  RegisterRequest,
  RegisterResponse,
  CheckUsernameResponse,
  SessionRequest,
  SessionResponse,
  RefreshResponse,
} from '@mythrun/contract/rest'
```

- [ ] **Step 9 — wire `configureTokenRefresh` in `frontend/src/app/providers.tsx`.** Import `useEffect` from `react`, and add `configureTokenRefresh, refreshSession` to the `@mythrun/client-core` import. After the `apiContext` `useMemo`, add an effect:

```ts
  // Wire the token manager's single-flight refresh to the real /api/auth/refresh
  // call (bound to the resolved ApiContext). defineEndpoint's 401 retry + the
  // on-load bootstrap both reach this via runRefresh(). Dormant in bypass mode
  // (bypass never 401s through the refresh path).
  useEffect(() => {
    configureTokenRefresh(() => refreshSession(undefined, apiContext))
  }, [apiContext])
```

> Edits a DIFFERENT region of `providers.tsx` than Task 3 (the QueryClient predicate) and Task 2 (`toAuthHeaderOptions`) — apply Task 2 → Task 3 → Task 4 in order; the three edits are non-overlapping.

- [ ] **Step 10 — verify + stage.** Run:
  - `pnpm --filter @mythrun/contract test && pnpm --filter @mythrun/contract typecheck`
  - `pnpm --filter @mythrun/client-core typecheck && pnpm --filter @mythrun/client-core test && pnpm --filter @mythrun/client-core test:coverage`
  - `pnpm --filter @mythrun/web typecheck`

  Stage: `git add frontend/contract/src/rest/auth.ts frontend/contract/src/rest/users.ts frontend/contract/src/rest/index.ts frontend/contract/src/__tests__/rest.test.ts frontend/client-core/src/api/users.ts frontend/client-core/src/api/session.ts frontend/client-core/src/api/session.test.ts frontend/client-core/src/api/users.test.tsx frontend/client-core/src/index.ts frontend/src/app/providers.tsx` — do not commit.

---

### Task 5: OAuth / PKCE helper (`client-core/src/auth/oauth.ts`) — canonical API + injected `OAuthStateStore` port + Cognito config wiring

Pure helpers the sign-in + callback screens consume, exposing the **CANONICAL oauth API** (the cross-cluster contract Tasks 11 + 12 are aligned to): `createPkce`, `isLocalPath`, `configureOAuth`, `createAuthState`, `buildAuthorizeUrl`, `parseCallback` (parse-only), `consumeAuthState` (single-use take). **State/verifier persistence is an INJECTED platform port — NOT `sessionStorage` directly** (R1/R2): `client-core` stays DOM-free; the web realization (sessionStorage-backed) lands in `@mythrun/web` under `src/platform/web/**` (the sanctioned web-globals carve-out). The Cognito Hosted UI config (domain/clientId/redirectUri/scopes) + the store are BOTH wired ONCE at boot via `configureOAuth({store, cognito})` in `main.tsx` (web layer — `window` allowed). `createPkce` may use the `crypto` global (NOT restricted).

**Files**
- Create: `frontend/client-core/src/platform/oauth-state-store.ts` (the `OAuthStateStore` interface)
- Create: `frontend/client-core/src/auth/oauth.ts`
- Create: `frontend/client-core/src/auth/oauth.test.ts`
- Create: `frontend/src/platform/web/oauth-state-store.ts` (web impl — sessionStorage)
- Create: `frontend/src/platform/web/oauth-state-store.test.ts`
- Modify: `frontend/client-core/src/index.ts` (export the helper surface + `configureOAuth` + the `OAuthStateStore` type)
- Modify: `frontend/src/main.tsx` (construct the web store + Cognito config; call `configureOAuth(...)` at boot — jwt branch)
- Modify: `frontend/.env.development` + `.github/workflows/deploy-frontend.yml` (the two PUBLIC `VITE_COGNITO_*` build vars) + `frontend/src/vite-env.d.ts` (the `ImportMetaEnv` types, if declared)

> Coverage: `src/auth/**` AND `src/platform/**` are in the client-core gate (Task 2 step 6) — land Task 2 first. `frontend/src/platform/web/**` is in the `@mythrun/web` gate. Both impls are 100%-gated; the tests below cover every branch.

**Interfaces (exact — the CANONICAL oauth API; Tasks 11 + 12 consume it)**
- `type OAuthProvider = 'google' | 'discord'` (lowercase; mapped to Cognito's `Google`/`Discord` casing INSIDE `buildAuthorizeUrl`).
- `interface PkcePair { verifier: string; challenge: string }`
- `interface AuthStateData { provider: OAuthProvider; returnTo: string | null; verifier: string }`
- `interface OAuthStateStore { set(state: string, payload: AuthStateData): void; take(state: string): AuthStateData | null }` — `take` is a single-use read+delete; the port OWNS persistence (corrupt-payload→null handling lives in the web impl).
- `interface OAuthCognitoConfig { domain: string; clientId: string; redirectUri: string; scopes: string[] }`
- `configureOAuth(config: { store: OAuthStateStore; cognito: OAuthCognitoConfig }): void` — configure-once at boot (holds BOTH the store + the Cognito Hosted UI config).
- `createPkce(): Promise<PkcePair>` — CSPRNG verifier (32 bytes → base64url, ≥128 bits) + S256 challenge via `crypto.subtle`.
- `isLocalPath(returnTo: string | null | undefined): boolean` — pure; leading single `/`, reject `//`, `/\`, any `scheme:`; null/undefined → false.
- `createAuthState({ provider: OAuthProvider; returnTo: string | null }): Promise<{ state: string; challenge: string }>` — validate `returnTo` (`isLocalPath` else null), gen PKCE + a CSPRNG `state`, persist `{provider, returnTo, verifier}` to the configured store keyed by `state`, return `{state, challenge}`.
- `buildAuthorizeUrl({ provider: OAuthProvider; state: string; challenge: string }): string` — from the configured Cognito config; maps lowercase provider → Cognito casing.
- `parseCallback(search: string): { code: string; state: string } | { error: string }` — parse ONLY; does NOT consume the store.
- `consumeAuthState(state: string): AuthStateData | null` — single-use take from the configured store.

> The screens apply the `isLocalPath` fallback-to-root before navigation: sign-in seeds `returnTo` from `?returnTo`; the callback re-validates `ctx.returnTo` after `consumeAuthState`. `oauth.ts` carries no route literals.

#### Steps

- [ ] **Step 1 — failing tests for the helper.** Create `frontend/client-core/src/auth/oauth.test.ts` (state persists through an INJECTED in-memory store + the Cognito config is injected; the web impl + its corrupt-JSON branch are tested separately in `@mythrun/web`):

```ts
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  buildAuthorizeUrl,
  configureOAuth,
  consumeAuthState,
  createAuthState,
  createPkce,
  isLocalPath,
  parseCallback,
  resetOAuthConfig,
} from './oauth.ts'
import type { AuthStateData } from './oauth.ts'
import type { OAuthStateStore } from '../platform/oauth-state-store.ts'

// jsdom does not implement crypto.subtle; ensure the Web Crypto API is present
// (Node's webcrypto) so createPkce's S256 digest works in the test env.
beforeAll(async () => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = await import('node:crypto')
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  }
})

// An in-memory OAuthStateStore — the helper is DOM-free (R1) and reaches
// persistence only through this injected port (R2). single-use is the Map delete.
function createMemoryStore(): OAuthStateStore {
  const map = new Map<string, AuthStateData>()
  return {
    set: (state, payload) => {
      map.set(state, payload)
    },
    take: (state) => {
      const v = map.get(state) ?? null
      map.delete(state)
      return v
    },
  }
}

const COGNITO = {
  domain: 'mythrun-staging.auth.us-east-1.amazoncognito.com',
  clientId: 'client123',
  redirectUri: 'https://staging.mythrun.com/auth/callback',
  scopes: ['openid', 'email', 'profile'],
}

beforeEach(() => {
  configureOAuth({ store: createMemoryStore(), cognito: COGNITO })
})

describe('createPkce', () => {
  it('produces a base64url verifier (≥128 bits) and a distinct S256 challenge', async () => {
    const a = await createPkce()
    const b = await createPkce()
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.verifier.length).toBeGreaterThanOrEqual(43) // 32 bytes → 43 b64url chars
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.challenge).not.toBe(a.verifier)
    expect(a.verifier).not.toBe(b.verifier) // CSPRNG → unique
  })
})

describe('isLocalPath — open-redirect guard', () => {
  it('accepts a valid local path', () => {
    expect(isLocalPath('/join/x')).toBe(true)
    expect(isLocalPath('/')).toBe(true)
  })
  it('rejects protocol-relative, backslash, absolute-URL, scheme, null, and undefined inputs', () => {
    for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', '', 'no-leading-slash']) {
      expect(isLocalPath(bad)).toBe(false)
    }
    expect(isLocalPath(null)).toBe(false)
    expect(isLocalPath(undefined)).toBe(false)
  })
})

describe('createAuthState / consumeAuthState', () => {
  it('gens pkce + state, persists {provider, returnTo, verifier}, returns {state, challenge}; single-use', async () => {
    const { state, challenge } = await createAuthState({ provider: 'google', returnTo: '/join/x' })
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    const first = consumeAuthState(state)
    expect(first?.provider).toBe('google')
    expect(first?.returnTo).toBe('/join/x')
    expect(typeof first?.verifier).toBe('string')
    expect(consumeAuthState(state)).toBeNull() // single-use
  })
  it('stores returnTo as null when it is not a local path', async () => {
    const { state } = await createAuthState({ provider: 'discord', returnTo: 'https://evil.com' })
    expect(consumeAuthState(state)?.returnTo).toBeNull()
  })
  it('returns null consuming an unknown state', () => {
    expect(consumeAuthState('nope')).toBeNull()
  })
})

describe('buildAuthorizeUrl', () => {
  it('builds the authorize URL from the configured cognito config + maps provider casing', () => {
    const url = new URL(buildAuthorizeUrl({ provider: 'discord', state: 'st', challenge: 'chal' }))
    expect(url.origin).toBe('https://mythrun-staging.auth.us-east-1.amazoncognito.com')
    expect(url.pathname).toBe('/oauth2/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('client123')
    expect(url.searchParams.get('redirect_uri')).toBe('https://staging.mythrun.com/auth/callback')
    expect(url.searchParams.get('scope')).toBe('openid email profile')
    expect(url.searchParams.get('identity_provider')).toBe('Discord')
    expect(url.searchParams.get('code_challenge')).toBe('chal')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('st')
  })
  it('maps the google provider to Cognito casing', () => {
    const url = new URL(buildAuthorizeUrl({ provider: 'google', state: 's', challenge: 'c' }))
    expect(url.searchParams.get('identity_provider')).toBe('Google')
  })
})

describe('parseCallback (parse-only — does NOT consume the store)', () => {
  it('returns { code, state } when both present', () => {
    expect(parseCallback('?code=AUTHCODE&state=st')).toEqual({ code: 'AUTHCODE', state: 'st' })
  })
  it('returns { error } on a provider-denial error param', () => {
    expect(parseCallback('?error=access_denied')).toEqual({ error: 'access_denied' })
  })
  it('returns { error: invalid_request } when code or state is missing', () => {
    expect(parseCallback('?state=x')).toEqual({ error: 'invalid_request' })
    expect(parseCallback('?code=x')).toEqual({ error: 'invalid_request' })
  })
  it('does NOT consume the store (a separate consumeAuthState still works)', async () => {
    const { state } = await createAuthState({ provider: 'google', returnTo: '/' })
    parseCallback(`?code=c&state=${state}`)
    expect(consumeAuthState(state)?.returnTo).toBe('/') // parseCallback left it intact
  })
})

describe('configureOAuth guard', () => {
  it('throws when an oauth helper is used before configureOAuth', () => {
    resetOAuthConfig()
    expect(() => consumeAuthState('x')).toThrow()
  })
})
```

Run (expect: red): `pnpm --filter @mythrun/client-core test src/auth/oauth.test.ts`

- [ ] **Step 2 — create the platform port `frontend/client-core/src/platform/oauth-state-store.ts`** (interface only — mirrors `secure-storage.ts`):

```ts
// A platform-capability port (R1): the DOM-free client brain persists the
// single-use OAuth `state` triple through this contract, never `sessionStorage`
// directly. The web impl (sessionStorage-backed) lands in @mythrun/web under
// src/platform/web/** (the sanctioned web-globals carve-out); a native shell can
// satisfy the same surface later. `take` is a single-use read+delete (CSRF +
// replay defense); a corrupt/absent payload yields null.
import type { AuthStateData } from '../auth/oauth.ts'

export interface OAuthStateStore {
  /** Persist the triple keyed by the opaque `state`. */
  set(state: string, payload: AuthStateData): void
  /** Read AND delete the triple for `state` (single-use); null if absent/corrupt. */
  take(state: string): AuthStateData | null
}
```

- [ ] **Step 3 — implement `frontend/client-core/src/auth/oauth.ts`** (the canonical API; persistence + Cognito config injected once via `configureOAuth`; `crypto`/`btoa` are universal — `sessionStorage` was the only web coupling, now behind the port):

```ts
// OAuth/PKCE helpers for the Cognito Hosted UI flow — the CANONICAL oauth API
// (Tasks 11 + 12 consume it). Pure + unit-tested. Uses the universal Web Crypto API
// (globalThis.crypto — browser + RN-with-polyfill + Node) for CSPRNG + S256. Two
// things are INJECTED once at boot via configureOAuth: the single-use `state` store
// (an OAuthStateStore platform port — client-core stays DOM-free, R1; the web impl
// is sessionStorage in @mythrun/web) and the Cognito Hosted UI config. parseCallback
// PARSES ONLY (never consumes); the callback then calls consumeAuthState separately.
import type { OAuthStateStore } from '../platform/oauth-state-store.ts'

export type OAuthProvider = 'google' | 'discord'

export interface PkcePair {
  verifier: string
  challenge: string
}

export interface AuthStateData {
  provider: OAuthProvider
  returnTo: string | null
  verifier: string
}

export interface OAuthCognitoConfig {
  /** Bare Hosted UI host, e.g. mythrun-staging.auth.us-east-1.amazoncognito.com */
  domain: string
  clientId: string
  redirectUri: string
  scopes: string[]
}

// Cognito's identity_provider is case-sensitive — map the lowercase app provider.
const PROVIDER_TO_COGNITO: Record<OAuthProvider, string> = { google: 'Google', discord: 'Discord' }

// Configure-once injected runtime (mirrors configureTokenRefresh): the state store
// + the Cognito config. The web bootstrap (main.tsx) wires it; tests inject in-memory.
interface OAuthRuntime {
  store: OAuthStateStore
  cognito: OAuthCognitoConfig
}
let runtime: OAuthRuntime | null = null

export function configureOAuth(config: OAuthRuntime): void {
  runtime = config
}

function requireRuntime(): OAuthRuntime {
  if (runtime === null) {
    throw new Error('configureOAuth not called at boot')
  }
  return runtime
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomBase64url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  globalThis.crypto.getRandomValues(bytes)
  return base64url(bytes)
}

/** CSPRNG code_verifier (32 bytes → 256 bits) + S256 code_challenge. */
export async function createPkce(): Promise<PkcePair> {
  const verifier = randomBase64url(32)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

/** Open-redirect guard: a single leading `/`, NOT `//` or `/\` (protocol-relative
 *  / backslash tricks), and no `scheme:` (an absolute URL never starts with `/`).
 *  null/undefined → false. */
export function isLocalPath(returnTo: string | null | undefined): boolean {
  if (returnTo === null || returnTo === undefined) return false
  if (!returnTo.startsWith('/')) return false
  if (returnTo.startsWith('//')) return false
  if (returnTo.startsWith('/\\')) return false
  return true
}

/** Gen PKCE + a CSPRNG opaque state, persist {provider, returnTo, verifier} to the
 *  configured store (single-use), return {state, challenge}. `returnTo` is validated
 *  LOCAL here (else null) so a forged value can never ride the round-trip. */
export async function createAuthState(input: {
  provider: OAuthProvider
  returnTo: string | null
}): Promise<{ state: string; challenge: string }> {
  const { store } = requireRuntime()
  const { verifier, challenge } = await createPkce()
  const state = randomBase64url(16)
  const returnTo = isLocalPath(input.returnTo) ? input.returnTo : null
  store.set(state, { provider: input.provider, returnTo, verifier })
  return { state, challenge }
}

/** Read + DELETE (single-use) the triple stored for `state` (delegates to the store). */
export function consumeAuthState(state: string): AuthStateData | null {
  return requireRuntime().store.take(state)
}

export function buildAuthorizeUrl(input: {
  provider: OAuthProvider
  state: string
  challenge: string
}): string {
  const { cognito } = requireRuntime()
  const url = new URL(`https://${cognito.domain}/oauth2/authorize`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', cognito.clientId)
  url.searchParams.set('redirect_uri', cognito.redirectUri)
  url.searchParams.set('scope', cognito.scopes.join(' '))
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('identity_provider', PROVIDER_TO_COGNITO[input.provider])
  return url.toString()
}

/** Parse the callback query ONLY — never consumes the store (the callback calls
 *  consumeAuthState separately). Provider denial (`?error=`) → { error }; a missing
 *  code/state → { error: 'invalid_request' }; otherwise { code, state }. */
export function parseCallback(search: string): { code: string; state: string } | { error: string } {
  const params = new URLSearchParams(search)
  const error = params.get('error')
  if (error !== null) return { error }
  const code = params.get('code')
  const state = params.get('state')
  if (code === null || state === null) return { error: 'invalid_request' }
  return { code, state }
}

/** TEST-ONLY: clear the configured runtime. NOT exported from the client-core
 *  barrel (imported via the direct module path in tests — mirrors resetTokenManager). */
export function resetOAuthConfig(): void {
  runtime = null
}
```

Run (expect: green): `pnpm --filter @mythrun/client-core test src/auth/oauth.test.ts`

- [ ] **Step 4 — failing test for the web impl.** Create `frontend/src/platform/web/oauth-state-store.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { createWebOAuthStateStore } from './oauth-state-store.ts'

afterEach(() => {
  sessionStorage.clear()
})

describe('createWebOAuthStateStore', () => {
  it('set then take returns the payload once (single-use)', () => {
    const store = createWebOAuthStateStore()
    store.set('st', { provider: 'google', returnTo: '/join/x', verifier: 'v1' })
    expect(store.take('st')).toEqual({ provider: 'google', returnTo: '/join/x', verifier: 'v1' })
    expect(store.take('st')).toBeNull()
  })
  it('take returns null for an unknown state', () => {
    expect(createWebOAuthStateStore().take('nope')).toBeNull()
  })
  it('take returns null (and clears) when the stored value is corrupt JSON', () => {
    const store = createWebOAuthStateStore()
    sessionStorage.setItem('mythrun_oauth_state:bad', '{not json')
    expect(store.take('bad')).toBeNull()
  })
})
```

Run (expect: red): `cd frontend && pnpm vitest run src/platform/web/oauth-state-store.test.ts`

- [ ] **Step 5 — implement the web impl `frontend/src/platform/web/oauth-state-store.ts`** (the `src/platform/web/**` carve-out — the ONE place web globals are allowed, R1):

```ts
import type { AuthStateData, OAuthStateStore } from '@mythrun/client-core'

// Web realization of the OAuthStateStore port — the single-use OAuth `state`
// triple backed by sessionStorage (cleared on tab close; scoped to the tab that
// began the flow). Lives under src/platform/web/** (the one place web globals are
// allowed, R1); the client-core OAuth helper reaches it only through the injected
// port. `take` is read+delete with corrupt-payload→null. A native shell swaps an
// in-app secure store behind the same contract.
const STATE_KEY_PREFIX = 'mythrun_oauth_state:'

export function createWebOAuthStateStore(): OAuthStateStore {
  return {
    set: (state, payload) => {
      sessionStorage.setItem(STATE_KEY_PREFIX + state, JSON.stringify(payload))
    },
    take: (state) => {
      const key = STATE_KEY_PREFIX + state
      const raw = sessionStorage.getItem(key)
      if (raw === null) return null
      sessionStorage.removeItem(key)
      try {
        return JSON.parse(raw) as AuthStateData
      } catch {
        return null
      }
    },
  }
}
```

Run (expect: green): `cd frontend && pnpm vitest run src/platform/web/oauth-state-store.test.ts`

- [ ] **Step 6 — barrel exports.** In `frontend/client-core/src/index.ts`, add (NOT `resetOAuthConfig` — that is test-only, imported via the direct module path):

```ts
// OAuth/PKCE helpers (MYT-84) — the canonical oauth API consumed by the sign-in +
// callback screens. State persistence + the Cognito Hosted UI config are injected
// once at boot via configureOAuth; the web store impl (sessionStorage) lives in
// @mythrun/web.
export {
  createPkce,
  createAuthState,
  consumeAuthState,
  configureOAuth,
  isLocalPath,
  buildAuthorizeUrl,
  parseCallback,
} from './auth/oauth.ts'
export type {
  OAuthProvider,
  PkcePair,
  AuthStateData,
  OAuthCognitoConfig,
} from './auth/oauth.ts'
export type { OAuthStateStore } from './platform/oauth-state-store.ts'
```

- [ ] **Step 7 — wire the store + Cognito config at boot (`main.tsx`, jwt branch).** Unlike `secureStorage`, the OAuth helper is configured DIRECTLY at the boot seam (not threaded through `AppProvidersConfig`/`providers.tsx`), because the screens call the bare `createAuthState`/`parseCallback`/`consumeAuthState` exports. Add the import + the configure-once call inside the `jwt` branch:

```tsx
// frontend/src/main.tsx
import { useSessionStore, configureOAuth } from '@mythrun/client-core'
import { createWebOAuthStateStore } from './platform/web/oauth-state-store.ts'
```
```tsx
if (config.authMode === 'bypass') {
  useSessionStore.getState().setReady(config.devSub)
} else {
  // jwt mode: wire the OAuth helper ONCE at boot — the single-use state store + the
  // Cognito Hosted UI config (PUBLIC build values, safe in the bundle). The
  // redirect_uri is derived from THIS origin and MUST exact-match the backend's
  // server-derived `${frontendBaseUrl}/auth/callback` AND the Cognito app-client
  // callback URL (Task 1). `window` is allowed here (the web entry).
  configureOAuth({
    store: createWebOAuthStateStore(),
    cognito: {
      domain: import.meta.env.VITE_COGNITO_HOSTED_UI_DOMAIN,
      clientId: import.meta.env.VITE_COGNITO_APP_CLIENT_ID,
      redirectUri: `${window.location.origin}/auth/callback`,
      scopes: ['openid', 'email', 'profile'],
    },
  })
}
```

> No `AppProvidersConfig`/`providers.tsx` change for OAuth (so no test-config ripple — unlike `secureStorage`). Dev/bypass never configures OAuth (it never reaches the sign-in screen). **Task 10 adds `void bootstrapSession(toApiContext(config))` into THIS SAME `jwt` `else` branch** — the two edits are additive to one block; the controller lands Task 5 first, then Task 10 inserts the bootstrap line.

- [ ] **Step 8 — the two PUBLIC Cognito build vars.** These are bundled into the SPA and are PUBLIC values (a Hosted UI domain + a public SPA client id — PKCE means there is NO client secret). Three edits:
  - In `frontend/.env.development`, add (local dev points at staging Cognito so the jwt path type-checks; OAuth itself isn't exercised in bypass):
    ```
    VITE_COGNITO_HOSTED_UI_DOMAIN=mythrun-staging.auth.us-east-1.amazoncognito.com
    VITE_COGNITO_APP_CLIENT_ID=<staging app client id>
    ```
  - In `.github/workflows/deploy-frontend.yml`, add both to the Vite build step's `env:` block alongside `VITE_API_BASE_URL`, sourced from GH Actions staging **`vars`** (public — NOT `secrets`): `VITE_COGNITO_HOSTED_UI_DOMAIN: ${{ vars.VITE_COGNITO_HOSTED_UI_DOMAIN }}` / `VITE_COGNITO_APP_CLIENT_ID: ${{ vars.VITE_COGNITO_APP_CLIENT_ID }}`.
  - If `frontend/src/vite-env.d.ts` declares an `ImportMetaEnv` interface, add `readonly VITE_COGNITO_HOSTED_UI_DOMAIN: string` + `readonly VITE_COGNITO_APP_CLIENT_ID: string` (typed `string`, not `string | undefined`, so the `configureOAuth` call is type-clean).

- [ ] **Step 9 — verify + stage.** Run:
  - `pnpm --filter @mythrun/client-core typecheck`
  - `pnpm --filter @mythrun/client-core test src/auth/oauth.test.ts`
  - `pnpm --filter @mythrun/client-core test:coverage` (100% on `src/auth/oauth.ts`; the `platform/oauth-state-store.ts` interface has no runtime lines)
  - `pnpm --filter @mythrun/web typecheck && cd frontend && pnpm vitest run src/platform/web/oauth-state-store.test.ts`

  Stage: `git add frontend/client-core/src/platform/oauth-state-store.ts frontend/client-core/src/auth/oauth.ts frontend/client-core/src/auth/oauth.test.ts frontend/src/platform/web/oauth-state-store.ts frontend/src/platform/web/oauth-state-store.test.ts frontend/client-core/src/index.ts frontend/src/main.tsx frontend/.env.development .github/workflows/deploy-frontend.yml frontend/src/vite-env.d.ts` — do not commit.

---

### Task 6: Narrow `POST /api/users/register` response to the public user projection

**Why:** `POST /api/users/register` currently returns the FULL `users` row — on BOTH the 201 `created:true` happy path (`{ ...user, freeTrialUsed: true }`) and the 200 `already_onboarded_same` path (`conflict.user`) — leaking `cognitoSub` / `stripeCustomerId` / `suspendedAt` / `updatedAt`, the exact four fields `GET /api/users/me` deliberately strips. Narrow register's response to the SAME public projection `/me` uses: extract `/me`'s inline projection into a shared `toPublicUser` helper and reuse it on both register paths AND `/me`. (The contract's `RegisterResponseSchema` already models the public projection, so this closes the leak at the source while Zod stays as defense-in-depth client-side.)

**Files**
- Modify: `backend/src/routes/users.ts` (extract `toPublicUser` from the `/me` handler; reuse on the register 201 + 200 responses + `/me`)
- Modify: `backend/src/routes/__tests__/users.test.ts` (failing assertions: the four fields are absent)

**Interfaces**
- Produces: `toPublicUser(user): MeResponse['user']` (id, username, displayName, freeTrialUsed, createdAt-as-ISO) — the single projection used by `/me` AND register.
- No contract change (`RegisterResponseSchema` already = `{ user: PublicUserSchema, created }`).

#### Steps

- [ ] **Step 1 — failing test: register 201 + 200 omit the four leaked fields.** Add to the `POST /api/users/register` describe block in `backend/src/routes/__tests__/users.test.ts`:

```ts
it('201 + 200 responses omit cognitoSub / stripeCustomerId / suspendedAt / updatedAt (public projection)', async () => {
  const sub = scope.userSub(0)
  const username = scope.username(0)
  const LEAKED = ['cognitoSub', 'stripeCustomerId', 'suspendedAt', 'updatedAt'] as const

  // 201 created.
  const created = await app.inject({
    method: 'POST',
    url: '/api/users/register',
    headers: { 'x-test-sub': sub, 'content-type': 'application/json' },
    payload: { username, displayName: scope.displayName(0) },
  })
  expect(created.statusCode).toBe(201)
  const createdUser = created.json<{ user: Record<string, unknown> }>().user
  for (const f of LEAKED) expect(createdUser).not.toHaveProperty(f)
  // The public fields ARE present.
  expect(createdUser).toHaveProperty('id')
  expect(createdUser).toHaveProperty('username')
  expect(createdUser).toHaveProperty('createdAt')

  // 200 already_onboarded_same — same sub + same username.
  const same = await app.inject({
    method: 'POST',
    url: '/api/users/register',
    headers: { 'x-test-sub': sub, 'content-type': 'application/json' },
    payload: { username, displayName: scope.displayName(1) },
  })
  expect(same.statusCode).toBe(200)
  const sameUser = same.json<{ user: Record<string, unknown> }>().user
  for (const f of LEAKED) expect(sameUser).not.toHaveProperty(f)
})
```

Run (expect: red — register currently sends the full row): `pnpm --filter @mythrun/backend test src/routes/__tests__/users.test.ts`

- [ ] **Step 2 — extract the projection helper.** In `backend/src/routes/users.ts`, add a top-level `toPublicUser` (above `usersRoutes`), modelling the SAME shape `/me` builds:

```ts
// The public user projection (MeResponse['user']): the ONLY user shape that goes
// over the wire. OMITS cognitoSub / stripeCustomerId / suspendedAt / updatedAt —
// they must never leak. `/me` AND register both render through this so the two can
// never drift (register previously sent the full row — MYT-84 leak fix). The
// `Date` createdAt is serialized to its ISO string (the contract models the wire).
function toPublicUser(user: {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly freeTrialUsed: boolean
  readonly createdAt: Date
}): MeResponse['user'] {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    freeTrialUsed: user.freeTrialUsed,
    createdAt: user.createdAt.toISOString(),
  }
}
```

- [ ] **Step 3 — reuse it on the register 201 + 200 paths.** In `handleRegister`, replace the 201 send:

```ts
    // Stitch the post-COMMIT free_trial_used into the response shape so the body
    // reflects state-at-end-of-tx, then narrow to the public projection (never
    // leak cognitoSub / stripeCustomerId / suspendedAt / updatedAt).
    const userResponse = { ...user, freeTrialUsed: true }
    return await reply
      .header('Location', '/api/users/me')
      .code(201)
      .send({ user: toPublicUser(userResponse), created: true })
```

and the `already_onboarded_same` 200 send:

```ts
    if (conflict.code === 'already_onboarded_same') {
      return await reply
        .header('Content-Location', '/api/users/me')
        .code(200)
        .send({ user: toPublicUser(conflict.user), created: false })
    }
```

> If `conflict.user` types as nullable (`getByCognitoSub` returns `User | undefined`), tighten the `already_onboarded_same` arm of `UniqueViolationResolution` to `user: NonNullable<Awaited<ReturnType<Repo['users']['getByCognitoSub']>>>` — it is non-null by construction (guarded by the `!existing` check above), so this only re-states what's already true and lets `toPublicUser` accept it without an assertion.

- [ ] **Step 4 — collapse `/me` onto the same helper** (so the projection is shared, not duplicated). In the `GET /api/users/me` handler, replace the inline body build with:

```ts
    const body: MeResponse = { user: toPublicUser(user) }
    return reply.send(body)
```

- [ ] **Step 5 — verify + stage.** Run:
  - `pnpm --filter @mythrun/backend typecheck && pnpm --filter @mythrun/backend lint`
  - `pnpm --filter @mythrun/backend test src/routes/__tests__/users.test.ts` (green; the new test + the existing 201/200/`/me` tests still pass)

  Stage: `git add backend/src/routes/users.ts backend/src/routes/__tests__/users.test.ts` — do not commit.

---

### Task 7: Backend BFF session endpoints (`/api/auth/{session,refresh,logout}`) + Cognito OAuth client + cookie helper

The backend half: a `@fastify/cookie` dependency, a Cognito-OAuth abstraction (token exchange / refresh / revoke), the refresh-cookie helper, the three public + rate-limited routes, the allowlist entries, and the CORS `credentials:true` flip. Integration-tested against a MOCKED Cognito token endpoint (no DB — these routes touch no rows, so per CONVENTIONS no scoped fixtures / pool are needed).

**Files**
- Modify: `backend/package.json` (add `@fastify/cookie`)
- Create: `backend/src/auth/cognito-oauth-client.ts`
- Create: `backend/src/auth/__tests__/cognito-oauth-client.test.ts`
- Create: `backend/src/auth/refresh-cookie.ts`
- Create: `backend/src/routes/auth.ts`
- Create: `backend/src/routes/__tests__/auth.test.ts`
- Modify: `backend/src/auth/public-route-allowlist.ts` (+3 entries)
- Modify: `backend/src/app.ts` (register `@fastify/cookie` + `authRoutes` in real mode; CORS `credentials:true`)

**Interfaces (exact)**
- Cookie: name `mythrun_refresh`; `HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=2592000`; host-only (no `Domain`). `clearRefreshCookie` mirrors path/secure/sameSite/httpOnly.
- `CognitoOAuthClient`: `exchangeCode({ code, codeVerifier, redirectUri }) → Promise<CognitoTokenSet>`, `refresh({ refreshToken }) → Promise<CognitoTokenSet>`, `revoke({ token }) → Promise<void>`. `CognitoTokenSet = { accessToken; expiresIn; idToken?; refreshToken? }`. Constructed via `createCognitoOAuthClient({ hostedUiDomain, clientId, fetchImpl? })`. `extractIdTokenName(idToken) → string | null`.
- Routes: `POST /api/auth/session` (JSON-only → 415 else; derives `redirect_uri = ${frontendBaseUrl}/auth/callback`; sets cookie; → `{ accessToken, expiresIn, name }`), `POST /api/auth/refresh` (reads cookie; re-sets ROTATED cookie; → `{ accessToken, expiresIn }`; 401 + clear on bad), `POST /api/auth/logout` (revoke + clear; 204). All three `config.auth:'public'` + in `PUBLIC_ROUTE_ALLOWLIST` + `config.rateLimit { max: 20, timeWindow: '1 minute' }` (default keyGenerator = `request.ip`).

#### Steps

- [ ] **Step 1 — add the dependency.** Add `"@fastify/cookie": "^11.0.2"` to `backend/package.json` `dependencies` (alphabetical, before `@fastify/cors`), then run `pnpm install`. Verify it resolves: `pnpm --filter @mythrun/backend exec node -e "import('@fastify/cookie').then(() => console.log('ok'))"`.

- [ ] **Step 2 — failing unit test for the Cognito client.** Create `backend/src/auth/__tests__/cognito-oauth-client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  CognitoOAuthError,
  createCognitoOAuthClient,
  extractIdTokenName,
} from '../cognito-oauth-client.js'

const HOST = 'mythrun-staging.auth.us-east-1.amazoncognito.com'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function makeIdToken(payload: Record<string, unknown>): string {
  const seg = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${seg({ alg: 'none' })}.${seg(payload)}.sig`
}

describe('createCognitoOAuthClient', () => {
  it('exchangeCode POSTs the PKCE authorization_code form to /oauth2/token', async () => {
    let url = ''
    let body = ''
    const fetchImpl = vi.fn((u: string, init?: RequestInit) => {
      url = u
      body = String(init?.body)
      return Promise.resolve(jsonResponse({ access_token: 'a', expires_in: 3600, id_token: 'i', refresh_token: 'r' }))
    }) as unknown as typeof fetch
    const client = createCognitoOAuthClient({ hostedUiDomain: HOST, clientId: 'c1', fetchImpl })
    const tokens = await client.exchangeCode({ code: 'CODE', codeVerifier: 'VER', redirectUri: 'https://x/auth/callback' })
    expect(tokens).toEqual({ accessToken: 'a', expiresIn: 3600, idToken: 'i', refreshToken: 'r' })
    expect(url).toBe(`https://${HOST}/oauth2/token`)
    const p = new URLSearchParams(body)
    expect(p.get('grant_type')).toBe('authorization_code')
    expect(p.get('client_id')).toBe('c1')
    expect(p.get('code')).toBe('CODE')
    expect(p.get('code_verifier')).toBe('VER')
    expect(p.get('redirect_uri')).toBe('https://x/auth/callback')
  })

  it('refresh POSTs the refresh_token grant', async () => {
    let body = ''
    const fetchImpl = vi.fn((_u: string, init?: RequestInit) => {
      body = String(init?.body)
      return Promise.resolve(jsonResponse({ access_token: 'a2', expires_in: 3600, refresh_token: 'rotated' }))
    }) as unknown as typeof fetch
    const client = createCognitoOAuthClient({ hostedUiDomain: HOST, clientId: 'c1', fetchImpl })
    const tokens = await client.refresh({ refreshToken: 'old' })
    expect(tokens.refreshToken).toBe('rotated')
    expect(new URLSearchParams(body).get('grant_type')).toBe('refresh_token')
    expect(new URLSearchParams(body).get('refresh_token')).toBe('old')
  })

  it('revoke POSTs token + client_id to /oauth2/revoke', async () => {
    let url = ''
    let body = ''
    const fetchImpl = vi.fn((u: string, init?: RequestInit) => {
      url = u
      body = String(init?.body)
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch
    const client = createCognitoOAuthClient({ hostedUiDomain: HOST, clientId: 'c1', fetchImpl })
    await client.revoke({ token: 'tok' })
    expect(url).toBe(`https://${HOST}/oauth2/revoke`)
    expect(new URLSearchParams(body).get('token')).toBe('tok')
    expect(new URLSearchParams(body).get('client_id')).toBe('c1')
  })

  it('throws CognitoOAuthError on a non-2xx token response', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ error: 'invalid_grant' }, 400))) as unknown as typeof fetch
    const client = createCognitoOAuthClient({ hostedUiDomain: HOST, clientId: 'c1', fetchImpl })
    await expect(client.exchangeCode({ code: 'x', codeVerifier: 'y', redirectUri: 'z' })).rejects.toBeInstanceOf(CognitoOAuthError)
  })

  it('throws CognitoOAuthError on a non-2xx revoke response', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 401 }))) as unknown as typeof fetch
    const client = createCognitoOAuthClient({ hostedUiDomain: HOST, clientId: 'c1', fetchImpl })
    await expect(client.revoke({ token: 't' })).rejects.toBeInstanceOf(CognitoOAuthError)
  })

  it('throws when the token response is missing access_token/expires_in', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ token_type: 'Bearer' }))) as unknown as typeof fetch
    const client = createCognitoOAuthClient({ hostedUiDomain: HOST, clientId: 'c1', fetchImpl })
    await expect(client.refresh({ refreshToken: 'r' })).rejects.toBeInstanceOf(CognitoOAuthError)
  })

  it('omits idToken/refreshToken from the set when absent', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ access_token: 'a', expires_in: 60 }))) as unknown as typeof fetch
    const client = createCognitoOAuthClient({ hostedUiDomain: HOST, clientId: 'c1', fetchImpl })
    const tokens = await client.exchangeCode({ code: 'x', codeVerifier: 'y', redirectUri: 'z' })
    expect(tokens).toEqual({ accessToken: 'a', expiresIn: 60 })
  })
})

describe('extractIdTokenName', () => {
  it('returns the name claim', () => {
    expect(extractIdTokenName(makeIdToken({ name: 'Ada Lovelace' }))).toBe('Ada Lovelace')
  })
  it('returns null for a blank/absent name, a non-3-part token, and malformed payload', () => {
    expect(extractIdTokenName(makeIdToken({ name: '' }))).toBeNull()
    expect(extractIdTokenName(makeIdToken({ sub: 'x' }))).toBeNull()
    expect(extractIdTokenName('not.a.jwt.at.all')).toBeNull()
    expect(extractIdTokenName('one-part')).toBeNull()
    expect(extractIdTokenName('a.%%%.c')).toBeNull()
  })
})
```

Run (expect: red): `pnpm --filter @mythrun/backend test src/auth/__tests__/cognito-oauth-client.test.ts`

- [ ] **Step 3 — implement `backend/src/auth/cognito-oauth-client.ts`:**

```ts
// backend/src/auth/cognito-oauth-client.ts
//
// The single abstraction over Cognito's OAuth2 token + revoke endpoints. All
// Cognito HTTP calls in the BFF session/refresh/logout flow go through here (no
// inline fetch in the route handlers) — mirrors the "all Anthropic calls through
// one layer" convention. PUBLIC client (PKCE): there is no client_secret.

export interface CognitoTokenSet {
  readonly accessToken: string
  readonly expiresIn: number
  readonly idToken?: string
  readonly refreshToken?: string
}

export interface CognitoOAuthClient {
  exchangeCode(input: {
    code: string
    codeVerifier: string
    redirectUri: string
  }): Promise<CognitoTokenSet>
  refresh(input: { refreshToken: string }): Promise<CognitoTokenSet>
  revoke(input: { token: string }): Promise<void>
}

export class CognitoOAuthError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'CognitoOAuthError'
    this.status = status
  }
}

export interface CognitoOAuthClientOpts {
  /** Bare host, e.g. mythrun-staging.auth.us-east-1.amazoncognito.com */
  readonly hostedUiDomain: string
  readonly clientId: string
  /** Injected in tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch
}

interface RawTokenResponse {
  access_token?: unknown
  expires_in?: unknown
  id_token?: unknown
  refresh_token?: unknown
}

function toTokenSet(raw: RawTokenResponse): CognitoTokenSet {
  if (typeof raw.access_token !== 'string' || typeof raw.expires_in !== 'number') {
    throw new CognitoOAuthError(502, 'cognito token response missing access_token/expires_in')
  }
  return {
    accessToken: raw.access_token,
    expiresIn: raw.expires_in,
    ...(typeof raw.id_token === 'string' ? { idToken: raw.id_token } : {}),
    ...(typeof raw.refresh_token === 'string' ? { refreshToken: raw.refresh_token } : {}),
  }
}

export function createCognitoOAuthClient(opts: CognitoOAuthClientOpts): CognitoOAuthClient {
  const fetchImpl = opts.fetchImpl ?? fetch
  const tokenUrl = `https://${opts.hostedUiDomain}/oauth2/token`
  const revokeUrl = `https://${opts.hostedUiDomain}/oauth2/revoke`

  const postForm = (url: string, params: Record<string, string>): Promise<Response> =>
    fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    })

  const tokenRequest = async (params: Record<string, string>): Promise<CognitoTokenSet> => {
    const res = await postForm(tokenUrl, params)
    if (!res.ok) {
      throw new CognitoOAuthError(res.status, `cognito token endpoint returned ${String(res.status)}`)
    }
    return toTokenSet((await res.json()) as RawTokenResponse)
  }

  return {
    exchangeCode: ({ code, codeVerifier, redirectUri }) =>
      tokenRequest({
        grant_type: 'authorization_code',
        client_id: opts.clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
    refresh: ({ refreshToken }) =>
      tokenRequest({
        grant_type: 'refresh_token',
        client_id: opts.clientId,
        refresh_token: refreshToken,
      }),
    revoke: async ({ token }) => {
      const res = await postForm(revokeUrl, { token, client_id: opts.clientId })
      if (!res.ok) {
        throw new CognitoOAuthError(res.status, `cognito revoke endpoint returned ${String(res.status)}`)
      }
    },
  }
}

/** Decode (no verification needed — the id_token came straight from Cognito's
 *  token endpoint over TLS) the JWT payload and return the `name` claim, or null
 *  when absent/blank/malformed. */
export function extractIdTokenName(idToken: string): string | null {
  const parts = idToken.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'),
    ) as { name?: unknown }
    return typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : null
  } catch {
    return null
  }
}
```

> Note the `a.%%%.c` test case: `Buffer.from('%%%', 'base64url')` decodes to bytes that are not valid UTF-8 JSON → `JSON.parse` throws → caught → null. (`%` is outside the base64url alphabet and is dropped, leaving an empty/garbage buffer → JSON.parse fails.)

Run (expect: green): `pnpm --filter @mythrun/backend test src/auth/__tests__/cognito-oauth-client.test.ts`

- [ ] **Step 4 — implement the cookie helper `backend/src/auth/refresh-cookie.ts`:**

```ts
// backend/src/auth/refresh-cookie.ts
//
// The refresh-token cookie: HttpOnly + Secure + SameSite=Lax + Path=/api/auth +
// host-only (NO Domain — never broadens to sibling subdomains). 30-day Max-Age.
// JS never sees it (httpOnly); it is sent only on the /api/auth/* fetches
// (credentials:'include' + the same-SITE registrable domain). clearRefreshCookie
// MUST mirror path/secure/sameSite/httpOnly so the browser clears the SAME cookie.
import type { FastifyReply } from 'fastify'

export const REFRESH_COOKIE_NAME = 'mythrun_refresh'
/** 30 days, in SECONDS (@fastify/cookie's maxAge is seconds, per the cookie spec). */
const REFRESH_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60

const BASE_ATTRS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/api/auth',
} as const

export function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE_NAME, token, { ...BASE_ATTRS, maxAge: REFRESH_COOKIE_MAX_AGE_S })
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE_NAME, BASE_ATTRS)
}
```

- [ ] **Step 5 — failing integration test.** Create `backend/src/routes/__tests__/auth.test.ts`:

```ts
// backend/src/routes/__tests__/auth.test.ts
//
// Integration tests for routes/auth.ts against a MOCKED CognitoOAuthClient. These
// routes touch NO database rows, so — per CONVENTIONS.md (scoped fixtures are for
// tests that create rows) — this file uses neither createTestPool nor a TestScope.
// The mocked client lets us assert the cookie set/rotate/clear, the 415 invariant,
// the allowlist boot, the rate limit, and CORS credentials.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { registerPublicRouteAllowlistHook } from '../../auth/public-route-allowlist.js'
import { authRoutes } from '../auth.js'
import type { CognitoOAuthClient } from '../../auth/cognito-oauth-client.js'

const FRONTEND = 'https://staging.mythrun.com'

function makeIdToken(payload: Record<string, unknown>): string {
  const seg = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${seg({ alg: 'none' })}.${seg(payload)}.sig`
}

function setCookieHeader(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  return Array.isArray(raw) ? raw.join('\n') : String(raw)
}

function makeCognitoMock(): CognitoOAuthClient {
  return {
    exchangeCode: vi.fn(() =>
      Promise.resolve({ accessToken: 'access-1', expiresIn: 3600, idToken: makeIdToken({ name: 'Ada' }), refreshToken: 'refresh-1' }),
    ),
    refresh: vi.fn(() => Promise.resolve({ accessToken: 'access-2', expiresIn: 3600, refreshToken: 'refresh-rotated' })),
    revoke: vi.fn(() => Promise.resolve()),
  }
}

async function buildApp(cognito: CognitoOAuthClient): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: 1 })
  registerPublicRouteAllowlistHook(app)
  await app.register(cors, {
    origin: [FRONTEND],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-mythrun-dev-sub'],
    credentials: true,
  })
  await app.register(cookie)
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(authRoutes, { cognito, frontendBaseUrl: FRONTEND })
  await app.ready()
  return app
}

describe('routes/auth', () => {
  let cognito: CognitoOAuthClient
  let app: FastifyInstance

  beforeEach(async () => {
    cognito = makeCognitoMock()
    app = await buildApp(cognito)
  })
  afterEach(async () => {
    await app.close()
  })

  describe('POST /api/auth/session', () => {
    it('200: exchanges code (derived redirect_uri), sets the refresh cookie, returns access token + name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { 'content-type': 'application/json' },
        payload: { code: 'CODE', codeVerifier: 'VER' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ accessToken: 'access-1', expiresIn: 3600, name: 'Ada' })
      expect(cognito.exchangeCode).toHaveBeenCalledWith({
        code: 'CODE',
        codeVerifier: 'VER',
        redirectUri: 'https://staging.mythrun.com/auth/callback',
      })
      const sc = setCookieHeader(res)
      expect(sc).toContain('mythrun_refresh=refresh-1')
      expect(sc).toContain('HttpOnly')
      expect(sc).toContain('Secure')
      expect(sc).toContain('SameSite=Lax')
      expect(sc).toContain('Path=/api/auth')
      expect(sc).toContain('Max-Age=2592000')
      expect(sc).not.toContain('Domain')
    })

    it('415 on a text/plain content type (login-CSRF invariant: no form-body parser)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { 'content-type': 'text/plain' },
        payload: 'code=CODE&codeVerifier=VER',
      })
      expect(res.statusCode).toBe(415)
    })

    it('415 on application/x-www-form-urlencoded (no parser registered)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'code=CODE&codeVerifier=VER',
      })
      expect(res.statusCode).toBe(415)
    })

    it('400 on a JSON body missing code/codeVerifier', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { 'content-type': 'application/json' },
        payload: { code: 'CODE' },
      })
      expect(res.statusCode).toBe(400)
    })

    it('401 when the code exchange fails', async () => {
      vi.mocked(cognito.exchangeCode).mockRejectedValueOnce(new Error('invalid_grant'))
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { 'content-type': 'application/json' },
        payload: { code: 'BAD', codeVerifier: 'VER' },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ code: 'code_exchange_failed' })
    })

    it('502 when Cognito returns no refresh_token', async () => {
      vi.mocked(cognito.exchangeCode).mockResolvedValueOnce({ accessToken: 'a', expiresIn: 3600 })
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { 'content-type': 'application/json' },
        payload: { code: 'CODE', codeVerifier: 'VER' },
      })
      expect(res.statusCode).toBe(502)
    })
  })

  describe('POST /api/auth/refresh', () => {
    it('200: refreshes and RE-SETS the rotated cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: { cookie: 'mythrun_refresh=refresh-1' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ accessToken: 'access-2', expiresIn: 3600 })
      expect(cognito.refresh).toHaveBeenCalledWith({ refreshToken: 'refresh-1' })
      expect(setCookieHeader(res)).toContain('mythrun_refresh=refresh-rotated')
    })

    it('401 + clears the cookie when no refresh cookie is present', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/refresh' })
      expect(res.statusCode).toBe(401)
      const sc = setCookieHeader(res)
      expect(sc).toContain('mythrun_refresh=')
      expect(sc).toContain('Path=/api/auth')
      expect(sc).toMatch(/Max-Age=0|Expires=/)
    })

    it('401 + clears the cookie when the refresh grant fails', async () => {
      vi.mocked(cognito.refresh).mockRejectedValueOnce(new Error('expired'))
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: { cookie: 'mythrun_refresh=dead' },
      })
      expect(res.statusCode).toBe(401)
      expect(setCookieHeader(res)).toMatch(/Max-Age=0|Expires=/)
    })

    it('does NOT re-set a cookie when the grant returns no rotated token', async () => {
      vi.mocked(cognito.refresh).mockResolvedValueOnce({ accessToken: 'access-2', expiresIn: 3600 })
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: { cookie: 'mythrun_refresh=refresh-1' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['set-cookie']).toBeUndefined()
    })
  })

  describe('POST /api/auth/logout', () => {
    it('204: revokes the token and clears the cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: 'mythrun_refresh=refresh-1' },
      })
      expect(res.statusCode).toBe(204)
      expect(cognito.revoke).toHaveBeenCalledWith({ token: 'refresh-1' })
      expect(setCookieHeader(res)).toMatch(/Max-Age=0|Expires=/)
    })

    it('204 + clears the cookie even with no cookie present (revoke not called)', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout' })
      expect(res.statusCode).toBe(204)
      expect(cognito.revoke).not.toHaveBeenCalled()
    })

    it('204 + clears even if revoke throws (best-effort revoke)', async () => {
      vi.mocked(cognito.revoke).mockRejectedValueOnce(new Error('revoke down'))
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: 'mythrun_refresh=refresh-1' },
      })
      expect(res.statusCode).toBe(204)
      expect(setCookieHeader(res)).toMatch(/Max-Age=0|Expires=/)
    })
  })

  it('CORS: a credentialed preflight echoes the origin + allow-credentials', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/session',
      headers: {
        origin: FRONTEND,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND)
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('rate limit: the per-IP cap returns 429 once exceeded', async () => {
    let last = 0
    for (let i = 0; i < 21; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { 'content-type': 'application/json' },
        payload: { code: 'CODE', codeVerifier: 'VER' },
      })
      last = res.statusCode
    }
    expect(last).toBe(429)
  })

  it('boots clean: the three public auth routes are allowlisted (app.ready did not throw)', async () => {
    // buildApp() already called app.ready() in beforeEach without throwing — a
    // public route NOT in PUBLIC_ROUTE_ALLOWLIST would have failed there.
    expect(app.hasRoute({ method: 'POST', url: '/api/auth/session' })).toBe(true)
  })
})
```

Run (expect: red — routes/auth.js missing): `pnpm --filter @mythrun/backend test src/routes/__tests__/auth.test.ts`

- [ ] **Step 6 — implement `backend/src/routes/auth.ts`:**

```ts
// backend/src/routes/auth.ts
//
// MYT-84 BFF session endpoints. The SPA hands over only { code, codeVerifier }
// and receives only the access token + pre-fill name; the refresh token rides an
// httpOnly cookie set/rotated/cleared here (JS never sees it). All three routes:
//   - config.auth:'public' (in PUBLIC_ROUTE_ALLOWLIST) — no JWT (the user has no
//     access token yet on /session; /refresh & /logout authenticate via cookie).
//   - per-IP config.rateLimit (default keyGenerator = request.ip; correct under
//     trustProxy:1).
//   - /session is application/json ONLY (415 otherwise) — with no form-body parser
//     registered, this is the login-CSRF / session-fixation defense (spec §5).
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  clearRefreshCookie,
  REFRESH_COOKIE_NAME,
  setRefreshCookie,
} from '../auth/refresh-cookie.js'
import { extractIdTokenName, type CognitoOAuthClient } from '../auth/cognito-oauth-client.js'

interface AuthRoutesOpts {
  readonly cognito: CognitoOAuthClient
  readonly frontendBaseUrl: string
}

interface SessionBody {
  readonly code: string
  readonly codeVerifier: string
}

const RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const

function parseSessionBody(body: unknown): SessionBody | null {
  if (typeof body !== 'object' || body === null) return null
  const code = (body as { code?: unknown }).code
  const verifier = (body as { codeVerifier?: unknown }).codeVerifier
  if (typeof code !== 'string' || code.length === 0) return null
  if (typeof verifier !== 'string' || verifier.length === 0) return null
  return { code, codeVerifier: verifier }
}

function isJsonRequest(request: FastifyRequest): boolean {
  const ct = request.headers['content-type'] ?? ''
  return ct.toLowerCase().includes('application/json')
}

function errClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'Unknown'
}

async function handleSession(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: AuthRoutesOpts,
): Promise<FastifyReply> {
  if (!isJsonRequest(request)) {
    return reply.code(415).send({ code: 'unsupported_media_type' })
  }
  const body = parseSessionBody(request.body)
  if (!body) return reply.code(400).send({ code: 'invalid_request' })
  const redirectUri = `${opts.frontendBaseUrl}/auth/callback`
  let tokens
  try {
    tokens = await opts.cognito.exchangeCode({
      code: body.code,
      codeVerifier: body.codeVerifier,
      redirectUri,
    })
  } catch (err) {
    request.log.warn({ event: 'auth.code_exchange_failed', errorClass: errClass(err) }, 'code exchange failed')
    return reply.code(401).send({ code: 'code_exchange_failed' })
  }
  if (!tokens.refreshToken) {
    request.log.error({ event: 'auth.no_refresh_token' }, 'cognito token response carried no refresh_token')
    return reply.code(502).send({ code: 'no_refresh_token' })
  }
  setRefreshCookie(reply, tokens.refreshToken)
  const name = tokens.idToken ? extractIdTokenName(tokens.idToken) : null
  return reply.send({ accessToken: tokens.accessToken, expiresIn: tokens.expiresIn, name })
}

async function handleRefresh(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: AuthRoutesOpts,
): Promise<FastifyReply> {
  const token = request.cookies[REFRESH_COOKIE_NAME]
  if (!token) {
    clearRefreshCookie(reply)
    return reply.code(401).send({ code: 'no_refresh_token' })
  }
  let tokens
  try {
    tokens = await opts.cognito.refresh({ refreshToken: token })
  } catch (err) {
    request.log.warn({ event: 'auth.refresh_failed', errorClass: errClass(err) }, 'refresh failed')
    clearRefreshCookie(reply)
    return reply.code(401).send({ code: 'refresh_failed' })
  }
  // Rotation enabled → re-set the ROTATED token; the prior one is now invalid.
  if (tokens.refreshToken) setRefreshCookie(reply, tokens.refreshToken)
  return reply.send({ accessToken: tokens.accessToken, expiresIn: tokens.expiresIn })
}

async function handleLogout(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: AuthRoutesOpts,
): Promise<FastifyReply> {
  const token = request.cookies[REFRESH_COOKIE_NAME]
  if (token) {
    try {
      await opts.cognito.revoke({ token })
    } catch (err) {
      // Best-effort revoke: clear the cookie regardless (the already-issued
      // access JWT stays valid until exp ≤ 60m — accepted JWT tradeoff).
      request.log.warn({ event: 'auth.revoke_failed', errorClass: errClass(err) }, 'revoke failed; clearing cookie anyway')
    }
  }
  clearRefreshCookie(reply)
  return reply.code(204).send()
}

// eslint-disable-next-line @typescript-eslint/require-await
export const authRoutes: FastifyPluginAsync<AuthRoutesOpts> = async (app, opts) => {
  const config = { auth: 'public', rateLimit: RATE_LIMIT } as const
  app.post('/api/auth/session', { config }, (request, reply) => handleSession(request, reply, opts))
  app.post('/api/auth/refresh', { config }, (request, reply) => handleRefresh(request, reply, opts))
  app.post('/api/auth/logout', { config }, (request, reply) => handleLogout(request, reply, opts))
}
```

- [ ] **Step 7 — add the allowlist entries.** In `backend/src/auth/public-route-allowlist.ts`, add to the `PUBLIC_ROUTE_ALLOWLIST` set (with the required security-review note comment):

```ts
  // MYT-84: the BFF session endpoints. They are `public` (no JWT) because the
  // caller has no access token yet on /session, and /refresh + /logout
  // authenticate via the httpOnly refresh cookie (validated server-side by the
  // Cognito grant), NOT a Bearer. Login-CSRF on /session is bounded by
  // application/json-only (415 otherwise) + no form-body parser + CORS preflight.
  // SECURITY REVIEW REQUIRED on any change to these three entries.
  'POST /api/auth/session',
  'POST /api/auth/refresh',
  'POST /api/auth/logout',
```

Run (expect: green): `pnpm --filter @mythrun/backend test src/routes/__tests__/auth.test.ts`

- [ ] **Step 8 — wire into `backend/src/app.ts`.** Three edits:

  (a) Add imports near the other route imports:
```ts
import cookie from '@fastify/cookie'
import { authRoutes } from './routes/auth.js'
import { createCognitoOAuthClient } from './auth/cognito-oauth-client.js'
```

  (b) Flip the CORS `credentials` flag (and update the trailing comment) in the `app.register(cors, { ... })` block:
```ts
    // MYT-84: cookie-based refresh has landed — credentials:true so the browser
    // sends the httpOnly mythrun_refresh cookie on the credentialed /api/auth/*
    // fetches. Origin stays the single explicit frontendBaseUrl (never '*').
    credentials: true,
```

  (c) Register the cookie plugin + the auth routes — REAL mode only (the cookie/refresh model is jwt-mode; bypass/dev never touches it, and the Cognito client needs the real cognito config). Insert immediately AFTER `await app.register(accessControlAllowlist)`:
```ts
  // MYT-84 BFF session endpoints (GAP-B). jwt-mode only: the cookie/refresh model
  // is staging/prod; dev runs bypass and never hits these. Registered after the
  // rate-limit plugin (so config.rateLimit applies) and after the public-route
  // allowlist hook (top of buildApp), which validates their config.auth:'public'.
  if (config.env.authMode === 'real') {
    const { cognitoHostedUiDomain, cognitoAppClientId } = config.env
    if (cognitoHostedUiDomain === undefined || cognitoAppClientId === undefined) {
      throw new Error('buildApp: authMode=real requires cognitoHostedUiDomain + cognitoAppClientId')
    }
    await app.register(cookie)
    await app.register(authRoutes, {
      cognito: createCognitoOAuthClient({
        hostedUiDomain: cognitoHostedUiDomain,
        clientId: cognitoAppClientId,
      }),
      frontendBaseUrl: config.frontendBaseUrl,
    })
  }
```

- [ ] **Step 9 — verify + stage.** Run:
  - `pnpm --filter @mythrun/backend typecheck`
  - `pnpm --filter @mythrun/backend lint`
  - `pnpm --filter @mythrun/backend test src/auth/__tests__/cognito-oauth-client.test.ts src/routes/__tests__/auth.test.ts`
  - Full app-boot regression (CORS + real-mode registration): `pnpm --filter @mythrun/backend test src/__tests__` (or the app/boot test files) — confirm the bypass-mode boot tests still pass.

  Stage: `git add backend/package.json pnpm-lock.yaml backend/src/auth/cognito-oauth-client.ts backend/src/auth/__tests__/cognito-oauth-client.test.ts backend/src/auth/refresh-cookie.ts backend/src/routes/auth.ts backend/src/routes/__tests__/auth.test.ts backend/src/auth/public-route-allowlist.ts backend/src/app.ts` — do not commit.

> Reference (from project memory): a `pipelineRoute:true` route would ripple to five contracts; these are NOT pipeline routes, so only the public-route allowlist applies. After this lands, a full backend coverage + typecheck sweep is the controller's job — `backend pnpm typecheck` does NOT compile `backend/dev-tool/**`, but no dev-tool surface is touched here.

---

### Task 8: Theme mode — ThemeProvider/useTheme, ThemeToggle FAB, pre-paint script, Stack layout primitives, sun/moon glyphs

Builds the whole theme subsystem in `@mythrun/ui` (the web UI package — DOM-capable, like Spinner's `matchMedia`). Adds the two Stack layout props the genesis screens need, and the sun/moon Icon glyphs the FAB uses.

**Files**
- Create `frontend/client-core/src/contract/theme.ts` (`Theme`, `ThemeContextValue`, `ThemeToggleProps`)
- Modify `frontend/client-core/src/contract/index.ts` (export theme types)
- Modify `frontend/client-core/src/contract/icon.ts` (+`'sun'`,`'moon'`) and `frontend/client-core/src/contract/icon.test.ts` (extend the pinned union)
- Modify `frontend/ui/src/components/Icon/glyphs.ts` (sun + moon glyph paths)
- Modify `frontend/client-core/src/contract/stack.ts` (+`minHeight?:'screen'`, `grow?:boolean`) + `frontend/ui/src/components/Stack/Stack.tsx` + `Stack.test.tsx` + `Stack.stories.tsx`
- Create `frontend/ui/src/theme/theme-provider.tsx` + `theme-provider.test.tsx`
- Create `frontend/ui/src/components/ThemeToggle/ThemeToggle.tsx` + `ThemeToggle.test.tsx` + `ThemeToggle.stories.tsx`
- Modify `frontend/ui/src/index.ts` (export `ThemeProvider`, `useTheme`, `ThemeToggle` + types)
- Modify `frontend/index.html` (inline pre-paint script)
- Modify `frontend/src/app/providers.tsx` (mount `<ThemeProvider>` at the composition root)

**Interfaces**
- Produces: `useTheme(): { theme: 'light'|'dark'; toggle(): void; setTheme(t): void }`; `<ThemeProvider>`; `<ThemeToggle label={…} data-testid?=… />`; `IconName` gains `'sun'|'moon'`; `Stack` gains `minHeight`/`grow`.

**Steps**

1. Stack layout props. In `frontend/client-core/src/contract/stack.ts` add to `StackProps`:
```ts
  /** Floor the stack at the full dynamic viewport height (`100dvh`) — a full-screen flex column (e.g. a genesis screen / a centered splash). */
  minHeight?: 'screen'
  /** Grow to fill the available main-axis space of a flex parent (`flex: 1`). Use on the body region of a column whose sibling (a crown band) is fixed-height. */
  grow?: boolean
```
In `frontend/ui/src/components/Stack/Stack.tsx` add the two variants + thread them:
```tsx
const stack = cva('flex [&>*]:min-w-0', {
  variants: {
    direction: { row: 'flex-row', column: 'flex-col' },
    align: { start: 'items-start', center: 'items-center', end: 'items-end', stretch: 'items-stretch' },
    justify: { start: 'justify-start', center: 'justify-center', end: 'justify-end', between: 'justify-between' },
    wrap: { true: 'flex-wrap', false: '' },
    // Full dynamic-viewport floor (mirrors Box's minHeight="screen" — `dvh`, not
    // `vh`, so mobile chrome doesn't leave a gap). Full literal so the v4 scanner emits it.
    minHeight: { screen: 'min-h-dvh' },
    // flex-1 fill for the body region of a fixed-crown column.
    grow: { true: 'grow', false: '' },
  },
  defaultVariants: { direction: 'column' },
})

export const Stack = forwardRef<HTMLDivElement, StackProps>(function Stack(
  { direction = 'column', gap, align, justify, wrap, minHeight, grow = false, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        stack({ direction, align, justify, wrap, grow, ...(minHeight !== undefined && { minHeight }) }),
        gap !== undefined && GAP_CLASS[gap],
      )}
      {...rest}
    >
      {children}
    </div>
  )
})
```
Add a Stack test (append to `Stack.test.tsx`):
```tsx
it('applies the dvh floor when minHeight="screen"', () => {
  render(<Stack minHeight="screen" data-testid="s" />)
  expect(screen.getByTestId('s').className).toContain('min-h-dvh')
})
it('applies flex-grow when grow', () => {
  render(<Stack grow data-testid="s" />)
  expect(screen.getByTestId('s').className).toContain('grow')
})
```
Add a `FullHeightCentered` story to `Stack.stories.tsx` (a `minHeight="screen"` column with a fixed top band + a `grow justify=center align=center` body). Run: `cd frontend/ui && pnpm vitest run src/components/Stack/Stack.test.tsx`.

2. sun/moon glyphs + the closed-union pin. In `frontend/client-core/src/contract/icon.ts` extend the union (after `'square-alert'`):
```ts
  // Theme toggle (MYT-84) — the FAB's sun (light) / moon (dark) glyphs.
  | 'sun'
  | 'moon'
```
In `frontend/client-core/src/contract/icon.test.ts` add the two members to the `toEqualTypeOf<…>()` pinned union (after `'square-alert'`): `| 'sun' | 'moon'`.
In `frontend/ui/src/components/Icon/glyphs.ts` add to `GLYPHS` (pixel sun + crescent moon, 24-grid, matching the mockup's sun rays / crescent):
```ts
  // Theme-toggle glyphs (MYT-84). Pixel sun (centre square + 8 rays) and a
  // crescent moon, authored on the 24-grid to read at --icon-sm (16px).
  sun: {
    viewBox: VIEWBOX_24,
    paths: [
      'M10 10h4v4h-4zM11 3h2v3h-2zM11 18h2v3h-2zM3 11h3v2H3zM18 11h3v2h-3zM5 5h2v2H5zM17 5h2v2h-2zM5 17h2v2H5zM17 17h2v2h-2z',
    ],
  },
  moon: {
    viewBox: VIEWBOX_24,
    paths: ['M13 2h-2v2H9v2H7v2H5v2H3v4h2v2h2v2h2v2h2v2h2v-2H9v-2H7v-2H5v-4h2V8h2V6h2V4h2V2z', 'M13 2h2v2h-2zM15 4h2v2h-2zM13 18h2v2h-2zM15 16h2v2h-2z'],
  },
```
> The exact path data is a stand-in pixel form; the visual-audit step (Tasks 12/13 + the ThemeToggle story) confirms the sun/moon read cleanly at 16px — adjust the grid if not.

Run: `cd frontend/client-core && pnpm vitest run src/contract/icon.test.ts` then `cd frontend/ui && pnpm vitest run src/components/Icon/Icon.test.tsx`.

3. Theme contract. Create `frontend/client-core/src/contract/theme.ts`:
```ts
import type { BaseProps } from './index.ts'

/** The two themes the running app supports. */
export type Theme = 'light' | 'dark'

/** The value `useTheme()` returns (the ThemeProvider's context). DOM-free type — the impl (with the `<html>.dark` + localStorage side effects) lives in the web UI package. */
export interface ThemeContextValue {
  /** The active theme. */
  theme: Theme
  /** Flip light↔dark (and persist). */
  toggle: () => void
  /** Set an explicit theme (and persist). */
  setTheme: (theme: Theme) => void
}

/**
 * The canonical theme-toggle FAB. A square button with its OWN solid surface +
 * strong border so it floats cleanly ABOVE the dither crown (occluding it, never
 * embedded). Carries the pixel sun/moon Icon; ≥44px touch target; 0px radius.
 */
export interface ThemeToggleProps extends BaseProps {
  /** Accessible name (an i18n KEY the consumer resolves) for the icon-only control. */
  label: string
}
```
In `frontend/client-core/src/contract/index.ts` add:
```ts
export type { Theme, ThemeContextValue, ThemeToggleProps } from './theme.ts'
```

4. (TDD) Theme provider test. Create `frontend/ui/src/theme/theme-provider.test.tsx`:
```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { ThemeProvider, useTheme } from './theme-provider.tsx'

function Probe(): React.JSX.Element {
  const { theme, toggle, setTheme } = useTheme()
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button data-testid="toggle" onClick={toggle} />
      <button data-testid="to-dark" onClick={() => { setTheme('dark') }} />
    </div>
  )
}

function setMatch(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }),
  })
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  setMatch(false)
})
afterEach(() => { localStorage.clear(); document.documentElement.classList.remove('dark') })

describe('ThemeProvider / useTheme', () => {
  it('defaults to the system preference when nothing stored (dark)', () => {
    setMatch(true)
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(screen.getByTestId('theme').textContent).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('prefers the stored choice over the system preference', () => {
    setMatch(true)
    localStorage.setItem('mythrun-theme', 'light')
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(screen.getByTestId('theme').textContent).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('toggle flips the theme, applies .dark, and persists', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(screen.getByTestId('theme').textContent).toBe('light')
    act(() => { screen.getByTestId('toggle').click() })
    expect(screen.getByTestId('theme').textContent).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('mythrun-theme')).toBe('dark')
  })

  it('setTheme sets an explicit theme + persists', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    act(() => { screen.getByTestId('to-dark').click() })
    expect(localStorage.getItem('mythrun-theme')).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})
```
Run (red): `cd frontend/ui && pnpm vitest run src/theme/theme-provider.test.tsx`.

5. Create `frontend/ui/src/theme/theme-provider.tsx`:
```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Theme, ThemeContextValue } from '@mythrun/client-core/contract'

// The theme runtime. Lives in @mythrun/ui (the web UI package — DOM-capable, like
// Spinner's matchMedia) so the @mythrun/ui ThemeToggle can consume `useTheme()`
// (the brain stays DOM-free). Applies/removes `.dark` on <html>, persists to
// localStorage('mythrun-theme'); default = stored ?? prefers-color-scheme. A tiny
// inline script in index.html applies the class BEFORE React mounts (no FOUC);
// this provider reconciles to the same value, so there is no flip on hydrate.
const STORAGE_KEY = 'mythrun-theme'

function readStored(): Theme | null {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'light' || v === 'dark' ? v : null
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function resolveInitial(): Theme {
  return readStored() ?? (systemPrefersDark() ? 'dark' : 'light')
}

function applyClass(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [theme, setThemeState] = useState<Theme>(resolveInitial)

  // Keep <html>.dark in sync with state (covers the toggle + a hydrate where the
  // pre-paint script and the resolved state ever disagree).
  useEffect(() => {
    applyClass(theme)
  }, [theme])

  const setTheme = useCallback((next: Theme): void => {
    localStorage.setItem(STORAGE_KEY, next)
    setThemeState(next)
  }, [])

  const toggle = useCallback((): void => {
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark'
      localStorage.setItem(STORAGE_KEY, next)
      return next
    })
  }, [])

  const value = useMemo<ThemeContextValue>(() => ({ theme, toggle, setTheme }), [theme, toggle, setTheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/** Read the active theme + the toggle/set actions. Must be under a <ThemeProvider>. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (ctx === null) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}
```
Run (green): `cd frontend/ui && pnpm vitest run src/theme/theme-provider.test.tsx`.

6. (TDD) ThemeToggle test. Create `frontend/ui/src/components/ThemeToggle/ThemeToggle.test.tsx`:
```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { axe } from 'jest-axe'
import { ThemeProvider } from '../../theme/theme-provider.tsx'
import { ThemeToggle } from './ThemeToggle.tsx'

function setMatch(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (q: string) => ({ matches, media: q, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }),
  })
}

describe('ThemeToggle', () => {
  it('renders an accessible-named button and flips the theme on click', () => {
    setMatch(false)
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    render(<ThemeProvider><ThemeToggle label="Theme" /></ThemeProvider>)
    const btn = screen.getByRole('button', { name: 'Theme' })
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    btn.click()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('has no axe violations', async () => {
    setMatch(false)
    const { container } = render(<ThemeProvider><ThemeToggle label="Theme" /></ThemeProvider>)
    expect(await axe(container)).toHaveNoViolations()
  })
})
```
Run (red): `cd frontend/ui && pnpm vitest run src/components/ThemeToggle/ThemeToggle.test.tsx`.

7. Create `frontend/ui/src/components/ThemeToggle/ThemeToggle.tsx`:
```tsx
import { forwardRef } from 'react'
import type { ThemeToggleProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Icon } from '../Icon/Icon.tsx'
import { useTheme } from '../../theme/theme-provider.tsx'

// The canonical theme-toggle FAB (MYT-84 §11). A square button with its OWN solid
// `surface` + `border-strong` so it floats cleanly ABOVE the dither crown
// (occluding it — never embedded). Self-positioning: `fixed` top-right so the
// genesis screens render `<ThemeToggle/>` and it floats over the crown without the
// screen reaching for raw positioning (no-ad-hoc-ui). ≥44px on BOTH axes (always,
// not just coarse — a small floating control), 0px radius, theme-aware focus ring.
// The BUTTON carries the accessible name (`label`); the sun/moon Icon is decorative.
//
// Colors use the `bg-surface`/`text-ink`/`border-border-strong` token UTILITIES,
// which flip under `.dark` (the @theme-inline gotcha: never raw --color-* here).
// The glyph follows the theme: sun in light, moon in dark (matches the mockup).
export const ThemeToggle = forwardRef<HTMLButtonElement, ThemeToggleProps>(function ThemeToggle(
  { label, ...rest },
  ref,
) {
  const { theme, toggle } = useTheme()
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      onClick={toggle}
      className={cn(
        'fixed top-[var(--space-4)] right-[var(--space-4)] z-[var(--z-nav)]',
        'inline-flex items-center justify-center min-w-[44px] min-h-[44px] shrink-0',
        'rounded-none cursor-pointer select-none',
        'bg-surface text-ink border border-border-strong',
        'hover:bg-surface-hover active:bg-surface-active',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
      )}
      {...rest}
    >
      <Icon name={theme === 'dark' ? 'moon' : 'sun'} size="sm" decorative />
    </button>
  )
})
```
Run (green): `cd frontend/ui && pnpm vitest run src/components/ThemeToggle/ThemeToggle.test.tsx`.

8. Story (the story-coverage gate requires it). Create `frontend/ui/src/components/ThemeToggle/ThemeToggle.stories.tsx`:
```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ThemeToggle } from './ThemeToggle.tsx'
import { ThemeProvider } from '../../theme/theme-provider.tsx'

// ThemeToggle — the canonical theme FAB (MYT-84). A square button with its own
// solid surface + strong border so it floats ABOVE the dither crown; the sun/moon
// glyph follows the active theme; ≥44px touch target; 0px radius. Click it to flip
// the page theme (it drives the ThemeProvider, which toggles `.dark` on <html>).
const meta: Meta<typeof ThemeToggle> = {
  title: 'Controls/ThemeToggle',
  component: ThemeToggle,
  parameters: { overflowGate: false },
  decorators: [(Story) => <ThemeProvider><Story /></ThemeProvider>],
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof ThemeToggle>

export const Default: Story = { args: { label: 'Theme' } }
```
Run: `cd frontend/ui && node scripts/story-coverage.mjs` → exit 0 (ThemeToggle has a story).

9. Export from `@mythrun/ui`. In `frontend/ui/src/index.ts` add:
```ts
// Theme runtime (MYT-84) — the root ThemeProvider + the useTheme hook live in the
// web UI package so the ThemeToggle (and screens) can consume them.
export { ThemeProvider, useTheme } from './theme/theme-provider.tsx'
export { ThemeToggle } from './components/ThemeToggle/ThemeToggle.tsx'
```
and add `ThemeToggleProps`, `Theme`, `ThemeContextValue` to the big `export type { … } from '@mythrun/client-core/contract'` block.

10. Pre-paint script (no FOUC). In `frontend/index.html`, add inside `<head>` BEFORE the module script tag:
```html
    <script>
      // Pre-paint theme: apply .dark before React mounts so there is no
      // flash-of-wrong-theme. Mirrors ThemeProvider's resolution
      // (stored('mythrun-theme') ?? prefers-color-scheme). Kept tiny + inline.
      (function () {
        try {
          var t = localStorage.getItem('mythrun-theme')
          if (t !== 'light' && t !== 'dark') {
            t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
          }
          if (t === 'dark') document.documentElement.classList.add('dark')
        } catch (e) {}
      })()
    </script>
```

11. Mount `<ThemeProvider>` at the composition root. In `frontend/src/app/providers.tsx`, import and wrap the OUTERMOST provider:
```tsx
import { ThemeProvider } from '@mythrun/ui'
```
```tsx
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider value={apiContext}>
          <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
        </ApiClientProvider>
      </QueryClientProvider>
    </ThemeProvider>
  )
```
> Tests that render `routes` WITHOUT AppProviders (router.test/home.test) don't have a ThemeProvider — they don't render the auth screens (which call `useTheme`), so they're unaffected. The signin/onboard component tests (Tasks 12/13) wrap in `<ThemeProvider>` explicitly.

12. Run: `cd frontend/ui && pnpm vitest run src/ && pnpm typecheck` and `cd frontend/client-core && pnpm vitest run src/contract/`. **Controller commits** `feat(MYT-84): theme mode (ThemeProvider/useTheme/ThemeToggle), sun-moon glyphs, Stack screen/grow, no-FOUC script`.

---

### Task 9: Session store `'initializing'` 4th state + suspended flag + `RequireAuth` splash

The jwt-mode boot default becomes `initializing`; `RequireAuth` renders a neutral splash (no redirect) while initializing. Adds a `suspended` flag for the account-suspended branch (§2). (The QueryClient 4xx-skip retry predicate is owned by Task 3 — NOT duplicated here.)

**Files**
- Modify `frontend/client-core/src/stores/session.ts` (add state + actions)
- Modify `frontend/client-core/src/stores/session.test.ts` (TDD — extend)
- Modify `frontend/src/app/require-auth.tsx` (splash branch)
- Modify `frontend/src/app/require-auth.test.tsx` (NEW if absent — splash assertion)
- Modify `frontend/src/app/router.test.tsx` (default is now `initializing` → seed `unauthenticated` explicitly; add splash case)
- Modify `frontend/client-core/src/i18n/locales/en/common.json` + `frontend/client-core/src/i18n/descriptions.ts` (add `splash.loading`)

**Interfaces**
- Produces: `SessionStatus = 'initializing'|'unauthenticated'|'onboarding-required'|'ready'` (default `'initializing'`); `SessionState.suspended: boolean`; actions `setUnauthenticated()`, `setSuspended()`, `setOnboardingRequired(sub)`, `setReady(sub)`, `setInitializing()`.

**Steps**

1. (TDD) Extend the store test. Append to `frontend/client-core/src/stores/session.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore } from './session.ts'

describe('session store — initializing + suspended (MYT-84)', () => {
  beforeEach(() => {
    useSessionStore.setState({ status: 'initializing', sub: null, suspended: false })
  })

  it('defaults to initializing with no sub and not suspended', () => {
    const s = useSessionStore.getState()
    expect(s.status).toBe('initializing')
    expect(s.sub).toBeNull()
    expect(s.suspended).toBe(false)
  })

  it('setReady moves to ready and carries the sub, clearing suspended', () => {
    useSessionStore.getState().setSuspended()
    useSessionStore.getState().setReady('sub-123')
    const s = useSessionStore.getState()
    expect(s.status).toBe('ready')
    expect(s.sub).toBe('sub-123')
    expect(s.suspended).toBe(false)
  })

  it('setOnboardingRequired moves to onboarding-required with the sub', () => {
    useSessionStore.getState().setOnboardingRequired('sub-9')
    expect(useSessionStore.getState().status).toBe('onboarding-required')
    expect(useSessionStore.getState().sub).toBe('sub-9')
  })

  it('setSuspended is unauthenticated + suspended, sub cleared', () => {
    useSessionStore.getState().setReady('sub-1')
    useSessionStore.getState().setSuspended()
    const s = useSessionStore.getState()
    expect(s.status).toBe('unauthenticated')
    expect(s.sub).toBeNull()
    expect(s.suspended).toBe(true)
  })

  it('setUnauthenticated clears suspended', () => {
    useSessionStore.getState().setSuspended()
    useSessionStore.getState().setUnauthenticated()
    expect(useSessionStore.getState().suspended).toBe(false)
  })

  it('setInitializing returns to the boot state', () => {
    useSessionStore.getState().setReady('sub-1')
    useSessionStore.getState().setInitializing()
    expect(useSessionStore.getState().status).toBe('initializing')
    expect(useSessionStore.getState().sub).toBeNull()
  })
})
```
Run (red): `cd frontend/client-core && pnpm vitest run src/stores/session.test.ts` → fails (no `initializing`/`suspended`/`setSuspended`/`setInitializing`).

2. Rewrite `frontend/client-core/src/stores/session.ts`:
```ts
import { create } from 'zustand'

// The session store: the client brain's single source of truth for the player's
// auth lifecycle. Tiny + DOM-free (R1) so the same logic drives web today and a
// native shell later. The platform adapters that ACQUIRE identity (the session
// adapter on the callback + on-load bootstrap) call these transitions.

/**
 * The four auth states, in lifecycle order:
 * - `initializing` — boot: the on-load refresh has not settled yet (jwt mode).
 *   `RequireAuth` shows a splash, NOT a redirect, while in this state.
 * - `unauthenticated` — no identity (logged out / pre-login / refresh failed).
 * - `onboarding-required` — identity known, profile not yet finalised.
 * - `ready` — fully provisioned; the app is playable.
 */
export type SessionStatus = 'initializing' | 'unauthenticated' | 'onboarding-required' | 'ready'

export interface SessionState {
  status: SessionStatus
  /** The Cognito `sub` of the signed-in player, or `null` when not ready/onboarding. */
  sub: string | null
  /** True after an `account_suspended` rejection — the sign-in screen surfaces a notice. */
  suspended: boolean
  /** Return to the boot state (used by logout-then-rebootstrap paths / tests). */
  setInitializing: () => void
  /** Transition to logged-out: clears the sub and the suspended flag. */
  setUnauthenticated: () => void
  /** Logged-out due to suspension: unauthenticated + the suspended notice flag. */
  setSuspended: () => void
  /** Transition to "identity known, profile incomplete". */
  setOnboardingRequired: (sub: string) => void
  /** Transition to fully-provisioned. */
  setReady: (sub: string) => void
}

export const useSessionStore = create<SessionState>((set) => ({
  status: 'initializing',
  sub: null,
  suspended: false,
  setInitializing: () => {
    set({ status: 'initializing', sub: null, suspended: false })
  },
  setUnauthenticated: () => {
    set({ status: 'unauthenticated', sub: null, suspended: false })
  },
  setSuspended: () => {
    set({ status: 'unauthenticated', sub: null, suspended: true })
  },
  setOnboardingRequired: (sub) => {
    set({ status: 'onboarding-required', sub, suspended: false })
  },
  setReady: (sub) => {
    set({ status: 'ready', sub, suspended: false })
  },
}))
```
Run (green): `cd frontend/client-core && pnpm vitest run src/stores/session.test.ts` → all pass.

3. Add the splash i18n key. In `frontend/client-core/src/i18n/locales/en/common.json`, add a top-level block (after `"frame"`):
```json
  "splash": {
    "loading": "[ph_splash_loading: a brief 'getting things ready' line]"
  },
```
In `frontend/client-core/src/i18n/descriptions.ts`, add the matching entry (the drift test gates this 1:1):
```ts
  'splash.loading': 'Accessible loading label on the boot splash shown while the on-load session refresh settles. Short (~2-4 words).',
```
Run: `cd frontend/client-core && pnpm vitest run src/i18n/resources.test.ts` → green (no orphan / missing key).

4. (TDD) RequireAuth splash test. Create/extend `frontend/src/app/require-auth.test.tsx`:
```tsx
import { render, screen, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { useSessionStore } from '@mythrun/client-core'
import { afterEach, describe, expect, it } from 'vitest'
import { routes } from './router.tsx'
import { i18n } from '../i18n/config.ts'

afterEach(() => {
  act(() => {
    useSessionStore.getState().setUnauthenticated()
  })
})

function renderAt(path: string): void {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  )
}

describe('RequireAuth — initializing splash (MYT-84)', () => {
  it('renders the splash (no redirect) while initializing', () => {
    act(() => {
      useSessionStore.getState().setInitializing()
    })
    renderAt('/home')
    expect(screen.getByTestId('auth-splash')).toBeDefined()
    // It must NOT have bounced to the sign-in screen.
    expect(screen.queryByTestId('route-signin')).toBeNull()
  })

  it('redirects to sign-in once unauthenticated', () => {
    act(() => {
      useSessionStore.getState().setUnauthenticated()
    })
    renderAt('/home')
    expect(screen.getByTestId('route-signin')).toBeDefined()
  })
})
```
Run (red): `cd frontend && pnpm vitest run src/app/require-auth.test.tsx` → fails (no `auth-splash`).

5. Rewrite `frontend/src/app/require-auth.tsx` (add the splash branch; keep the two redirects):
```tsx
import { Navigate, Outlet } from 'react-router-dom'
import { Box, Stack, Spinner } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '@mythrun/client-core'

// The auth gate the whole authed tree hangs on. It reads ONLY the session store's
// `status` (the client brain's single source of truth, R1) — no token parsing, no
// backend call, no local intelligence:
//
//   initializing        → render a neutral splash (NOT a redirect): the on-load
//                          refresh has not settled, so we must not race it to
//                          sign-in. The boot bootstrap transitions us out of this.
//   unauthenticated     → bounce to sign-in (no identity yet)
//   onboarding-required → bounce to onboarding (identity known, profile not)
//   ready               → render the matched authed route (<Outlet/>)
//
// `replace` keeps the pre-auth URL out of history so Back doesn't loop the gate.
export function RequireAuth(): React.JSX.Element {
  const { t } = useTranslation()
  const status = useSessionStore((s) => s.status)

  if (status === 'initializing') {
    return (
      <Stack align="center" justify="center" minHeight="screen" data-testid="auth-splash">
        <Box padding={6}>
          <Spinner label={t('splash.loading')} />
        </Box>
      </Stack>
    )
  }
  if (status === 'unauthenticated') {
    return <Navigate to="/auth/signin" replace />
  }
  if (status === 'onboarding-required') {
    return <Navigate to="/auth/onboard" replace />
  }
  return <Outlet />
}
```
> NOTE: `<Stack minHeight="screen">` requires the Stack `minHeight` prop added in **Task 8 step 1**. Sequence Task 8 before this step's green run, or temporarily use `<Stack align="center" justify="center">` and add `minHeight` when Task 8 lands.

Run (green): `cd frontend && pnpm vitest run src/app/require-auth.test.tsx` → pass.

6. Fix `frontend/src/app/router.test.tsx`: the store default is now `initializing`, so the first existing case ("redirects … when unauthenticated") must seed `unauthenticated` explicitly before `renderAt`. Edit that test to add, as the first line of the `it`:
```tsx
    act(() => {
      useSessionStore.getState().setUnauthenticated()
    })
```
(the `afterEach` already resets to `unauthenticated`, but the FIRST test ran on the old `unauthenticated` default — now it would render the splash). Run: `cd frontend && pnpm vitest run src/app/router.test.tsx` → pass.

7. **Controller commits:** `git add frontend/client-core/src/stores/session.ts frontend/client-core/src/stores/session.test.ts frontend/src/app/require-auth.tsx frontend/src/app/require-auth.test.tsx frontend/src/app/router.test.tsx frontend/client-core/src/i18n/locales/en/common.json frontend/client-core/src/i18n/descriptions.ts` then commit `feat(MYT-84): session 'initializing' + suspended state, RequireAuth splash`.

---

### Task 10: Session adapter (`applyMe` + `bootstrapSession`) + JWT sub decode + boot wiring

The `/me` → store mapping, applied IDENTICALLY on the callback path (Task 11) and the on-load bootstrap (main.tsx). `sub` is read from the **access-token `sub` claim** via a structural decoder.

**Files**
- Create `frontend/client-core/src/auth/jwt-claims.ts`
- Create `frontend/client-core/src/auth/jwt-claims.test.ts` (TDD)
- Create `frontend/client-core/src/auth/session-adapter.ts`
- Create `frontend/client-core/src/auth/session-adapter.test.ts` (TDD)
- Modify `frontend/client-core/src/index.ts` (export `applyMe`, `bootstrapSession`)
- Modify `frontend/src/main.tsx` (jwt branch fires `bootstrapSession`)
- Modify `frontend/src/app/providers.tsx` (export `toApiContext(config)` helper reused by main.tsx)

**Interfaces**
- Consumes (transport tasks): `getAccessToken(): string | null`, `runRefresh(): Promise<boolean>` (bare named exports from `@mythrun/client-core` — Task 2); `HttpError.code?: string` populated from the error body (Task 3).
- Consumes (existing): `getMe(undefined, ctx)` (`client-core/src/api/users.ts`), `useSessionStore`, `HttpError`/`isHttpError`, `ApiContext`.
- Produces: `applyMe(ctx: ApiContext): Promise<void>`, `bootstrapSession(ctx: ApiContext): Promise<void>`, `readSubClaim(token: string): string | null`.

**Steps**

1. (TDD) JWT decode test. Create `frontend/client-core/src/auth/jwt-claims.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { readSubClaim } from './jwt-claims.ts'

// Build a JWT with the given payload (header.payload.sig — sig unused; we only
// read the payload, never verify — verification is the backend's job).
function jwt(payload: Record<string, unknown>): string {
  const b64url = (o: unknown): string =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`
}

describe('readSubClaim', () => {
  it('reads the sub claim from a well-formed token', () => {
    expect(readSubClaim(jwt({ sub: 'cognito-uuid-1', token_use: 'access' }))).toBe('cognito-uuid-1')
  })
  it('returns null when sub is missing', () => {
    expect(readSubClaim(jwt({ token_use: 'access' }))).toBeNull()
  })
  it('returns null when sub is not a string', () => {
    expect(readSubClaim(jwt({ sub: 42 }))).toBeNull()
  })
  it('returns null for a malformed (non-three-part) token', () => {
    expect(readSubClaim('not-a-jwt')).toBeNull()
  })
  it('returns null when the payload is not base64url JSON', () => {
    expect(readSubClaim('aaa.@@@.bbb')).toBeNull()
  })
})
```
Run (red): `cd frontend/client-core && pnpm vitest run src/auth/jwt-claims.test.ts`.

2. Create `frontend/client-core/src/auth/jwt-claims.ts`:
```ts
// Structural read of a single claim out of a JWT payload — NO verification.
// The backend verifies the access token (signature, audience, token_use); the
// client reads `sub` purely as the opaque routing id for the session store (the
// same immutable id the backend trusts and bypass-mode seeds). A base64url JSON
// decode is mechanical structure-extraction (ZFC-allowed), not intelligence.
//
// Universal (web + RN): no DOM globals — base64 via the standard `atob` (present
// in browsers and Node ≥16). Any malformation → `null` (the caller falls back).

function decodeBase64UrlToJson(segment: string): unknown {
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    const json = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    )
    return JSON.parse(json)
  } catch {
    return null
  }
}

/** The `sub` claim of a JWT, or `null` if absent / not a string / malformed. */
export function readSubClaim(token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const payload = decodeBase64UrlToJson(parts[1] ?? '')
  if (typeof payload !== 'object' || payload === null) return null
  const sub = (payload as { sub?: unknown }).sub
  return typeof sub === 'string' ? sub : null
}
```
Run (green): `cd frontend/client-core && pnpm vitest run src/auth/jwt-claims.test.ts`.

3. (TDD) Session-adapter test. Create `frontend/client-core/src/auth/session-adapter.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '../api/errors.ts'
import { useSessionStore } from '../stores/session.ts'
import type { ApiContext } from '../api/endpoint.ts'

const getMeMock = vi.fn()
const getAccessTokenMock = vi.fn<() => string | null>()
const runRefreshMock = vi.fn<() => Promise<boolean>>()

vi.mock('../api/users.ts', () => ({ getMe: (...a: unknown[]) => getMeMock(...a) }))
vi.mock('./token-manager.ts', () => ({
  getAccessToken: () => getAccessTokenMock(),
  runRefresh: () => runRefreshMock(),
}))

// Imported AFTER the mocks so the adapter binds to them.
const { applyMe, bootstrapSession } = await import('./session-adapter.ts')

// A token whose payload carries sub = 'cognito-1' (header.payload.sig).
const TOKEN =
  'eyJhbGciOiJub25lIn0.' +
  Buffer.from(JSON.stringify({ sub: 'cognito-1' })).toString('base64url') +
  '.sig'

const ctx: ApiContext = { baseUrl: 'http://api.test', getAuthHeaders: () => Promise.resolve({}) }

beforeEach(() => {
  useSessionStore.setState({ status: 'initializing', sub: null, suspended: false })
  getMeMock.mockReset()
  getAccessTokenMock.mockReset().mockReturnValue(TOKEN)
  runRefreshMock.mockReset()
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('applyMe', () => {
  it('200 → ready with the sub from the access token', async () => {
    getMeMock.mockResolvedValue({ user: { id: 'db-id', username: 'u', displayName: 'U', freeTrialUsed: false, createdAt: '2026-01-01T00:00:00.000Z' } })
    await applyMe(ctx)
    expect(useSessionStore.getState().status).toBe('ready')
    expect(useSessionStore.getState().sub).toBe('cognito-1')
  })

  it('403 username_required → onboarding-required', async () => {
    getMeMock.mockRejectedValue(new HttpError(403, 'Forbidden', 'username_required'))
    await applyMe(ctx)
    expect(useSessionStore.getState().status).toBe('onboarding-required')
    expect(useSessionStore.getState().sub).toBe('cognito-1')
  })

  it('403 account_suspended → unauthenticated + suspended', async () => {
    getMeMock.mockRejectedValue(new HttpError(403, 'Forbidden', 'account_suspended'))
    await applyMe(ctx)
    expect(useSessionStore.getState().status).toBe('unauthenticated')
    expect(useSessionStore.getState().suspended).toBe(true)
  })

  it('401 (or any other failure) → unauthenticated', async () => {
    getMeMock.mockRejectedValue(new HttpError(401, 'Unauthorized'))
    await applyMe(ctx)
    expect(useSessionStore.getState().status).toBe('unauthenticated')
    expect(useSessionStore.getState().suspended).toBe(false)
  })
})

describe('bootstrapSession', () => {
  it('refresh true → applyMe runs (200 → ready)', async () => {
    runRefreshMock.mockResolvedValue(true)
    getMeMock.mockResolvedValue({ user: { id: 'db-id', username: 'u', displayName: 'U', freeTrialUsed: false, createdAt: '2026-01-01T00:00:00.000Z' } })
    await bootstrapSession(ctx)
    expect(useSessionStore.getState().status).toBe('ready')
  })

  it('refresh false (no/invalid cookie) → unauthenticated, no /me call', async () => {
    runRefreshMock.mockResolvedValue(false)
    await bootstrapSession(ctx)
    expect(getMeMock).not.toHaveBeenCalled()
    expect(useSessionStore.getState().status).toBe('unauthenticated')
  })
})
```
> The `HttpError` 3-arg constructor `(status, statusText, code?)` is Task 3's `HttpError.code` change (the 4-arg ctor `(status, message, code?, body?)` accepts the 3-arg form). The token-manager mock + the adapter both bind the BARE named exports `getAccessToken` / `runRefresh` (Task 2's exports — there is no `tokenManager` namespace object).

Run (red): `cd frontend/client-core && pnpm vitest run src/auth/session-adapter.test.ts`.

4. Create `frontend/client-core/src/auth/session-adapter.ts`:
```ts
import { getMe } from '../api/users.ts'
import { isHttpError } from '../api/errors.ts'
import { useSessionStore } from '../stores/session.ts'
import { readSubClaim } from './jwt-claims.ts'
import { getAccessToken, runRefresh } from './token-manager.ts'
import type { ApiContext } from '../api/endpoint.ts'

// The `/me` → session-store mapping, applied IDENTICALLY on the OAuth callback
// (after createSession sets the access token) and on the on-load bootstrap (after
// a successful refresh). `useMe` is NEVER the onboarding-discovery seam — the
// adapter settles the store BEFORE the Hub's `useMe` runs.
//
// `sub` is the access-token `sub` claim (the immutable Cognito id the backend
// trusts), read for BOTH the 200 and the 403 paths — the 403 has no body, and the
// 200 body's `user.id` is the DB row id, not the Cognito sub. Decoded structurally
// (no verification — that is the backend's job).

function currentSub(): string {
  const token = getAccessToken()
  return (token !== null ? readSubClaim(token) : null) ?? ''
}

/** Resolve the access-token-bearing session: GET /me, map status → store. */
export async function applyMe(ctx: ApiContext): Promise<void> {
  const store = useSessionStore.getState()
  try {
    await getMe(undefined, ctx)
    store.setReady(currentSub())
  } catch (err) {
    if (isHttpError(err) && err.status === 403 && err.code === 'username_required') {
      store.setOnboardingRequired(currentSub())
      return
    }
    if (isHttpError(err) && err.status === 403 && err.code === 'account_suspended') {
      store.setSuspended()
      return
    }
    // 401 / network / contract drift → no usable session.
    store.setUnauthenticated()
  }
}

/** Boot: attempt the on-load refresh; success → applyMe; failure → unauthenticated. */
export async function bootstrapSession(ctx: ApiContext): Promise<void> {
  const ok = await runRefresh()
  if (ok) {
    await applyMe(ctx)
    return
  }
  useSessionStore.getState().setUnauthenticated()
}
```
Run (green): `cd frontend/client-core && pnpm vitest run src/auth/session-adapter.test.ts`.

5. Export from the barrel. In `frontend/client-core/src/index.ts`, add (after the session-store block):
```ts
// Session adapter — the /me → store mapping + the on-load bootstrap (MYT-84).
export { applyMe, bootstrapSession } from './auth/session-adapter.ts'
export { readSubClaim } from './auth/jwt-claims.ts'
```

6. Boot wiring. In `frontend/src/app/providers.tsx`, export a context builder so main.tsx and AppProviders construct it identically. Add:
```tsx
/** The resolved ApiContext for a config — shared by AppProviders + the boot bootstrap. */
export function toApiContext(config: AppProvidersConfig): ApiContext {
  return { baseUrl: config.baseUrl, getAuthHeaders: getAuthHeaders(toAuthHeaderOptions(config)) }
}
```
and have the existing `apiContext` useMemo call it:
```tsx
  const apiContext = useMemo<ApiContext>(() => toApiContext(config), [config])
```

7. In `frontend/src/main.tsx`, add `bootstrapSession` to the `@mythrun/client-core` import and `toApiContext` to the providers import, then add the fire-and-forget bootstrap call INTO the existing `jwt` `else` branch (the branch Task 5 created for `configureOAuth`) — it transitions the store; the splash covers the gap; §3 rejects AWAITING before createRoot, not FIRING it:
```tsx
import { useSessionStore, configureOAuth, bootstrapSession } from '@mythrun/client-core'
import { App } from './app.tsx'
import { type AppProvidersConfig, toApiContext } from './app/providers.tsx'
```
```tsx
if (config.authMode === 'bypass') {
  useSessionStore.getState().setReady(config.devSub)
} else {
  // jwt mode: wire the OAuth helper once (Task 5) …
  configureOAuth({ store: createWebOAuthStateStore(), cognito: { /* …Task 5… */ } })
  // … then kick the on-load refresh → /me mapping. The store stays `initializing`
  // (its default) until this settles — RequireAuth shows the splash meanwhile.
  // Transitions to ready / onboarding-required / unauthenticated. Fire-and-forget:
  // it must NOT block first paint (spec §3).
  void bootstrapSession(toApiContext(config))
}
```
> COORDINATION: this step adds ONLY the `void bootstrapSession(...)` line (+ the two imports) to the `else` branch Task 5 already established. Task 2's getAuthHeaders/secureStorage refactor changes `AppProvidersConfig`'s jwt variant (dropping `secureStorage` from the auth seam) and `toAuthHeaderOptions`; keep the bootstrap call shape (`toApiContext(config)`) — Task 2 owns the getAuthHeaders internals.

8. Run the suite: `cd frontend/client-core && pnpm vitest run src/auth/ src/stores/` then `cd frontend && pnpm vitest run src/app/`. **Controller commits** `feat(MYT-84): session adapter (applyMe/bootstrapSession) + jwt sub decode + boot wiring`.

---

### Task 11: OAuth callback route handler

`/auth/callback` (bare, no `:provider`): consume the OAuth state, re-validate the return-to, exchange the code, set the token, run the adapter, navigate. StrictMode single-use dedup.

> Follows the **canonical oauth API** (Task 5): `parseCallback(search) → { code; state } | { error }` (parse-only) + a SEPARATE `consumeAuthState(parsed.state) → { provider; returnTo; verifier } | null` (single-use take). Token-manager access uses Task 2's bare `setAccessToken` export.

**Files**
- Modify `frontend/src/app/router.tsx` (collapse `auth/callback/:provider` → `auth/callback`)
- Modify `frontend/src/app/router.test.tsx` (update the callback path assertion if present)
- Rewrite `frontend/src/routes/callback.tsx`
- Create `frontend/src/routes/callback.test.tsx` (TDD/component)
- Modify `frontend/src/routes/callback.stories.tsx` (entry `/auth/callback`)
- Modify `frontend/client-core/src/i18n/locales/en/common.json` + `descriptions.ts` (`callback.*`; remove `stub.callback`)

**Interfaces**
- Consumes (`@mythrun/client-core`): `parseCallback(search) → { code: string; state: string } | { error: string }`, `consumeAuthState(state) → { provider; returnTo; verifier } | null`, `isLocalPath(returnTo) → boolean`, `createSession({ code, codeVerifier }) → { accessToken; expiresIn; name: string | null }`, `setAccessToken(token, expiresIn)` (Task 2 bare export), `applyMe(ctx)` (Task 10).
- Consumes (existing): `useApiContext`, react-router `useLocation`/`useNavigate`, `useSessionStore` (read `status`).

**Steps**

1. Collapse the route. In `frontend/src/app/router.tsx`:
```tsx
      { path: 'auth/callback', element: <CallbackRoute /> },
```
(was `auth/callback/:provider`). If `router.test.tsx` asserts the `:provider` form, update its entry to `/auth/callback?code=x&state=y`.

2. (TDD) Component test. Create `frontend/src/routes/callback.test.tsx`:
```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ApiClientProvider, useSessionStore, type ApiContext } from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'

const parseCallback = vi.fn()
const consumeAuthState = vi.fn()
const isLocalPath = vi.fn()
const createSession = vi.fn()
const setAccessToken = vi.fn()
const applyMe = vi.fn<(ctx: ApiContext) => Promise<void>>()

vi.mock('@mythrun/client-core', async (orig) => {
  const actual = await orig<typeof import('@mythrun/client-core')>()
  return {
    ...actual,
    parseCallback: (...a: unknown[]) => parseCallback(...a),
    consumeAuthState: (...a: unknown[]) => consumeAuthState(...a),
    isLocalPath: (...a: unknown[]) => isLocalPath(...a),
    createSession: (...a: unknown[]) => createSession(...a),
    applyMe: (...a: unknown[]) => applyMe(...a),
    setAccessToken: (...a: unknown[]) => setAccessToken(...a),
  }
})

// Imported AFTER the mock (the route binds the mocked members).
const { CallbackRoute } = await import('./callback.tsx')

const ctx: ApiContext = { baseUrl: 'http://api.test', getAuthHeaders: () => Promise.resolve({}) }

function renderCallback(search: string): void {
  const router = createMemoryRouter(
    [
      { path: '/auth/callback', element: <CallbackRoute /> },
      { path: '/home', element: <div data-testid="at-home" /> },
      { path: '/auth/onboard', element: <div data-testid="at-onboard" /> },
      { path: '/join/:code', element: <div data-testid="at-join" /> },
    ],
    { initialEntries: [`/auth/callback${search}`] },
  )
  render(
    <ApiClientProvider value={ctx}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </ApiClientProvider>,
  )
}

beforeEach(() => {
  useSessionStore.setState({ status: 'initializing', sub: null, suspended: false })
  for (const m of [parseCallback, consumeAuthState, isLocalPath, createSession, setAccessToken, applyMe]) m.mockReset()
  isLocalPath.mockReturnValue(true)
  createSession.mockResolvedValue({ accessToken: 'at', expiresIn: 3600, name: 'Aria' })
})
afterEach(() => { vi.clearAllMocks() })

describe('CallbackRoute', () => {
  it('exchanges the code and navigates to the return-to when ready', async () => {
    parseCallback.mockReturnValue({ code: 'auth-code', state: 'st' })
    consumeAuthState.mockReturnValue({ provider: 'google', returnTo: '/join/abc', verifier: 'v' })
    applyMe.mockImplementation((c: ApiContext) => {
      void c
      act(() => { useSessionStore.getState().setReady('sub-1') })
      return Promise.resolve()
    })

    renderCallback('?code=auth-code&state=st')

    await waitFor(() => { expect(screen.getByTestId('at-join')).toBeDefined() })
    expect(createSession).toHaveBeenCalledWith({ code: 'auth-code', codeVerifier: 'v' }, ctx)
    expect(setAccessToken).toHaveBeenCalledWith('at', 3600)
  })

  it('navigates to onboard (carrying name + returnTo) when onboarding-required', async () => {
    parseCallback.mockReturnValue({ code: 'c', state: 'st' })
    consumeAuthState.mockReturnValue({ provider: 'discord', returnTo: '/home', verifier: 'v' })
    applyMe.mockImplementation(() => {
      act(() => { useSessionStore.getState().setOnboardingRequired('sub-2') })
      return Promise.resolve()
    })
    renderCallback('?code=c&state=st')
    await waitFor(() => { expect(screen.getByTestId('at-onboard')).toBeDefined() })
  })

  it('shows the error state when the state does not match (consumeAuthState null)', async () => {
    parseCallback.mockReturnValue({ code: 'c', state: 'forged' })
    consumeAuthState.mockReturnValue(null)
    renderCallback('?code=c&state=forged')
    await waitFor(() => { expect(screen.getByTestId('callback-error')).toBeDefined() })
    expect(createSession).not.toHaveBeenCalled()
  })

  it('shows the error state when parseCallback reports an error (provider denial)', async () => {
    parseCallback.mockReturnValue({ error: 'access_denied' })
    renderCallback('?error=access_denied')
    await waitFor(() => { expect(screen.getByTestId('callback-error')).toBeDefined() })
    expect(consumeAuthState).not.toHaveBeenCalled()
  })

  it('runs the exchange exactly once under StrictMode double-mount', async () => {
    parseCallback.mockReturnValue({ code: 'once', state: 'st' })
    consumeAuthState.mockReturnValue({ provider: 'google', returnTo: '/home', verifier: 'v' })
    applyMe.mockImplementation(() => {
      act(() => { useSessionStore.getState().setReady('sub-1') })
      return Promise.resolve()
    })
    renderCallback('?code=once&state=st')
    await waitFor(() => { expect(screen.getByTestId('at-home')).toBeDefined() })
    expect(createSession).toHaveBeenCalledTimes(1)
  })
})
```
Run (red): `cd frontend && pnpm vitest run src/routes/callback.test.tsx`.

3. Rewrite `frontend/src/routes/callback.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Box, Stack, Spinner, Text } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import {
  useApiContext,
  useSessionStore,
  parseCallback,
  consumeAuthState,
  isLocalPath,
  createSession,
  applyMe,
  setAccessToken,
} from '@mythrun/client-core'

// The OAuth callback (`/auth/callback?code=…&state=…`). It verifies the opaque
// `state` against the value stashed at sign-in (CSRF), re-validates the carried
// return-to is a LOCAL path, exchanges {code, codeVerifier} at POST /api/auth/session,
// stores the access token IN MEMORY, runs the session adapter (/me → store), and
// navigates: to the return-to when `ready`, to `/auth/onboard` (carrying the pre-fill
// name + return-to) when `onboarding-required`. The OAuth `state` is single-use
// (consumed here), so the return-to is RE-PERSISTED onto the onboard navigation's
// router location state to survive the onboard detour (spec §7).
//
// `code` is single-use too: a module-level guard makes the exchange run exactly
// once even under React StrictMode's dev double-mount (which re-runs effects).
const processedCodes = new Set<string>()

export function CallbackRoute(): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  const navigate = useNavigate()
  const { search } = useLocation()
  const ran = useRef(false)
  const [errored, setErrored] = useState(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    const parsed = parseCallback(search)
    if ('error' in parsed) {
      setErrored(true)
      return
    }
    if (processedCodes.has(parsed.code)) return
    processedCodes.add(parsed.code)

    const stored = consumeAuthState(parsed.state)
    if (stored === null) {
      setErrored(true)
      return
    }
    const returnTo = stored.returnTo !== null && isLocalPath(stored.returnTo) ? stored.returnTo : '/'

    const run = async (): Promise<void> => {
      const session = await createSession({ code: parsed.code, codeVerifier: stored.verifier }, ctx)
      setAccessToken(session.accessToken, session.expiresIn)
      await applyMe(ctx)
      const status = useSessionStore.getState().status
      if (status === 'ready') {
        navigate(returnTo, { replace: true })
      } else if (status === 'onboarding-required') {
        navigate('/auth/onboard', { replace: true, state: { name: session.name, returnTo } })
      } else {
        setErrored(true)
      }
    }
    void run().catch(() => {
      setErrored(true)
    })
  }, [search, ctx, navigate])

  if (errored) {
    return (
      <Stack align="center" justify="center" minHeight="screen" data-testid="callback-error">
        <Box padding={6}>
          <Text as="p" role="prose-body">
            {t('callback.error')}
          </Text>
        </Box>
      </Stack>
    )
  }
  return (
    <Stack align="center" justify="center" minHeight="screen" data-testid="route-callback">
      <Box padding={6}>
        <Spinner label={t('callback.loading')} />
      </Box>
    </Stack>
  )
}
```
> `<Stack minHeight="screen">` needs Task 8 step 1.

Run (green): `cd frontend && pnpm vitest run src/routes/callback.test.tsx`.

4. i18n. In `common.json` add (and remove `"callback"` from the `"stub"` block):
```json
  "callback": {
    "loading": "[ph_callback_loading: a brief 'signing you in' line]",
    "error": "[ph_callback_error: ~1 sentence — sign-in couldn't complete, plus a nudge to try again]"
  },
```
In `descriptions.ts` add and remove `'stub.callback'`:
```ts
  'callback.loading': 'Loading label on the OAuth callback screen while the code is exchanged. Short.',
  'callback.error': "Error message on the OAuth callback screen when the exchange fails or state doesn't match. ~1 sentence with a retry nudge.",
```
Run: `cd frontend/client-core && pnpm vitest run src/i18n/resources.test.ts`.

5. Update `frontend/src/routes/callback.stories.tsx` entry to `/auth/callback` (the ScreenHarness renders the spinner/error path — the OAuth mocks aren't wired in Storybook, so it lands on `callback-error` or the spinner; assert `route-callback` OR `callback-error`). Minimal:
```tsx
export const Default: Story = {
  render: () => <ScreenHarness entry="/auth/callback" session="unauthenticated" />,
  play: expectScreen('callback-error'),
}
```
(With no `?state`, `consumeAuthState` returns null → the error state renders deterministically.)

6. **Controller commits** `feat(MYT-84): bare /auth/callback handler (state CSRF + exchange + adapter + StrictMode dedup)`.

---

### Task 12: Sign-in screen (genesis title composition)

The §11 title screen matching `signin-title-fab.html`: the genesis crown (theme-driven Dither), the `Mythrun` wordmark, a placeholder tagline, two `secondary` provider Buttons that begin the OAuth flow, the `ThemeToggle` FAB. A suspended notice when the store's `suspended` flag is set.

> Follows the **canonical oauth API** (Task 5): lowercase `provider: 'google'|'discord'`; `createAuthState({provider, returnTo}) → Promise<{state, challenge}>` (PKCE + state folded in, persisted via the configured store); `buildAuthorizeUrl({provider, state, challenge}) → string` (reads the boot-configured Cognito host/clientId/redirectUri/scopes — wired in Task 5's `main.tsx` `configureOAuth`). The screen reads nothing about Cognito directly.

**Files**
- Rewrite `frontend/src/routes/signin.tsx`
- Create `frontend/src/routes/signin.test.tsx` (component — button→authorize-url wiring)
- Create `frontend/src/platform/web/navigation.ts` (the external-redirect capability) + `frontend/src/platform/web/navigation.test.ts`
- Modify `frontend/src/routes/signin.stories.tsx` (unchanged entry; assert `route-signin`)
- Modify `common.json` + `descriptions.ts` (`signin.*`; remove `stub.signin`; add `theme.toggle`)

**Interfaces**
- Consumes (`@mythrun/client-core`): `createAuthState({ provider, returnTo }) → Promise<{ state; challenge }>` (async), `buildAuthorizeUrl({ provider, state, challenge }) → string`, `isLocalPath(returnTo)`.
- Consumes: `useTheme` (Task 8), `useSessionStore` (read `suspended`), react-router `useSearchParams`, `redirectTo` (new web capability).

**Steps**

1. (TDD) The external-redirect web capability. Create `frontend/src/platform/web/navigation.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { redirectTo } from './navigation.ts'

describe('redirectTo', () => {
  it('assigns the URL to window.location', () => {
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { writable: true, value: { assign } })
    redirectTo('https://example.com/authorize?x=1')
    expect(assign).toHaveBeenCalledWith('https://example.com/authorize?x=1')
  })
})
```
Run (red): `cd frontend && pnpm vitest run src/platform/web/navigation.test.ts`.

2. Create `frontend/src/platform/web/navigation.ts` (the `src/platform/web/**` carve-out is the ONE place web globals are allowed — R1):
```ts
// Web realization of the "navigate the browser to an external URL" capability —
// the full-page redirect to the Cognito Hosted UI that the OAuth sign-in needs.
// Lives under src/platform/web/** (the sanctioned web-globals carve-out); the
// sign-in screen consumes this helper instead of touching `window.location`
// itself (R1 — screens stay DOM-free). A native shell uses an in-app browser
// session (ASWebAuthenticationSession) behind the same intent.
export function redirectTo(url: string): void {
  window.location.assign(url)
}
```
Run (green): `cd frontend && pnpm vitest run src/platform/web/navigation.test.ts` (this file is %-gated — `src/platform/web/**` is in the coverage include; the single test covers it 100%).

3. (TDD) Sign-in wiring test. Create `frontend/src/routes/signin.test.tsx`:
```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import { useSessionStore } from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'

const createAuthState = vi.fn()
const buildAuthorizeUrl = vi.fn()
const redirectTo = vi.fn()

vi.mock('@mythrun/client-core', async (orig) => {
  const actual = await orig<typeof import('@mythrun/client-core')>()
  return {
    ...actual,
    createAuthState: (...a: unknown[]) => createAuthState(...a),
    buildAuthorizeUrl: (...a: unknown[]) => buildAuthorizeUrl(...a),
    isLocalPath: () => true,
  }
})
vi.mock('../platform/web/navigation.ts', () => ({ redirectTo: (...a: unknown[]) => redirectTo(...a) }))

const { SigninRoute } = await import('./signin.tsx')

function setMatch(): void {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: (q: string) => ({ matches: false, media: q, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }) })
}

function renderSignin(entry = '/auth/signin'): void {
  const router = createMemoryRouter([{ path: '/auth/signin', element: <SigninRoute /> }], { initialEntries: [entry] })
  render(<ThemeProvider><I18nextProvider i18n={i18n}><RouterProvider router={router} /></I18nextProvider></ThemeProvider>)
}

beforeEach(() => {
  setMatch(); localStorage.clear()
  useSessionStore.setState({ status: 'unauthenticated', sub: null, suspended: false })
  // createAuthState is async (PKCE digest) → resolve the {state, challenge}.
  createAuthState.mockReset().mockResolvedValue({ state: 'st', challenge: 'ch' })
  buildAuthorizeUrl.mockReset().mockReturnValue('https://cognito/authorize?x=1')
  redirectTo.mockReset()
})
afterEach(() => { vi.clearAllMocks() })

describe('SigninRoute', () => {
  it('Google button → createAuthState + buildAuthorizeUrl(google) + redirect', async () => {
    renderSignin()
    // `begin` is async (awaits createAuthState); the async act flushes the chain.
    await act(async () => { screen.getByRole('button', { name: /google/i }).click() })
    expect(createAuthState).toHaveBeenCalledWith({ provider: 'google', returnTo: '/home' })
    expect(buildAuthorizeUrl).toHaveBeenCalledWith({ provider: 'google', state: 'st', challenge: 'ch' })
    expect(redirectTo).toHaveBeenCalledWith('https://cognito/authorize?x=1')
  })

  it('Discord button passes provider=discord', async () => {
    renderSignin()
    await act(async () => { screen.getByRole('button', { name: /discord/i }).click() })
    expect(createAuthState).toHaveBeenCalledWith({ provider: 'discord', returnTo: '/home' })
  })

  it('threads a validated ?returnTo into the auth state', async () => {
    renderSignin('/auth/signin?returnTo=/join/abc')
    await act(async () => { screen.getByRole('button', { name: /google/i }).click() })
    expect(createAuthState).toHaveBeenCalledWith({ provider: 'google', returnTo: '/join/abc' })
  })

  it('shows the suspended notice when the store is suspended', () => {
    act(() => { useSessionStore.getState().setSuspended() })
    renderSignin()
    expect(screen.getByTestId('signin-suspended')).toBeDefined()
  })
})
```
Run (red): `cd frontend && pnpm vitest run src/routes/signin.test.tsx`.

4. Rewrite `frontend/src/routes/signin.tsx`:
```tsx
import { useSearchParams } from 'react-router-dom'
import { Box, Stack, Text, Button, Dither, Banner, ThemeToggle, useTheme } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { useSessionStore, createAuthState, buildAuthorizeUrl, isLocalPath } from '@mythrun/client-core'
import { redirectTo } from '../platform/web/navigation.ts'

// The sign-in screen — the §11 genesis title composition (matches
// signin-title-fab.html): a theme-driven Dither CROWN (light-ember in light,
// dark-cream in dark) grading out of the page field, the quiet `Mythrun` wordmark,
// a terse at-the-table tagline (placeholder), and the two provider actions as
// `secondary` (bordered) Buttons. The ThemeToggle FAB floats top-right above the
// crown (self-positioning — never laid ON the dither). Each provider button begins
// the OAuth flow: createAuthState (CSPRNG state + PKCE, carrying provider + a
// validated return-to) → buildAuthorizeUrl → full-page redirect to the Hosted UI.
//
// The return-to is seeded from a `?returnTo` query (the invite handoff, §7),
// validated LOCAL before it rides the OAuth `state`; otherwise the Hub.
type Provider = 'google' | 'discord'

export function SigninRoute(): React.JSX.Element {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const [params] = useSearchParams()
  const suspended = useSessionStore((s) => s.suspended)

  const rawReturnTo = params.get('returnTo')
  const returnTo = rawReturnTo !== null && isLocalPath(rawReturnTo) ? rawReturnTo : '/home'

  // `createAuthState` is async (the S256 PKCE digest); it persists the state +
  // returns {state, challenge}, then we build the authorize URL and redirect.
  const begin = async (provider: Provider): Promise<void> => {
    const { state, challenge } = await createAuthState({ provider, returnTo })
    redirectTo(buildAuthorizeUrl({ provider, state, challenge }))
  }

  return (
    <Stack minHeight="screen" data-testid="route-signin">
      <ThemeToggle label={t('theme.toggle')} data-testid="signin-theme-toggle" />
      <Dither pairing={theme === 'dark' ? 'dark-cream' : 'light-ember'} data-testid="signin-crown" />
      <Stack grow justify="center" align="center" gap={7}>
        <Box padding={6}>
          <Stack align="center" gap={6}>
            <Text role="ui-label" data-testid="signin-wordmark">
              {t('signin.wordmark')}
            </Text>
            <Text as="p" role="prose-body" data-testid="signin-tagline">
              {t('signin.tagline')}
            </Text>
            {suspended ? (
              <Banner severity="warning" data-testid="signin-suspended">
                {t('signin.suspended')}
              </Banner>
            ) : null}
            <Stack align="stretch" gap={3}>
              <Button variant="secondary" onPress={() => { void begin('google') }}>
                {t('signin.google')}
              </Button>
              <Button variant="secondary" onPress={() => { void begin('discord') }}>
                {t('signin.discord')}
              </Button>
            </Stack>
            <Text role="ui-caption" data-testid="signin-legal">
              {t('signin.legal')}
            </Text>
          </Stack>
        </Box>
      </Stack>
    </Stack>
  )
}
```
> The two provider buttons ship **text-only** (no provider mark): the Icon set has no Google/Discord glyph, and §11 mandates the OFFICIAL marks per each provider's sign-in branding guidelines (brand-compliant SVG assets) — that is a follow-up (see gaps). `Banner`'s prop is `severity` per the `@mythrun/ui` Banner contract — confirm the exact prop name when wiring. The `align="stretch"` column stretches the Buttons to full width (the mockup's `width:100%`); confirm in the visual audit.

Run (green): `cd frontend && pnpm vitest run src/routes/signin.test.tsx`.

5. i18n. In `common.json` add `signin` + `theme`, and remove `"signin"` from `stub`:
```json
  "theme": {
    "toggle": "Theme"
  },
  "signin": {
    "wordmark": "Mythrun",
    "tagline": "[ph_signin_tagline: a terse at-the-table line, ~1 sentence — the door into a session]",
    "google": "Continue with Google",
    "discord": "Continue with Discord",
    "legal": "[ph_signin_legal: a short Terms · Privacy line]",
    "suspended": "[ph_signin_suspended: ~1 sentence — this account is suspended, with a contact nudge]"
  },
```
In `descriptions.ts` add matching entries and remove `'stub.signin'`:
```ts
  'theme.toggle': 'Accessible name (aria-label) for the theme-toggle FAB. A real shipped string (generic chrome), ~1 word.',
  'signin.wordmark': 'The Mythrun wordmark on the sign-in title screen. The brand name (~1 word).',
  'signin.tagline': 'The terse at-the-table tagline under the wordmark on sign-in. ~1 sentence, evocative, no hype.',
  'signin.google': 'Label for the "continue with Google" provider button. Functional (real string).',
  'signin.discord': 'Label for the "continue with Discord" provider button. Functional (real string).',
  'signin.legal': 'The small Terms · Privacy line at the foot of the sign-in screen. Short.',
  'signin.suspended': 'Notice shown on sign-in when the account was suspended. ~1 sentence with a contact nudge.',
```
Run: `cd frontend/client-core && pnpm vitest run src/i18n/resources.test.ts`.

6. Keep `signin.stories.tsx` entry `/auth/signin` session `unauthenticated`, `play: expectScreen('route-signin')`. The ScreenHarness mounts the real route under AppProviders → ThemeProvider is present (Task 8), so `useTheme` resolves. Run: `cd frontend && pnpm vitest run src/app/router.test.tsx` (the router test's `route-signin` assertion still holds).

7. **Controller commits** `feat(MYT-84): sign-in genesis title screen (provider OAuth begin + theme crown + FAB)`. **HOLD push for Miklos visual audit (light + dark), per the frontend visual-audit rule.**

---

### Task 13: Onboard screen + `deriveUsername`

The §11 gentle moment matching `onboard-modes.html`: the crown, the serif "What should we call you?", one pre-filled `Input`, a single ember **primary** Button, the FAB. Submit derives a valid-by-construction username, probes `check-username`, registers ONCE, maps the error taxonomy.

**Files**
- Create `frontend/client-core/src/auth/derive-username.ts` + `derive-username.test.ts` (TDD)
- Modify `frontend/client-core/src/index.ts` (export `deriveUsername`)
- Rewrite `frontend/src/routes/onboard.tsx`
- Create `frontend/src/routes/onboard.test.tsx` (TDD — error-taxonomy branching)
- Modify `frontend/src/routes/onboard.stories.tsx` (entry `/auth/onboard`)
- Modify `common.json` + `descriptions.ts` (`onboard.*`; remove `stub.onboard`)

**Interfaces**
- Produces: `deriveUsername(displayName: string, randomAlnum?: (n: number) => string): string`.
- Consumes (`@mythrun/client-core`): `checkUsername(username) → { available: boolean; reason?: string }` (REAL shape — NO `suggestion`), `register({ username, displayName }) → { user; created }` (resolves on the 200 `already_onboarded_same`; throws `HttpError` with `.code`/`.body` on 4xx); `useSessionStore`, `isHttpError`.
- Consumes: react-router `useLocation`/`useNavigate` (read `state.name`/`state.returnTo`), `useTheme`, `isLocalPath`.

**Steps**

1. (TDD) Derive-username edge matrix. Create `frontend/client-core/src/auth/derive-username.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { deriveUsername } from './derive-username.ts'

const REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9_]{1,18}[a-zA-Z0-9])?$/
// Deterministic 'a'-runs for the random-padding/fallback branches.
const rand = (n: number): string => 'a'.repeat(n)

describe('deriveUsername', () => {
  it('lowercases + strips to a regex-valid handle', () => {
    const u = deriveUsername('Aria Thorne')
    expect(u).toBe('ariathorne')
    expect(REGEX.test(u)).toBe(true)
  })
  it('pads a too-short (<3) alnum slug to length 3', () => {
    expect(deriveUsername('Bo', rand)).toBe('boa')
  })
  it('trims a leading underscore', () => {
    expect(deriveUsername('_bob')).toBe('bob')
  })
  it('trims a trailing underscore', () => {
    expect(deriveUsername('bob_')).toBe('bob')
  })
  it('collapses underscore runs', () => {
    expect(deriveUsername('a__b')).toBe('a_b')
  })
  it('all-underscore → player_ fallback (regex-valid)', () => {
    const u = deriveUsername('___', rand)
    expect(u.startsWith('player_')).toBe(true)
    expect(REGEX.test(u)).toBe(true)
  })
  it('empty after stripping (CJK / emoji) → player_ fallback', () => {
    expect(deriveUsername('日本語', rand).startsWith('player_')).toBe(true)
    expect(deriveUsername('🐉🔥', rand).startsWith('player_')).toBe(true)
  })
  it('clamps a 40-char display name to ≤20, last char alphanumeric', () => {
    const u = deriveUsername('A'.repeat(40))
    expect(u.length).toBeLessThanOrEqual(20)
    expect(/[a-z0-9]$/.test(u)).toBe(true)
    expect(REGEX.test(u)).toBe(true)
  })
  it('trims a trailing underscore left by truncation', () => {
    // 19 chars + '_' + 'x' → truncating to 20 lands on '_' → trimmed.
    const u = deriveUsername(`${'a'.repeat(19)}_x`)
    expect(u.endsWith('_')).toBe(false)
    expect(REGEX.test(u)).toBe(true)
  })
})
```
Run (red): `cd frontend/client-core && pnpm vitest run src/auth/derive-username.test.ts`.

2. Create `frontend/client-core/src/auth/derive-username.ts`:
```ts
// Derive a backend-valid `username` from the player's display name — regex-valid
// BY CONSTRUCTION (spec §6), so the only retry ever needed is a genuine collision.
// The handle is a system id, never shown. Target regex (backend, len 3–20,
// first/last alphanumeric, no length-2): /^[a-zA-Z0-9](?:[a-zA-Z0-9_]{1,18}[a-zA-Z0-9])?$/
//
// `randomAlnum` is injected for deterministic tests (default: real random); it
// returns an n-char lowercase-alphanumeric string (never `_`).
const MIN = 3
const MAX = 20
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function defaultRandomAlnum(n: number): string {
  let out = ''
  for (let i = 0; i < n; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return out
}

export function deriveUsername(displayName: string, randomAlnum: (n: number) => string = defaultRandomAlnum): string {
  // 1. lowercase → keep [a-z0-9_] → collapse underscore runs → trim edge underscores.
  let slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')

  // 2. empty / all-underscore → player_<rand>; else too-short → pad with alnum.
  if (slug === '') {
    slug = `player_${randomAlnum(6)}`
  } else if (slug.length < MIN) {
    slug = (slug + randomAlnum(MIN)).slice(0, MIN)
  }

  // 3. truncate to 20, then trim a trailing underscore truncation may have left.
  if (slug.length > MAX) slug = slug.slice(0, MAX).replace(/_+$/, '')

  // 4. regex-valid by construction.
  return slug
}
```
Run (green): `cd frontend/client-core && pnpm vitest run src/auth/derive-username.test.ts`. Export from `frontend/client-core/src/index.ts`:
```ts
export { deriveUsername } from './auth/derive-username.ts'
```

3. (TDD) Onboard error-taxonomy test. Create `frontend/src/routes/onboard.test.tsx`:
```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import { HttpError, useSessionStore } from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'

const checkUsername = vi.fn()
const register = vi.fn()

vi.mock('@mythrun/client-core', async (orig) => {
  const actual = await orig<typeof import('@mythrun/client-core')>()
  return {
    ...actual,
    checkUsername: (...a: unknown[]) => checkUsername(...a),
    register: (...a: unknown[]) => register(...a),
    isLocalPath: () => true,
  }
})
const { OnboardRoute } = await import('./onboard.tsx')

function setMatch(): void {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: (q: string) => ({ matches: false, media: q, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }) })
}

function renderOnboard(state?: { name?: string | null; returnTo?: string }): void {
  const router = createMemoryRouter(
    [
      { path: '/auth/onboard', element: <OnboardRoute /> },
      { path: '/home', element: <div data-testid="at-home" /> },
      { path: '/join/:code', element: <div data-testid="at-join" /> },
    ],
    { initialEntries: [{ pathname: '/auth/onboard', state }] },
  )
  render(<ThemeProvider><I18nextProvider i18n={i18n}><RouterProvider router={router} /></I18nextProvider></ThemeProvider>)
}

beforeEach(() => {
  setMatch(); localStorage.clear()
  useSessionStore.setState({ status: 'onboarding-required', sub: 'cognito-1', suspended: false })
  checkUsername.mockReset().mockResolvedValue({ available: true })
  register.mockReset().mockResolvedValue({ user: { id: 'db1' }, created: true })
})
afterEach(() => { vi.clearAllMocks() })

describe('OnboardRoute', () => {
  it('pre-fills the name from location state', () => {
    renderOnboard({ name: 'Aria Thorne', returnTo: '/home' })
    expect(screen.getByDisplayValue('Aria Thorne')).toBeDefined()
  })

  it('happy path: derive → check available → register once → ready → return-to', async () => {
    renderOnboard({ name: 'Aria Thorne', returnTo: '/join/abc' })
    act(() => { screen.getByRole('button', { name: /continue/i }).click() })
    await waitFor(() => { expect(screen.getByTestId('at-join')).toBeDefined() })
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith({ username: 'ariathorne', displayName: 'Aria Thorne' }, expect.anything())
    expect(useSessionStore.getState().status).toBe('ready')
  })

  it('display_name_invalid (400) → inline error, no navigation', async () => {
    register.mockRejectedValue(new HttpError(400, 'Bad Request', 'display_name_invalid'))
    renderOnboard({ name: 'Aria', returnTo: '/home' })
    act(() => { screen.getByRole('button', { name: /continue/i }).click() })
    await waitFor(() => { expect(screen.getByTestId('onboard-field-error')).toBeDefined() })
    expect(screen.queryByTestId('at-home')).toBeNull()
  })

  it('already_onboarded (409) → setReady → return-to (no loop)', async () => {
    register.mockRejectedValue(new HttpError(409, 'Conflict', 'already_onboarded'))
    renderOnboard({ name: 'Aria', returnTo: '/home' })
    act(() => { screen.getByRole('button', { name: /continue/i }).click() })
    await waitFor(() => { expect(screen.getByTestId('at-home')).toBeDefined() })
    expect(useSessionStore.getState().status).toBe('ready')
  })

  it('username_taken (409) → re-probe + register again, bounded', async () => {
    register
      .mockRejectedValueOnce(new HttpError(409, 'Conflict', 'username_taken'))
      .mockResolvedValueOnce({ user: { id: 'db1' }, created: true })
    renderOnboard({ name: 'Aria', returnTo: '/home' })
    act(() => { screen.getByRole('button', { name: /continue/i }).click() })
    await waitFor(() => { expect(screen.getByTestId('at-home')).toBeDefined() })
    expect(register.mock.calls.length).toBeGreaterThanOrEqual(2)
    // The 2nd register used a DIFFERENT candidate (local mutation, not the same taken slug).
    expect((register.mock.calls[1]?.[0] as { username: string }).username)
      .not.toBe((register.mock.calls[0]?.[0] as { username: string }).username)
  })

  it('429 → friendly rate-limit error, no loop', async () => {
    register.mockRejectedValue(new HttpError(429, 'Too Many Requests', 'rate_limited'))
    renderOnboard({ name: 'Aria', returnTo: '/home' })
    act(() => { screen.getByRole('button', { name: /continue/i }).click() })
    await waitFor(() => { expect(screen.getByTestId('onboard-error')).toBeDefined() })
  })

  it('gracefully renders with an empty pre-fill (reload — no location state)', () => {
    renderOnboard(undefined)
    expect(screen.getByTestId('route-onboard')).toBeDefined()
  })
})
```
Run (red): `cd frontend && pnpm vitest run src/routes/onboard.test.tsx`.

4. Rewrite `frontend/src/routes/onboard.tsx`:
```tsx
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Box, Stack, Heading, Text, Input, Button, Dither, ThemeToggle, useTheme } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import {
  useSessionStore,
  deriveUsername,
  checkUsername,
  register,
  isLocalPath,
  useApiContext,
  isHttpError,
} from '@mythrun/client-core'

// The onboarding moment (§11, matches onboard-modes.html): the genesis crown, the
// serif "What should we call you?" as the question-that-IS-the-label (gentler than
// a form), ONE pre-filled Input, a single ember PRIMARY Button, the theme FAB. The
// pre-fill name + return-to ride the callback→onboard router location state (the
// OAuth state was already single-use-consumed at the callback, §7); on reload the
// state is absent → the pre-fill gracefully empties and the user types.
//
// Submit: derive a regex-valid handle → probe check-username for a free candidate
// (≤3 local candidates; check-username has NO server suggestion, so a taken
// candidate is re-mutated locally) → register ONCE (with a bounded race retry) →
// setReady → return-to. Error taxonomy: display_name_invalid → inline on the
// (only visible) field; already_onboarded(_same) → already done, setReady;
// username_taken / username_invalid → fresh candidate, retry (≤3); 429/other →
// a friendly notice.
const MAX_ATTEMPTS = 3
const SUFFIX_LEN = 3
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'

function freshCandidate(base: string): string {
  let s = ''
  for (let i = 0; i < SUFFIX_LEN; i++) s += ALNUM[Math.floor(Math.random() * ALNUM.length)]
  return (base.slice(0, 20 - SUFFIX_LEN) + s).slice(0, 20)
}

export function OnboardRoute(): React.JSX.Element {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const navigate = useNavigate()
  const ctx = useApiContext()
  const { state } = useLocation() as { state: { name?: string | null; returnTo?: string } | null }

  const [name, setName] = useState<string>(state?.name ?? '')
  const [fieldError, setFieldError] = useState(false)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)

  const returnTo = state?.returnTo !== undefined && isLocalPath(state.returnTo) ? state.returnTo : '/home'
  const sub = useSessionStore.getState().sub ?? ''

  const finish = (): void => {
    useSessionStore.getState().setReady(sub)
    navigate(returnTo, { replace: true })
  }

  const submit = async (): Promise<void> => {
    setFieldError(false)
    setError(false)
    setBusy(true)
    try {
      const base = deriveUsername(name)
      // Probe up to MAX_ATTEMPTS candidates for a free one (cheap, 10/min).
      let candidate = base
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const res = await checkUsername(candidate)
        if (res.available) break
        candidate = freshCandidate(base)
      }
      // Register ONCE (bounded race retry on a taken/invalid candidate).
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          await register({ username: candidate, displayName: name }, ctx)
          finish()
          return
        } catch (err) {
          if (!isHttpError(err)) throw err
          if (err.status === 409 && (err.code === 'already_onboarded' || err.code === 'already_onboarded_same')) {
            finish()
            return
          }
          if (err.status === 400 && err.code === 'display_name_invalid') {
            setFieldError(true)
            return
          }
          if (err.status === 409 && err.code === 'username_taken') {
            candidate = freshCandidate(base)
            continue
          }
          if (err.status === 400 && err.code === 'username_invalid') {
            candidate = freshCandidate(base)
            continue
          }
          // 429 / anything else → a friendly notice (no loop).
          setError(true)
          return
        }
      }
      setError(true)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Stack minHeight="screen" data-testid="route-onboard">
      <ThemeToggle label={t('theme.toggle')} data-testid="onboard-theme-toggle" />
      <Dither pairing={theme === 'dark' ? 'dark-cream' : 'light-ember'} data-testid="onboard-crown" />
      <Stack grow justify="center" align="center" gap={6}>
        <Box padding={6}>
          <Stack align="center" gap={5}>
            <Heading level={1} role="title" data-testid="onboard-prompt">
              {t('onboard.prompt')}
            </Heading>
            <Input
              value={name}
              onChange={setName}
              size="lg"
              invalid={fieldError}
              aria-label={t('onboard.nameLabel')}
              data-testid="onboard-input"
            />
            {fieldError ? (
              <Text role="ui-caption" data-testid="onboard-field-error">
                {t('onboard.errors.displayNameInvalid')}
              </Text>
            ) : null}
            {error ? (
              <Text role="ui-caption" data-testid="onboard-error">
                {t('onboard.errors.generic')}
              </Text>
            ) : null}
            <Stack align="stretch" gap={3}>
              <Button variant="primary" loading={busy} onPress={() => { void submit() }}>
                {t('onboard.continue')}
              </Button>
            </Stack>
            <Text role="ui-caption" data-testid="onboard-hint">
              {t('onboard.hint')}
            </Text>
          </Stack>
        </Box>
      </Stack>
    </Stack>
  )
}
```
> `Input` (bordered, capital-I) — NOT `SeamlessInput` — matches the approved mockup's bordered field. `aria-label` is allowed on `Input` (it spreads `...rest`); the i18n attribute rule exempts `aria-.*`. The 429 friendly copy reuses `onboard.errors.generic` (or add a dedicated `onboard.errors.rateLimited` key for a clearer message — optional).

Run (green): `cd frontend && pnpm vitest run src/routes/onboard.test.tsx`.

5. i18n. In `common.json` add `onboard` (remove `"onboard"` from `stub`):
```json
  "onboard": {
    "prompt": "[ph_onboard_prompt: the gentle 'what should we call you?' question, serif]",
    "nameLabel": "Display name",
    "continue": "Continue",
    "hint": "[ph_onboard_hint: a reassuring 'you can change this later' line]",
    "errors": {
      "displayNameInvalid": "[ph_onboard_err_display: ~1 sentence — that display name can't be used, try another]",
      "generic": "[ph_onboard_err_generic: ~1 sentence — something went wrong, please try again]"
    }
  },
```
In `descriptions.ts` add matching entries and remove `'stub.onboard'`:
```ts
  'onboard.prompt': 'The serif "what should we call you?" question on onboarding — the question that IS the label. ~1 short sentence.',
  'onboard.nameLabel': 'Accessible name (aria-label) for the display-name input on onboarding. Functional, ~2 words.',
  'onboard.continue': 'Label for the single primary action on onboarding. Functional, ~1 word.',
  'onboard.hint': 'Reassuring sub-line under the onboarding action ("you can change this later"). Short.',
  'onboard.errors.displayNameInvalid': 'Inline error under the onboarding input when the display name is rejected. ~1 sentence.',
  'onboard.errors.generic': 'Generic onboarding failure notice (rate-limited / exhausted retries). ~1 sentence with a retry nudge.',
```
Run: `cd frontend/client-core && pnpm vitest run src/i18n/resources.test.ts`.

6. Update `onboard.stories.tsx` entry `/auth/onboard` session `onboarding-required`, `play: expectScreen('route-onboard')`. Run: `cd frontend && pnpm vitest run src/routes/onboard.test.tsx`.

7. **Controller commits** `feat(MYT-84): onboarding moment + valid-by-construction username derivation + register taxonomy`. **HOLD push for Miklos visual audit (light + dark).**

---

### Task 14: E2E real-OAuth smoke (the done-when) — runbook, no code

A precise checklist the controller/Miklos executes against `staging.mythrun.com` with real Google + Discord. NOT a mock — this proves the wire (spec §8/§10 done-when). Preconditions: Task 1 (GAP-A) applied (the Cognito callback/logout URLs include `https://staging.mythrun.com/auth/callback` + `https://staging.mythrun.com`) and the staging gate password (the authed app is behind the gate, MYT-96).

**Files**
- Append the runbook to the MYT-84 wiki/plan notes (no source files). Document under `docs/wiki/` per AUTHORING.md at close.

**Procedure (execute, don't author from memory — verify each click-path against the live site):**

1. **Pre-flight.** Confirm `pnpm typecheck && pnpm lint && pnpm test` green across `@mythrun/web`, `@mythrun/client-core`, `@mythrun/ui`, `@mythrun/contract`; `cd frontend/ui && node scripts/story-coverage.mjs` exit 0; the Storybook overflow gate passes for `Screens/Signin` + `Screens/Onboard`. Confirm the backend `session`/`refresh`/`logout` deploy (Task 7) is green (a fresh ECS revision rolled — not the TF placeholder rev). Confirm Task 1 (GAP-A) is applied (Cognito app-client callback URLs in `infra/environments/staging`).

2. **Google sign-in → Hub.** Open `https://staging.mythrun.com` (pass the gate). Land on the sign-in title screen — assert: the ember dither crown renders, the `Mythrun` wordmark, two provider buttons, the theme FAB top-right. Click **Continue with Google** → Cognito Hosted UI → Google consent → redirect to `/auth/callback?code=…&state=…` → the callback spinner → for a FIRST-time account: lands on `/auth/onboard`. Assert the display-name Input is **pre-filled** with the Google `name`. Submit → lands on `/home` (the Hub) with campaigns/empty-state. Assert the network tab shows `POST /api/auth/session` set a `mythrun_refresh` cookie (HttpOnly, `Path=/api/auth`, `SameSite=Lax`, Secure, no Domain) and `POST /api/users/register` returned 201.

3. **Reload re-hydrates over the wire.** On `/home`, hard-reload. Assert: the boot splash flashes, then `POST /api/auth/refresh` fires (set a ROTATED `mythrun_refresh`), `GET /api/users/me` returns 200, and the app lands **straight on `/home`** — NO sign-in bounce. (This is the `initializing`-splash → on-load-refresh path; it must be the real refresh, not a mock.)

4. **Discord sign-in → name pre-fill.** Logout (step 6) or use a fresh browser profile. Click **Continue with Discord** → Discord consent → callback. For a first-time Discord account, assert the onboard Input pre-fills with the Discord `name` (confirm the Cognito Discord OIDC `name` mapping yields non-empty; if empty, the moment gracefully no-ops with a blank field — note which). Submit → `/home`.

5. **First-time invitee deep link.** Open `https://staging.mythrun.com/join/<a-real-invite-code>` unauthenticated → the join preview → "sign in to join" → OAuth (state carries `returnTo=/join/<code>`) → callback → onboard (first-timer) → submit → assert it lands back on **`/join/<code>`** (return-to survived BOTH the OAuth redirect AND the onboard detour, §7), not `/home`.

6. **Logout clears the cookie.** From `/home`, trigger logout (the logout action). Assert: `POST /api/auth/logout` → 204, the `mythrun_refresh` cookie is cleared (attributes mirror the set), the in-memory token is dropped, and the app returns to the landing/sign-in screen. Reload → stays unauthenticated (no silent re-login).

7. **Theme persists across reload, no flash.** On any screen, click the theme FAB → the whole screen flips light↔dark (crown re-pairs ember↔cream, FAB glyph sun↔moon). Reload → the chosen theme is applied with **no flash-of-wrong-theme** on first paint (the index.html pre-paint script). Toggle back, reload again → persists. Confirm `localStorage['mythrun-theme']` holds the choice.

8. **Sign-off.** Record each assertion's result. Any failure → root-cause before declaring done (never ship the reduced version without naming the cause). Then dispatch the wiki-update subagent, push, flip MYT-84 to Done.

---

## Controller notes (bead wiring + cross-task coordination)

**Task order (R1 dependency sequence):** 1 (infra) → 2 (token-manager) → 3 (defineEndpoint transport) → 4 (contract + endpoints) → 5 (oauth helper) → 6 (register-narrowing) → 7 (backend session endpoints) → 8 (theme) → 9 (session-store `initializing` + RequireAuth) → 10 (session adapter + bootstrap) → 11 (callback) → 12 (sign-in) → 13 (onboard) → 14 (E2E smoke).
- Tasks 1, 6, 7 are backend/infra and independent of the frontend chain (can run alongside it). Task 1's `terraform apply` is a human gate and a precondition for Task 14.
- Frontend chain deps: 2 → 3 → 4 (client-core transport trio, serial — shared `providers.tsx`); 5 after 2 (coverage gate + barrel); 8 before 9/11/12/13 (Stack `minHeight="screen"`/`grow` + ThemeProvider/useTheme/ThemeToggle); 9 → 10; 10 before 11; 5 before 11/12; 4 before 13.

**Shared files (additive, non-overlapping regions; controller commits serially in task order):**
- `frontend/src/app/providers.tsx` — Task 2 (`toAuthHeaderOptions` drops secureStorage), Task 3 (QueryClient 4xx-skip predicate + `isHttpError` import), Task 4 (`configureTokenRefresh` effect), Task 8 (`<ThemeProvider>` mount), Task 10 (`toApiContext` helper). (OAuth is NOT wired here — Task 5 configures it directly in `main.tsx`.)
- `frontend/src/main.tsx` — Task 5 (`configureOAuth({store, cognito})` in the jwt branch), Task 10 (`bootstrapSession` boot wiring into that same jwt branch). (secureStorage already present.)
- `frontend/client-core/src/index.ts` — Task 2 (token-manager), Task 4 (users/session endpoints + contract types), Task 5 (oauth helpers + `configureOAuth` + `OAuthStateStore`/`OAuthCognitoConfig` types), Task 10 (session adapter + `readSubClaim`), Task 13 (`deriveUsername`).
- `frontend/client-core/src/i18n/locales/en/common.json` + `descriptions.ts` — Task 9 (`splash`), Task 11 (`callback`), Task 12 (`signin` + `theme`), Task 13 (`onboard`). Each adds keys + removes the corresponding `stub.*`.
- `frontend/.env.development` + `.github/workflows/deploy-frontend.yml` + `frontend/src/vite-env.d.ts` — Task 5 (the two PUBLIC `VITE_COGNITO_*` build vars).

**Coverage:** the client-core 100% gate covers `src/auth/**` + `src/platform/**` (Task 2 extends the include). `@mythrun/web` gates `src/platform/web/**`. Run `pnpm --filter @mythrun/client-core test:coverage` after Tasks 2/4/5/10/13 and the web suite after 5/11/12/13.

**Frontend visual audit + E2E gate:** Tasks 12 + 13 HOLD the push for Miklos's light+dark visual audit. Task 14 (real Google + Discord against `staging.mythrun.com`) is the done-when and needs Task 1 applied.

### Resolved cross-cluster interface conflicts (canonical API)

The six interface agreements R5 enumerates all HOLD as merged (HttpError `code`+`body`; `CheckUsernameResponseSchema` no `suggestion`; `getAccessToken()` → raw JWT string; `register` → `{user, created}`; onboard `Input size="lg"`; provider buttons text-only). Merging surfaced three additional drifts — all now RESOLVED in the plan:

1. **`tokenManager` export form — RESOLVED.** Tasks 10/11 originally consumed a `tokenManager.getAccessToken()/.runRefresh()/.setAccessToken()` namespace object; Task 2 exports BARE named functions (`getAccessToken`, `runRefresh`, `setAccessToken`, …) and the barrel re-exports those. Tasks 10 + 11 (source + test mocks) are aligned to the bare named exports (the only form that exists).

2. **`parseCallback` shape — RESOLVED (canonical: parse-only).** Task 5's `parseCallback(search): { code; state } | { error }` parses ONLY (never touches the store); the callback then calls `consumeAuthState(parsed.state) → AuthStateData | null` (single-use take). This recovers the provider-denial (`{error}`) vs forged-state (`consumeAuthState`→null) distinction. Task 11 (callback) consumes exactly this shape — `if ('error' in parsed)` → error; else `const ctx = consumeAuthState(parsed.state)`; `if (ctx === null)` → error; exchange with `ctx.verifier`; navigate `ctx.returnTo !== null && isLocalPath(ctx.returnTo) ? ctx.returnTo : '/'`.

3. **`createAuthState` / `buildAuthorizeUrl` + provider casing + Cognito config — RESOLVED (canonical: high-level helpers).** Task 5 ships the high-level pair: `createAuthState({provider, returnTo}): Promise<{state, challenge}>` (folds in PKCE + the CSPRNG state, validates `returnTo` local-else-null, persists the triple) and `buildAuthorizeUrl({provider, state, challenge}): string` reading the boot-configured Cognito config. `OAuthProvider` is lowercase `'google'|'discord'`, mapped to Cognito's `Google`/`Discord` casing inside `buildAuthorizeUrl`. The Cognito config (`domain`/`clientId`/`redirectUri`/`scopes`) is wired ONCE at boot via `configureOAuth({store, cognito})` in `main.tsx` (Task 5 step 7), with `domain`/`clientId` from the new PUBLIC `VITE_COGNITO_*` build vars and `redirectUri = ${window.location.origin}/auth/callback` (exact-matches the backend's server-derived `${frontendBaseUrl}/auth/callback` + the Task 1 Cognito callback URL). Task 12 (sign-in) consumes this directly (`await createAuthState(...)` → `redirectTo(buildAuthorizeUrl(...))`). `createPkce` stays a separate export (used internally by `createAuthState`; available for tests/future callers).

---
