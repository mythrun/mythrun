# MYT-37 — JWT Middleware + Bypass Mode + Public-Route Allowlist (Design)

> **Status**: Draft (pending user + blind-review approval)
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

### Default-require, opt-out per route

The plugin's `onRequest` hook checks `request.routeOptions.config?.auth === 'public'` and skips validation if true. Default behavior (config absent) means auth required. A forgotten opt-out is the safer failure mode (a 401 is loud; a silently-public protected route is not). The two existing public routes (`GET /health`, `GET /health/ready`) explicitly mark themselves public.

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
   *  For bypass mode: 'Dev_User'
   *  This is the cognito-internal username, NOT the user-chosen username
   *  Mythrun adds in MYT-38 onboarding (which lives on `users.username`). */
  readonly username: string

  /** Space-separated OAuth scopes granted to this token. */
  readonly scope: string

  /** Always 'access' for real tokens; 'bypass' for bypass mode.
   *  Routes that need to differentiate (rare) can switch on this. */
  readonly tokenUse: 'access' | 'bypass'
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser
  }

  interface FastifyContextConfig {
    /** Set `auth: 'public'` on a route's config to skip JWT validation.
     *  Default (undefined) means auth required. */
    auth?: 'public'
  }
}
```

### `index.ts`

```typescript
import type { FastifyInstance } from 'fastify'
import { jwtPlugin, type JwtPluginOptions } from './jwt-plugin.js'
import { bypassPlugin } from './bypass-plugin.js'

export type AuthMode = 'bypass' | 'real'

export interface RegisterAuthOptions {
  mode: AuthMode
  /** Required when mode === 'real'; ignored in bypass mode. */
  userPoolId?: string
  /** Required when mode === 'real'; ignored in bypass mode. */
  appClientId?: string
}

export const registerAuth = async (
  app: FastifyInstance,
  opts: RegisterAuthOptions,
): Promise<void> => {
  if (opts.mode === 'bypass') {
    await app.register(bypassPlugin)
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

### Layer 3 — Bypass requires Cognito env vars to be ABSENT

If `process.env.COGNITO_USER_POOL_ID` is set (which only happens via Terraform-wired ECS task-def env vars in staging/prod), bypass mode registration throws `Error('bypass mode is forbidden when COGNITO_USER_POOL_ID is set')`. Catches the case where someone added `AUTH_MODE=bypass` to a real environment's task-def — that environment, by definition, has the Cognito env vars set. Same dual-check (registration AND per-request).

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

export const jwtPlugin: FastifyPluginAsync<JwtPluginOptions> = async (app, opts) => {
  // Construct once at registration. The verifier internally fetches Cognito's
  // JWKS, caches the keys, and refreshes them on key-rotation events. We do
  // not need to manage that cache ourselves.
  const verifier = CognitoJwtVerifier.create({
    userPoolId: opts.userPoolId,
    clientId: opts.appClientId,
    tokenUse: 'access',
  })

  app.addHook('onRequest', async (request, reply) => {
    // Public-route opt-out: routes that set `config: { auth: 'public' }` skip
    // all validation. Check FIRST — before any token parsing — so a health
    // probe with no Authorization header on a public route doesn't burn a
    // verifier call or fail noisily.
    if (request.routeOptions.config?.auth === 'public') return

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
      // operators can distinguish "expired tokens" from "wrong audience"
      // patterns in CloudWatch without exposing PII.
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

### Five things worth flagging

1. **`tokenUse: 'access'` in the verifier config.** `aws-jwt-verify` rejects id_tokens when configured for access; rejects access tokens when configured for `id`. We accept access only.

2. **JWKS caching is `aws-jwt-verify`'s job.** The library fetches the JWKS endpoint on the first verify call, caches the keys in memory, refreshes on key rotation. We don't manage this cache ourselves; doing so would re-introduce the bug surface the library already eliminates.

3. **Constructor at registration, not per request.** The verifier is constructed once when the plugin registers. `verifier.verify(token)` is the per-request hot path. No per-request setup cost.

4. **Error-class logging without PII.** The token itself, the payload, and the user's identity NEVER appear in logs. Only the error class name (`JwtExpiredError`, `JwtInvalidSignatureError`, etc.) goes to CloudWatch. Lets operators triage patterns without leaking auth material.

5. **Public-route check is FIRST.** Before any token parsing, before any verifier call. Cheaper for public routes and avoids spurious "no Bearer token" warnings on health probes.

---

## 6. Bypass Plugin Internals

```typescript
import { type FastifyPluginAsync } from 'fastify'
import type { AuthUser } from './types.js'

const BYPASS_USER: AuthUser = {
  sub: 'dev-sub-1',
  username: 'Dev_User',
  scope: 'openid email profile',
  tokenUse: 'bypass',
}

export const bypassPlugin: FastifyPluginAsync = async (app) => {
  // Defense layer 2: NODE_ENV=production must reject bypass at registration.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'auth bypass plugin: NODE_ENV=production — bypass mode is forbidden in production builds',
    )
  }

  // Defense layer 3: presence of the Cognito env vars (only set by Terraform
  // in real environments) must reject bypass at registration.
  if (process.env.COGNITO_USER_POOL_ID) {
    throw new Error(
      'auth bypass plugin: COGNITO_USER_POOL_ID is set — bypass mode is forbidden in any environment with real Cognito wiring',
    )
  }

  // Defense layer 4: loud, structured warning whenever bypass is active.
  app.log.warn(
    { event: 'auth.bypass_mode_active' },
    'AUTH BYPASS MODE: all requests authenticated as dev user. NEVER run in staging/production.',
  )

  app.addHook('onRequest', async (request) => {
    // Public routes opt out the same way they do under real auth.
    if (request.routeOptions.config?.auth === 'public') return

    // Re-check the safety gates on every request — defense-in-depth.
    // ~1ns per request; cost is irrelevant; catches the case where some
    // future code path bypasses the registration check.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('auth bypass plugin: NODE_ENV=production observed at request time')
    }
    if (process.env.COGNITO_USER_POOL_ID) {
      throw new Error('auth bypass plugin: COGNITO_USER_POOL_ID observed at request time')
    }

    request.user = BYPASS_USER
  })
}
```

### Three things worth flagging

1. **No `reply` parameter on the bypass `onRequest` hook.** Bypass mode never sends responses from the hook; it always passes through to the route handler. The plugin's only failure mode is "registration or runtime check threw" — which surfaces as a 500 from Fastify's error handler, the right behavior for "bypass mode tried to run in production" (loud failure rather than silent auth bypass).

2. **`request.user` mutability.** `AuthUser` is `readonly` per the type definition, so the user record can't be modified once attached. The assignment to `request.user` itself is fine because the request object is request-scoped, not shared.

3. **`BYPASS_USER` is `const` at module scope.** Cheap; one allocation; same shape attached to every bypassed request. If multi-dev-user testing via `X-Dev-User` header ever ships (deferred), the const becomes a function returning a different fixed user per N.

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

| Case | Expected |
|------|----------|
| Valid access token | 200; `request.user = { sub, username, scope, tokenUse: 'access' }` |
| Missing `Authorization` header | 401; body `{ error: 'Missing Bearer token' }` |
| `Authorization: Basic abc` (wrong scheme) | 401; same body (the prefix check rejects) |
| `Authorization: Bearer ` (empty after prefix) | 401; body `{ error: 'Empty Bearer token' }` |
| Expired token (mock throws `JwtExpiredError`) | 401; body `{ error: 'Invalid token' }`; log includes `errorClass: 'JwtExpiredError'`; no token in log |
| Wrong issuer | 401; log includes `errorClass: 'JwtInvalidIssuerError'` |
| Wrong audience | 401; log includes the corresponding error class |
| `id_token` sent (mock throws on `tokenUse: 'access'` config) | 401 |
| Public route, no `Authorization` header | 200; opt-out hits before token parsing |

### `backend/src/auth/__tests__/bypass-plugin.test.ts`

| Case | Expected |
|------|----------|
| Plain GET, no token, `AUTH_MODE=bypass`, `NODE_ENV` unset, no `COGNITO_USER_POOL_ID` | 200; `request.user = BYPASS_USER` |
| Public route | 200; bypass hook returns early; `request.user` not asserted |
| Registration with `NODE_ENV='production'` | throws `Error` matching `/forbidden when NODE_ENV=production/` |
| Registration with `COGNITO_USER_POOL_ID` set | throws `Error` matching `/forbidden when COGNITO_USER_POOL_ID/` |
| Per-request: `NODE_ENV='production'` set after registration | request throws (Fastify 500) |
| Per-request: `COGNITO_USER_POOL_ID` set after registration | request throws |
| Bypass logs `auth.bypass_mode_active` warning at registration | log captured via Fastify's pino transport |

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

This is the **first ticket that consumes MYT-36's `COGNITO_*` env vars**. Per `reference_tf_ci_taskdef_split.md`, the live ECS service is currently on the last CI-deployed revision (no `COGNITO_*`, no `AUTH_MODE`). Three phases:

### Phase A — Code lands on `main`

All commits from the implementation plan get pushed to `main` as the implementer subagents complete each task. The `Deploy` workflow auto-triggers on push to `main` (per `.github/workflows/deploy.yml`).

### Phase B — TF apply for the `AUTH_MODE` env var

1. Add `{ name = "AUTH_MODE", value = "real" }` to staging composition's `extra_env` list (one-line change).
2. `terraform plan` from `infra/environments/staging` — expect 1 task-def revision change (api task-def picks up `AUTH_MODE` in addition to MYT-36's 4 `COGNITO_*` vars + `BOOT_GATE_ENABLED`).
3. `terraform apply`.

### Phase C — Trigger CI to roll the service onto the new task-def

`gh workflow run Deploy` (or wait for the auto-trigger from the code push if Phase A pushes haven't yet rolled out). CI's `aws-actions/amazon-ecs-render-task-definition` step takes the latest TF-registered task-def (which now has all 5 env vars + `AUTH_MODE`), renders the real ECR image into it, registers a new revision, calls `update-service`. Service rolls onto the new revision with the JWT plugin code AND `AUTH_MODE=real`.

### Phase D — Verify in staging

- `aws ecs describe-services --cluster mythrun --services mythrun-staging-api` shows desired = running on the new revision.
- `curl https://staging-api.mythrun.com/health` returns `{ status: 'ok' }` (public route, still works without auth).
- `curl https://staging-api.mythrun.com/api/whatever-doesnt-exist-yet` returns 401 with `{ error: 'Missing Bearer token' }` — proof that auth is now required by default, even on routes that don't exist yet (Fastify returns 404 normally, but the auth hook fires first and returns 401 before route matching).
- `curl -H "Authorization: Bearer invalidtoken123" https://staging-api.mythrun.com/api/whatever` returns 401 with `{ error: 'Invalid token' }` — JWT verification path active.
- A real access_token grabbed via the Cognito Hosted UI click-through flow should pass — but **we have no protected routes yet to test against**, so end-to-end testing is deferred to MYT-38 when the first protected route ships.

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
| Boot-gate probe for Cognito JWKS reachability | Future, if/when JWKS unreachability becomes a real failure mode |
| Custom claim validation (custom scopes, group membership) | Future, when access-control needs it |
| Rate-limited fallback JWKS refresh on cache miss (parent spec §5.2 step 4) | Already handled by `aws-jwt-verify` internally; we don't re-implement |

---

## 12. Follow-up Beads

To file after MYT-37 lands:

- **`myth-auth-jwks-probe`** — Optionally extend the boot gate (`backend/src/boot/wait-for.ts`) to probe Cognito's JWKS endpoint as part of readiness, so a Cognito outage prevents the service from coming up healthy. Skip until the failure is observed in the wild.
- **`myth-auth-multi-dev-user`** — Add `X-Dev-User: <N>` header support to bypass plugin when multiplayer testing needs distinct dev users. Likely concurrent with MYT-39's WebSocket work.
- **Parent spec correction** (no bead — sweeping with MYT-39's design): re-articulate `docs/specs/2026-04-13-auth-users.md` §5.1 to reflect the claims-only-vs-loadUser-plugin separation. The `AuthUser` interface in §5.1 describes the eventual handler-side shape, not what the JWT plugin attaches.
