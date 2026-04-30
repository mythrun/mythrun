# MYT-37 — JWT Middleware + Bypass Mode + Public-Route Allowlist (Design)

> **Status**: Draft v2 (post round-1 blind review — reptile cohort: Komodo / Cobra / Gecko)
> **Date**: 2026-04-30
> **Linear**: [MYT-37](https://linear.app/mythrun/issue/MYT-37/auth-jwt-middleware-bypass-mode-public-route-allowlist)
> **Parent spec**: `docs/specs/2026-04-13-auth-users.md` §5 (with deferral to MYT-39 for the DB-lookup + suspended-user path — see §1 below)
> **Depends on**: MYT-36 (Cognito User Pool + IdPs ship the env vars this plugin reads)
> **Scope**: A Fastify auth plugin family that validates Cognito access_tokens, attaches a claims-only `request.user`, supports a development bypass mode protected by six independent safety layers, and gates all routes by default with explicit per-route opt-out for public routes. First ticket that triggers an ECS deploy consuming MYT-36's `COGNITO_*` env vars.

---

## Table of Contents

1. [Goal & Done-When](#1-goal--done-when)
2. [Architecture](#2-architecture)
3. [Module Surface & Types](#3-module-surface--types)
4. [Bypass-Mode Safety: Six-Layer Defense](#4-bypass-mode-safety-six-layer-defense)
5. [JWT Plugin Internals](#5-jwt-plugin-internals)
6. [Bypass Plugin Internals](#6-bypass-plugin-internals)
7. [Server Wiring & Env Loader](#7-server-wiring--env-loader)
8. [Public-Route Allowlist](#8-public-route-allowlist)
9. [Testing](#9-testing)
10. [Deploy Sequence](#10-deploy-sequence)
11. [Out of Scope](#11-out-of-scope)
12. [Follow-up Beads](#12-follow-up-beads)

---

## 1. Goal & Done-When

**Goal:** Stand up the Fastify auth plugin family for Mythrun's backend. Validates Cognito access_tokens against the User Pool MYT-36 provisioned, attaches a claims-only `request.user`, and supports a development bypass mode that's protected against accidental production activation by six independent safety layers. First ticket that triggers an ECS deploy consuming MYT-36's `COGNITO_*` env vars.

**Done when:**

- `backend/src/auth/jwt-plugin.ts` — Fastify plugin verifying access_tokens via `aws-jwt-verify`, attaching `request.user = { sub, username, scope, tokenUse: 'access' }` from the verified claims. NO database lookup; suspended-user enforcement deferred to MYT-39.
- `backend/src/auth/bypass-plugin.ts` — when `AUTH_MODE=bypass`, attaches a fixed dev user `{ sub: 'dev-sub-1', username: 'Dev_User', scope: 'openid email profile', tokenUse: 'bypass' }`. Six safety layers prevent activation in production environments.
- `backend/src/auth/index.ts` — `registerAuth(app, { mode, userPoolId, appClientId })` dispatches to one of the two plugins based on mode.
- `backend/src/auth/types.ts` — `AuthUser` interface + Fastify module augmentation for `request.user` and `FastifyContextConfig.auth`.
- `loadEnv` validates `AUTH_MODE` is exactly `'real' | 'bypass'`. Throws on unset, typo, or any other value. No silent default.
- Default-require auth enforcement: routes that should be public set `config: { auth: 'public' }`; everything else 401s without a valid Bearer token.
- The two existing public routes (`GET /health`, `GET /health/ready`) opt out via `config: { auth: 'public' }`.
- `infra/environments/staging/main.tf` adds `{ name = "AUTH_MODE", value = "real" }` to `module.serving.extra_env` (defense layer 5).
- Tests cover all the gates: valid token → user attached; expired/wrong-issuer/wrong-audience tokens → 401; bypass mode → fixed user; bypass + `NODE_ENV=production` → throws; bypass + `COGNITO_USER_POOL_ID` set → throws; `AUTH_MODE` unset → throws; `AUTH_MODE='bogus'` → throws; public routes always 200 in both modes; protected routes 401 without auth.
- ECS service rolls onto a CI-rendered task-def revision that has all of MYT-36's `COGNITO_*` env vars + the new `AUTH_MODE=real` + the JWT plugin code. `staging-api.mythrun.com/health` still 200; arbitrary other paths return 401 (proves auth is now required by default).

**Out of MYT-37's done-when:** `/api/auth/refresh` endpoint, `/api/users/register`, DB lookup of internal user UUID, `suspended_at` enforcement, WebSocket ticket exchange, WebSocket re-validation, multi-dev-user header switching, end-to-end test through real Cognito JWKS (no protected routes exist yet).

---

## 2. Architecture

### Claims-only verification, DB lookup deferred

The JWT plugin's job is exactly one thing: prove the access_token is valid and surface its claims. It does NOT look up `users WHERE cognito_sub = $1`. This is the industry pattern (`aws-jwt-verify`, `passport-jwt`, `express-oauth2-jwt-bearer` all assume this shape) and the right call for Mythrun for four reasons:

1. **Statelessness is the point of JWTs.** Forcing a DB lookup per authenticated request reintroduces session-table semantics with extra cryptographic overhead.
2. **Latency tax.** A `getByCognitoSub` lookup per request adds ~5–10ms in the indexed best case. For routes that don't need the DB row (webhooks, identity-only endpoints), pure waste.
3. **Failure-mode coupling.** If middleware does the DB lookup, every authenticated route fails when the DB is down — even routes that never touch the DB. With claims-only, auth works as long as Cognito's JWKS is reachable.
4. **Routes choose what they need.** A future `loadCurrentUser` plugin (MYT-39, when `suspended_at` enforcement needs the DB row) layers on top of the JWT plugin and is opt-in per protected route group. The JWT plugin itself stays claims-only forever.

The parent spec §5.1 sketches the eventual `AuthUser` shape with `id` (internal UUID), `cognitoSub`, `email`, `displayName`, `username` — which describes "what the eventual handler sees once both the JWT plugin AND the (future) loadUser plugin have run," not what the JWT middleware alone attaches. Spec §5.1 will be re-articulated as part of MYT-39's design.

### access_token, not id_token

The SPA sends `Authorization: Bearer <access_token>` on every API request. Standard OAuth 2.0 pattern; access_tokens are designed for resource access. Cognito access_tokens carry `sub`, `username` (Cognito-internal — `Google_<sub>` or `Discord_<snowflake>` for federated users), `client_id`, `scope`, `token_use`. They do NOT carry `email`, `name`, `picture` — those are id_token claims. We never see them in the JWT plugin. `email` / `name` / `picture` get persisted to `users.email` / `display_name` / `avatar_url` during MYT-38 onboarding (which calls Cognito's `/oauth2/userInfo` once at user creation). After onboarding, the DB row is the source of truth.

Using id_tokens for API auth is a known anti-pattern (id_tokens are for clients, not APIs, per the OIDC spec). We don't.

### Two plugins, conditionally registered

`registerAuth(app, opts)` registers exactly one plugin based on `opts.mode`:
- `mode: 'real'` → `jwtPlugin` (real Cognito JWT validation)
- `mode: 'bypass'` → `bypassPlugin` (fixed dev user, no token)

The choice is made once at app construction in `server.ts`, not per-request. Each plugin is single-purpose, single-file, and individually testable.

### Default-require, opt-out per route, three auth modes

The plugin's `onRequest` hook reads `request.routeOptions.config?.auth` to determine handling:

| `config.auth` value | Behavior |
|---------------------|----------|
| `'public'` | Skip validation entirely; no `request.user` attached. Used for `/health`, `/health/ready`, Stripe webhook (which has its own signature verification), public recap pages. |
| `'jwt-no-db'` | Verify the JWT, attach claims-only `request.user`. Used for `/api/users/register` (MYT-38) — the JWT is required to identify who's registering, but no DB row exists yet to look up. **Today (MYT-37) this mode is identical to default** — no behavioral difference until MYT-39 adds the DB-lookup layer for the default mode. The type is locked in now so MYT-38 has a stable contract. |
| `undefined` (default) | Default-require. Today: same as `'jwt-no-db'`. After MYT-39: also looks up the user in the DB by `cognito_sub`, attaches the internal UUID, and rejects with 403 if `users.suspended_at` is set. |

A forgotten opt-out is the safer failure mode — a 401 is loud; a silently-public protected route is not.

### 404 fall-through

Fastify's `onRequest` hook fires AFTER route matching (per the official lifecycle). For matched routes, the hook sees `request.routeOptions.config` and applies the rules above. For UNMATCHED paths, behavior depends on whether `setNotFoundHandler` is registered:

- **No custom 404 handler (Fastify default):** unmatched paths skip `onRequest` entirely; the framework returns 404 directly.
- **With `setNotFoundHandler`:** unmatched paths flow through `onRequest`, but `request.routeOptions` is `undefined`. Without explicit handling, the auth check would proceed and an unauthenticated request to a nonexistent path would get 401 instead of 404 — a route-existence info-leak.

Both auth plugins guard with `if (!request.routeOptions) return` at the top of the hook, so unmatched paths fall through to the 404 handler regardless of whether one is registered. Tests verify both unauth-on-unmatched (404) and authenticated-on-unmatched (404) cases.

---

## 3. Module Surface & Types

### File layout

```
backend/src/auth/
  index.ts          # registerAuth(app, opts) — dispatches based on mode
  jwt-plugin.ts     # real JWT validation
  bypass-plugin.ts  # fixed dev user, six safety layers
  types.ts          # AuthUser + Fastify module augmentation
  __tests__/
    jwt-plugin.test.ts
    bypass-plugin.test.ts
    index.test.ts
```

### `types.ts`

```typescript
export interface AuthUser {
  /** Cognito sub claim — stable per-user identifier across token refreshes. */
  readonly sub: string

  /** Cognito's internal username for the federated user.
   *  For Google sign-in: 'Google_<google-sub>'
   *  For Discord sign-in: 'Discord_<discord-snowflake>'
   *  For bypass mode: 'bypass_dev_1' (lowercase + underscores per parent §4 username format)
   *  This is the cognito-internal username, NOT the user-chosen username
   *  Mythrun adds in MYT-38 onboarding (which lives on `users.username`). */
  readonly username: string

  /** Space-separated OAuth scopes granted to this token. */
  readonly scope: string

  /** Always 'access' for real tokens; 'bypass' for bypass mode.
   *  Routes that need to differentiate (rare) can switch on this. */
  readonly tokenUse: 'access' | 'bypass'

  // Note: `email`, `name`, and `picture` are deliberately absent. The Linear
  // ticket and parent §5.1 list them, but Cognito access tokens don't carry
  // them — they're id_token claims, and we use access tokens (per §2). The
  // backend gets email/name/picture from the users row after MYT-38
  // onboarding (which calls /oauth2/userInfo once at user creation).
}

declare module 'fastify' {
  interface FastifyRequest {
    /** OPTIONAL — public routes don't have a user attached. Protected
     *  handlers should narrow via the `requireUser(request)` helper rather
     *  than dereferencing `request.user.sub` directly, which would throw at
     *  runtime if a route accidentally lands here without auth. */
    user?: AuthUser
  }

  interface FastifyContextConfig {
    /** Per-route auth opt-out / opt-in.
     *  - 'public' — skip validation entirely; no request.user attached.
     *  - 'jwt-no-db' — verify JWT, attach claims; no DB lookup. Used by
     *    MYT-38's /api/users/register since the user row doesn't exist yet.
     *  - undefined (default) — default-require. Today: same as 'jwt-no-db'.
     *    After MYT-39: also DB lookup + suspended_at check. */
    auth?: 'public' | 'jwt-no-db'
  }
}

/** Helper for protected handlers — narrows request.user from optional to
 *  required. Throws if called from a public-route handler (which would
 *  indicate a route misconfigured `config.auth = 'public'` and then tried
 *  to use the user).
 */
export function requireUser(request: { user?: AuthUser }): AuthUser {
  if (!request.user) {
    throw new Error('requireUser: request.user is undefined — was this route marked public?')
  }
  return request.user
}
```

### `index.ts`

```typescript
import type { FastifyInstance } from 'fastify'
import { jwtPlugin, type JwtPluginOptions } from './jwt-plugin.js'
import { bypassPlugin, type BypassPluginOptions } from './bypass-plugin.js'

export type AuthMode = 'bypass' | 'real'

export interface RegisterAuthOptions {
  mode: AuthMode
  /** Cognito User Pool ID. REQUIRED when mode === 'real'. In bypass mode,
   *  presence is FORBIDDEN (Layer 3 of the bypass-mode defense rejects). */
  userPoolId?: string
  /** Cognito App Client ID. REQUIRED when mode === 'real'. */
  appClientId?: string
}

export const registerAuth = async (
  app: FastifyInstance,
  opts: RegisterAuthOptions,
): Promise<void> => {
  if (opts.mode === 'bypass') {
    // Plumb the (presumed-empty) userPoolId through to bypassPlugin's Layer 3
    // check. If a misconfig has it set, the plugin throws at registration.
    const bypassOpts: BypassPluginOptions = {
      cognitoUserPoolId: opts.userPoolId,
    }
    await app.register(bypassPlugin, bypassOpts)
    return
  }
  if (!opts.userPoolId || !opts.appClientId) {
    throw new Error('registerAuth: real mode requires userPoolId and appClientId')
  }
  const jwtOpts: JwtPluginOptions = {
    userPoolId: opts.userPoolId,
    appClientId: opts.appClientId,
  }
  await app.register(jwtPlugin, jwtOpts)
}
```

### Module-augmentation import path

`types.ts` augments the global `FastifyRequest` interface, which means any file using `request.user` needs `types.ts` transitively in its import graph. The natural path: `app.ts` (or whichever file calls `buildApp`) imports `registerAuth` from `./auth/index.js`, which imports both plugins, both of which import `types.ts`. Routes don't need to import `types.ts` directly — the augmentation is global once any file in the project loads it.

---

## 4. Bypass-Mode Safety: Six-Layer Defense

The bypass plugin is the single most dangerous piece of code in MYT-37. If it ever runs in staging or production, every request becomes authenticated as `dev-sub-1` — a complete auth bypass. Six independent layers each catch the most likely failure mode; combined, the chance of a leak is vanishingly small.

### Layer 1 — `AUTH_MODE` is required and binary

`loadEnv` validates `process.env.AUTH_MODE` is exactly `'real'` or `'bypass'`. Anything else — unset, empty, `'true'`, `'1'`, `'Real'` (case mismatch) — throws at boot with a clear error. **No silent default to either mode.** Forces every environment to make the decision explicitly. `.env.development.example` sets `bypass`; staging Terraform sets `real`; production Terraform sets `real`. The boot fails loudly if any environment forgot.

### Layer 2 — Bypass requires `NODE_ENV !== 'production'`

`bypass-plugin.ts`'s `register` function checks `process.env.NODE_ENV` at registration time. If `'production'` → throw `Error('bypass mode is forbidden when NODE_ENV=production')`. The Dockerfile's production runtime stage sets `ENV NODE_ENV=production`. This catches "staging accidentally got `AUTH_MODE=bypass`."

The check runs **at registration time AND inside the `onRequest` hook** — defense-in-depth. The runtime check costs ~1ns per request and means even if registration somehow succeeded (cosmic ray, library bug, hot-reload glitch), no individual request can leak.

### Layer 3 — Bypass requires Cognito config to be ABSENT (read from parsed env, not process.env directly)

The bypass plugin receives the parsed `cognitoUserPoolId: string | undefined` value as a registration option (set by `registerAuth` based on `loadEnv` output). If the value is non-empty, bypass mode registration throws `Error('bypass mode is forbidden when cognitoUserPoolId is set')`. Catches the case where someone added `AUTH_MODE=bypass` to a real environment's task-def — that environment, by definition, has the Cognito config set.

**Critical detail:** Layer 3 reads from the parsed env object (the result of `loadEnv`), NOT `process.env.COGNITO_USER_POOL_ID` directly. This makes the layer refactor-proof: if a future PR moves Cognito config to Secrets Manager (loaded into `env.COGNITO_USER_POOL_ID` by `loadEnv` from a runtime fetch instead of an ECS task-def env var), Layer 3 still fires because it reads the parsed value, not the raw env var. Same dual-check (registration AND per-request) — both checks read the same plumbed-in value.

### Layer 4 — Loud structured-log warning at registration

```typescript
app.log.warn(
  { event: 'auth.bypass_mode_active' },
  'AUTH BYPASS MODE: all requests authenticated as dev user. NEVER run in staging/production.',
)
```

Logged once at registration. Visible in any dev log tail, any CI run, any local `pnpm dev` startup. If bypass somehow gets to a production environment despite layers 2 + 3 + 5, the log line is the loud canary.

### Layer 5 — Terraform sets `AUTH_MODE=real` explicitly in staging

`infra/environments/staging/main.tf` adds `{ name = "AUTH_MODE", value = "real" }` to `module.serving.extra_env`. Same shape as the MYT-36 `BOOT_GATE_ENABLED` and `COGNITO_*` additions. Production composition (the `myth-prod-auth-compose` follow-up) does the same. No silent defaults at the infra layer either.

### Layer 6 — Tests verify every gate

- `AUTH_MODE` unset → loadEnv throws
- `AUTH_MODE='bogus'` → loadEnv throws
- Bypass + `NODE_ENV='production'` → registration throws
- Bypass + `COGNITO_USER_POOL_ID` set → registration throws
- Per-request: `NODE_ENV='production'` set after registration → request throws
- Per-request: `COGNITO_USER_POOL_ID` set after registration → request throws

### What's deliberately NOT in the defense

- **Network-bind check** ("only allow bypass when listening on 127.0.0.1"): unreliable inside a request handler; ECS health checks come from a different IP than user traffic; the layers above are sufficient.
- **Build-time exclusion of `bypass-plugin.ts` from production bundles**: brittle; any future bundler tweak could silently re-include it; the runtime checks are more robust than build-time hopes.
- **Cryptographic signature on bypass tokens**: pointless overhead; bypass means "no token at all," not "a special token."

---

## 5. JWT Plugin Internals

```typescript
import { type FastifyPluginAsync } from 'fastify'
import { CognitoJwtVerifier } from 'aws-jwt-verify'
import type { AuthUser } from './types.js'

export interface JwtPluginOptions {
  userPoolId: string  // e.g. 'us-east-1_5gDAtYzjV'
  appClientId: string // e.g. 'l7u6cnoev0cv9d5vei76ko5tj'
}

const REGISTERED_DECORATOR = 'mythAuthRegistered'

export const jwtPlugin: FastifyPluginAsync<JwtPluginOptions> = async (app, opts) => {
  // Sentinel: refuse double-registration. A misconfigured test harness or
  // a code path that calls registerAuth twice would otherwise stack two
  // onRequest hooks (verifying every request twice + the second hook
  // overwriting request.user with a different result).
  if (app.hasDecorator(REGISTERED_DECORATOR)) {
    throw new Error('jwtPlugin: auth is already registered on this Fastify instance')
  }
  app.decorate(REGISTERED_DECORATOR, 'jwt' as const)

  const verifier = CognitoJwtVerifier.create({
    userPoolId: opts.userPoolId,
    clientId: opts.appClientId,
    tokenUse: 'access',
  })

  // Pre-fetch the JWKS at registration so the FIRST protected request after
  // every container start doesn't pay the ~100-3000ms JWKS fetch latency.
  // aws-jwt-verify's `hydrate()` always fetches the latest JWKS; if it fails
  // (Cognito unreachable, network down), we fail boot loudly — a service
  // that can't fetch the JWKS can't authenticate anyone, so refusing to
  // come up healthy is the correct behavior.
  await verifier.hydrate()

  // Decorate the app with the verifier so MYT-38's /api/users/register handler
  // (which uses `auth: 'jwt-no-db'` mode, identical to default in MYT-37) can
  // reuse the same verifier instance without constructing its own.
  app.decorate('jwtVerifier', verifier)

  app.addHook('onRequest', async (request, reply) => {
    // 404 fall-through: unmatched routes have undefined routeOptions when a
    // setNotFoundHandler is registered. Without this guard, the auth check
    // would proceed and an unauthenticated request to a nonexistent path
    // would return 401 instead of 404 — leaking auth-state info about route
    // existence.
    if (!request.routeOptions) return

    const authMode = request.routeOptions.config?.auth
    // Public-route opt-out: skip ALL validation, no request.user attached.
    // Check FIRST so a health probe doesn't burn a verifier call.
    if (authMode === 'public') return

    // Both 'jwt-no-db' and undefined (default) flow through verification.
    // In MYT-37 they're identical; MYT-39 will add a DB-lookup branch for
    // the default mode while keeping 'jwt-no-db' claims-only.
    const header = request.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing Bearer token' })
    }
    const token = header.slice('Bearer '.length).trim()
    if (token.length === 0) {
      return reply.code(401).send({ error: 'Empty Bearer token' })
    }

    let payload
    try {
      payload = await verifier.verify(token)
    } catch (err) {
      // aws-jwt-verify throws specific error subclasses (JwtExpiredError,
      // JwtInvalidIssuerError, JwtInvalidSignatureError, etc.). We log the
      // error CLASS name only — never the token, never the payload — so
      // operators can distinguish failure patterns in CloudWatch without
      // exposing PII. We catch the parent Error class so future library
      // versions adding new subclasses (e.g. JwtRevokedError) still get
      // turned into 401s; the runbook lists known classes but new ones are
      // expected and treated as 401.
      request.log.warn(
        { event: 'auth.jwt_verify_failed', errorClass: err instanceof Error ? err.constructor.name : 'Unknown' },
        'JWT verification failed',
      )
      return reply.code(401).send({ error: 'Invalid token' })
    }

    const user: AuthUser = {
      sub: payload.sub,
      username: payload.username,
      scope: payload.scope ?? '',
      tokenUse: 'access',
    }
    request.user = user
  })
}
```

### Seven things worth flagging

1. **`tokenUse: 'access'` in the verifier config.** `aws-jwt-verify` rejects id_tokens when configured for access; rejects access tokens when configured for `id`. We accept access only.

2. **JWKS caching: `aws-jwt-verify`'s actual model.** The library fetches the JWKS lazily on the first `verify()` call (which is why we call `hydrate()` at registration to warm it). It caches keys per-`kid` indefinitely; refetches happen only when a JWT arrives with an unknown `kid` (i.e., key rotation). The library enforces a 10-second per-URI rate limit on JWKS fetches to prevent abuse. **Parent §5.2 step 4 specified "10-minute refresh cadence with rate-limited fallback on cache miss" — that exact cadence does not exist in the library; the kid-miss model is functionally equivalent for our use case** (Cognito rotates keys rarely, kid-miss invalidates instantly when it happens, the 10-second rate limit covers the abuse case). The deviation is acknowledged here rather than re-implemented.

3. **Constructor at registration + hydrate at registration.** Without `hydrate()`, the FIRST request after every container start would pay the JWKS fetch latency (~100ms-3s depending on Cognito's response). With `hydrate()` awaited at registration, every request benefits from a warm cache. Hydrate failure throws — the boot fails loudly, which is the right behavior for "this service can't authenticate anyone."

4. **Error-class logging without PII.** The token itself, the payload, and the user's identity NEVER appear in logs. Only the error class name (`JwtExpiredError`, `JwtInvalidSignatureError`, etc.) goes to CloudWatch. Lets operators triage patterns without leaking auth material. We catch the parent `Error` class (not specific subclasses), so future library versions introducing new error classes still get turned into 401s.

5. **404 fall-through guard is FIRST.** `if (!request.routeOptions) return` ensures unmatched paths skip the hook entirely, letting Fastify's 404 handler (default or custom) respond cleanly. Without this, an authenticated request to a nonexistent path would return 401 instead of 404, leaking route-existence info.

6. **Public-route check is SECOND.** Before any token parsing, before any verifier call. Cheaper for public routes and avoids spurious "no Bearer token" warnings on health probes.

7. **Signature verification is delegated to `aws-jwt-verify`** — including the kid-confusion / alg=none / matching-kid attacker classes. The library is AWS-Labs maintained, has no published CVEs, and is the canonical Cognito-JWT verifier. We trust the library's JWKS-pin + signature-check.

---

## 6. Bypass Plugin Internals

```typescript
import { type FastifyPluginAsync } from 'fastify'
import type { AuthUser } from './types.js'

const REGISTERED_DECORATOR = 'mythAuthRegistered'

// Bypass user. The `sub` deliberately uses the form `bypass:dev-1` (with a
// colon) which is not a valid Cognito sub UUID — eliminates collision risk
// with any real federated user's sub. Username matches parent §4 username
// format (lowercase, alphanumeric + underscores).
const BYPASS_USER: AuthUser = {
  sub: 'bypass:dev-1',
  username: 'bypass_dev_1',
  scope: 'openid email profile',
  tokenUse: 'bypass',
}

export interface BypassPluginOptions {
  /** Plumbed in from loadEnv (parsed env), NOT read from process.env directly.
   *  Layer 3 of the bypass-mode defense reads this. If it's a non-empty
   *  string, registration throws. Refactor-proof: future moves of Cognito
   *  config to Secrets Manager / SSM still flow through loadEnv → here. */
  cognitoUserPoolId?: string
}

export const bypassPlugin: FastifyPluginAsync<BypassPluginOptions> = async (app, opts) => {
  // Sentinel: refuse double-registration (same as jwtPlugin).
  if (app.hasDecorator(REGISTERED_DECORATOR)) {
    throw new Error('bypassPlugin: auth is already registered on this Fastify instance')
  }
  app.decorate(REGISTERED_DECORATOR, 'bypass' as const)

  // Defense layer 2: NODE_ENV=production must reject bypass at registration.
  // Reading process.env.NODE_ENV is correct here because Node's runtime
  // exposes its own environment via this property; there's no "parsed"
  // alternative.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'auth bypass plugin: NODE_ENV=production — bypass mode is forbidden in production builds',
    )
  }

  // Defense layer 3: parsed Cognito config must be empty.
  // Reads from opts (plumbed in from loadEnv), not process.env directly —
  // refactor-proof against future Secrets Manager / SSM moves.
  if (opts.cognitoUserPoolId) {
    throw new Error(
      'auth bypass plugin: cognitoUserPoolId is set — bypass mode is forbidden in any environment with real Cognito wiring',
    )
  }

  // Defense layer 4: loud, structured warning whenever bypass is active.
  app.log.warn(
    { event: 'auth.bypass_mode_active' },
    'AUTH BYPASS MODE: all requests authenticated as dev user. NEVER run in staging/production.',
  )

  app.addHook('onRequest', async (request) => {
    // 404 fall-through (same as jwtPlugin).
    if (!request.routeOptions) return

    // Public routes opt out the same way they do under real auth.
    if (request.routeOptions.config?.auth === 'public') return

    // Per-request re-check of layers 2 and 3 — belt-and-suspenders. The
    // realistic failure mode this catches is narrow (something mutating
    // process.env at runtime, which no library should do); it's mostly
    // ceremony that signals the seriousness of bypass mode rather than
    // providing genuinely new defense beyond the registration check. Cost
    // is trivial (one boolean compare); we keep it.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('auth bypass plugin: NODE_ENV=production observed at request time')
    }
    if (opts.cognitoUserPoolId) {
      throw new Error('auth bypass plugin: cognitoUserPoolId observed at request time')
    }

    request.user = BYPASS_USER
  })
}
```

### Five things worth flagging

1. **`BYPASS_USER.sub = 'bypass:dev-1'`** — the colon is intentional. Cognito subs are UUIDs (no colons); the prefix makes accidental collision with a real user's sub structurally impossible. If `users.cognito_sub` ever gets populated by mistake (e.g., a developer ran their local backend against staging Postgres once with bypass mode active), the value is recognizable as bypass-origin in the row, not just by app behavior. A future schema ticket can add a `CHECK (cognito_sub NOT LIKE 'bypass:%')` constraint to make this guarantee enforced at the DB layer.

2. **`BYPASS_USER.username = 'bypass_dev_1'`** matches parent §4 username format (lowercase, alphanumeric + underscores, no leading/trailing underscores). Important if any code path ever copies it into `users.username`.

3. **No `reply` parameter on the bypass `onRequest` hook.** Bypass mode never sends responses from the hook; it always passes through. The plugin's only failure mode is "registration or runtime check threw" — which surfaces as a 500 from Fastify's error handler, the right behavior for "bypass mode tried to run in production" (loud failure rather than silent auth bypass).

4. **Plumbed env values, not `process.env` reads.** `bypassPlugin` accepts `cognitoUserPoolId` as an option (set by `registerAuth` from the parsed `loadEnv` output). This makes Layer 3 refactor-proof: a future PR moving Cognito config to Secrets Manager / SSM still flows through `loadEnv` to here. `process.env.NODE_ENV` IS read directly because that's how Node's runtime exposes its own environment — no "parsed" alternative exists.

5. **Per-request re-check is honest defense-in-depth, not extra security.** The realistic failure mode the runtime check catches (something mutating `process.env` between registration and a request) is narrow — no production library does this. The check is mostly ceremony signaling bypass-mode seriousness; cost is trivial. Spec keeps it for defense-in-depth posture, not because it provides genuinely new protection.

---

## 7. Server Wiring & Env Loader

### `loadEnv` additions

The existing `loadEnv` (from MYT-29) gains:

- **`AUTH_MODE`** — required, validated to `'real' | 'bypass'` (Zod enum or equivalent). Throws on unset, empty string, or any value other than the two literals (case-sensitive).
- **`COGNITO_USER_POOL_ID`** — optional `string | undefined`. Required if `AUTH_MODE='real'`, validated downstream in `registerAuth`.
- **`COGNITO_APP_CLIENT_ID`** — same shape as `COGNITO_USER_POOL_ID`.
- (`COGNITO_HOSTED_UI_DOMAIN` and `COGNITO_ISSUER_URL` are wired as env vars by MYT-36 but the JWT plugin doesn't need them; loadEnv may parse them for completeness or skip them.)

### `server.ts` wiring

In the existing boot sequence (after `loadEnv`, after the boot gate's pg/redis probes succeed, before `app.listen`):

```typescript
import { registerAuth } from './auth/index.js'

// ... after loadEnv ...
const env = loadEnv()

// ... after the boot gate ...
const app = buildApp(deps)

await registerAuth(app, {
  mode: env.AUTH_MODE,
  userPoolId: env.COGNITO_USER_POOL_ID,
  appClientId: env.COGNITO_APP_CLIENT_ID,
})

await app.listen(...)
```

The plugin registers AFTER `buildApp` constructs the Fastify instance and registers the existing health routes. Hooks added later run on subsequent requests; the existing health route handlers don't see the auth hook for already-mounted-but-still-incoming requests. (Not a real concern — registration happens at boot before `listen`.)

### `.env.development.example`

Already sets `AUTH_MODE=bypass`. No change needed beyond confirming it's the correct value for local dev.

### Infra change: `AUTH_MODE=real` in staging

`infra/environments/staging/main.tf` — extend `module.serving.extra_env`:

```hcl
extra_env = [
  { name = "BOOT_GATE_ENABLED",        value = "1" },                            # MYT-35
  { name = "COGNITO_USER_POOL_ID",     value = module.auth.user_pool_id },       # MYT-36
  { name = "COGNITO_APP_CLIENT_ID",    value = module.auth.app_client_id },      # MYT-36
  { name = "COGNITO_HOSTED_UI_DOMAIN", value = module.auth.hosted_ui_domain },   # MYT-36
  { name = "COGNITO_ISSUER_URL",       value = module.auth.issuer_url },         # MYT-36
  { name = "AUTH_MODE",                value = "real" },                          # MYT-37
]
```

---

## 8. Public-Route Allowlist

For MYT-37, the public routes are exactly the ones that exist today:

| Method | Path | Reason |
|--------|------|--------|
| GET | `/health` | ECS container liveness probe |
| GET | `/health/ready` | ALB target-group readiness probe |

Both opt out via `config: { auth: 'public' }` on their route registration. No path-based allowlist in the plugin; the opt-out is a per-route property visible at the route's definition site.

Future tickets add their public routes the same way:
- MYT-38 adds `POST /api/users/register` (public — uses claims from the verified JWT but doesn't require an existing DB row, so it ALSO uses `auth: 'public'` and does its own `verifier.verify()` inline; OR uses a custom auth mode like `auth: 'jwt-no-db'` once we have the loadUser plugin to differentiate from)
- MYT-42 adds `POST /webhooks/stripe` (public — verified by Stripe signature, not JWT)
- A future ticket adds `GET /api/sessions/:id/recap` (public shareable recap)

Each addition is a one-line change in the route file plus a test that verifies the route is reachable without a Bearer token.

---

## 9. Testing

Three test files plus a loadEnv test. All Vitest. No real Cognito calls — `aws-jwt-verify` is mockable via `vi.mock` or via constructing the verifier with a stubbed `cacheLoadKey`.

### `backend/src/auth/__tests__/jwt-plugin.test.ts`

Tests use `vi.mock('aws-jwt-verify')` to stub `CognitoJwtVerifier.create()` returning a verifier with controllable `hydrate()` and `verify()` behavior.

| Case | Expected |
|------|----------|
| `hydrate()` succeeds at registration | plugin registers cleanly |
| `hydrate()` rejects | registration throws; boot fails loudly |
| `app.register(jwtPlugin)` called twice | second call throws `auth is already registered` |
| Valid access token | 200; `request.user = { sub, username, scope, tokenUse: 'access' }` |
| Missing `Authorization` header on protected route | 401; body `{ error: 'Missing Bearer token' }` |
| `Authorization: Basic abc` (wrong scheme) | 401; same body (the prefix check rejects) |
| `Authorization: Bearer ` (empty after prefix) | 401; body `{ error: 'Empty Bearer token' }` |
| `Authorization: bearer xyz` (lowercase scheme) | 401 (we case-sensitive match `Bearer ` per RFC 6750 §2.1) |
| `Authorization: Bearer\txyz` (tab instead of space) | 401 (the `startsWith('Bearer ')` rejects tab) |
| `Authorization: Bearer t1, Bearer t2` (multi-token) | 401 (the second `Bearer ` is treated as part of the token; verifier rejects) |
| Expired token (mock throws `JwtExpiredError`) | 401; body `{ error: 'Invalid token' }`; log includes `errorClass: 'JwtExpiredError'`; no token in log |
| Wrong issuer | 401; log includes `errorClass: 'JwtInvalidIssuerError'` |
| Wrong audience | 401; log includes the corresponding error class |
| Future unknown error class | 401; log includes the actual class name (whatever it is) |
| `id_token` sent (mock throws on `tokenUse: 'access'` config) | 401 |
| Public route (`auth: 'public'`), no `Authorization` header | 200; opt-out hits before token parsing; `request.user` not attached |
| `jwt-no-db` route, valid token | 200; `request.user` attached (identical behavior to default route in MYT-37) |
| Unmatched path, no `Authorization` header | 404 (404 fall-through guard) |
| Unmatched path, valid `Authorization` header | 404 (still falls through; `routeOptions` undefined) |

### `backend/src/auth/__tests__/bypass-plugin.test.ts`

**Test harness note:** per-request env-mutation tests use `vi.stubEnv('NODE_ENV', 'production')` + `vi.unstubAllEnvs()` in `afterEach` to avoid cross-test contamination across Vitest's parallel workers. Plain `process.env.NODE_ENV = 'production'` mutation would leak between tests.

| Case | Expected |
|------|----------|
| Plain GET, no token, bypass mode, `NODE_ENV` unset, `cognitoUserPoolId` undefined | 200; `request.user = BYPASS_USER` |
| Public route (`auth: 'public'`) | 200; bypass hook returns early; `request.user` not attached |
| `app.register(bypassPlugin)` called twice | second call throws `auth is already registered` |
| Registration with `NODE_ENV='production'` (via `vi.stubEnv`) | throws `Error` matching `/forbidden in production builds/` |
| Registration with `cognitoUserPoolId: 'us-east-1_xyz'` | throws `Error` matching `/forbidden in any environment with real Cognito wiring/` |
| Per-request: `vi.stubEnv('NODE_ENV', 'production')` between registration and request | request throws → Fastify 500 |
| Per-request: dynamic mutation of plumbed `cognitoUserPoolId` (via test indirection) | request throws |
| Bypass logs `auth.bypass_mode_active` warning at registration | log captured via Fastify's pino test transport |
| Unmatched path | 404 (404 fall-through guard) |
| `BYPASS_USER.sub` is `'bypass:dev-1'` | exact-match assertion (collision-proof prefix) |
| `BYPASS_USER.username` matches parent §4 username regex | conforms to lowercase + alphanumeric + underscores |

### `backend/src/auth/__tests__/index.test.ts`

| Case | Expected |
|------|----------|
| `mode: 'bypass'` | bypass behavior on a request |
| `mode: 'real'` with valid config | JWT behavior (mocked verifier) |
| `mode: 'real'` with missing `userPoolId` | throws `Error` matching `/real mode requires/` |
| `mode: 'real'` with missing `appClientId` | throws |

### `backend/src/config/__tests__/load-env.test.ts` (or wherever loadEnv lives)

| Case | Expected |
|------|----------|
| `AUTH_MODE` unset | throws |
| `AUTH_MODE='bypass'` | parsed cleanly |
| `AUTH_MODE='real'` | parsed cleanly |
| `AUTH_MODE='Real'` (case mismatch) | throws |
| `AUTH_MODE='1'` or any other value | throws |

---

## 10. Deploy Sequence

This is the **first ticket that consumes MYT-36's `COGNITO_*` env vars**. Per `reference_tf_ci_taskdef_split.md`, the live ECS service is currently on the last CI-deployed revision (no `COGNITO_*`, no `AUTH_MODE`). Three phases. **Order matters: TF apply MUST land before code reaches `main`**, otherwise the auto-Deploy fires against a task-def that lacks `AUTH_MODE`, the new container's `loadEnv` throws on the missing env var, ECS health-check fails, and the deployment circuit-breaker rolls back.

### Phase A — TF apply for the `AUTH_MODE` env var (BEFORE any code ships)

1. On a working branch (NOT yet merged to `main`), add `{ name = "AUTH_MODE", value = "real" }` to staging composition's `extra_env` list (one-line change).
2. From the working branch, `cd infra/environments/staging && terraform plan -out=apply.tfplan` — expect 1 task-def revision change (api task-def picks up `AUTH_MODE` in addition to MYT-36's 4 `COGNITO_*` vars + `BOOT_GATE_ENABLED`).
3. `terraform apply apply.tfplan`. The TF-registered task-def now has `AUTH_MODE=real`, but the ECS service is still on the old CI-deployed revision (which lacks `AUTH_MODE` AND lacks the new JWT plugin code) — and crucially, the old running code doesn't read `AUTH_MODE`, so no failure.
4. Re-plan to verify drift-free (`terraform plan` shows `No changes`).
5. **Now** the TF state is ready for code that depends on `AUTH_MODE`.

### Phase B — Code lands on `main` and auto-deploys

Push the working branch to `main` (or merge the PR). `Deploy` workflow auto-triggers. CI's `aws-actions/amazon-ecs-render-task-definition` step takes the latest TF-registered task-def (which now has all 5 env vars + `AUTH_MODE`), renders the real ECR image with the new JWT plugin code, registers a new revision, calls `update-service`. Service rolls onto the new revision: JWT plugin loaded, `AUTH_MODE=real` set, JWKS hydrated at boot via `verifier.hydrate()`.

### Phase C — Verify in staging

- `aws ecs describe-services --cluster mythrun --services mythrun-staging-api` shows desired = running on the new revision.
- `curl https://staging-api.mythrun.com/health` returns `{ status: 'ok' }` (public route, no auth).
- `curl https://staging-api.mythrun.com/some-nonexistent-path` returns **404** (404 fall-through guard works — the `if (!request.routeOptions) return` lets unmatched paths skip auth and reach the 404 handler).
- `curl -H "Authorization: Bearer invalidtoken123" https://staging-api.mythrun.com/some-nonexistent-path` returns 404 (authenticated request to a nonexistent path; auth hook still falls through; `routeOptions` is undefined for unmatched paths).
- `curl -X POST https://staging-api.mythrun.com/some-nonexistent-protected-path` returns 401 with `{ error: 'Missing Bearer token' }` — wait, this is wrong: a POST to a nonexistent path is also unmatched, so it should 404 too. The actual proof of "auth is enforced" comes from MYT-38 when the first protected route ships. **Today we can verify the negative case (public routes still work without auth, JWKS hydrate succeeds at boot per logs) but we cannot verify the positive case (a protected route 401s without auth, 200s with valid auth) — that test is deferred to MYT-38.**
- CloudWatch logs show `verifier.hydrate()` succeeded: look for absence of `auth.bypass_mode_active` (correct — staging is real mode), and a successful boot completion log line.
- CloudWatch logs do NOT show `auth.bypass_mode_active` — bypass mode is correctly NOT active in staging.

### What if Phase A's TF apply succeeded but Phase B's code push fails?

Recoverable. The TF-registered task-def has `AUTH_MODE=real` but the live ECS service is still on the old CI rev (no new code). Since the old code doesn't read `AUTH_MODE`, the running service is unaffected. Push a fixed code change to retry Phase B.

### What if Phase B fires before Phase A?

The new container boots, `loadEnv` throws on missing `AUTH_MODE`, ECS health check fails, circuit-breaker rolls back to the previous revision. No corruption, no exposure — just a failed deploy. The fix: complete Phase A first, then re-trigger Phase B (push a no-op commit or `gh workflow run Deploy`).

---

## 11. Out of Scope

| Item | Deferred to |
|------|-------------|
| `/api/auth/refresh` endpoint | Future ticket alongside SPA frontend |
| `/api/users/register` (creates the user row from claims) | MYT-38 |
| DB lookup of `users.id` from `cognito_sub` | MYT-39 (when first consumer needs it) |
| `suspended_at` enforcement | MYT-39 |
| WebSocket ticket exchange | MYT-39 |
| WebSocket re-validation (every 30 min ping/pong with fresh token) | MYT-39 |
| Multi-dev-user testing via `X-Dev-User` header | Defer until multiplayer code exists (MYT-39 territory) |
| End-to-end test through real Cognito JWKS | MYT-38 (first protected route) |
| Boot-gate probe for Cognito JWKS reachability beyond hydrate | `verifier.hydrate()` at registration covers cold-start; deferred for ongoing reachability |
| Custom claim validation (custom scopes, group membership) | Future, when access-control needs it |
| Rate-limited fallback JWKS refresh on cache miss (parent spec §5.2 step 4) | The parent's exact 10-minute cadence isn't what `aws-jwt-verify` does; see §5 flag #2 |
| `userPoolId` rotation without process restart | Out of scope; DR rotation requires a redeploy |
| `users.cognito_sub` CHECK constraint rejecting `'bypass:%'` | `myth-bypass-user-db-constraint` follow-up bead, deferred to whichever schema-related ticket lands the constraint |
| Module-level `AUTH_MODE` default in `infra/modules/serving` | `myth-serving-auth-mode-default` follow-up bead — Komodo's round-1 finding; deferred because it's a serving-module change beyond MYT-37's scope |
| Window between `suspended_at = now()` being set and an active access token expiring (up to 1 hour) | `myth-suspended-token-revocation` follow-up bead — banned users can keep API access until token TTL until MYT-39 ships the DB-lookup. Acceptable for pre-launch staging; must close before public launch |
| CloudWatch metric on `auth.bypass_mode_active` for proactive alerting | `myth-cognito-monitoring` (already filed in MYT-36 as the broader Cognito monitoring bead) |

---

## 12. Follow-up Beads

To file after MYT-37 lands:

- **`myth-serving-auth-mode-default`** (P2) — Bake `AUTH_MODE` into the serving Terraform module as a forced default with validation that rejects `'bypass'` unless an explicit `allow_bypass = true` flag is also passed. Today, MYT-37 sets `AUTH_MODE=real` per-environment in staging's `extra_env`; production composition has to remember the same. The module-level default makes the constraint structural rather than per-env-vigilance. (Komodo round-1 finding; deferred because it's a serving-module change beyond MYT-37's scope.)
- **`myth-bypass-user-db-constraint`** (P3) — Add `CHECK (cognito_sub NOT LIKE 'bypass:%')` to the `users` table whenever a future migration touches it. Defense-in-depth: even if bypass mode somehow ran against a real DB, the row insert fails. Skip until a schema-related ticket creates a natural home for the constraint.
- **`myth-suspended-token-revocation`** (P2 before launch, P3 today) — Close the up-to-1-hour gap between `users.suspended_at = now()` being set and an active access token expiring. MYT-39 adds the DB lookup that makes this enforceable, so this bead is partially handled there; remaining work is deciding whether to also add a Redis-pub/sub revocation path (as parent §6.4 suggests for active WebSockets). Must close before public launch.
- **`myth-auth-jwks-probe`** (P4) — Optionally extend the boot gate (`backend/src/boot/wait-for.ts`) to probe Cognito's JWKS endpoint as part of readiness. `verifier.hydrate()` at plugin registration already covers cold-start; this would add ongoing reachability monitoring. Skip until the failure is observed in the wild.
- **`myth-auth-multi-dev-user`** (P4) — Add `X-Dev-User: <N>` header support to bypass plugin when multiplayer testing needs distinct dev users. Likely concurrent with MYT-39's WebSocket work.
- **Parent spec correction** (no bead — sweeping with MYT-39's design): re-articulate `docs/specs/2026-04-13-auth-users.md` §5.1 to reflect the claims-only-vs-loadUser-plugin separation. The `AuthUser` interface in §5.1 describes the eventual handler-side shape (after both plugins have run), not what the JWT plugin alone attaches. Also: parent §6.4's "we're already doing the DB lookup" reasoning is invalidated by MYT-37's claims-only architecture; `suspended_at` enforcement runs in `loadCurrentUser` (MYT-39), not the JWT plugin.
