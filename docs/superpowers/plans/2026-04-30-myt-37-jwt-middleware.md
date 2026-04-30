# MYT-37 JWT Middleware + Bypass + Public-Route Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Fastify auth plugin family that validates Cognito access_tokens, attaches a claims-only `request.user`, and supports a hardened development bypass mode. First ticket that consumes MYT-36's `COGNITO_*` env vars and triggers an ECS deploy.

**Architecture:** Two `fastify-plugin`-wrapped plugins (`jwtPlugin`, `bypassPlugin`) registered conditionally based on `AUTH_MODE`. JWT plugin uses `aws-jwt-verify` against access tokens with JWKS hydrate-at-boot + 10s timeout + 1s jitter. Bypass plugin protected by multi-layer defense including a network probe to the ECS task-metadata endpoint that operators cannot fake. `buildApp` becomes async and registers auth on every boot path. Default-require auth with per-route opt-out via `config.auth = 'public' | 'jwt-no-db'`.

**Tech Stack:** Fastify v5, aws-jwt-verify v5, fastify-plugin v5, Vitest, AWS Cognito (provisioned by MYT-36), Terraform.

**Spec:** `docs/superpowers/specs/2026-04-30-myt-37-jwt-middleware-design.md` (v9, 1318 lines)

---

## File Structure

**Create:**
- `backend/src/auth/types.ts` — `AuthUser`, `JwtVerifier`, Fastify module augmentation
- `backend/src/auth/constants.ts` — `REGISTERED_DECORATOR` shared between plugins
- `backend/src/auth/require-user.ts` — `requireUser(request)` helper
- `backend/src/auth/jwt-plugin.ts` — JWT validation plugin (fastify-plugin wrapped)
- `backend/src/auth/bypass-plugin.ts` — bypass plugin with multi-layer defense
- `backend/src/auth/index.ts` — `registerAuth(app, opts)` dispatcher
- `backend/src/auth/__tests__/types.test.ts`
- `backend/src/auth/__tests__/require-user.test.ts`
- `backend/src/auth/__tests__/jwt-plugin.test.ts`
- `backend/src/auth/__tests__/bypass-plugin.test.ts`
- `backend/src/auth/__tests__/index.test.ts`

**Modify:**
- `backend/package.json` — add `aws-jwt-verify`, `fastify-plugin`
- `backend/src/__tests__/setup-env.ts` — add `vi.unstubAllEnvs()` afterEach hook
- `backend/src/config/env.ts` — extend `Env` interface + `loadEnv` for `AUTH_MODE` + `COGNITO_*` + cross-checks
- `backend/src/config/__tests__/env.test.ts` — new tests for the additions
- `backend/src/app.ts` — `buildApp` becomes async, registers auth, custom 404, logger redaction + serializer
- `backend/src/__tests__/app.test.ts` — update for new shape; add encapsulation-contract test
- `backend/src/server.ts` — pass authOpts through both boot paths
- `infra/modules/serving/variables.tf` — add `auth_mode`, `node_env` variables; `extra_env` reserved-name validation
- `infra/modules/serving/main.tf` — inject AUTH_MODE + NODE_ENV via `common_env`
- `.github/workflows/deploy.yml` — add AUTH_MODE precondition gate
- `.github/workflows/typecheck.yml` (or new `lint.yml`) — add `requireUser` grep CI rule

**No tests written for:**
- The aws-jwt-verify library itself (we trust it; tests use `vi.mock` to stub)
- Terraform changes (verified by `terraform plan` + the CI gate)

---

## Task 1: Dependencies + setup-env.ts harness

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/src/__tests__/setup-env.ts`

- [ ] **Step 1: Add dependencies**

```bash
cd backend && pnpm add aws-jwt-verify@^5.0.0 fastify-plugin@^5.0.0
```

Expected: `package.json` updated; `pnpm-lock.yaml` updated.

- [ ] **Step 2: Update setup-env.ts to clean up `vi.stubEnv` calls between tests**

Replace `backend/src/__tests__/setup-env.ts` with:

```typescript
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, vi } from 'vitest'

// Resolve relative to this file, not CWD — works whether vitest is invoked
// from `pnpm --filter @mythrun/backend test` (CWD = backend/) or from a
// root-level `pnpm test` (CWD = repo root).
const here = fileURLToPath(import.meta.url)
config({ path: resolve(here, '../../../.env.development') })

// Global teardown: any test that uses `vi.stubEnv(...)` to mutate process.env
// gets cleanup automatically so env-mutations don't leak to sibling tests
// across Vitest's parallel workers. The bypass-plugin tests rely on this.
afterEach(() => {
  vi.unstubAllEnvs()
})
```

- [ ] **Step 3: Verify**

```bash
cd backend && pnpm typecheck && pnpm test -- --reporter=basic 2>&1 | tail -5
```

Expected: typecheck clean; existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add backend/package.json backend/pnpm-lock.yaml backend/src/__tests__/setup-env.ts
git commit -m "infra(myt-37): aws-jwt-verify + fastify-plugin deps + vi.unstubAllEnvs hook"
```

---

## Task 2: Auth types + constants + requireUser helper

**Files:**
- Create: `backend/src/auth/types.ts`
- Create: `backend/src/auth/constants.ts`
- Create: `backend/src/auth/require-user.ts`
- Create: `backend/src/auth/__tests__/require-user.test.ts`

- [ ] **Step 1: Create constants.ts**

```typescript
// backend/src/auth/constants.ts
//
// Shared sentinel between jwt-plugin and bypass-plugin. Used by both plugins
// to reject double-registration on the same Fastify instance.
export const REGISTERED_DECORATOR = 'mythAuthRegistered'
```

- [ ] **Step 2: Create types.ts**

```typescript
// backend/src/auth/types.ts
//
// AuthUser shape + Fastify module augmentation.
//
// Spec: docs/superpowers/specs/2026-04-30-myt-37-jwt-middleware-design.md §3.

import type { CognitoAccessTokenPayload } from 'aws-jwt-verify/jwt-model'

export interface AuthUser {
  /** Cognito sub claim — stable per-user identifier across token refreshes.
   *  This is the canonical identifier for cross-system reference (matching
   *  to `users.cognito_sub` after MYT-38 onboarding creates the row).
   *  Treat as immutable; do NOT use Cognito's `username` claim for identity. */
  readonly sub: string

  /** Cognito's internal username for the federated user.
   *  For Google sign-in: 'Google_<google-sub>'
   *  For Discord sign-in: 'Discord_<discord-snowflake>'
   *  For bypass mode: 'bypass_dev_1'
   *
   *  DO NOT confuse this with `users.username` — the user-chosen name
   *  Mythrun adds in MYT-38 onboarding. This field is the cognito-internal
   *  identifier; treat as opaque (no prefix-based reasoning). */
  readonly cognitoUsername: string

  /** OAuth scopes granted to this token, parsed at the boundary into an
   *  array. Consumers should use `scopes.includes('admin')` not
   *  `scope.includes('admin')` — the latter would substring-match
   *  'administrator' (a real authorization bug class). Treat as a set. */
  readonly scopes: readonly string[]
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
     *  than dereferencing `request.user.sub` directly, which would throw
     *  at runtime if a route accidentally lands here without auth. */
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
     *  that doesn't need a DB row. */
    jwtVerifier?: JwtVerifier
  }
}

// Side-effect import marker so build tools don't tree-shake the
// `declare module` block.
export const __AUTH_TYPES_LOADED = true as const
```

- [ ] **Step 3: Create require-user.ts**

```typescript
// backend/src/auth/require-user.ts
//
// Helper for protected handlers — narrows request.user from optional to
// required. Throws if called from a public-route handler (which would
// indicate the route was misconfigured `config.auth = 'public'` and then
// tried to use the user). Lives in its own file (not types.ts) so type
// augmentation and runtime helpers don't share a module.

import type { AuthUser } from './types.js'

export function requireUser(request: { user?: AuthUser }): AuthUser {
  if (!request.user) {
    throw new Error(
      'requireUser: request.user is undefined — was this route marked public?',
    )
  }
  return request.user
}
```

- [ ] **Step 4: Write a failing test for requireUser**

Create `backend/src/auth/__tests__/require-user.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { requireUser } from '../require-user.js'
import type { AuthUser } from '../types.js'

describe('requireUser', () => {
  it('returns the user when present', () => {
    const user: AuthUser = {
      sub: 'a1b2c3',
      cognitoUsername: 'Google_a1b2c3',
      scopes: Object.freeze(['openid', 'email']),
    }
    expect(requireUser({ user })).toBe(user)
  })

  it('throws when user is undefined', () => {
    expect(() => requireUser({})).toThrow(/was this route marked public/)
  })

  it('throws when user is null (defensive)', () => {
    expect(() => requireUser({ user: undefined })).toThrow(/was this route marked public/)
  })
})
```

- [ ] **Step 5: Run tests**

```bash
cd backend && pnpm vitest run src/auth/__tests__/require-user.test.ts
```

Expected: all 3 tests pass.

- [ ] **Step 6: Typecheck**

```bash
cd backend && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/auth/
git commit -m "feat(myt-37): auth types + constants + requireUser helper"
```

---

## Task 3: JWT plugin with hydrate + verify hook

**Files:**
- Create: `backend/src/auth/jwt-plugin.ts`
- Create: `backend/src/auth/__tests__/jwt-plugin.test.ts`

- [ ] **Step 1: Create jwt-plugin.ts**

```typescript
// backend/src/auth/jwt-plugin.ts
//
// Real Cognito JWT validation plugin. Hydrates JWKS at registration
// (with 0-1s jitter to spread thundering-herd, 10s timeout to bound
// the boot-failure case). Per-request: validates the access token,
// attaches claims-only request.user.
//
// Spec: docs/superpowers/specs/2026-04-30-myt-37-jwt-middleware-design.md §5.

import { CognitoJwtVerifier } from 'aws-jwt-verify'
import type { FastifyPluginAsync } from 'fastify'
import fastifyPlugin from 'fastify-plugin'
import { REGISTERED_DECORATOR } from './constants.js'
import type { AuthUser, JwtVerifier } from './types.js'

export interface JwtPluginOptions {
  userPoolId: string
  appClientId: string
}

const jwtPluginImpl: FastifyPluginAsync<JwtPluginOptions> = async (app, opts) => {
  if (app.hasDecorator(REGISTERED_DECORATOR)) {
    throw new Error('jwtPlugin: auth is already registered on this Fastify instance')
  }
  app.decorate(REGISTERED_DECORATOR, 'jwt' as const)

  const verifier = CognitoJwtVerifier.create({
    userPoolId: opts.userPoolId,
    clientId: opts.appClientId,
    tokenUse: 'access',
  })

  // Pre-fetch JWKS at registration so the FIRST protected request after
  // every cold start doesn't pay the JWKS fetch latency.
  // Jitter (0-1s) spreads simultaneous container-start fetches.
  // Promise.race timeout (10s) bounds the boot-failure case.
  // The .catch(() => {}) BEFORE Promise.race prevents unhandled-rejection
  // crashes if the timer wins and the underlying hydrate rejects late.
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 1000))
  let hydrateTimer: NodeJS.Timeout | undefined
  const hydratePromise = verifier.hydrate()
  hydratePromise.catch(() => {
    // Swallow late rejection from the loser path; the boot has already
    // failed via Promise.race or the catch below logged + threw.
  })
  const timeoutPromise = new Promise<never>((_, reject) => {
    hydrateTimer = setTimeout(
      () => reject(new Error('verifier.hydrate() timed out after 10s — Cognito JWKS unreachable')),
      10_000,
    )
  })
  try {
    await Promise.race([hydratePromise, timeoutPromise])
  } catch (err) {
    const issuer = `https://cognito-idp.${process.env.AWS_REGION ?? 'us-east-1'}.amazonaws.com/${opts.userPoolId}`
    app.log.error(
      {
        event: 'auth.jwks_hydrate_failed',
        issuer,
        errorClass: err instanceof Error ? err.constructor.name : 'Unknown',
      },
      'JWKS hydrate failed at boot',
    )
    throw err
  } finally {
    if (hydrateTimer) clearTimeout(hydrateTimer)
  }

  if (app.hasDecorator('jwtVerifier')) {
    throw new Error('jwtPlugin: app.jwtVerifier is already decorated — likely double-registration')
  }
  const jwtVerifier: JwtVerifier = {
    verify: (token) => verifier.verify(token),
  }
  app.decorate('jwtVerifier', jwtVerifier)

  app.addHook('onRequest', async (request, reply) => {
    // 404 fall-through: routeOptions can be undefined wholesale OR an
    // object with undefined .url under setNotFoundHandler.
    if (request.routeOptions === undefined || request.routeOptions.url === undefined) return

    const authMode = request.routeOptions.config?.auth
    if (authMode === 'public') return

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
      request.log.warn(
        {
          event: 'auth.jwt_verify_failed',
          errorClass: err instanceof Error ? err.constructor.name : 'Unknown',
        },
        'JWT verification failed',
      )
      return reply.code(401).send({ error: 'Invalid token' })
    }

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
      scopes:
        typeof payload.scope === 'string' && payload.scope.length > 0
          ? Object.freeze(payload.scope.split(' '))
          : Object.freeze([]),
    }
    request.user = user
  })
}

// fastify-plugin wrapper: tells Fastify to skip the encapsulation wrapping
// so the hook + decorator apply at the parent app's scope (where /health,
// /health/ready, and all future protected routes live). Without this
// wrapper, the hook would only apply to the plugin's child scope and every
// route registered on the parent app would silently bypass auth.
export const jwtPlugin = fastifyPlugin(jwtPluginImpl, {
  fastify: '5.x',
  name: 'mythrun-auth-jwt',
})
```

- [ ] **Step 2: Write the test file with all spec'd cases**

Create `backend/src/auth/__tests__/jwt-plugin.test.ts`:

```typescript
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock aws-jwt-verify with a controllable stub. The stub's verify/hydrate
// are configured per-test via getters on the mock module.
const mockVerify = vi.fn()
const mockHydrate = vi.fn()
vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: () => ({
      verify: mockVerify,
      hydrate: mockHydrate,
    }),
  },
}))

import { jwtPlugin } from '../jwt-plugin.js'

const VALID_PAYLOAD = {
  sub: 'a1b2c3-d4e5-6789',
  username: 'Google_117992928105490108417',
  scope: 'openid email profile',
  token_use: 'access',
}

const OPTS = {
  userPoolId: 'us-east-1_TestPool',
  appClientId: 'testclient123',
}

describe('jwtPlugin', () => {
  let app: FastifyInstance

  beforeEach(() => {
    mockVerify.mockReset()
    mockHydrate.mockReset()
    mockHydrate.mockResolvedValue(undefined)
  })
  afterEach(async () => {
    if (app) await app.close()
  })

  it('hydrates JWKS at registration', async () => {
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    expect(mockHydrate).toHaveBeenCalledOnce()
  })

  it('throws on hydrate failure → boot fails loudly', async () => {
    mockHydrate.mockRejectedValue(new Error('JWKS unreachable'))
    app = Fastify({ logger: false })
    await expect(app.register(jwtPlugin, OPTS)).rejects.toThrow(/JWKS unreachable/)
  })

  it('throws on hydrate timeout', async () => {
    vi.useFakeTimers()
    mockHydrate.mockImplementation(() => new Promise(() => {})) // never resolves
    app = Fastify({ logger: false })
    const registerPromise = app.register(jwtPlugin, OPTS)
    await vi.advanceTimersByTimeAsync(11_000)
    await expect(registerPromise).rejects.toThrow(/timed out after 10s/)
    vi.useRealTimers()
  })

  it('rejects double registration', async () => {
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    await expect(app.register(jwtPlugin, OPTS)).rejects.toThrow(/already registered/)
  })

  it('attaches request.user on valid token', async () => {
    mockVerify.mockResolvedValue(VALID_PAYLOAD)
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    let attachedUser: unknown
    app.get('/protected', (request) => {
      attachedUser = request.user
      return { ok: true }
    })

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer valid-token' },
    })
    expect(res.statusCode).toBe(200)
    expect(attachedUser).toEqual({
      sub: VALID_PAYLOAD.sub,
      cognitoUsername: VALID_PAYLOAD.username,
      scopes: ['openid', 'email', 'profile'],
    })
  })

  it('encapsulation contract: hook applies to PARENT-scope routes (fastify-plugin wrapper test)', async () => {
    mockVerify.mockResolvedValue(VALID_PAYLOAD)
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    // Register a NEW route on the parent app AFTER plugin registration —
    // without the fastify-plugin wrapper, this route would NOT be gated.
    app.get('/parent-route', () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/parent-route' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'Missing Bearer token' })
  })

  it('returns 401 with "Missing Bearer token" on no Authorization header', async () => {
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    app.get('/protected', () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/protected' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'Missing Bearer token' })
  })

  it('returns 401 on Bearer with empty token', async () => {
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    app.get('/protected', () => ({ ok: true }))
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer    ' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'Empty Bearer token' })
  })

  it('returns 401 on lowercase scheme', async () => {
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    app.get('/protected', () => ({ ok: true }))
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'bearer xyz' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 on JwtExpiredError', async () => {
    class JwtExpiredError extends Error {}
    mockVerify.mockRejectedValue(new JwtExpiredError('expired'))
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    app.get('/protected', () => ({ ok: true }))
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer expired-token' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'Invalid token' })
  })

  it('returns 401 on missing sub claim', async () => {
    mockVerify.mockResolvedValue({ ...VALID_PAYLOAD, sub: '' })
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    app.get('/protected', () => ({ ok: true }))
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer t' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 on missing username claim', async () => {
    mockVerify.mockResolvedValue({ ...VALID_PAYLOAD, username: '' })
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    app.get('/protected', () => ({ ok: true }))
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer t' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('public route bypasses validation entirely', async () => {
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    app.get('/health', { config: { auth: 'public' } }, () => ({ status: 'ok' }))
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(mockVerify).not.toHaveBeenCalled()
  })

  it('jwt-no-db route requires valid token (identical to default in MYT-37)', async () => {
    mockVerify.mockResolvedValue(VALID_PAYLOAD)
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    app.post('/api/users/register', { config: { auth: 'jwt-no-db' } }, () => ({ ok: true }))
    const res = await app.inject({
      method: 'POST',
      url: '/api/users/register',
      headers: { authorization: 'Bearer valid' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('decorates app.jwtVerifier with verify method', async () => {
    mockVerify.mockResolvedValue(VALID_PAYLOAD)
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    expect(typeof app.jwtVerifier?.verify).toBe('function')
    const result = await app.jwtVerifier!.verify('token')
    expect(result).toEqual(VALID_PAYLOAD)
  })
})
```

- [ ] **Step 3: Run tests**

```bash
cd backend && pnpm vitest run src/auth/__tests__/jwt-plugin.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Typecheck**

```bash
cd backend && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/auth/jwt-plugin.ts backend/src/auth/__tests__/jwt-plugin.test.ts
git commit -m "feat(myt-37): JWT plugin with hydrate + claims-only attach"
```

---

## Task 4: Bypass plugin with multi-layer defense

**Files:**
- Create: `backend/src/auth/bypass-plugin.ts`
- Create: `backend/src/auth/__tests__/bypass-plugin.test.ts`

- [ ] **Step 1: Create bypass-plugin.ts**

```typescript
// backend/src/auth/bypass-plugin.ts
//
// Development-only auth bypass plugin. Multi-layer defense prevents
// activation in any AWS-managed runtime even with coordinated misconfig:
//   Layer 2a: NODE_ENV must be 'development' or 'test' (allow-list, not block-list)
//   Layer 2b: HTTP probe to ECS task-metadata endpoint must FAIL (proves not on ECS)
//   Layer 3:  No Cognito config in plumbed opts OR raw process.env
//   Layer 4:  Loud structured-log warning at registration
//   Layer 5:  Terraform serving-module forces AUTH_MODE=real and NODE_ENV=production
//   Layer 6:  Tests verify every gate
//
// Spec: docs/superpowers/specs/2026-04-30-myt-37-jwt-middleware-design.md §4 + §6.

import type { FastifyPluginAsync } from 'fastify'
import fastifyPlugin from 'fastify-plugin'
import { REGISTERED_DECORATOR } from './constants.js'
import type { AuthUser } from './types.js'

const BYPASS_USER: AuthUser = {
  sub: 'bypass:dev-1',
  cognitoUsername: 'bypass_dev_1',
  scopes: Object.freeze(['bypass']),
}

export interface BypassPluginOptions {
  /** Plumbed in from loadEnv. Layer 3 rejects if any are populated. */
  cognitoUserPoolId?: string
  cognitoAppClientId?: string
  cognitoIssuerUrl?: string
  cognitoHostedUiDomain?: string
}

const bypassPluginImpl: FastifyPluginAsync<BypassPluginOptions> = async (app, opts) => {
  if (app.hasDecorator(REGISTERED_DECORATOR)) {
    throw new Error('bypassPlugin: auth is already registered on this Fastify instance')
  }
  app.decorate(REGISTERED_DECORATOR, 'bypass' as const)

  // Layer 2a: NODE_ENV allow-list.
  const nodeEnv = process.env.NODE_ENV
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new Error(
      `auth bypass plugin: NODE_ENV must be 'development' or 'test' (got ${JSON.stringify(nodeEnv)})`,
    )
  }

  // Layer 2b: HTTP probe to ECS task-metadata endpoint. The link-local IP
  // 169.254.170.2 is served by the ECS agent; not addressable from local
  // dev. Probe success → we're on ECS → throw. Probe failure → we're not
  // on ECS → proceed.
  const controller = new AbortController()
  const probeTimer = setTimeout(() => controller.abort(), 1000)
  try {
    const response = await fetch('http://169.254.170.2/v2/metadata', {
      signal: controller.signal,
    })
    if (response.ok) {
      throw new Error(
        'auth bypass plugin: ECS task-metadata endpoint reachable — bypass forbidden in any ECS runtime',
      )
    }
    throw new Error(
      `auth bypass plugin: ECS task-metadata endpoint responded (status ${response.status}) — bypass forbidden`,
    )
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('auth bypass plugin:')) {
      throw err
    }
    // Probe failed (refused / timeout / DNS) — not on ECS, proceed.
  } finally {
    clearTimeout(probeTimer)
  }

  // Layer 3: No Cognito config in plumbed opts.
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
  const COGNITO_KEYS = [
    'COGNITO_USER_POOL_ID',
    'COGNITO_APP_CLIENT_ID',
    'COGNITO_ISSUER_URL',
    'COGNITO_HOSTED_UI_DOMAIN',
  ] as const
  const populatedFromEnv = COGNITO_KEYS.filter((k) => Boolean(process.env[k]))
  if (populatedFromOpts.length > 0 || populatedFromEnv.length > 0) {
    throw new Error(
      `auth bypass plugin: bypass forbidden — Cognito config present (opts: ${populatedFromOpts.join(', ') || 'none'}; env: ${populatedFromEnv.join(', ') || 'none'})`,
    )
  }

  // Layer 4: loud, structured warning at registration.
  app.log.warn(
    { event: 'auth.bypass_mode_active' },
    'AUTH BYPASS MODE: all requests authenticated as dev user. NEVER run in staging/production.',
  )

  app.addHook('onRequest', async (request) => {
    // 404 fall-through (dual check, same as jwtPlugin).
    if (request.routeOptions === undefined || request.routeOptions.url === undefined) return
    if (request.routeOptions.config?.auth === 'public') return

    // Per-request re-check of Layers 2a + 3. Belt-and-suspenders against
    // some future code path mutating process.env at runtime. Layer 2b
    // (HTTP probe) is NOT re-checked per request — too expensive.
    const requestNodeEnv = process.env.NODE_ENV
    if (requestNodeEnv !== 'development' && requestNodeEnv !== 'test') {
      throw new Error(
        `auth bypass plugin: NODE_ENV must be 'development' or 'test' at request time (got ${JSON.stringify(requestNodeEnv)})`,
      )
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

export const bypassPlugin = fastifyPlugin(bypassPluginImpl, {
  fastify: '5.x',
  name: 'mythrun-auth-bypass',
})
```

- [ ] **Step 2: Write tests for every defense layer**

Create `backend/src/auth/__tests__/bypass-plugin.test.ts`:

```typescript
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock global fetch so the Layer 2b HTTP probe is controllable per-test.
const originalFetch = globalThis.fetch
let mockFetchImpl: typeof globalThis.fetch | undefined
beforeEach(() => {
  globalThis.fetch = ((...args) => mockFetchImpl!(...args)) as typeof globalThis.fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
  mockFetchImpl = undefined
})

import { bypassPlugin } from '../bypass-plugin.js'

const SAFE_DEV_ENV = () => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('COGNITO_USER_POOL_ID', '')
  vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
  vi.stubEnv('COGNITO_ISSUER_URL', '')
  vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
  // Default Layer 2b probe: simulate "not on ECS" — connection refused.
  mockFetchImpl = () => Promise.reject(new Error('ECONNREFUSED'))
}

describe('bypassPlugin', () => {
  let app: FastifyInstance
  afterEach(async () => {
    if (app) await app.close()
  })

  it('attaches BYPASS_USER on protected route', async () => {
    SAFE_DEV_ENV()
    app = Fastify({ logger: false })
    await app.register(bypassPlugin, {})
    let attached: unknown
    app.get('/protected', (request) => {
      attached = request.user
      return { ok: true }
    })
    const res = await app.inject({ method: 'GET', url: '/protected' })
    expect(res.statusCode).toBe(200)
    expect(attached).toEqual({
      sub: 'bypass:dev-1',
      cognitoUsername: 'bypass_dev_1',
      scopes: ['bypass'],
    })
  })

  it('Layer 2a: throws when NODE_ENV=production at registration', async () => {
    SAFE_DEV_ENV()
    vi.stubEnv('NODE_ENV', 'production')
    app = Fastify({ logger: false })
    await expect(app.register(bypassPlugin, {})).rejects.toThrow(
      /NODE_ENV must be 'development' or 'test'/,
    )
  })

  it('Layer 2a: throws when NODE_ENV is unset', async () => {
    SAFE_DEV_ENV()
    vi.stubEnv('NODE_ENV', '')
    app = Fastify({ logger: false })
    await expect(app.register(bypassPlugin, {})).rejects.toThrow(/NODE_ENV must be/)
  })

  it("Layer 2b: throws when ECS metadata probe returns 200", async () => {
    SAFE_DEV_ENV()
    mockFetchImpl = () =>
      Promise.resolve(new Response('{"task":"x"}', { status: 200 }))
    app = Fastify({ logger: false })
    await expect(app.register(bypassPlugin, {})).rejects.toThrow(
      /ECS task-metadata endpoint reachable/,
    )
  })

  it('Layer 2b: throws when ECS metadata probe returns non-200', async () => {
    SAFE_DEV_ENV()
    mockFetchImpl = () =>
      Promise.resolve(new Response('forbidden', { status: 403 }))
    app = Fastify({ logger: false })
    await expect(app.register(bypassPlugin, {})).rejects.toThrow(
      /ECS task-metadata endpoint responded \(status 403\)/,
    )
  })

  it('Layer 2b: proceeds when probe times out', async () => {
    SAFE_DEV_ENV()
    mockFetchImpl = () =>
      new Promise((_resolve, reject) => {
        const t = setTimeout(() => reject(new Error('aborted')), 200)
        // Cleanup happens implicitly when the global fetch is restored
        ;(t as { unref?: () => void }).unref?.()
      })
    app = Fastify({ logger: false })
    await app.register(bypassPlugin, {})
    expect(app.hasDecorator('mythAuthRegistered')).toBe(true)
  })

  it('Layer 3: throws when cognitoUserPoolId opt is set', async () => {
    SAFE_DEV_ENV()
    app = Fastify({ logger: false })
    await expect(
      app.register(bypassPlugin, { cognitoUserPoolId: 'us-east-1_xxx' }),
    ).rejects.toThrow(/Cognito config present/)
  })

  it('Layer 3: throws when COGNITO_USER_POOL_ID env is set', async () => {
    SAFE_DEV_ENV()
    vi.stubEnv('COGNITO_USER_POOL_ID', 'us-east-1_yyy')
    app = Fastify({ logger: false })
    await expect(app.register(bypassPlugin, {})).rejects.toThrow(/Cognito config present/)
  })

  it('Layer 4: logs auth.bypass_mode_active at registration', async () => {
    SAFE_DEV_ENV()
    const logs: unknown[] = []
    app = Fastify({
      logger: { level: 'warn', stream: { write: (s) => { logs.push(JSON.parse(s)); return true } } as never },
    })
    await app.register(bypassPlugin, {})
    expect(
      logs.some(
        (l) => typeof l === 'object' && l !== null && (l as Record<string, unknown>).event === 'auth.bypass_mode_active',
      ),
    ).toBe(true)
  })

  it('rejects double registration', async () => {
    SAFE_DEV_ENV()
    app = Fastify({ logger: false })
    await app.register(bypassPlugin, {})
    await expect(app.register(bypassPlugin, {})).rejects.toThrow(/already registered/)
  })

  it('encapsulation contract: hook applies to PARENT-scope routes', async () => {
    SAFE_DEV_ENV()
    app = Fastify({ logger: false })
    await app.register(bypassPlugin, {})
    let attached: unknown
    app.get('/parent-route', (request) => {
      attached = request.user
      return { ok: true }
    })
    const res = await app.inject({ method: 'GET', url: '/parent-route' })
    expect(res.statusCode).toBe(200)
    expect(attached).toMatchObject({ sub: 'bypass:dev-1' })
  })

  it('public route: no user attached', async () => {
    SAFE_DEV_ENV()
    app = Fastify({ logger: false })
    await app.register(bypassPlugin, {})
    let attached: unknown = 'sentinel'
    app.get('/health', { config: { auth: 'public' } }, (request) => {
      attached = request.user
      return { status: 'ok' }
    })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(attached).toBe(undefined)
  })

  it('per-request: throws if NODE_ENV mutated to production after registration', async () => {
    SAFE_DEV_ENV()
    app = Fastify({ logger: false })
    await app.register(bypassPlugin, {})
    app.get('/protected', () => ({ ok: true }))
    vi.stubEnv('NODE_ENV', 'production')
    const res = await app.inject({ method: 'GET', url: '/protected' })
    expect(res.statusCode).toBe(500)
  })
})
```

- [ ] **Step 3: Run tests**

```bash
cd backend && pnpm vitest run src/auth/__tests__/bypass-plugin.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Typecheck + lint**

```bash
cd backend && pnpm typecheck && pnpm lint
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/auth/bypass-plugin.ts backend/src/auth/__tests__/bypass-plugin.test.ts
git commit -m "feat(myt-37): bypass plugin with multi-layer defense + ECS probe"
```

---

## Task 5: registerAuth dispatcher

**Files:**
- Create: `backend/src/auth/index.ts`
- Create: `backend/src/auth/__tests__/index.test.ts`

- [ ] **Step 1: Create index.ts**

```typescript
// backend/src/auth/index.ts
//
// Auth plugin dispatcher. Registers exactly one of jwtPlugin / bypassPlugin
// based on opts.mode. Re-exports requireUser and types for convenience.
//
// Spec: docs/superpowers/specs/2026-04-30-myt-37-jwt-middleware-design.md §3.

import type { FastifyInstance } from 'fastify'
import { bypassPlugin, type BypassPluginOptions } from './bypass-plugin.js'
import { jwtPlugin, type JwtPluginOptions } from './jwt-plugin.js'

export type AuthMode = 'real' | 'bypass'

export interface RegisterAuthOptions {
  mode: AuthMode
  /** Required when mode === 'real'; ignored in bypass mode. */
  userPoolId?: string
  /** Required when mode === 'real'. */
  appClientId?: string
  /** Passed to bypass plugin's Layer 3 check. */
  issuerUrl?: string
  hostedUiDomain?: string
}

export const registerAuth = async (
  app: FastifyInstance,
  opts: RegisterAuthOptions,
): Promise<void> => {
  if (opts.mode === 'bypass') {
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

export { requireUser } from './require-user.js'
export type { AuthUser, JwtVerifier } from './types.js'
```

- [ ] **Step 2: Tests**

Create `backend/src/auth/__tests__/index.test.ts`:

```typescript
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: () => ({
      verify: vi.fn().mockResolvedValue({ sub: 's', username: 'u', scope: '' }),
      hydrate: vi.fn().mockResolvedValue(undefined),
    }),
  },
}))

import { registerAuth } from '../index.js'

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('COGNITO_USER_POOL_ID', '')
  vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
  vi.stubEnv('COGNITO_ISSUER_URL', '')
  vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
  globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof globalThis.fetch
})

describe('registerAuth', () => {
  let app: FastifyInstance
  afterEach(async () => {
    if (app) await app.close()
  })

  it('registers bypass plugin in bypass mode', async () => {
    app = Fastify({ logger: false })
    await registerAuth(app, { mode: 'bypass' })
    expect(app.hasDecorator('mythAuthRegistered')).toBe(true)
  })

  it('registers jwt plugin in real mode', async () => {
    app = Fastify({ logger: false })
    await registerAuth(app, {
      mode: 'real',
      userPoolId: 'us-east-1_x',
      appClientId: 'c',
    })
    expect(app.hasDecorator('jwtVerifier')).toBe(true)
  })

  it('throws if real mode without userPoolId', async () => {
    app = Fastify({ logger: false })
    await expect(
      registerAuth(app, { mode: 'real', appClientId: 'c' }),
    ).rejects.toThrow(/real mode requires userPoolId and appClientId/)
  })

  it('throws if real mode without appClientId', async () => {
    app = Fastify({ logger: false })
    await expect(
      registerAuth(app, { mode: 'real', userPoolId: 'us-east-1_x' }),
    ).rejects.toThrow(/real mode requires userPoolId and appClientId/)
  })

  it('passes Cognito values through to bypass plugin Layer 3', async () => {
    app = Fastify({ logger: false })
    await expect(
      registerAuth(app, {
        mode: 'bypass',
        userPoolId: 'us-east-1_xxx', // simulating misconfig
      }),
    ).rejects.toThrow(/Cognito config present/)
  })
})
```

- [ ] **Step 3: Run + verify**

```bash
cd backend && pnpm vitest run src/auth/__tests__/index.test.ts && pnpm typecheck
```

Expected: all tests pass; typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add backend/src/auth/index.ts backend/src/auth/__tests__/index.test.ts
git commit -m "feat(myt-37): registerAuth dispatcher"
```

---

## Task 6: loadEnv extensions

**Files:**
- Modify: `backend/src/config/env.ts`
- Create: `backend/src/config/__tests__/env.test.ts`

- [ ] **Step 1: Extend Env interface and loadEnv**

Replace `backend/src/config/env.ts` with:

```typescript
export type AuthMode = 'real' | 'bypass'

export interface Env {
  readonly databaseUrl: string
  readonly redisRealtimeUrl: string
  readonly redisBatchUrl: string
  readonly port: number
  readonly authMode: AuthMode
  /** Defined when authMode === 'real'; undefined in bypass. */
  readonly cognitoUserPoolId?: string
  readonly cognitoAppClientId?: string
  readonly cognitoIssuerUrl?: string
  readonly cognitoHostedUiDomain?: string
}

function buildDatabaseUrl(): string {
  const migrateRaw = process.env.MIGRATE_DATABASE_URL?.trim()
  if (migrateRaw && migrateRaw.length > 0) return migrateRaw

  const explicit = process.env.DATABASE_URL
  if (explicit) return explicit
  const host = process.env.DB_HOST
  const port = process.env.DB_PORT
  const user = process.env.DB_USER
  const name = process.env.DB_NAME
  const password = process.env.DB_PASSWORD
  if (!host || !port || !user || !name || !password) {
    throw new Error(
      'Missing database config: provide DATABASE_URL (or MIGRATE_DATABASE_URL), or all of DB_HOST/DB_PORT/DB_USER/DB_NAME/DB_PASSWORD',
    )
  }
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}?sslmode=require`
}

function buildRedisUrl(role: 'realtime' | 'batch'): string {
  const envKey = role === 'realtime' ? 'REDIS_REALTIME_URL' : 'REDIS_BATCH_URL'
  const explicit = process.env[envKey]
  if (explicit) return explicit
  const host = process.env.REDIS_HOST
  const port = process.env.REDIS_PORT
  const authToken = process.env.REDIS_AUTH_TOKEN
  if (!host || !port) {
    throw new Error(`Missing redis config: provide ${envKey}, or REDIS_HOST + REDIS_PORT`)
  }
  const scheme = authToken ? 'rediss' : 'redis'
  const authPart = authToken ? `:${encodeURIComponent(authToken)}@` : ''
  return `${scheme}://${authPart}${host}:${port}`
}

function loadAuthConfig(): Pick<
  Env,
  'authMode' | 'cognitoUserPoolId' | 'cognitoAppClientId' | 'cognitoIssuerUrl' | 'cognitoHostedUiDomain'
> {
  const authModeRaw = process.env.AUTH_MODE
  if (authModeRaw !== 'real' && authModeRaw !== 'bypass') {
    throw new Error(
      `AUTH_MODE must be exactly 'real' or 'bypass' (got ${JSON.stringify(authModeRaw)})`,
    )
  }
  const authMode: AuthMode = authModeRaw

  // Cross-check 1: bypass requires non-production NODE_ENV.
  const nodeEnvRaw = process.env.NODE_ENV
  if (authMode === 'bypass' && nodeEnvRaw !== 'development' && nodeEnvRaw !== 'test') {
    throw new Error(
      `loadEnv: AUTH_MODE=bypass requires NODE_ENV in {'development','test'}, got NODE_ENV=${JSON.stringify(nodeEnvRaw)}`,
    )
  }

  // Cross-check 2: real + production requires the boot gate on.
  if (authMode === 'real' && nodeEnvRaw === 'production' && process.env.BOOT_GATE_ENABLED !== '1') {
    throw new Error(
      'loadEnv: AUTH_MODE=real with NODE_ENV=production requires BOOT_GATE_ENABLED=1',
    )
  }

  if (authMode === 'real') {
    const userPoolId = process.env.COGNITO_USER_POOL_ID
    const appClientId = process.env.COGNITO_APP_CLIENT_ID
    const issuerUrl = process.env.COGNITO_ISSUER_URL
    const hostedUiDomain = process.env.COGNITO_HOSTED_UI_DOMAIN
    if (!userPoolId || !appClientId || !issuerUrl || !hostedUiDomain) {
      throw new Error(
        'AUTH_MODE=real requires all of COGNITO_USER_POOL_ID, COGNITO_APP_CLIENT_ID, COGNITO_ISSUER_URL, COGNITO_HOSTED_UI_DOMAIN',
      )
    }
    return {
      authMode,
      cognitoUserPoolId: userPoolId,
      cognitoAppClientId: appClientId,
      cognitoIssuerUrl: issuerUrl,
      cognitoHostedUiDomain: hostedUiDomain,
    }
  }

  // bypass mode
  return {
    authMode,
    cognitoUserPoolId: undefined,
    cognitoAppClientId: undefined,
    cognitoIssuerUrl: undefined,
    cognitoHostedUiDomain: undefined,
  }
}

export function loadEnv(): Env {
  const portRaw = process.env.PORT
  if (!portRaw) {
    throw new Error('Missing required env var: PORT')
  }
  const port = Number(portRaw)
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`PORT must be numeric, got: ${portRaw}`)
  }
  return Object.freeze({
    databaseUrl: buildDatabaseUrl(),
    redisRealtimeUrl: buildRedisUrl('realtime'),
    redisBatchUrl: buildRedisUrl('batch'),
    port,
    ...loadAuthConfig(),
  })
}
```

- [ ] **Step 2: Tests**

Create `backend/src/config/__tests__/env.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadEnv } from '../env.js'

const SAFE_BASE = () => {
  vi.stubEnv('PORT', '3000')
  vi.stubEnv('DATABASE_URL', 'postgresql://x:y@localhost:5432/test')
  vi.stubEnv('REDIS_REALTIME_URL', 'redis://localhost:6379')
  vi.stubEnv('REDIS_BATCH_URL', 'redis://localhost:6380')
}

describe('loadEnv auth-mode parsing', () => {
  beforeEach(() => SAFE_BASE())
  afterEach(() => vi.unstubAllEnvs())

  it('throws when AUTH_MODE is unset', () => {
    vi.stubEnv('AUTH_MODE', '')
    expect(() => loadEnv()).toThrow(/AUTH_MODE must be exactly/)
  })

  it("throws on AUTH_MODE='Real' (case-mismatch)", () => {
    vi.stubEnv('AUTH_MODE', 'Real')
    vi.stubEnv('NODE_ENV', 'development')
    expect(() => loadEnv()).toThrow(/AUTH_MODE must be exactly/)
  })

  it('parses bypass mode in NODE_ENV=development', () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'development')
    const env = loadEnv()
    expect(env.authMode).toBe('bypass')
    expect(env.cognitoUserPoolId).toBeUndefined()
  })

  it('throws bypass + NODE_ENV=production', () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'production')
    expect(() => loadEnv()).toThrow(/AUTH_MODE=bypass requires NODE_ENV/)
  })

  it('throws real + production without BOOT_GATE_ENABLED', () => {
    vi.stubEnv('AUTH_MODE', 'real')
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('COGNITO_USER_POOL_ID', 'x')
    vi.stubEnv('COGNITO_APP_CLIENT_ID', 'y')
    vi.stubEnv('COGNITO_ISSUER_URL', 'https://cognito-idp.us-east-1.amazonaws.com/x')
    vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', 'x.auth.us-east-1.amazoncognito.com')
    expect(() => loadEnv()).toThrow(/BOOT_GATE_ENABLED=1/)
  })

  it('parses real mode with all Cognito vars', () => {
    vi.stubEnv('AUTH_MODE', 'real')
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('BOOT_GATE_ENABLED', '1')
    vi.stubEnv('COGNITO_USER_POOL_ID', 'us-east-1_test')
    vi.stubEnv('COGNITO_APP_CLIENT_ID', 'cli')
    vi.stubEnv('COGNITO_ISSUER_URL', 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test')
    vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', 'mythrun.auth.us-east-1.amazoncognito.com')
    const env = loadEnv()
    expect(env.authMode).toBe('real')
    expect(env.cognitoUserPoolId).toBe('us-east-1_test')
  })

  it('throws real mode missing COGNITO_USER_POOL_ID', () => {
    vi.stubEnv('AUTH_MODE', 'real')
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('COGNITO_APP_CLIENT_ID', 'c')
    vi.stubEnv('COGNITO_ISSUER_URL', 'https://x.example.com')
    vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', 'd.example.com')
    expect(() => loadEnv()).toThrow(/AUTH_MODE=real requires/)
  })
})
```

- [ ] **Step 3: Run tests**

```bash
cd backend && pnpm vitest run src/config/__tests__/env.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Verify other tests still pass (loadEnv is widely consumed)**

```bash
cd backend && pnpm test 2>&1 | tail -10
```

Some pre-existing tests may now require AUTH_MODE in their env stubs. If any fail, the failure is a missing AUTH_MODE — add `vi.stubEnv('AUTH_MODE', 'bypass'); vi.stubEnv('NODE_ENV', 'development')` to the failing test's setup. The base `.env.development` already has `AUTH_MODE=bypass`, so most tests should pick it up via the dotenv load in `setup-env.ts`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/config/env.ts backend/src/config/__tests__/env.test.ts
git commit -m "feat(myt-37): loadEnv AUTH_MODE + COGNITO_* + cross-checks"
```

---

## Task 7: buildApp updates

**Files:**
- Modify: `backend/src/app.ts`
- Modify: `backend/src/__tests__/app.test.ts`

- [ ] **Step 1: Update app.ts**

Read the current contents first:

```bash
cat backend/src/app.ts
```

Then replace `backend/src/app.ts` (preserving the existing `createShutdown` exports — only change `buildApp`):

```typescript
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { AppDeps } from './app-deps.js'
import { registerAuth, type RegisterAuthOptions } from './auth/index.js'
import { registerReadyRoute } from './routes/health-ready.js'

export const buildApp = async (
  deps: AppDeps,
  authOpts: RegisterAuthOptions,
): Promise<FastifyInstance> => {
  const app = Fastify({
    genReqId: (req) => {
      const trace = req.headers['x-amzn-trace-id']
      return typeof trace === 'string' ? trace : randomUUID()
    },
    logger: {
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
        ],
        censor: '[REDACTED]',
      },
      serializers: {
        req(request) {
          const url = typeof request.url === 'string' ? request.url.split('?')[0] : request.url
          return {
            method: request.method,
            url,
            hostname: request.hostname,
            remoteAddress: request.ip,
            remotePort: request.socket?.remotePort,
          }
        },
      },
    },
  })

  app.get('/health', { config: { auth: 'public' } }, () => ({ status: 'ok' })) // liveness
  registerReadyRoute(app, deps) // readiness — opts out via config: { auth: 'public' } inside the route file

  // Custom 404 handler so the auth hook's dual routeOptions guard runs
  // against unmatched paths. Marked auth: 'public' as belt-and-suspenders.
  app.setNotFoundHandler({ config: { auth: 'public' } }, (_request, reply) => {
    reply.code(404).send({ error: 'Not Found' })
  })

  await registerAuth(app, authOpts)
  return app
}

export type ShutdownSignal = 'SIGTERM' | 'SIGINT'
export type ShutdownHandler = (signal: ShutdownSignal) => Promise<void>

export interface ShutdownClients {
  readonly pg: Pool
  readonly redisRealtime: Redis
  readonly redisBatch: Redis
}

export const createShutdown = (
  app: FastifyInstance,
  clients: ShutdownClients,
): ShutdownHandler => {
  return async (signal) => {
    try {
      app.log.info({ signal }, 'shutting down')
      await new Promise<void>((resolve) => setImmediate(resolve))
      await app.close()
      await clients.pg.end()
      await clients.redisRealtime.quit()
      await clients.redisBatch.quit()
      process.exit(0)
    } catch (err) {
      app.log.error({ err, signal }, 'error during shutdown')
      process.exit(1)
    }
  }
}
```

- [ ] **Step 2: Update health-ready.ts to mark itself public**

```bash
grep -n "registerReadyRoute" backend/src/routes/health-ready.ts | head -3
```

Inside `backend/src/routes/health-ready.ts`, find the `app.get('/health/ready', ...)` call and add `{ config: { auth: 'public' } }` as the second argument (before the handler):

```typescript
app.get('/health/ready', { config: { auth: 'public' } }, async (_req, reply) => {
  // ... existing implementation ...
})
```

- [ ] **Step 3: Update existing app.test.ts to await buildApp + supply authOpts**

Open `backend/src/__tests__/app.test.ts` and update every `buildApp(deps)` call to `await buildApp(deps, { mode: 'bypass' })`. Add an explicit encapsulation-contract test:

```typescript
it('encapsulation: auth hook applies to parent-scope routes', async () => {
  vi.stubEnv('NODE_ENV', 'development')
  // ... clear cognito env vars ...
  globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof globalThis.fetch
  const app = await buildApp(makeStubDeps(), { mode: 'bypass' })
  app.get('/post-register-route', () => ({ ok: true }))
  // bypass mode: route should respond 200 with bypass user attached
  const res = await app.inject({ method: 'GET', url: '/post-register-route' })
  expect(res.statusCode).toBe(200)
  await app.close()
})
```

(Read the existing file first; this test is added alongside the existing tests. The existing tests may need their `buildApp` calls converted to `await buildApp(deps, { mode: 'bypass' })`.)

- [ ] **Step 4: Run tests**

```bash
cd backend && pnpm vitest run src/__tests__/app.test.ts && pnpm typecheck
```

Expected: tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/app.ts backend/src/routes/health-ready.ts backend/src/__tests__/app.test.ts
git commit -m "feat(myt-37): buildApp async + auth registration + 404 handler + logger config"
```

---

## Task 8: server.ts wiring

**Files:**
- Modify: `backend/src/server.ts`

- [ ] **Step 1: Read current server.ts**

```bash
cat backend/src/server.ts
```

- [ ] **Step 2: Update both boot paths to pass authOpts to buildApp**

In `backend/src/server.ts`:

1. After `loadEnv()` is called and `env` is bound, construct `authOpts`:

```typescript
const authOpts = {
  mode: env.authMode,
  userPoolId: env.cognitoUserPoolId,
  appClientId: env.cognitoAppClientId,
  issuerUrl: env.cognitoIssuerUrl,
  hostedUiDomain: env.cognitoHostedUiDomain,
}
```

2. In the gated path, change `const app = buildApp(deps)` → `const app = await buildApp(deps, authOpts)`.

3. In `fallbackStart()`, change `const app = buildApp(stubDeps)` → `const app = await buildApp(stubDeps, authOpts)`. If `fallbackStart` doesn't currently call `loadEnv`, add `const env = loadEnv()` and the `authOpts` construction at the top of `fallbackStart` (or refactor so loadEnv is called once at module top and passed in).

- [ ] **Step 3: Verify locally**

```bash
cd backend && pnpm typecheck && pnpm test 2>&1 | tail -10
```

Expected: typecheck clean; tests pass. If a server-test exists and fails on the boot path, update its env-stub to include AUTH_MODE.

- [ ] **Step 4: Smoke-test the local boot**

```bash
cd backend && pnpm db:up && DATABASE_URL=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun pnpm dev 2>&1 | head -20
```

Expected output: pino lines including `auth.bypass_mode_active` (the bypass plugin's loud warning), and a "server listening on port 3000" line. Ctrl-C after confirmation.

- [ ] **Step 5: Commit**

```bash
git add backend/src/server.ts
git commit -m "feat(myt-37): server.ts passes authOpts to buildApp on both boot paths"
```

---

## Task 9: Serving module Terraform changes

**Files:**
- Modify: `infra/modules/serving/variables.tf`
- Modify: `infra/modules/serving/main.tf`

- [ ] **Step 1: Add auth_mode and node_env variables**

Append to `infra/modules/serving/variables.tf`:

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
  description = "Node.js NODE_ENV value. Defaults to 'production' so a real environment can't lose Layer 2 of the bypass-mode defense by forgetting to set it. The bypass plugin demands NODE_ENV in {'development','test'} at registration."
  type        = string
  default     = "production"

  validation {
    condition     = contains(["development", "test", "production"], var.node_env)
    error_message = "node_env must be 'development', 'test', or 'production'."
  }
}
```

- [ ] **Step 2: Add reserved-name validation to var.extra_env**

Find the existing `variable "extra_env"` block in `infra/modules/serving/variables.tf` and replace it with:

```hcl
variable "extra_env" {
  description = "Per-environment additional env vars to inject into the API task. May NOT contain AUTH_MODE, NODE_ENV, BOOT_GATE_ENABLED, or any COGNITO_* — those are owned by the module's dedicated variables (auth_mode, node_env) or by the auth module's outputs. Override attempts fail at terraform plan."
  type        = list(object({ name = string, value = string }))
  default     = []

  validation {
    condition = alltrue([
      for e in var.extra_env : !contains([
        "AUTH_MODE", "NODE_ENV", "BOOT_GATE_ENABLED",
        "COGNITO_USER_POOL_ID", "COGNITO_APP_CLIENT_ID",
        "COGNITO_ISSUER_URL", "COGNITO_HOSTED_UI_DOMAIN",
        "AWS_EXECUTION_ENV", "ECS_CONTAINER_METADATA_URI_V4",
      ], e.name)
    ])
    error_message = "extra_env must not contain reserved auth/Cognito/boot-gate/AWS-runtime names. Use the module's dedicated variables (auth_mode, node_env) instead."
  }
}
```

- [ ] **Step 3: Inject AUTH_MODE + NODE_ENV into common_env in main.tf**

Find the `common_env` local in `infra/modules/serving/main.tf` and add the two new entries AFTER `var.extra_env` so positional ordering is also defensive:

```hcl
common_env = concat(var.extra_env, [
  { name = "ENVIRONMENT", value = var.environment },
  # ... existing entries ...
  { name = "AUTH_MODE", value = var.auth_mode },
  { name = "NODE_ENV",  value = var.node_env },
])
```

(Read `main.tf` first to find the exact existing shape; insert the two new entries in the inline list after the existing ENV var entries.)

- [ ] **Step 4: Validate**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun && terraform -chdir=infra/modules/serving init -backend=false && terraform -chdir=infra/modules/serving validate
```

Expected: `Success! The configuration is valid.`

- [ ] **Step 5: Commit**

```bash
git add infra/modules/serving/variables.tf infra/modules/serving/main.tf
git commit -m "infra(myt-37): serving module auth_mode + node_env variables + extra_env validation"
```

---

## Task 10: CI gates + lint rule

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Create: `.github/workflows/lint-auth.yml` (or extend an existing lint workflow)

- [ ] **Step 1: Add AUTH_MODE precondition gate to Deploy**

In `.github/workflows/deploy.yml`, find the step that runs `aws-actions/amazon-ecs-render-task-definition` and add this step BEFORE it:

```yaml
      - name: Verify AUTH_MODE is set in the latest task-def
        run: |
          set -euo pipefail
          LATEST=$(aws ecs describe-task-definition \
            --task-definition mythrun-staging-api \
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

- [ ] **Step 2: Add the `requireUser` grep CI rule**

Create `.github/workflows/lint-auth.yml`:

```yaml
name: Auth Lint

on:
  pull_request:
    paths:
      - 'backend/src/**'
      - '.github/workflows/lint-auth.yml'
  push:
    branches: [main]
    paths:
      - 'backend/src/**'

jobs:
  forbid-unsafe-user-access:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - name: Forbid `request.user!` and `request.user?` outside auth/__tests__
        run: |
          set -euo pipefail
          # Search backend/src/, exclude the auth/ module itself and any __tests__/.
          if grep -rEn 'request\.user[!?]\.|request\.user as ' \
              backend/src/ --include='*.ts' \
              --exclude-dir=__tests__ --exclude-dir=auth; then
            echo ""
            echo "::error::Found request.user! / request.user?. / (request.user as) usage. Use requireUser(request) instead."
            exit 1
          fi
          echo "Auth-narrowing pattern check passed."
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml .github/workflows/lint-auth.yml
git commit -m "ci(myt-37): AUTH_MODE precondition gate + requireUser lint rule"
```

---

## Task 11: Compose into staging + apply + verify deploy + close

This task is operator-driven (no implementer subagent for the apply itself).

- [ ] **Step 1: Push all prior commits to a working branch**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
git push origin main
```

- [ ] **Step 2: Verify staging composition will pick up the module defaults**

The staging composition (`infra/environments/staging/main.tf`) already calls `module "serving"`. With `auth_mode` defaulting to `"real"` and `node_env` defaulting to `"production"`, no composition change is needed — the module supplies AUTH_MODE + NODE_ENV automatically.

```bash
cd infra/environments/staging && terraform plan -out=apply.tfplan
```

Expected plan diff: 1 task-def revision change for `mythrun-staging-api` adding `AUTH_MODE=real` and `NODE_ENV=production` to the environment list. Worker task-def gets the same.

- [ ] **Step 3: Apply**

```bash
terraform apply apply.tfplan
```

Expected: TF registers a new task-def revision. ECS service stays on the previous CI-deployed revision until CI runs.

- [ ] **Step 4: Verify drift-free re-plan**

```bash
terraform plan
```

Expected: `No changes.`

- [ ] **Step 5: Trigger CI deploy**

```bash
gh workflow run Deploy --ref main
```

Watch the workflow:

```bash
gh run watch
```

Expected: AUTH_MODE precondition gate passes (logs "AUTH_MODE=real verified"); render-task-def step succeeds; ECS service rolls onto the new revision.

- [ ] **Step 6: Verify in staging**

```bash
curl -s https://staging-api.mythrun.com/health
# Expected: {"status":"ok"}

curl -s -o /dev/null -w "%{http_code}\n" https://staging-api.mythrun.com/health/ready
# Expected: 200

curl -s -o /dev/null -w "%{http_code}\n" https://staging-api.mythrun.com/some-nonexistent-path
# Expected: 404 (404 fall-through guard works)

curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer invalid" https://staging-api.mythrun.com/some-nonexistent-path
# Expected: 404 (still falls through; auth hook respects the unmatched-path guard)
```

CloudWatch log check:

```bash
aws logs tail /ecs/mythrun-staging-api --since 10m --filter-pattern '"auth.bypass_mode_active"'
# Expected: empty result (real mode active, no bypass logs)

aws logs tail /ecs/mythrun-staging-api --since 10m --filter-pattern '"auth.jwks_hydrate_failed"'
# Expected: empty result (hydrate succeeded at boot)
```

- [ ] **Step 7: Close MYT-37 in Linear**

Use `mcp__linear-server__save_issue` with `id=MYT-37`, `state="Done"`.

- [ ] **Step 8: File follow-up beads**

```bash
bd create --title="Compose auth module into production environment" --description="See myth-8pcx (already filed for MYT-36); MYT-37 doesn't add new prod work beyond what's already deferred." --type=task --priority=2

bd create --title="JWKS periodic refresh — close key-compromise window" --description="Wrap aws-jwt-verify with a customJwksFetcher bounded to 6h max-age TTL. Closes the unbounded-cache-on-compromise window. P2 launch-blocker. See MYT-37 spec §5 flag #2 + §11." --type=task --priority=2

bd create --title="Suspended-user enforcement (DB lookup + Redis kill-switch)" --description="MYT-39's loadCurrentUser plugin does the DB lookup for suspended_at. The Redis pub/sub user:{userId}:suspend channel for active WebSocket termination is the second half of parent §6.4. P2 launch-blocker." --type=task --priority=2

bd create --title="Multi-dev-user X-Dev-User header for bypass" --description="Parent Auth & Users spec §5.6 specifies X-Dev-User: 2 header for testing multiplayer locally. Defer until first multiplayer ticket lands." --type=task --priority=4

bd create --title="users.cognito_sub CHECK constraint rejecting 'bypass:%'" --description="Defense-in-depth: even if bypass mode somehow ran against a real DB, the row insert fails. Land whenever a future migration touches users." --type=task --priority=3
```

- [ ] **Step 9: Dispatch wiki-update subagent**

Per CLAUDE.md, wiki content sync is part of closing a Linear ticket. The wiki authoring instructions live at `docs/wiki/AUTHORING.md`. Dispatch a subagent with the prompt parameterized for MYT-37; the subagent updates `docs/wiki/content/auth-billing/identity.html` (or adds a sibling page for JWT middleware) and commits its changes.

- [ ] **Step 10: Push wiki commit**

```bash
git push origin main
```

Done. MYT-37 is shipped.
