# MYT-37 — JWT Middleware + Bypass Mode + Public-Route Allowlist (Design)

> **Status**: Draft v8 (post round-7 blind review — weather cohort: Storm / Fog / Aurora; identical-to-round-1 prompts)
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

- `backend/src/auth/jwt-plugin.ts` — Fastify plugin verifying access_tokens via `aws-jwt-verify`, hydrating JWKS at registration with a 10s timeout, attaching `request.user = { sub, username, scope }` from the verified claims (no `tokenUse` discriminator). NO database lookup; suspended-user enforcement deferred to MYT-39. Decorates the app with `app.jwtVerifier` for MYT-38's `/api/users/register` to reuse.
- `backend/src/auth/bypass-plugin.ts` — when `AUTH_MODE=bypass`, attaches a fixed dev user `{ sub: 'bypass:dev-1', username: 'bypass_dev_1', scope: 'openid email profile' }`. Multi-layer defense prevents activation outside `NODE_ENV=development|test`.
- `backend/src/auth/index.ts` — `registerAuth(app, { mode, userPoolId, appClientId })` dispatches to one of the two plugins based on mode.
- `backend/src/auth/types.ts` — `AuthUser` interface + Fastify module augmentation for `request.user`, `FastifyContextConfig.auth`, and `FastifyInstance.jwtVerifier`.
- `backend/src/auth/require-user.ts` — `requireUser(request)` helper that narrows `request.user` from optional to required (throws if absent).
- `loadEnv` validates `AUTH_MODE` is exactly `'real' | 'bypass'`. Throws on unset, typo, or any other value. No silent default.
- `buildApp` becomes async and registers auth as part of every boot path (eliminates the `fallbackStart` bypass risk).
- Default-require auth enforcement: routes that should be public set `config: { auth: 'public' }`; routes that need JWT verification but no DB row set `config: { auth: 'jwt-no-db' }`; everything else 401s without a valid Bearer token.
- The two existing public routes (`GET /health`, `GET /health/ready`) opt out via `config: { auth: 'public' }`.
- `infra/modules/serving/variables.tf` adds an `auth_mode` variable (default `"real"`, validated to `'real' | 'bypass'`); `infra/modules/serving/main.tf` injects `{ name = "AUTH_MODE", value = var.auth_mode }` into `common_env`. Staging composition gets `real` via the module default — no `extra_env` line needed (defense layer 5 is now structural at the module).
- Tests cover all the gates: valid token → user attached; expired/wrong-issuer/wrong-audience/missing-claim tokens → 401; bypass mode → fixed user; bypass + `NODE_ENV=production` (or unset, or any non-dev/test value) → throws; bypass + `cognitoUserPoolId` set → throws; `AUTH_MODE` unset → throws; public routes always 200 in both modes; protected routes 401 without auth; unmatched paths return 404 with or without auth header (404 fall-through guard).
- ECS service rolls onto a CI-rendered task-def revision that has all of MYT-36's `COGNITO_*` env vars + the new `AUTH_MODE=real` + the JWT plugin code. `staging-api.mythrun.com/health` still 200; arbitrary nonexistent paths return 404 (404 fall-through working).

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
- **With `setNotFoundHandler`:** unmatched paths flow through `onRequest`. **CRITICAL Fastify behavior** (per the official Server docs): inside the not-found-handler context, `request.routeOptions` is an OBJECT but its `.url`, `.method`, and `.config` are `undefined` — `request.routeOptions` is NOT undefined wholesale. So a guard like `if (!request.routeOptions) return` does NOT fire, and the hook proceeds. Reading `request.routeOptions.config?.auth` returns `undefined !== 'public'`, the hook continues, and an unauthenticated request to a nonexistent path returns 401 instead of 404 — the exact info-leak the design is trying to prevent.

The fix is a guard that checks for the undefined-PROPS shape:

```typescript
// At the top of the auth hook, BEFORE config-based opt-out:
if (request.routeOptions === undefined || request.routeOptions.url === undefined) {
  return // unmatched route, even with setNotFoundHandler registered
}
```

`request.routeOptions.url === undefined` is the documented Fastify signal for "this is a not-found-handler invocation, no route matched." The guard fires for both the default-404 case (routeOptions undefined wholesale) and the setNotFoundHandler-registered case (routeOptions object with undefined props).

`buildApp` registers a custom `setNotFoundHandler` so the auth hook is exercised for unmatched paths (a test that hits an unmatched path actually runs the guard, rather than relying on Fastify's default 404 to short-circuit before the hook fires). The handler returns 404 cleanly. Tests verify both unauth-on-unmatched (404) and authenticated-on-unmatched (404) cases under this configuration.

---

## 3. Module Surface & Types

### File layout

```
backend/src/auth/
  index.ts          # registerAuth(app, opts) — dispatches based on mode; re-exports requireUser
  jwt-plugin.ts     # real JWT validation
  bypass-plugin.ts  # fixed dev user, multi-layer safety defense
  types.ts          # AuthUser + JwtVerifier + Fastify module augmentation
  require-user.ts   # requireUser(request) helper — runtime, kept separate from types.ts
  constants.ts      # REGISTERED_DECORATOR shared between jwt-plugin.ts and bypass-plugin.ts
  __tests__/
    jwt-plugin.test.ts
    bypass-plugin.test.ts
    index.test.ts
```

### `types.ts`

```typescript
import type { CognitoAccessTokenPayload } from 'aws-jwt-verify/jwt-model'

export interface AuthUser {
  /** Cognito sub claim — stable per-user identifier across token refreshes.
   *  This is the canonical identifier for cross-system reference (e.g.,
   *  matching to `users.cognito_sub` after MYT-38 onboarding creates the row).
   *  Treat as immutable; do NOT use Cognito's `username` claim for identity. */
  readonly sub: string

  /** Cognito's internal username for the federated user.
   *  For Google sign-in: 'Google_<google-sub>'
   *  For Discord sign-in: 'Discord_<discord-snowflake>'
   *  For bypass mode: 'bypass_dev_1'
   *
   *  **DO NOT confuse this with `users.username`** — the user-chosen username
   *  Mythrun adds in MYT-38 onboarding. This field is the cognito-internal
   *  identifier. Renamed from `username` (which was a footgun: handlers
   *  reading `request.user.username` could plausibly think it was the
   *  user-chosen name and authorize/log/display the wrong value). */
  readonly cognitoUsername: string

  /** OAuth scopes granted to this token, parsed into an array at the
   *  boundary. The plugin splits the JWT's space-separated `scope` claim
   *  into this array so consumers can do `scopes.includes('admin')` instead
   *  of `scope.includes('admin')` — the latter would substring-match
   *  `'administrator'` and any other token-containing-substring, a real
   *  authorization bug class. Treat as a set; order is not significant. */
  readonly scopes: readonly string[]

  // Note: `email`, `name`, and `picture` are deliberately absent. The Linear
  // ticket and parent §5.1 listed them, but Cognito access tokens don't carry
  // them — they're id_token claims, and we use access tokens (per §2). The
  // backend gets email/name/picture from the users row after MYT-38
  // onboarding (which calls /oauth2/userInfo once at user creation).
  //
  // No `tokenUse` discriminator either: routes branching on whether auth
  // came from real-Cognito vs bypass would be a footgun. Either every
  // protected route trusts the auth layer or it doesn't.
}

/** Minimal verifier interface decorated onto FastifyInstance.
 *  Pinned to a method shape (rather than the parameterized
 *  CognitoJwtVerifier<...> generic) so consumers like MYT-38's
 *  /api/users/register handler can use it without depending on the
 *  library's internal type variance. */
export interface JwtVerifier {
  verify(token: string): Promise<CognitoAccessTokenPayload>
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

  interface FastifyInstance {
    /** Decorated by jwtPlugin in real mode; absent in bypass mode. MYT-38's
     *  /api/users/register handler reads this to verify a JWT for a route
     *  that doesn't need a DB row. Public routes don't use it; protected
     *  routes don't need it either (the plugin's onRequest hook already
     *  populated request.user). */
    jwtVerifier?: JwtVerifier
  }
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
  /** Cognito issuer URL (passed through to Layer 3's all-cognito-vars check). */
  issuerUrl?: string
  /** Cognito Hosted UI domain (passed through to Layer 3's check). */
  hostedUiDomain?: string
}

export const registerAuth = async (
  app: FastifyInstance,
  opts: RegisterAuthOptions,
): Promise<void> => {
  if (opts.mode === 'bypass') {
    // Plumb ALL four Cognito values (presumed-empty) through to bypassPlugin's
    // Layer 3 check. If any are populated (real or partial-migration), the
    // plugin throws at registration.
    const bypassOpts: BypassPluginOptions = {
      cognitoUserPoolId: opts.userPoolId,
      cognitoAppClientId: opts.appClientId,
      cognitoIssuerUrl: opts.issuerUrl,
      cognitoHostedUiDomain: opts.hostedUiDomain,
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

### `requireUser` helper (lives in its own file, not types.ts)

Protected handlers need a typed way to assert `request.user` is present without dereferencing `.sub` and crashing at runtime. The helper lives in `backend/src/auth/require-user.ts` (not in `types.ts`, which is augmentation-only — runtime helpers and pure type augmentations don't share a file):

```typescript
// backend/src/auth/require-user.ts
import type { AuthUser } from './types.js'

export function requireUser(request: { user?: AuthUser }): AuthUser {
  if (!request.user) {
    throw new Error('requireUser: request.user is undefined — was this route marked public?')
  }
  return request.user
}
```

Re-exported from `backend/src/auth/index.ts` for convenience: `export { requireUser } from './require-user.js'`.

### Protected handler convention (worked example)

Every protected route handler that needs the user calls `requireUser(request)` once at the top to narrow `request.user` from optional to required. This is the project's mandatory convention; `!` non-null assertions on `request.user` are forbidden by the strict-TS rule in CLAUDE.md.

```typescript
import { requireUser } from '../auth/index.js'

// MYT-39 example: a future protected route
app.get('/api/me', async (request) => {
  const user = requireUser(request) // throws if accidentally hit a public-marked route
  return { sub: user.sub, username: user.username }
})

// MYT-38 example: /api/users/register uses jwt-no-db mode but still has a user
app.post('/api/users/register', { config: { auth: 'jwt-no-db' } }, async (request, reply) => {
  const user = requireUser(request) // claims-only user; no DB row yet
  // ... create users row from claims ...
})
```

Public routes don't call `requireUser` because there's no user to require:

```typescript
app.get('/health', { config: { auth: 'public' } }, () => ({ status: 'ok' }))
// No requireUser call. request.user is undefined here, by design.
```

**A grep-based CI check ships AS PART OF MYT-37** (not roadmapped to a future ticket — the convention is enforceable from day one to prevent the wrong pattern from accreting in MYT-38 and later tickets):

`.github/workflows/lint.yml` adds:

```yaml
- name: Forbid `request.user!` / `request.user?` outside auth/__tests__
  run: |
    set -euo pipefail
    if grep -rEn 'request\.user[!?]\.\b|request\.user as ' \
        backend/src/ --include='*.ts' \
        --exclude-dir=__tests__ --exclude-dir=auth; then
      echo "::error::Use `requireUser(request)` instead of `request.user!` or `request.user?` in handler files."
      exit 1
    fi
```

Test files and the `auth/` module itself are excluded; everywhere else, `requireUser` is the only sanctioned narrowing path.

### Module-augmentation import path

`types.ts` augments the global `FastifyRequest`, `FastifyContextConfig`, and `FastifyInstance` interfaces. Any file using `request.user` or `app.jwtVerifier` needs `types.ts` transitively in its import graph. The natural path: `app.ts` (or whichever file calls `buildApp`) imports `registerAuth` from `./auth/index.js`, which imports both plugins, both of which import `types.ts`. Routes don't need to import `types.ts` directly — the augmentation is global once any file in the project loads it.

---

## 4. Bypass-Mode Safety: Six-Layer Defense

The bypass plugin is the single most dangerous piece of code in MYT-37. If it ever runs in staging or production, every request becomes authenticated as `dev-sub-1` — a complete auth bypass. Six independent layers each catch the most likely failure mode; combined, the chance of a leak is vanishingly small.

### Layer 1 — `AUTH_MODE` is required and binary

`loadEnv` validates `process.env.AUTH_MODE` is exactly `'real'` or `'bypass'`. Anything else — unset, empty, `'true'`, `'1'`, `'Real'` (case mismatch) — throws at boot with a clear error. **No silent default to either mode.** Forces every environment to make the decision explicitly. `.env.development.example` sets `bypass`; staging Terraform sets `real`; production Terraform sets `real`. The boot fails loudly if any environment forgot.

### Layer 2 — Bypass requires `NODE_ENV ∈ {development, test}` AND `AWS_EXECUTION_ENV` to be unset

`bypass-plugin.ts`'s `register` function performs TWO independent runtime-environment checks:

**Layer 2a — `NODE_ENV` allow-list.** The value MUST be exactly `'development'` or `'test'`. Any other value — `'production'`, `'staging'`, an empty string, undefined, a typo — throws. The block-list shape (`!== 'production'`) is rejected because it fails-open on misconfig: an environment that forgets to set `NODE_ENV` defaults to undefined, which is `!== 'production'`, which historically allowed bypass. The allow-list shape requires an explicit dev-or-test marker.

**Layer 2b — `ECS_CONTAINER_METADATA_URI_V4` must be unset.** The ECS container agent injects `ECS_CONTAINER_METADATA_URI_V4` directly into each container's process environment at task launch — NOT through the task-def `environment` list. An operator cannot override it via `extra_env` because `extra_env` flows through the task-def array which is materialized before the agent's metadata-URI injection happens. This decouples bypass-mode rejection from any operator-controllable env var: even if someone sets `NODE_ENV=development` AND `AUTH_MODE=bypass` in extra_env, bypass still fails at registration because `ECS_CONTAINER_METADATA_URI_V4` is set in any ECS task. Local dev (no ECS agent → no metadata URI) is unaffected.

**(Note on `AWS_EXECUTION_ENV`):** A previous draft used `AWS_EXECUTION_ENV` as the Layer 2b signal. That var IS settable from the task-def `environment` list with no documented immutability guarantee — an operator could override it to empty string. Round 7's Storm reviewer caught this. `ECS_CONTAINER_METADATA_URI_V4` is the agent-injected, post-task-def-array signal; `AWS_EXECUTION_ENV` is still in the `extra_env` reserved-name list as belt-and-suspenders, but the load-bearing check is the metadata URI.

**Structural reinforcement:** The serving Terraform module ALSO force-injects `NODE_ENV=production` and `AUTH_MODE=real` into the API task definition's environment. Without these defaults, the runtime check would see whatever extra_env supplied (or `undefined` if nothing). With both module-level defaults plus the AWS_EXECUTION_ENV check, the bypass-defense layers are genuinely orthogonal:

- Defeating Layer 2a requires overriding NODE_ENV in extra_env (caught by the reserved-name validation in `var.extra_env`)
- Defeating Layer 2b requires NOT running on AWS — impossible from a task-def
- Defeating Layer 5 requires overriding AUTH_MODE in extra_env (also caught by the validation)

Three coordinated misconfigs are required, each catchable by a different mechanism. The Dockerfile's production runtime stage also sets `ENV NODE_ENV=production`. All checks run **at registration time AND inside the `onRequest` hook**.

### Layer 3 — Bypass requires ALL Cognito config to be ABSENT (read from parsed env, not process.env directly)

The bypass plugin receives the four Cognito config values as registration options: `cognitoUserPoolId`, `cognitoAppClientId`, `cognitoIssuerUrl`, `cognitoHostedUiDomain` (all `string | undefined`, set by `registerAuth` based on `loadEnv` output). If ANY of them is non-empty, bypass mode registration throws `Error('bypass mode is forbidden when any Cognito config is set: <list of populated keys>')`.

Catches the case where someone added `AUTH_MODE=bypass` to a real environment's task-def — that environment, by definition, has Cognito config set. **Checking all four values, not just `cognitoUserPoolId`,** defends against a partial Secrets Manager migration where one of the four moved before the others — leaving (say) `cognitoAppClientId` set while `cognitoUserPoolId` was temporarily fetched from elsewhere.

**Critical detail:** Layer 3 reads from the parsed env object (the result of `loadEnv`), NOT `process.env.COGNITO_*` directly. This makes the layer refactor-proof: if a future PR moves Cognito config to Secrets Manager (loaded into `env.COGNITO_*` by `loadEnv` from a runtime fetch), Layer 3 still fires because it reads the parsed value, not the raw env var. Same dual-check (registration AND per-request) — both checks read the same plumbed-in values.

### Layer 4 — Loud structured-log warning at registration

```typescript
app.log.warn(
  { event: 'auth.bypass_mode_active' },
  'AUTH BYPASS MODE: all requests authenticated as dev user. NEVER run in staging/production.',
)
```

Logged once at registration. Visible in any dev log tail, any CI run, any local `pnpm dev` startup. If bypass somehow gets to a production environment despite layers 2 + 3 + 5, the log line is the loud canary.

### Layer 5 — `AUTH_MODE` is a forced default at the serving-module layer

`infra/modules/serving/variables.tf` gains a new variable `auth_mode` with type `string`, default `"real"`, and a `validation` block that rejects any value other than `"real"` or `"bypass"`. The serving module injects `{ name = "AUTH_MODE", value = var.auth_mode }` into the API task definition's environment automatically — no per-environment opt-in required.

Production composition (the `myth-prod-auth-compose` follow-up) gets `AUTH_MODE=real` for free without remembering. A new environment that copies an older `module "serving"` call still gets `real` by default; the only path to bypass is an explicit `auth_mode = "bypass"` override in the composition, which a human reviewer would catch immediately.

Staging composition does NOT need to add `AUTH_MODE` to `extra_env` — the module supplies it via the dedicated variable. (Staging keeps `auth_mode = "real"` either explicitly or via the default; for clarity the design recommends explicit.) Defense at the structural layer rather than per-environment vigilance.

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
  // Bounded with an explicit 10s timeout so a slow Cognito JWKS endpoint
  // doesn't hang boot indefinitely. On failure, throw → boot fails →
  // deployment circuit-breaker rolls back to the previous revision (which
  // keeps serving with its already-warm cache, no impact). The right failure
  // mode for a service that can't authenticate users.
  //
  // Jitter (0-1s random delay before hydrate) spreads JWKS fetches across
  // simultaneous container starts during a rolling deploy, avoiding a
  // thundering-herd that could trip Cognito's JWKS rate limiting on
  // desired_count > 2 services. Capped at 1s so the wall-clock budget
  // stays bounded at 11s (1s jitter + 10s hydrate timeout) for the ECS
  // health-check grace period to accommodate.
  //
  // Promise.race leak avoidance: if hydrate() loses to the timer, hydrate
  // may still reject later (network finally errors). With Node 24's
  // default unhandled-rejections=throw, that crashes the running container.
  // We attach a no-op .catch() to the loser promise AND clearTimeout the
  // timer in finally(). Pattern: capture both promises, race them, swallow
  // the loser's rejection, clean up the timer.
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 1000))
  let hydrateTimer: NodeJS.Timeout | undefined
  const hydratePromise = verifier.hydrate()
  // Attach the no-op .catch BEFORE Promise.race so that if the timeout
  // wins and Race rejects synchronously, the still-pending hydratePromise
  // already has a rejection handler queued — no microtask-queue window where
  // a late hydrate rejection could surface as unhandled (which would crash
  // the process under Node 24's default --unhandled-rejections=throw). This
  // ordering matters: attaching .catch inside finally{} after Race resolution
  // is too late.
  hydratePromise.catch(() => {})
  const timeoutPromise = new Promise<never>((_, reject) => {
    hydrateTimer = setTimeout(
      () => reject(new Error('verifier.hydrate() timed out after 10s — Cognito JWKS unreachable')),
      10_000,
    )
  })
  try {
    await Promise.race([hydratePromise, timeoutPromise])
  } catch (err) {
    // Surface enough detail for an operator to distinguish reachability
    // (timeout) from misconfig (wrong userPoolId / wrong region) without
    // leaking secrets. The pool ID is not a secret; the JWKS URL isn't either.
    const issuer = `https://cognito-idp.${process.env.AWS_REGION ?? 'us-east-1'}.amazonaws.com/${opts.userPoolId}`
    app.log.error(
      { event: 'auth.jwks_hydrate_failed', issuer, errorClass: err instanceof Error ? err.constructor.name : 'Unknown' },
      'JWKS hydrate failed at boot',
    )
    throw err
  } finally {
    if (hydrateTimer) clearTimeout(hydrateTimer)
  }

  // Decorate the app with the verifier so MYT-38's /api/users/register handler
  // can reuse the same instance without constructing its own. Guarded with
  // hasDecorator: a double-registration of jwtPlugin already throws via the
  // sentinel above, but if some future path invokes app.decorate('jwtVerifier')
  // independently (test harness leak, dev fixture), Fastify throws
  // FST_ERR_DEC_ALREADY_PRESENT with a generic message — the guard surfaces
  // a clearer error first.
  if (app.hasDecorator('jwtVerifier')) {
    throw new Error('jwtPlugin: app.jwtVerifier is already decorated — likely double-registration')
  }
  app.decorate('jwtVerifier', verifier)

  app.addHook('onRequest', async (request, reply) => {
    // 404 fall-through: unmatched routes have routeOptions either undefined
    // (default Fastify 404) OR an object with undefined .url/.method/.config
    // (with setNotFoundHandler registered, per the Fastify Server docs).
    // The guard checks BOTH shapes — without checking .url, the
    // setNotFoundHandler case slips through and the hook returns 401 for
    // unauthenticated requests to nonexistent paths, leaking route-existence.
    if (request.routeOptions === undefined || request.routeOptions.url === undefined) return

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

    // Validate the claims we depend on. Cognito access tokens for federated
    // users always carry sub + username, but defensive coding guards against
    // future provider types or library version changes.
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      request.log.warn({ event: 'auth.jwt_missing_sub' }, 'JWT missing sub claim')
      return reply.code(401).send({ error: 'Invalid token' })
    }
    if (typeof payload.username !== 'string' || payload.username.length === 0) {
      request.log.warn({ event: 'auth.jwt_missing_username' }, 'JWT missing username claim')
      return reply.code(401).send({ error: 'Invalid token' })
    }

    const user: AuthUser = {
      sub: payload.sub,
      cognitoUsername: payload.username,
      // Split the JWT's space-separated scope claim into an array. Empty
      // string → empty array (split(' ') returns ['']). Non-string claim
      // (defensive against future library shape changes) → empty array.
      scopes:
        typeof payload.scope === 'string' && payload.scope.length > 0
          ? Object.freeze(payload.scope.split(' '))
          : Object.freeze([]),
    }
    request.user = user
  })
}
```

### Seven things worth flagging

1. **`tokenUse: 'access'` in the verifier config.** `aws-jwt-verify` rejects id_tokens when configured for access; rejects access tokens when configured for `id`. We accept access only.

2. **JWKS caching: `aws-jwt-verify`'s actual model.** The library fetches the JWKS lazily on the first `verify()` call (which is why we call `hydrate()` at registration to warm it). It caches keys per-`kid` indefinitely; refetches happen only when a JWT arrives with an unknown `kid` (i.e., key rotation). The library enforces a 10-second per-URI rate limit on JWKS fetches to prevent abuse. **Parent §5.2 step 4 specified "10-minute refresh cadence with rate-limited fallback on cache miss" — that exact cadence does not exist in the library; the kid-miss model is functionally equivalent for our use case** (Cognito rotates keys rarely, kid-miss invalidates instantly when it happens, the 10-second rate limit covers the abuse case). The deviation is acknowledged here rather than re-implemented.

   **Key-compromise incident response:** if Cognito (AWS) ever revokes a key without rotating it (signaling compromise rather than scheduled rotation), `aws-jwt-verify` keeps the compromised key in cache until the container restarts. The library does NOT expose a TTL knob on the JWKS cache. Mitigation: an ECS service rollover during incident response. Documented as a known operational limit in §11; acceptable for staging, must be cross-referenced with the security incident-response runbook before public launch. If we ever observe this gap mattering, a follow-up bead implements a `customJwksFetcher` wrapping the library's default with a max-age TTL.

3. **Constructor at registration + hydrate at registration.** Without `hydrate()`, the FIRST request after every container start would pay the JWKS fetch latency (~100ms-3s depending on Cognito's response). With `hydrate()` awaited at registration, every request benefits from a warm cache. Hydrate failure throws — the boot fails loudly, which is the right behavior for "this service can't authenticate anyone."

4. **Error-class logging without PII.** The token itself, the payload, and the user's identity NEVER appear in logs. Only the error class name (`JwtExpiredError`, `JwtInvalidSignatureError`, etc.) goes to CloudWatch. Lets operators triage patterns without leaking auth material. We catch the parent `Error` class (not specific subclasses), so future library versions introducing new error classes still get turned into 401s.

5. **404 fall-through guard is FIRST.** The dual check `if (request.routeOptions === undefined || request.routeOptions.url === undefined) return` ensures unmatched paths skip the hook regardless of whether a custom `setNotFoundHandler` is registered (per the documented Fastify behavior — see §2 "404 fall-through"). Without it, an authenticated request to a nonexistent path under `setNotFoundHandler` would return 401 instead of 404, leaking route-existence info.

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
// format (lowercase, alphanumeric + underscores). Parent §5.6 originally
// specified `username: 'dev_user'`; we use `'bypass_dev_1'` to encode the
// bypass-origin in the username for forensic traceability — if any code path
// ever accidentally writes this into `users.username`, the bypass-origin
// marker is visible in the row, complementing the colon-prefixed sub.
// Bypass user. Note `scopes: ['bypass']` — NOT the realistic-looking
// 'openid email profile' set. If any future authz check reads scopes (e.g.
// "if user.scopes.includes('admin')"), the bypass user must be visibly
// distinct so the check fails closed in dev rather than masquerading as a
// fully-authorized real user.
const BYPASS_USER: AuthUser = {
  sub: 'bypass:dev-1',
  cognitoUsername: 'bypass_dev_1',
  scopes: Object.freeze(['bypass']),
}

export interface BypassPluginOptions {
  /** Plumbed in from loadEnv (parsed env), NOT read from process.env directly.
   *  Layer 3 of the bypass-mode defense rejects if ANY of these is non-empty.
   *  Refactor-proof: future moves of Cognito config to Secrets Manager / SSM
   *  still flow through loadEnv → here. Checking all four (not just
   *  userPoolId) defends against a partial-migration window where one moved
   *  before the others. */
  cognitoUserPoolId?: string
  cognitoAppClientId?: string
  cognitoIssuerUrl?: string
  cognitoHostedUiDomain?: string
}

export const bypassPlugin: FastifyPluginAsync<BypassPluginOptions> = async (app, opts) => {
  // Sentinel: refuse double-registration (same as jwtPlugin).
  if (app.hasDecorator(REGISTERED_DECORATOR)) {
    throw new Error('bypassPlugin: auth is already registered on this Fastify instance')
  }
  app.decorate(REGISTERED_DECORATOR, 'bypass' as const)

  // Defense layer 2: NODE_ENV must be exactly 'development' or 'test'.
  // Allow-list, not block-list: a misconfigured environment that forgets to
  // set NODE_ENV defaults to undefined, which is !== 'production', which
  // would have fail-opened under a block-list. The allow-list shape requires
  // an explicit dev-or-test marker.
  const nodeEnv = process.env.NODE_ENV
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new Error(
      `auth bypass plugin: NODE_ENV must be 'development' or 'test' (got ${JSON.stringify(nodeEnv)})`,
    )
  }

  // Defense layer 2b (independent of Layer 2a): ECS_CONTAINER_METADATA_URI_V4
  // is set by the ECS container agent at task launch INDEPENDENTLY of the
  // task-def `environment` list. The agent injects it directly into the
  // container's process environment; it does NOT pass through the task-def
  // env array, so an operator cannot override it via `extra_env`. If we
  // observe this var, we're running inside ECS (Fargate or EC2-launch-type)
  // and bypass is forbidden, regardless of NODE_ENV / AUTH_MODE / cognito-config.
  //
  // (We do NOT use AWS_EXECUTION_ENV for this layer — that var IS settable
  // from the task-def `environment` list, has no documented immutability
  // guarantee, and an operator could override it to empty string from
  // `extra_env`. Round-7 Storm caught this in the v7 design. AWS_EXECUTION_ENV
  // is still in the extra_env reserved-name list as belt-and-suspenders, but
  // ECS_CONTAINER_METADATA_URI_V4 is the load-bearing signal.)
  if (process.env.ECS_CONTAINER_METADATA_URI_V4) {
    throw new Error(
      `auth bypass plugin: ECS_CONTAINER_METADATA_URI_V4 is set — bypass mode is forbidden in any ECS-managed runtime`,
    )
  }

  // Defense layer 3: ALL Cognito config must be empty in BOTH the parsed env
  // (plumbed via opts) AND the raw process.env. Belt-and-suspenders:
  //   - Plumbed check is refactor-proof against future Secrets Manager / SSM
  //     moves (loadEnv evolves; the plumbed value reflects whatever loadEnv
  //     produced).
  //   - Raw process.env check defends against the case where loadEnv ran in
  //     a degraded mode and skipped the Cognito vars (e.g., AUTH_MODE=bypass
  //     told it to skip them) but the underlying environment WAS provisioned
  //     with Cognito wiring (the operator just told loadEnv to ignore it).
  // The two together fail closed under every realistic misconfig pattern.
  const COGNITO_KEYS = [
    'COGNITO_USER_POOL_ID',
    'COGNITO_APP_CLIENT_ID',
    'COGNITO_ISSUER_URL',
    'COGNITO_HOSTED_UI_DOMAIN',
  ] as const
  const populatedFromOpts = (
    [
      ['cognitoUserPoolId', opts.cognitoUserPoolId],
      ['cognitoAppClientId', opts.cognitoAppClientId],
      ['cognitoIssuerUrl', opts.cognitoIssuerUrl],
      ['cognitoHostedUiDomain', opts.cognitoHostedUiDomain],
    ] as const
  )
    .filter(([, v]) => Boolean(v))
    .map(([k]) => k)
  const populatedFromEnv = COGNITO_KEYS.filter((k) => Boolean(process.env[k]))
  if (populatedFromOpts.length > 0 || populatedFromEnv.length > 0) {
    throw new Error(
      `auth bypass plugin: bypass mode forbidden — Cognito config present (opts: ${populatedFromOpts.join(', ') || 'none'}; env: ${populatedFromEnv.join(', ') || 'none'})`,
    )
  }

  // Defense layer 4: loud, structured warning whenever bypass is active.
  app.log.warn(
    { event: 'auth.bypass_mode_active' },
    'AUTH BYPASS MODE: all requests authenticated as dev user. NEVER run in staging/production.',
  )

  app.addHook('onRequest', async (request) => {
    // 404 fall-through (same dual-check as jwtPlugin: routeOptions can be
    // undefined wholesale OR an object with undefined .url under
    // setNotFoundHandler).
    if (request.routeOptions === undefined || request.routeOptions.url === undefined) return

    // Public routes opt out the same way they do under real auth.
    if (request.routeOptions.config?.auth === 'public') return

    // Per-request re-check of layers 2 and 3 — belt-and-suspenders. The
    // realistic failure mode this catches is narrow (something mutating
    // process.env at runtime, which no library should do); it's mostly
    // ceremony that signals the seriousness of bypass mode rather than
    // providing genuinely new defense beyond the registration check. Cost
    // is trivial (one boolean compare); we keep it.
    const requestNodeEnv = process.env.NODE_ENV
    if (requestNodeEnv !== 'development' && requestNodeEnv !== 'test') {
      throw new Error(
        `auth bypass plugin: NODE_ENV must be 'development' or 'test' at request time (got ${JSON.stringify(requestNodeEnv)})`,
      )
    }
    if (process.env.ECS_CONTAINER_METADATA_URI_V4) {
      throw new Error('auth bypass plugin: ECS_CONTAINER_METADATA_URI_V4 observed at request time')
    }
    if (
      opts.cognitoUserPoolId ||
      opts.cognitoAppClientId ||
      opts.cognitoIssuerUrl ||
      opts.cognitoHostedUiDomain ||
      process.env.COGNITO_USER_POOL_ID ||
      process.env.COGNITO_APP_CLIENT_ID ||
      process.env.COGNITO_ISSUER_URL ||
      process.env.COGNITO_HOSTED_UI_DOMAIN
    ) {
      throw new Error('auth bypass plugin: Cognito config observed at request time')
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

The existing `loadEnv` (from MYT-29) gains a **conditional requirement**: in `real` mode the Cognito vars are required at the env-loader level, with friendly error messages (not pushed downstream into `registerAuth`).

```typescript
// Pseudo-Zod / discriminated-union shape:
const AuthEnv = z.discriminatedUnion('AUTH_MODE', [
  z.object({
    AUTH_MODE: z.literal('real'),
    COGNITO_USER_POOL_ID: z.string().min(1),
    COGNITO_APP_CLIENT_ID: z.string().min(1),
    COGNITO_ISSUER_URL: z.string().url(),
    COGNITO_HOSTED_UI_DOMAIN: z.string().min(1),
  }),
  z.object({
    AUTH_MODE: z.literal('bypass'),
    // In bypass mode, COGNITO_* are TYPED as optional, NOT forbidden at the
    // Zod layer. The plumbed Layer 3 check in bypassPlugin runs against
    // these values and rejects if any are populated. We do NOT use
    // z.undefined() here because that would make Zod throw on parse — the
    // plumbed Layer 3 check would then be unreachable dead code (the
    // architectural bug v6 introduced). With optional(), values flow through
    // and the runtime check fires.
    COGNITO_USER_POOL_ID: z.string().optional(),
    COGNITO_APP_CLIENT_ID: z.string().optional(),
    COGNITO_ISSUER_URL: z.string().optional(),
    COGNITO_HOSTED_UI_DOMAIN: z.string().optional(),
  }),
])
```

The discriminated union gives mode-narrowed types: a TypeScript consumer reading `env.COGNITO_USER_POOL_ID` after narrowing on `env.AUTH_MODE === 'real'` gets a non-nullable string; in the bypass branch it's `string | undefined`. The Layer 3 plumbing in `bypassPlugin` then has real values to check (or `undefined`s, which is the safe path). Two layers of defense:

1. **loadEnv-level (preferred):** if a real environment somehow gets `AUTH_MODE=bypass` AND has populated Cognito vars, loadEnv parses the bypass branch with the populated values flowing through; the plumbed Layer 3 in bypassPlugin then rejects at registration. (No bypass user attached to any request.)
2. **process.env-level (defense-in-depth):** bypassPlugin's hook ALSO reads `process.env.COGNITO_*` directly, defending against the case where loadEnv was somehow shimmed or the parsed env was bypassed.

`loadEnv` throws with mode-specific error messages: in real mode, "missing COGNITO_USER_POOL_ID — required when AUTH_MODE=real" rather than the generic "missing COGNITO_USER_POOL_ID."

**Layer 1b cross-check** (defense at the env-loader level, independent of bypassPlugin's runtime layers): `loadEnv` enforces that `AUTH_MODE='bypass'` REQUIRES `NODE_ENV ∈ {'development', 'test'}`. The check runs at boot, before the plugin is constructed:

```typescript
const env = AuthEnv.parse(process.env)
const nodeEnv = z.enum(['development', 'test', 'production']).parse(process.env.NODE_ENV)
if (env.AUTH_MODE === 'bypass' && nodeEnv !== 'development' && nodeEnv !== 'test') {
  throw new Error(
    `loadEnv: AUTH_MODE=bypass requires NODE_ENV in {'development','test'}, got NODE_ENV=${JSON.stringify(nodeEnv)}`,
  )
}
```

This collapses the multi-layer "two coordinated misconfigs" path into a single env-loader check that fires before any plugin code runs. Any future code path that constructs `buildApp` (test harnesses, sidecars, alternative server bootstraps) inherits the same gate by virtue of calling `loadEnv` first.

### `buildApp` is now async and registers auth (CRITICAL: closes the `fallbackStart` gap)

`backend/src/server.ts` has two boot paths: the `BOOT_GATE_ENABLED=1` gated path (waitFor + listen) and `fallbackStart()` (used when the gate is off). To eliminate the risk that `fallbackStart` boots a Fastify instance with no auth wiring at all, `registerAuth` moves INTO `buildApp` so every code path that constructs a Fastify instance gets auth:

```typescript
import { randomUUID } from 'node:crypto'
import { registerAuth, type RegisterAuthOptions } from './auth/index.js'

export const buildApp = async (
  deps: AppDeps,
  authOpts: RegisterAuthOptions,
): Promise<FastifyInstance> => {
  const app = Fastify({
    // Cross-task correlation IDs: Fastify's default genReqId is an
    // in-process counter that resets on container restart, so two ECS
    // tasks would emit overlapping req-ids and CloudWatch log queries
    // collide. UUIDs are unique across tasks, restarts, and time. Trace
    // header (ALB-injected X-Amzn-Trace-Id) is preferred when present so
    // ALB → ECS → backend logs share an id.
    genReqId: (req) => {
      const trace = req.headers['x-amzn-trace-id']
      return typeof trace === 'string' ? trace : randomUUID()
    },
    logger: {
      // Redact auth material from structured log fields. Without this, a
      // future serializer change or an unrelated err.request log line
      // could spill the Authorization header into CloudWatch.
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: '[REDACTED]',
      },
    },
  })

  app.get('/health', { config: { auth: 'public' } }, () => ({ status: 'ok' }))
  registerReadyRoute(app, deps) // /health/ready opts out via config: { auth: 'public' }

  // Custom 404 handler so the auth hook's dual routeOptions guard ACTUALLY
  // runs against unmatched paths. Without setNotFoundHandler, Fastify's
  // default 404 path bypasses onRequest entirely, leaving the route-existence
  // info-leak guard as forward-looking dead code that no test could exercise.
  // With this handler, unmatched paths flow through the auth hook (which
  // sees routeOptions.url === undefined and falls through) and reach this
  // handler, which returns 404. The guard's behavior is now testable +
  // observable. The handler itself is marked auth: 'public' as belt-and-
  // suspenders — if the dual guard ever regresses, the public opt-out kicks
  // in to keep the 404 path clean.
  app.setNotFoundHandler({ config: { auth: 'public' } }, (_request, reply) => {
    reply.code(404).send({ error: 'Not Found' })
  })

  await registerAuth(app, authOpts)
  return app
}
```

`buildApp` is now async (the existing tests + callers must be updated to `await buildApp(...)`). Auth registration becomes part of every boot path — gated and fallback alike.

### `server.ts` wiring

`server.ts` has two boot paths from MYT-29:
1. **Gated path** (`BOOT_GATE_ENABLED=1`): runs `loadEnv`, opens real pg/redis clients, runs `waitFor` probes, calls `buildApp`, listens.
2. **`fallbackStart`** (`BOOT_GATE_ENABLED=0` or unset): originally skipped `loadEnv` entirely and used stub deps that throw on use; intended for a transition period before the boot gate became standard.

MYT-37 requires both paths to call `loadEnv` at minimum (auth needs `AUTH_MODE` + `COGNITO_*`), which changes the contract from MYT-29's purely-degraded-fallback.

**Migration impact — environments that currently lack `AUTH_MODE`:**

| Environment | `BOOT_GATE_ENABLED` today | Has `AUTH_MODE`? | Action required before MYT-37 ships |
|-------------|---------------------------|-------------------|-------------------------------------|
| Local dev (`backend/.env.development`) | `1` (per `.env.development.example`) | Yes (`bypass`) | None — already set |
| Staging ECS task | `1` (set by serving module via MYT-35) | No (today) | Phase A: serving module's `auth_mode` variable defaults to `"real"` and injects `AUTH_MODE`; nothing to do at composition |
| CI test run | varies | No | `backend/src/__tests__/setup-env.ts` adds `AUTH_MODE=bypass` + `NODE_ENV=test` |
| Production ECS task (when composed) | `1` | N/A — not yet composed | The serving module's default `auth_mode = "real"` provides it automatically |

The reconciliation:

- **Both paths run `loadEnv` and pass `authOpts` through `buildApp`.** This is not optional; auth is now part of every boot.
- **fallbackStart still uses stub deps** for pg/redis — that's its only remaining purpose. Auth is wired identically.
- **fallbackStart in real mode (`AUTH_MODE=real`) still hydrates JWKS** at registration. If Cognito is unreachable, the boot fails — same as the gated path.
- **fallbackStart's net behavior under real mode** is "no DB/Redis but auth works." That's a degenerate state useful only for verifying the auth path in isolation; never used in production. The boot gate is `BOOT_GATE_ENABLED=1` in staging and will be in production.

```typescript
// server.ts top:
const env = loadEnv()
const authOpts: RegisterAuthOptions = {
  mode: env.AUTH_MODE,
  userPoolId: env.COGNITO_USER_POOL_ID,
  appClientId: env.COGNITO_APP_CLIENT_ID,
  issuerUrl: env.COGNITO_ISSUER_URL,
  hostedUiDomain: env.COGNITO_HOSTED_UI_DOMAIN,
}

if (env.BOOT_GATE_ENABLED === '1') {
  // gated path: real deps + waitFor + buildApp + listen
  const app = await buildApp(realDeps, authOpts)
  await app.listen(...)
} else {
  // fallbackStart: stub deps + buildApp + listen (auth still wired)
  const app = await buildApp(stubDeps, authOpts)
  await app.listen(...)
}
```

JWKS hydrate (in real mode) happens before `app.listen`. The container reports healthy only after the verifier is warmed.

### Hydrate timeout

`verifier.hydrate()` is wrapped in an explicit timeout to bound the boot-failure mode against a slow Cognito JWKS endpoint. The full implementation is in §5; the budget breakdown:

- 0–1 s random jitter (anti-thundering-herd)
- 10 s hydrate timeout
- **Total wall-clock boot budget for the auth plugin: 11 s.**

The ECS task health-check `startPeriod` must accommodate this 11s plus the rest of `buildApp` (Fastify + boot gate + listen). The Dockerfile's `HEALTHCHECK --start-period=30s` and the Fargate task-def's `healthCheck.startPeriod=60` both leave generous room.

A sustained Cognito JWKS outage hard-fails the boot of every new task — the deployment circuit-breaker rolls back to the previous revision (which keeps serving with its already-warm cache, no impact). The right failure mode: a service that can't authenticate users should not report healthy. Operator runbook covers JWKS unreachability as a known incident; mitigation is "wait for Cognito to recover; the previous revision keeps serving."

### `.env.development.example`

Already sets `AUTH_MODE=bypass`. No change needed.

### Infra change: `AUTH_MODE` AND `NODE_ENV` become serving-module variables

Defense Layers 2 and 5 BOTH land as structural properties of the serving module, not per-environment vigilance. (v4 claimed this for NODE_ENV but only delivered for AUTH_MODE — v5 corrects.)

`infra/modules/serving/variables.tf` adds:

```hcl
variable "auth_mode" {
  description = "Mythrun auth-plugin mode. Defaults to 'real' so a new environment can't accidentally launch with bypass mode just by forgetting to set this. Override to 'bypass' is structurally possible but requires an explicit composition-level opt-in, which a code reviewer would catch immediately."
  type        = string
  default     = "real"

  validation {
    condition     = contains(["real", "bypass"], var.auth_mode)
    error_message = "auth_mode must be 'real' or 'bypass'."
  }
}

variable "node_env" {
  description = "Node.js NODE_ENV value. Defaults to 'production' so a real environment can't lose Layer 2 of the bypass-mode defense by forgetting to set it. The bypass plugin demands NODE_ENV ∈ {'development','test'} at registration; the production default ensures real environments fail-closed even on extra_env override attempts (the dedicated variable's value gets injected directly into common_env, not via extra_env, so an extra_env override with the same name would be appended later and could shadow it — see hardening note below)."
  type        = string
  default     = "production"

  validation {
    condition     = contains(["development", "test", "production"], var.node_env)
    error_message = "node_env must be 'development', 'test', or 'production'."
  }
}
```

`infra/modules/serving/main.tf` injects BOTH into the API task definition's environment via the `common_env` local. Two layers of defense against an `extra_env` override silently shadowing them:

**Layer A (input validation, rejects at `terraform plan`):** `infra/modules/serving/variables.tf` adds a `validation` block on `var.extra_env` that fails the plan if any entry's `name` is in the reserved list:

```hcl
variable "extra_env" {
  description = "Per-environment additional env vars to inject into the API task. May NOT contain AUTH_MODE, NODE_ENV, or any COGNITO_* — those are owned by the module's dedicated variables (auth_mode, node_env) or by the auth module's outputs (COGNITO_USER_POOL_ID, etc.). Override attempts fail at terraform plan."
  type        = list(object({ name = string, value = string }))
  default     = []

  validation {
    condition = alltrue([
      for e in var.extra_env : !contains([
        "AUTH_MODE", "NODE_ENV", "BOOT_GATE_ENABLED",
        "COGNITO_USER_POOL_ID", "COGNITO_APP_CLIENT_ID",
        "COGNITO_ISSUER_URL", "COGNITO_HOSTED_UI_DOMAIN",
      ], e.name)
    ])
    error_message = "extra_env must not contain reserved auth/Cognito/boot-gate names. Use the module's dedicated variables (auth_mode, node_env, boot_gate_enabled) instead."
  }
}
```

**Layer B (positional ordering as backup):** the AUTH_MODE and NODE_ENV entries appear AFTER `var.extra_env` in the `concat` call. ECS task-def `environment` semantics on duplicate names are not formally documented as "last wins" — the validation block in Layer A is the load-bearing defense — but the positional ordering is defense-in-depth in case AWS provider behavior shifts:

```hcl
common_env = concat(var.extra_env, [
  { name = "ENVIRONMENT", value = var.environment },
  # ... existing entries ...
  { name = "AUTH_MODE", value = var.auth_mode },
  { name = "NODE_ENV",  value = var.node_env },
])
```

`infra/environments/staging/main.tf` does NOT add `AUTH_MODE` or `NODE_ENV` to `extra_env`. Staging gets `auth_mode = "real"` and `node_env = "production"` via the module defaults. Production composition (the `myth-prod-auth-compose` follow-up) inherits the same defaults automatically. Switching to bypass in staging for local-debug experimentation requires an explicit `auth_mode = "bypass"` AND `node_env = "development"` line pair in the composition — two coordinated changes a reviewer catches.

---

## 8. Public-Route Allowlist

For MYT-37, the public routes are exactly the ones that exist today:

| Method | Path | Reason |
|--------|------|--------|
| GET | `/health` | ECS container liveness probe |
| GET | `/health/ready` | ALB target-group readiness probe |

Plus the not-found handler registered in `buildApp` (set `auth: 'public'` so unmatched paths skip auth and reach a clean 404 — see §2 "404 fall-through").

Parent §5.3 also lists `/health/live` as a public route. **MYT-37 does NOT add `/health/live`** because no consumer needs it: `/health` already serves as the ECS container liveness probe (per the comment in `app.ts:9`), and `/health/ready` serves as the ALB readiness probe. A separate `/health/live` would be redundant. If a future consumer (a different load balancer, a different orchestrator) needs the distinct path, it adds the route + opt-out as part of that ticket.

The Linear ticket's "Done when" list mentions `/auth/callback` as a public route. **`/auth/callback` is a frontend SPA route, NOT a backend route** — it's the page the browser lands on after Cognito redirects back from the OAuth flow. Per parent §3 ("Frontend exchanges the authorization code for tokens" + "Frontend stores tokens"), the SPA POSTs directly to Cognito's `/oauth2/token` endpoint to exchange the code; no backend `/auth/callback` route exists or will exist. The Linear ticket text is mistaken; no public-allowlist entry is needed.

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
| Valid access token | 200; `request.user = { sub, username, scope }` (no `tokenUse` per v3) |
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
| Token signed by the SAME User Pool but issued for a DIFFERENT app client | 401 (verifier rejects on `client_id` mismatch with `clientId` config). Sanity-check: `aws-jwt-verify` enforces this; if a future library version drops the check, this test surfaces immediately. |
| `verifier.hydrate()` rejects with timeout | registration throws → boot fails; log includes `event: auth.jwks_hydrate_failed` + `issuer` URL (no token, no secrets) |
| `Promise.race` loser-rejection | the unhandled-rejection handler sees zero `auth.*` events from the timer-loser path (the `.catch(() => {})` on hydratePromise prevents the spill) |
| Public route (`auth: 'public'`), no `Authorization` header | 200; opt-out hits before token parsing; `request.user` not attached |
| `jwt-no-db` route, valid token | 200; `request.user` attached (identical behavior to default route in MYT-37) |
| Unmatched path, no `Authorization` header | 404 (404 fall-through guard) |
| Unmatched path, valid `Authorization` header | 404 (still falls through; `routeOptions` undefined) |

### `backend/src/auth/__tests__/bypass-plugin.test.ts`

**Test harness note:** per-request env-mutation tests use `vi.stubEnv('NODE_ENV', 'production')` + `vi.unstubAllEnvs()` in `afterEach` to avoid cross-test contamination across Vitest's parallel workers. Plain `process.env.NODE_ENV = 'production'` mutation would leak between tests.

`backend/src/__tests__/setup-env.ts` is extended with a global `afterEach(() => vi.unstubAllEnvs())` so individual test files don't have to repeat the cleanup; missing it is a foot-gun across parallel workers.

Worked example for the per-request env-mutation case:

```typescript
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

describe('bypass plugin per-request safety re-checks', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    // Register in safe env (NODE_ENV=development, no Cognito vars).
    vi.stubEnv('NODE_ENV', 'development')
    app = await buildApp(stubDeps, { mode: 'bypass' })
  })
  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })

  it('rejects requests if NODE_ENV becomes "production" between registration and request', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const res = await app.inject({ method: 'GET', url: '/api/some-protected-route' })
    expect(res.statusCode).toBe(500) // Fastify wraps the thrown error
  })
})
```

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

This is the **first ticket that consumes MYT-36's `COGNITO_*` env vars**. Per `reference_tf_ci_taskdef_split.md`, the live ECS service is currently on the last CI-deployed revision (no `COGNITO_*`, no `AUTH_MODE`). Two phases. **Order matters: TF apply MUST land before code reaches `main`**, otherwise the auto-Deploy fires against a task-def that lacks `AUTH_MODE`, the new container's `loadEnv` throws on the missing env var, ECS health-check fails, and the deployment circuit-breaker rolls back.

### Phase A — TF apply for the new serving-module `auth_mode` variable (BEFORE any code ships)

The `auth_mode` variable is structural in the serving module (defaults to `"real"`), so the staging composition doesn't need an `extra_env` line — applying the module change is sufficient.

1. On a working branch (NOT yet merged to `main`), add the `auth_mode` variable + validation to `infra/modules/serving/variables.tf` and the `AUTH_MODE` injection into `infra/modules/serving/main.tf`'s `common_env`. No staging composition change required.
2. From the working branch, `cd infra/environments/staging && terraform plan -out=apply.tfplan` — expect 1 task-def revision change (api task-def picks up `AUTH_MODE=real` from the serving module's default in addition to MYT-36's 4 `COGNITO_*` vars + `BOOT_GATE_ENABLED`).
3. `terraform apply apply.tfplan`. The TF-registered task-def now has `AUTH_MODE=real`, but the ECS service is still on the old CI-deployed revision — old code doesn't read `AUTH_MODE`, so no failure.
4. Re-plan to verify drift-free (`terraform plan` shows `No changes`).

### Phase B — Code lands on `main` and auto-deploys, with a CI precondition gate

Push the working branch to `main` (or merge the PR). `Deploy` workflow auto-triggers. **A new precondition step in `.github/workflows/deploy.yml`** runs before `aws-actions/amazon-ecs-render-task-definition`:

```bash
- name: Verify AUTH_MODE is set in the latest task-def
  run: |
    set -euo pipefail
    LATEST=$(aws ecs describe-task-definition --task-definition mythrun-staging-api \
      --query 'taskDefinition.containerDefinitions[0].environment[?name==`AUTH_MODE`].value' \
      --output text)
    if [[ -z "$LATEST" ]]; then
      echo "::error::AUTH_MODE not set in mythrun-staging-api task-def. Phase A (terraform apply) must run before this deploy."
      exit 1
    fi
    if [[ "$LATEST" != "real" ]]; then
      echo "::error::AUTH_MODE in mythrun-staging-api task-def is '$LATEST', not 'real'. Bypass mode in staging/production is rejected by this gate."
      exit 1
    fi
    echo "AUTH_MODE=$LATEST verified."
```

If a merger forgets Phase A, the Deploy workflow fails fast at this step instead of booting a container that throws on `loadEnv`. The error message names the missing prerequisite, so the operator's recovery is obvious: run Phase A's TF apply, then re-trigger Deploy.

Once the gate passes: CI's `aws-actions/amazon-ecs-render-task-definition` step takes the latest TF-registered task-def (which now has all 5 env vars + `AUTH_MODE`), renders the real ECR image with the new JWT plugin code, registers a new revision, calls `update-service`. Service rolls onto the new revision: JWT plugin loaded, `AUTH_MODE=real` set, JWKS hydrated at boot via `verifier.hydrate()` (with 10s timeout).

### Phase C — Verify in staging

- `aws ecs describe-services --cluster mythrun --services mythrun-staging-api` shows desired = running on the new revision.
- `curl https://staging-api.mythrun.com/health` returns `{ status: 'ok' }` (public route, no auth).
- `curl https://staging-api.mythrun.com/some-nonexistent-path` returns **404** (404 fall-through guard works — the dual check `if (request.routeOptions === undefined || request.routeOptions.url === undefined) return` lets unmatched paths skip auth and reach the 404 handler).
- `curl -H "Authorization: Bearer invalidtoken123" https://staging-api.mythrun.com/some-nonexistent-path` returns 404 (authenticated request to a nonexistent path; auth hook still falls through; `routeOptions` is undefined for unmatched paths).
- **Negative case verifiable today**: public routes still respond without auth, JWKS hydrate succeeds at boot (per CloudWatch logs).
- **Positive case (protected route returns 401 without token, 200 with valid token) deferred to MYT-38** — no protected routes exist in MYT-37 to test against.
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
| Multi-dev-user testing via `X-Dev-User` header (parent §5.6 specifies this) | Defer until multiplayer code exists (MYT-39 territory) |
| End-to-end test through real Cognito JWKS | MYT-38 (first protected route) |
| Boot-gate probe for Cognito JWKS reachability beyond hydrate | `verifier.hydrate()` at registration covers cold-start; deferred for ongoing reachability |
| Custom claim validation (custom scopes, group membership) | Future, when access-control needs it |
| Rate-limited fallback JWKS refresh on cache miss (parent spec §5.2 step 4) | The parent's exact 10-minute cadence isn't what `aws-jwt-verify` does; see §5 flag #2 |
| `userPoolId` rotation without process restart | Out of scope; DR rotation requires a redeploy |
| `users.cognito_sub` CHECK constraint rejecting `'bypass:%'` | `myth-bypass-user-db-constraint` follow-up bead, deferred to whichever schema-related ticket lands the constraint |
| Window between `suspended_at = now()` being set and an active access token expiring (up to 1 hour) + the parent §6.4 Redis pub/sub `user:{userId}:suspend` channel for active WebSocket termination | `myth-suspended-token-revocation` follow-up bead — banned users can keep API access until token TTL until MYT-39 ships the DB-lookup, and active WebSockets need the Redis-pubsub kill-switch. Acceptable for pre-launch staging; must close before public launch |
| JWKS rotation on key compromise (vs scheduled rotation) | `aws-jwt-verify` caches keys per-`kid` indefinitely; an old compromised key remains verifiable from cache until the container restarts. Industry-standard limitation for JWKS-cached verifiers; mitigation is "ECS service rollover during incident response" — documented here as a known operational limit, not a Mythrun gap |
| CloudWatch metric on `auth.bypass_mode_active` for proactive alerting | `myth-cognito-monitoring` (already filed in MYT-36 as the broader Cognito monitoring bead) |

---

## 12. Follow-up Beads

To file after MYT-37 lands:

- **`myth-bypass-user-db-constraint`** (P2-before-launch, was P3) — Add `CHECK (cognito_sub NOT LIKE 'bypass:%')` to the `users` table whenever a future migration touches it. Defense-in-depth: even if bypass mode somehow ran against a real DB, the row insert fails. Promoted from P3 because the DB constraint is the only layer that survives a "bypass mode somehow ran against a real DB" event — every other layer is process-level.

- **`myth-jwks-periodic-refresh`** (P2-before-launch) — Wrap `aws-jwt-verify` with a `customJwksFetcher` that bounds the JWKS cache age to 6 hours. Closes the key-compromise window: today, an AWS-revoked compromised key remains verifiable from cache until the container restarts. The library doesn't expose a TTL knob natively; we wrap the default `SimpleJwksCache` with a max-age. Required before public launch; staging is acceptable without it because no real users yet.
- **`myth-suspended-token-revocation`** (P2 before launch, P3 today) — Close the up-to-1-hour gap between `users.suspended_at = now()` being set and an active access token expiring. MYT-39 adds the DB lookup that makes this enforceable, so this bead is partially handled there; remaining work is deciding whether to also add a Redis-pub/sub revocation path (as parent §6.4 suggests for active WebSockets). Must close before public launch.
- **`myth-auth-jwks-probe`** (P4) — Optionally extend the boot gate (`backend/src/boot/wait-for.ts`) to probe Cognito's JWKS endpoint as part of readiness. `verifier.hydrate()` at plugin registration already covers cold-start; this would add ongoing reachability monitoring. Skip until the failure is observed in the wild.
- **`myth-auth-multi-dev-user`** (P4) — Add `X-Dev-User: <N>` header support to bypass plugin when multiplayer testing needs distinct dev users. Likely concurrent with MYT-39's WebSocket work.
- **Parent spec correction** (no bead — sweeping with MYT-39's design): re-articulate `docs/specs/2026-04-13-auth-users.md` §5.1 to reflect the claims-only-vs-loadUser-plugin separation. The `AuthUser` interface in §5.1 describes the eventual handler-side shape (after both plugins have run), not what the JWT plugin alone attaches. Also: parent §6.4's "we're already doing the DB lookup" reasoning is invalidated by MYT-37's claims-only architecture; `suspended_at` enforcement runs in `loadCurrentUser` (MYT-39), not the JWT plugin.
