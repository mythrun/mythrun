# MYT-39 — Access Control + WebSocket Ticket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship per-resource access-control middleware (`requireCampaignMember`, `requireWorldCreator`) and the WebSocket ticket exchange (`POST /api/sessions/:id/ws-ticket` + `consumeWsTicket` helper). Closes the Auth track of the Platform milestone.

**Architecture:** Two preHandler factories in `backend/src/auth/access-control.ts` plus framework-agnostic Redis helpers in `backend/src/auth/ws-ticket.ts`. `requireOnboarded` is extended to attach a frozen `request.dbUser` and reject suspended accounts. A boot-time `accessControlAllowlist` plugin gates against access-control middleware on `auth: 'public'`/`'jwt-no-db'` routes. The single new route `POST /api/sessions/:id/ws-ticket` exercises the full chain.

**Tech Stack:** Node.js 24, Fastify v5, TypeScript strict, ioredis 5.x, Postgres 15+ (pg), Vitest, ESLint. Tests use `ioredis-mock` (added in this plan) and `vi.mock` for repo seams.

**Spec:** `docs/superpowers/specs/2026-05-08-myt-39-access-control-ws-ticket-design.md`

**Source spec (mutates in this commit):** `docs/specs/2026-04-13-auth-users.md` §6 / §7 / §8 / §10, plus three other source-of-truth files (see Task 14).

---

## File Structure

**New files:**

| Path | Responsibility |
|------|----------------|
| `backend/src/auth/access-control.ts` | `requireCampaignMember(repo, role?)` and `requireWorldCreator(repo)` factories returning `preHandlerHookHandler` |
| `backend/src/auth/access-control-allowlist.ts` | Boot-time `onRoute`+`onReady` plugin that fails app start if any access-control-guarded route uses `auth: 'public'`/`'jwt-no-db'` |
| `backend/src/auth/require-db-user.ts` | `requireDbUser(request): User` — narrows `request.dbUser` from optional, throws if missing |
| `backend/src/auth/ws-ticket.ts` | `mintWsTicket` and `consumeWsTicket` Redis helpers, framework-agnostic |
| `backend/src/auth/__tests__/access-control.test.ts` | Tests for the two factories |
| `backend/src/auth/__tests__/access-control-allowlist.test.ts` | Tests for the boot-time gate |
| `backend/src/auth/__tests__/require-db-user.test.ts` | Tests for the helper |
| `backend/src/auth/__tests__/ws-ticket.test.ts` | Tests for mint/consume |
| `backend/src/routes/sessions.ts` | Single route: `POST /api/sessions/:id/ws-ticket` |
| `backend/src/routes/__tests__/sessions.test.ts` | Integration tests for the route |

**Modified files:**

| Path | Why |
|------|-----|
| `backend/src/config/env.ts` | Read `MYTHRUN_ENV`; expose `redisKeyPrefix` derived from `MYTHRUN_ENV` + `REGION_PREFIX` |
| `backend/src/auth/types.ts` | Add `dbUser` / `campaignMember` / `world` / `resolvedCampaignId` augmentations; consolidate `FastifyContextConfig.auth` declaration |
| `backend/src/auth/require-onboarded.ts` | Attach frozen `request.dbUser`; reject when `suspended_at IS NOT NULL` with `{code: 'account_suspended'}` |
| `backend/src/auth/jwt-plugin.ts` | Normalize 401 error shape `{error: '...'}` → `{code: 'unauthenticated'}` |
| `backend/src/auth/__tests__/require-onboarded.test.ts` | Add cases for `dbUser` attachment, freeze, `suspended_at` rejection |
| `backend/src/auth/__tests__/jwt-plugin.test.ts` | Update to assert new `{code: 'unauthenticated'}` shape |
| `backend/src/app-deps.ts` | Add `redisKeyPrefix: string` to `AppDeps` |
| `backend/src/app.ts` | Register `accessControlAllowlist` plugin and `sessionsRoutes`; thread `redisKeyPrefix` |
| `backend/src/boot/index.ts` (or wherever AppDeps is built) | Wire `env.redisKeyPrefix` into `AppDeps` |
| `backend/package.json` | Add `ioredis-mock` to devDependencies |
| `infra/modules/serving/main.tf` | Add `MYTHRUN_ENV` env var to ECS task definition |
| `docs/specs/2026-04-13-auth-users.md` | §6 (mark suspend-enforcement done), §7 (endpoint shape, payload, TTL), §8 (illustrative code, role enum, world-access scope, new param-naming-convention subsection), §10 (auth-routes table) |
| `docs/specs/2026-04-13-multiplayer-session-runtime.md` | Connection flow + reconnection protocol — new endpoint shape |
| `docs/specs/2026-04-06-production-architecture-overview.md` | §5 WebSocket Protocol — endpoint shape, repo API name |
| `docs/specs/2026-04-10-ux-design.md` | Auth & Identity API surface — endpoint name |

**Deleted file:**

| Path | Why |
|------|-----|
| `backend/src/types/fastify.d.ts` | Duplicate `FastifyContextConfig.auth` declaration; consolidated into `auth/types.ts` |

---

## Task Sequencing Notes

Tasks 1–4 are foundational scaffolding (env, dep, helper, types). Tasks 5–9 build the auth primitives bottom-up (`requireOnboarded` mod → ws-ticket helpers → access-control factories → allowlist gate → JWT shape normalization). Task 10 wires up the route. Task 11 wires `app.ts`. Task 12 ships the infra env var. Tasks 13–14 are doc-only source-spec syncs. Task 15 is final verification + commit + push.

Each task ends with a commit. The implementation does NOT push until Task 15.

---

## Task 1: Add `MYTHRUN_ENV` env var + `redisKeyPrefix` derivation

**Files:**
- Modify: `backend/src/config/env.ts`
- Modify: `backend/src/config/__tests__/env.test.ts`

`REGION_PREFIX` is already wired into `infra/modules/serving/main.tf:128`. `MYTHRUN_ENV` is new — add it as a required string env var with the values `production | staging | development`. Derive `redisKeyPrefix` as `${MYTHRUN_ENV}:${REGION_PREFIX}:`.

- [ ] **Step 1: Write failing test for `redisKeyPrefix` derivation**

Append to `backend/src/config/__tests__/env.test.ts`:

```typescript
describe('redisKeyPrefix', () => {
  it('derives from MYTHRUN_ENV + REGION_PREFIX', () => {
    process.env.MYTHRUN_ENV = 'production'
    process.env.REGION_PREFIX = 'use1'
    // ... rest of required env vars set per existing test setup
    const env = loadEnv()
    expect(env.redisKeyPrefix).toBe('production:use1:')
  })

  it('rejects missing MYTHRUN_ENV', () => {
    delete process.env.MYTHRUN_ENV
    process.env.REGION_PREFIX = 'use1'
    expect(() => loadEnv()).toThrow(/MYTHRUN_ENV/)
  })

  it('rejects missing REGION_PREFIX', () => {
    process.env.MYTHRUN_ENV = 'production'
    delete process.env.REGION_PREFIX
    expect(() => loadEnv()).toThrow(/REGION_PREFIX/)
  })

  it('rejects invalid MYTHRUN_ENV value', () => {
    process.env.MYTHRUN_ENV = 'prod'  // must be 'production'
    process.env.REGION_PREFIX = 'use1'
    expect(() => loadEnv()).toThrow(/MYTHRUN_ENV must be one of/)
  })
})
```

(The existing tests in this file already populate the rest of the required env vars in a `beforeEach`; reuse that pattern.)

- [ ] **Step 2: Run tests, verify they fail**

```
pnpm --filter backend vitest run config/__tests__/env.test.ts
```

Expected: 4 new tests fail.

- [ ] **Step 3: Add `redisKeyPrefix` to `Env` interface**

Modify `backend/src/config/env.ts` `Env` interface:

```typescript
export interface Env {
  readonly databaseUrl: string
  readonly redisRealtimeUrl: string
  readonly redisBatchUrl: string
  readonly redisKeyPrefix: string  // NEW — e.g. "production:use1:"
  readonly mythrunEnv: 'production' | 'staging' | 'development'  // NEW
  readonly port: number
  readonly authMode: AuthMode
  readonly cognitoUserPoolId?: string
  readonly cognitoAppClientId?: string
  readonly cognitoIssuerUrl?: string
  readonly cognitoHostedUiDomain?: string
  readonly frontendBaseUrl: string
  readonly stripeSecretKey: string
  readonly stripeWebhookSecret: string
  readonly anthropicApiKey: string
}
```

- [ ] **Step 4: Add validation + derivation in `loadEnv()`**

Inside `loadEnv()` in `backend/src/config/env.ts`, after the existing field reads but before the `Env` object construction:

```typescript
const mythrunEnvRaw = process.env.MYTHRUN_ENV
if (mythrunEnvRaw !== 'production' && mythrunEnvRaw !== 'staging' && mythrunEnvRaw !== 'development') {
  throw new Error(
    `loadEnv: MYTHRUN_ENV must be one of {'production','staging','development'}, got ${JSON.stringify(mythrunEnvRaw)}`,
  )
}
const regionPrefix = process.env.REGION_PREFIX
if (!regionPrefix || regionPrefix.length === 0) {
  throw new Error('loadEnv: REGION_PREFIX is required (e.g. "use1")')
}
const redisKeyPrefix = `${mythrunEnvRaw}:${regionPrefix}:`
```

Then add `mythrunEnv: mythrunEnvRaw` and `redisKeyPrefix` to the returned `Env` object.

- [ ] **Step 5: Run tests, verify they pass**

```
pnpm --filter backend vitest run config/__tests__/env.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Update `.env.development.example` and `.env.development`**

Add to both files:

```
MYTHRUN_ENV=development
REGION_PREFIX=use1
```

- [ ] **Step 7: Commit**

```
git add backend/src/config/env.ts backend/src/config/__tests__/env.test.ts \
        backend/.env.development.example backend/.env.development
git commit -m "feat(myt-39): MYTHRUN_ENV + redisKeyPrefix derivation in env.ts"
```

---

## Task 2: Add `ioredis-mock` to devDependencies

**Files:**
- Modify: `backend/package.json`
- Modify: `pnpm-lock.yaml` (auto-updated)

- [ ] **Step 1: Add the dep**

```
cd backend && pnpm add -D ioredis-mock
```

- [ ] **Step 2: Verify it's in `package.json` `devDependencies`**

```
grep -A 1 '"devDependencies"' backend/package.json | grep ioredis-mock
```

Expected: `"ioredis-mock": "^X.Y.Z",`

- [ ] **Step 3: Verify install completes cleanly**

```
pnpm install
```

Expected: no errors.

- [ ] **Step 4: Commit**

```
git add backend/package.json pnpm-lock.yaml
git commit -m "chore(myt-39): add ioredis-mock devDependency for ws-ticket tests"
```

---

## Task 3: Create `requireDbUser` helper + tests

**Files:**
- Create: `backend/src/auth/require-db-user.ts`
- Create: `backend/src/auth/__tests__/require-db-user.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/auth/__tests__/require-db-user.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { requireDbUser } from '../require-db-user.js'
import type { User } from '../../repo/types.js'

const fakeUser: User = {
  id: 'u-1',
  cognitoSub: 'sub-1',
  username: 'tester',
  displayName: 'Tester',
  stripeCustomerId: null,
  freeTrialUsed: false,
  suspendedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe('requireDbUser', () => {
  it('returns request.dbUser when present', () => {
    expect(requireDbUser({ dbUser: fakeUser })).toBe(fakeUser)
  })

  it('throws when dbUser is undefined', () => {
    expect(() => requireDbUser({})).toThrow(/requireOnboarded/)
  })

  it('throws when dbUser is explicitly undefined', () => {
    expect(() => requireDbUser({ dbUser: undefined })).toThrow(/requireOnboarded/)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

```
pnpm --filter backend vitest run auth/__tests__/require-db-user.test.ts
```

Expected: all 3 tests fail (module not found).

- [ ] **Step 3: Implement `requireDbUser`**

Create `backend/src/auth/require-db-user.ts`:

```typescript
// backend/src/auth/require-db-user.ts
//
// Helper that narrows request.dbUser from optional to required. Throws
// if called from a route where requireOnboarded didn't run upstream
// (which would indicate a misconfigured route — public/jwt-no-db routes
// don't have dbUser attached).
//
// Parallels require-user.ts; lives in its own file (not types.ts) so
// type augmentation and runtime helpers don't share a module.

import type { User } from '../repo/types.js'

export function requireDbUser(request: { dbUser?: User | undefined }): User {
  if (!request.dbUser) {
    throw new Error(
      'requireDbUser: request.dbUser is undefined — was requireOnboarded registered before this hook?',
    )
  }
  return request.dbUser
}
```

- [ ] **Step 4: Run tests, verify they pass**

```
pnpm --filter backend vitest run auth/__tests__/require-db-user.test.ts
```

Expected: 3 pass.

- [ ] **Step 5: Commit**

```
git add backend/src/auth/require-db-user.ts backend/src/auth/__tests__/require-db-user.test.ts
git commit -m "feat(myt-39): requireDbUser helper paralleling require-user"
```

---

## Task 4: Add type augmentations to `auth/types.ts`; delete `types/fastify.d.ts`

**Files:**
- Modify: `backend/src/auth/types.ts`
- Delete: `backend/src/types/fastify.d.ts`

- [ ] **Step 1: Verify no consumers reference the doomed file**

```
grep -rn "from.*types/fastify" backend/src/ 2>/dev/null
```

Expected: empty output. (If any matches, stop and read them — they need updating before delete.)

- [ ] **Step 2: Update `auth/types.ts` with the new augmentations**

Modify `backend/src/auth/types.ts`. Replace the existing `declare module 'fastify'` block with:

```typescript
declare module 'fastify' {
  interface FastifyRequest {
    /** OPTIONAL — public routes don't have a user attached. Protected
     *  handlers should narrow via the `requireUser(request)` helper rather
     *  than dereferencing `request.user.sub` directly, which would throw
     *  at runtime if a route accidentally lands here without auth. */
    user?: AuthUser

    /** OPTIONAL — populated by `requireOnboarded` after the cognito_sub →
     *  users-row lookup succeeds and `suspended_at` is null. Public and
     *  jwt-no-db routes don't have it. Frozen to prevent in-place mutation
     *  by downstream middleware. Narrow via `requireDbUser(request)`. */
    dbUser?: User

    /** OPTIONAL — populated by `requireCampaignMember` after the membership
     *  check passes. Handlers can read this to skip a redo of the same query. */
    campaignMember?: CampaignMember

    /** OPTIONAL — populated by `requireWorldCreator` after the ownership
     *  check passes. */
    world?: World

    /** OPTIONAL — set by upstream resolvers (e.g. session→campaign in
     *  `routes/sessions.ts`) to feed `requireCampaignMember` when the
     *  route's URL doesn't directly carry `:campaignId`. */
    resolvedCampaignId?: string
  }

  interface FastifyContextConfig {
    /** Per-route auth opt-out / opt-in.
     *  - 'public' — skip JWT validation entirely; no request.user attached.
     *  - 'jwt-no-db' — verify JWT, attach claims; no users-row DB lookup.
     *  - undefined (default) — JWT verify + users-row lookup +
     *    suspended_at check + dbUser attach. */
    auth?: 'public' | 'jwt-no-db'
  }

  interface FastifyInstance {
    /** Decorated by jwtPlugin in real mode; absent in bypass mode. */
    jwtVerifier?: JwtVerifier
  }
}
```

Add the imports at the top (or merge with existing ones):

```typescript
import type { CognitoAccessTokenPayload } from 'aws-jwt-verify/jwt-model'
import type { CampaignMember, User, World } from '../repo/types.js'
```

- [ ] **Step 3: Delete the duplicate file**

```
git rm backend/src/types/fastify.d.ts
```

- [ ] **Step 4: Run typecheck — verify nothing broke**

```
pnpm --filter backend typecheck
```

Expected: clean. If anything errors with `Property 'auth' does not exist on type 'FastifyContextConfig'`, the consumer is referencing `'jwt'` (the deleted stale literal) — search for it (`grep -rn "auth: 'jwt'" backend/src/`) and fix.

- [ ] **Step 5: Run full test suite**

```
pnpm --filter backend test
```

Expected: green. The deletion + augmentation is type-only; no runtime test should break.

- [ ] **Step 6: Commit**

```
git add backend/src/auth/types.ts
git commit -m "feat(myt-39): consolidate FastifyContextConfig.auth + add request augmentations"
```

---

## Task 5: Modify `requireOnboarded` to attach frozen `dbUser` + reject suspended accounts

**Files:**
- Modify: `backend/src/auth/require-onboarded.ts`
- Modify: `backend/src/auth/__tests__/require-onboarded.test.ts`

- [ ] **Step 1: Write failing tests for the new behavior**

Append to `backend/src/auth/__tests__/require-onboarded.test.ts`:

```typescript
it('attaches frozen request.dbUser when row exists and suspended_at is null', async () => {
  const row = {
    id: 'u-1',
    cognitoSub: 'sub-1',
    username: 'tester',
    displayName: 'Tester',
    stripeCustomerId: null,
    freeTrialUsed: false,
    suspendedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  getByCognitoSubWithTimeout.mockResolvedValueOnce(row)

  app = Fastify({ logger: false })
  await app.register(fakeJwtPlugin({ sub: 'sub-1' }))
  await app.register(requireOnboarded, { pool: fakePool })

  let attached: unknown
  app.get('/check', (req) => {
    attached = (req as unknown as { dbUser?: unknown }).dbUser
    return { ok: true }
  })

  const res = await app.inject({ method: 'GET', url: '/check' })
  expect(res.statusCode).toBe(200)
  expect(attached).toMatchObject({ id: 'u-1', cognitoSub: 'sub-1' })
  expect(Object.isFrozen(attached)).toBe(true)
})

it('returns 403 account_suspended when suspended_at is set', async () => {
  const row = {
    id: 'u-1',
    cognitoSub: 'sub-1',
    username: 'tester',
    displayName: 'Tester',
    stripeCustomerId: null,
    freeTrialUsed: false,
    suspendedAt: new Date('2026-01-01'),
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  getByCognitoSubWithTimeout.mockResolvedValueOnce(row)

  app = Fastify({ logger: false })
  await app.register(fakeJwtPlugin({ sub: 'sub-1' }))
  await app.register(requireOnboarded, { pool: fakePool })
  app.get('/check', () => ({ ok: true }))

  const res = await app.inject({ method: 'GET', url: '/check' })
  expect(res.statusCode).toBe(403)
  expect(res.json()).toEqual({ code: 'account_suspended' })
})
```

- [ ] **Step 2: Run tests, verify the new ones fail**

```
pnpm --filter backend vitest run auth/__tests__/require-onboarded.test.ts
```

Expected: existing tests still pass; the 2 new tests fail.

- [ ] **Step 3: Modify `require-onboarded.ts`'s preHandler body**

In `backend/src/auth/require-onboarded.ts`, replace the per-request gate (currently lines ~76-93) with:

```typescript
  // Per-request gate.
  app.addHook('preHandler', async (request, reply) => {
    const cfg = request.routeOptions.config.auth
    if (cfg === 'public' || cfg === 'jwt-no-db') return

    if (request.routeOptions.url === undefined) return // 404 fall-through

    if (!request.user) {
      return reply.code(401).send({ code: 'unauthenticated' })
    }

    const row = await users.getByCognitoSubWithTimeout(
      request.user.sub,
      REQUIRE_ONBOARDED_LOOKUP_TIMEOUT_MS,
    )
    if (!row) {
      return reply.code(403).send({ code: 'username_required' })
    }
    if (row.suspendedAt !== null) {
      return reply.code(403).send({ code: 'account_suspended' })
    }
    // Frozen so a buggy / malicious downstream hook can't swap fields
    // in place. TS `readonly` is structural-only; runtime freeze is the
    // actual guarantee.
    request.dbUser = Object.freeze(row)
  })
```

Note: the `if (!request.user)` branch was also changed from `{ code: 'unauthenticated' }` (already that shape per existing code at line 83) — verify the existing line is `{ code: 'unauthenticated' }`. If it was `{ error: '...' }`, this update normalizes it.

- [ ] **Step 4: Run tests, verify all pass**

```
pnpm --filter backend vitest run auth/__tests__/require-onboarded.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```
git add backend/src/auth/require-onboarded.ts backend/src/auth/__tests__/require-onboarded.test.ts
git commit -m "feat(myt-39): requireOnboarded attaches frozen dbUser + rejects suspended"
```

---

## Task 6: Create `ws-ticket.ts` + tests

**Files:**
- Create: `backend/src/auth/ws-ticket.ts`
- Create: `backend/src/auth/__tests__/ws-ticket.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/auth/__tests__/ws-ticket.test.ts`:

```typescript
import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WS_TICKET_TTL_SECONDS,
  consumeWsTicket,
  mintWsTicket,
} from '../ws-ticket.js'

const KEY_PREFIX = 'staging:use1:ws:ticket:'

describe('mintWsTicket', () => {
  let redis: Redis

  beforeEach(() => {
    redis = new IoRedisMock() as unknown as Redis
  })
  afterEach(async () => {
    await redis.quit()
  })

  it('returns 64-char hex ticket', async () => {
    const result = await mintWsTicket(
      { redis, keyPrefix: KEY_PREFIX },
      { userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' },
    )
    expect(result.ticket).toMatch(/^[0-9a-f]{64}$/)
  })

  it('stores key with payload JSON under the prefix', async () => {
    const { ticket } = await mintWsTicket(
      { redis, keyPrefix: KEY_PREFIX },
      { userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' },
    )
    const raw = await redis.get(`${KEY_PREFIX}${ticket}`)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed).toEqual({ userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' })
  })

  it('sets PTTL within (27000, 30000] immediately after mint', async () => {
    const { ticket } = await mintWsTicket(
      { redis, keyPrefix: KEY_PREFIX },
      { userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' },
    )
    const pttl = await redis.pttl(`${KEY_PREFIX}${ticket}`)
    expect(pttl).toBeGreaterThan(27_000)
    expect(pttl).toBeLessThanOrEqual(30_000)
  })

  it('returns expiresAt ~30s in future, ISO-8601 parseable', async () => {
    const before = Date.now()
    const { expiresAt } = await mintWsTicket(
      { redis, keyPrefix: KEY_PREFIX },
      { userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' },
    )
    const parsed = Date.parse(expiresAt)
    expect(parsed).not.toBeNaN()
    expect(parsed - before).toBeGreaterThanOrEqual(WS_TICKET_TTL_SECONDS * 1000 - 100)
    expect(parsed - before).toBeLessThanOrEqual(WS_TICKET_TTL_SECONDS * 1000 + 100)
  })
})

describe('consumeWsTicket', () => {
  let redis: Redis

  beforeEach(() => {
    redis = new IoRedisMock() as unknown as Redis
  })
  afterEach(async () => {
    await redis.quit()
  })

  it('returns payload and removes the key', async () => {
    const { ticket } = await mintWsTicket(
      { redis, keyPrefix: KEY_PREFIX },
      { userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' },
    )
    const result = await consumeWsTicket({ redis, keyPrefix: KEY_PREFIX }, ticket)
    expect(result).toEqual({ userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' })
    expect(await redis.get(`${KEY_PREFIX}${ticket}`)).toBeNull()
  })

  it('second consume returns null', async () => {
    const { ticket } = await mintWsTicket(
      { redis, keyPrefix: KEY_PREFIX },
      { userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' },
    )
    await consumeWsTicket({ redis, keyPrefix: KEY_PREFIX }, ticket)
    expect(await consumeWsTicket({ redis, keyPrefix: KEY_PREFIX }, ticket)).toBeNull()
  })

  it('non-existent ticket returns null', async () => {
    expect(
      await consumeWsTicket({ redis, keyPrefix: KEY_PREFIX }, 'never-existed'),
    ).toBeNull()
  })

  it('corrupt JSON payload returns null', async () => {
    await redis.set(`${KEY_PREFIX}corrupt`, '{not json', 'EX', 30)
    expect(
      await consumeWsTicket({ redis, keyPrefix: KEY_PREFIX }, 'corrupt'),
    ).toBeNull()
  })

  it('payload missing required field returns null', async () => {
    await redis.set(
      `${KEY_PREFIX}incomplete`,
      JSON.stringify({ userId: 'u-1', sessionId: 's-1' }),  // missing campaignId
      'EX',
      30,
    )
    expect(
      await consumeWsTicket({ redis, keyPrefix: KEY_PREFIX }, 'incomplete'),
    ).toBeNull()
  })

  it('payload with extra fields parses cleanly (forward compat)', async () => {
    await redis.set(
      `${KEY_PREFIX}extra`,
      JSON.stringify({ userId: 'u-1', sessionId: 's-1', campaignId: 'c-1', clientVersion: '2.0' }),
      'EX',
      30,
    )
    const result = await consumeWsTicket({ redis, keyPrefix: KEY_PREFIX }, 'extra')
    expect(result).toMatchObject({ userId: 'u-1', sessionId: 's-1', campaignId: 'c-1' })
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

```
pnpm --filter backend vitest run auth/__tests__/ws-ticket.test.ts
```

Expected: all fail (module not found).

- [ ] **Step 3: Implement `ws-ticket.ts`**

Create `backend/src/auth/ws-ticket.ts`:

```typescript
// backend/src/auth/ws-ticket.ts
//
// Single-use WebSocket ticket store. Mint stores a {userId, sessionId,
// campaignId} payload under a 30s TTL Redis key. Consume reads + deletes
// atomically via GETDEL. Framework-agnostic — both the Fastify mint route
// and the future WS upgrade handler call these directly.
//
// Spec: docs/superpowers/specs/2026-05-08-myt-39-access-control-ws-ticket-design.md §5

import { randomBytes } from 'node:crypto'
import type { Redis } from 'ioredis'

export const WS_TICKET_TTL_SECONDS = 30

export interface WsTicketPayload {
  readonly userId: string
  readonly sessionId: string
  readonly campaignId: string
}

export interface MintedTicket {
  readonly ticket: string
  readonly expiresAt: string  // ISO-8601 — informational; WS upgrade is authority
}

export interface WsTicketDeps {
  readonly redis: Redis
  readonly keyPrefix: string  // e.g. "production:use1:ws:ticket:" — derived in env.ts
}

export async function mintWsTicket(
  deps: WsTicketDeps,
  payload: WsTicketPayload,
): Promise<MintedTicket> {
  const ticket = randomBytes(32).toString('hex')
  const value = JSON.stringify(payload)
  await deps.redis.set(`${deps.keyPrefix}${ticket}`, value, 'EX', WS_TICKET_TTL_SECONDS)
  const expiresAt = new Date(Date.now() + WS_TICKET_TTL_SECONDS * 1000).toISOString()
  return { ticket, expiresAt }
}

export async function consumeWsTicket(
  deps: WsTicketDeps,
  ticket: string,
): Promise<WsTicketPayload | null> {
  // ioredis 5.x typed redis.getdel — atomic read+delete in one round-trip.
  // Returns Promise<string | null>; cast through `unknown` is unnecessary.
  const value = await deps.redis.getdel(`${deps.keyPrefix}${ticket}`)
  if (value === null) return null
  if (typeof value !== 'string') {
    // Buffer mode is incompatible with this string contract. The shared
    // realtime client today is string-mode (backend/src/redis/client.ts);
    // belt-and-suspenders for a future config regression.
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { userId?: unknown }).userId !== 'string' ||
    typeof (parsed as { sessionId?: unknown }).sessionId !== 'string' ||
    typeof (parsed as { campaignId?: unknown }).campaignId !== 'string'
  ) {
    return null
  }
  return parsed as WsTicketPayload
}
```

- [ ] **Step 4: Run tests, verify all pass**

```
pnpm --filter backend vitest run auth/__tests__/ws-ticket.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```
git add backend/src/auth/ws-ticket.ts backend/src/auth/__tests__/ws-ticket.test.ts
git commit -m "feat(myt-39): mintWsTicket + consumeWsTicket helpers"
```

---

## Task 7: Create `access-control.ts` + tests

**Files:**
- Create: `backend/src/auth/access-control.ts`
- Create: `backend/src/auth/__tests__/access-control.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/auth/__tests__/access-control.test.ts`:

```typescript
import Fastify, { type FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../repo/index.js'
import type {
  CampaignMember,
  CampaignMemberRole,
  User,
  World,
} from '../../repo/types.js'
import { requireCampaignMember, requireWorldCreator } from '../access-control.js'

const fakeUser: User = {
  id: 'u-1',
  cognitoSub: 'sub-1',
  username: 'tester',
  displayName: 'Tester',
  stripeCustomerId: null,
  freeTrialUsed: false,
  suspendedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

function attachDbUserPlugin(user: User | undefined) {
  return fp(
    // eslint-disable-next-line @typescript-eslint/require-await
    async (app) => {
      // eslint-disable-next-line @typescript-eslint/require-await
      app.addHook('preHandler', async (request) => {
        if (user) {
          ;(request as unknown as { dbUser: User }).dbUser = Object.freeze(user)
        }
      })
    },
    { fastify: '5.x', name: 'fake-attach-db-user' },
  )
}

function makeRepo(overrides: {
  membership?: CampaignMember | null
  world?: World | null
}): Repo {
  return {
    campaigns: {
      getMembership: vi.fn().mockResolvedValue(overrides.membership ?? null),
    },
    worlds: {
      getById: vi.fn().mockResolvedValue(overrides.world ?? null),
    },
  } as unknown as Repo
}

const memberRow = (role: CampaignMemberRole, inviteAccepted = true): CampaignMember => ({
  id: 'cm-1',
  campaignId: 'c-1',
  userId: 'u-1',
  role,
  inviteAccepted,
  joinedAt: new Date(),
})

const worldRow = (createdBy: string): World => ({
  id: 'w-1',
  createdBy,
  sourceWorldId: null,
  name: 'Test',
  concept: 'X',
  tone: null,
  themes: null,
  geographySummary: null,
  politicalSummary: null,
  era: null,
  keyTensions: null,
  worldOverview: null,
  followUpQuestions: null,
  startingSituations: null,
  isPublic: false,
  forkCount: 0,
  status: 'complete',
  language: 'en',
  moderationStatus: 'unreviewed',
  createdAt: new Date(),
  updatedAt: new Date(),
})

describe('requireCampaignMember', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
  })

  it('member with no role gate passes; attaches request.campaignMember', async () => {
    const repo = makeRepo({ membership: memberRow('player') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    let attached: unknown
    app.get(
      '/c/:campaignId/x',
      { preHandler: requireCampaignMember(repo) },
      (req) => {
        attached = (req as unknown as { campaignMember?: unknown }).campaignMember
        return { ok: true }
      },
    )
    const res = await app.inject({ method: 'GET', url: '/c/c-1/x' })
    expect(res.statusCode).toBe(200)
    expect(attached).toMatchObject({ campaignId: 'c-1', userId: 'u-1', role: 'player' })
  })

  it('member with matching role gate passes', async () => {
    const repo = makeRepo({ membership: memberRow('owner') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    app.get('/c/:campaignId/x', { preHandler: requireCampaignMember(repo, 'owner') }, () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/c/c-1/x' })
    expect(res.statusCode).toBe(200)
  })

  it('member with mismatching role gate returns 403 not_campaign_owner', async () => {
    const repo = makeRepo({ membership: memberRow('player') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    app.get('/c/:campaignId/x', { preHandler: requireCampaignMember(repo, 'owner') }, () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/c/c-1/x' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_owner' })
  })

  it('non-member returns 403 not_campaign_member', async () => {
    const repo = makeRepo({ membership: null })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    app.get('/c/:campaignId/x', { preHandler: requireCampaignMember(repo) }, () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/c/c-1/x' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_member' })
  })

  it('member with invite_accepted=false returns 403 not_campaign_member', async () => {
    const repo = makeRepo({ membership: memberRow('player', false) })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    app.get('/c/:campaignId/x', { preHandler: requireCampaignMember(repo) }, () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/c/c-1/x' })
    expect(res.statusCode).toBe(403)
  })

  it('uses request.resolvedCampaignId when set (no :campaignId in URL)', async () => {
    const repo = makeRepo({ membership: memberRow('player') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    app.get(
      '/sessions/:id/x',
      {
        preHandler: [
          // eslint-disable-next-line @typescript-eslint/require-await
          async (req) => {
            ;(req as unknown as { resolvedCampaignId: string }).resolvedCampaignId = 'c-1'
          },
          requireCampaignMember(repo),
        ],
      },
      () => ({ ok: true }),
    )
    const res = await app.inject({ method: 'GET', url: '/sessions/s-1/x' })
    expect(res.statusCode).toBe(200)
  })

  it('throws (500) when neither :campaignId nor resolvedCampaignId set', async () => {
    const repo = makeRepo({ membership: memberRow('player') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    app.get('/x', { preHandler: requireCampaignMember(repo) }, () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/x' })
    expect(res.statusCode).toBe(500)
  })

  it('throws (500) when request.dbUser is missing', async () => {
    const repo = makeRepo({ membership: memberRow('player') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(undefined))  // no dbUser attached
    app.get('/c/:campaignId/x', { preHandler: requireCampaignMember(repo) }, () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/c/c-1/x' })
    expect(res.statusCode).toBe(500)
  })
})

describe('requireWorldCreator', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
  })

  it('creator passes; attaches request.world', async () => {
    const repo = makeRepo({ world: worldRow('u-1') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    let attached: unknown
    app.get(
      '/w/:worldId',
      { preHandler: requireWorldCreator(repo) },
      (req) => {
        attached = (req as unknown as { world?: unknown }).world
        return { ok: true }
      },
    )
    const res = await app.inject({ method: 'GET', url: '/w/w-1' })
    expect(res.statusCode).toBe(200)
    expect(attached).toMatchObject({ id: 'w-1', createdBy: 'u-1' })
  })

  it('non-creator returns 403 not_world_creator', async () => {
    const repo = makeRepo({ world: worldRow('other-user') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    app.get('/w/:worldId', { preHandler: requireWorldCreator(repo) }, () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/w/w-1' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_world_creator' })
  })

  it('non-existent world returns 404 world_not_found', async () => {
    const repo = makeRepo({ world: null })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    app.get('/w/:worldId', { preHandler: requireWorldCreator(repo) }, () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/w/w-1' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ code: 'world_not_found' })
  })

  it('throws (500) when :worldId missing', async () => {
    const repo = makeRepo({ world: worldRow('u-1') })
    app = Fastify({ logger: false })
    await app.register(attachDbUserPlugin(fakeUser))
    app.get('/w', { preHandler: requireWorldCreator(repo) }, () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/w' })
    expect(res.statusCode).toBe(500)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

```
pnpm --filter backend vitest run auth/__tests__/access-control.test.ts
```

Expected: all fail (module not found).

- [ ] **Step 3: Implement `access-control.ts`**

Create `backend/src/auth/access-control.ts`:

```typescript
// backend/src/auth/access-control.ts
//
// Per-resource access-control middleware factories. Returned hooks read
// request.dbUser (attached by requireOnboarded) and either :campaignId
// from the URL or request.resolvedCampaignId set by an upstream resolver.
//
// Param-name convention: campaign-rooted routes use :campaignId; world-
// rooted routes use :worldId; sessions resolve their parent campaign
// via an upstream preHandler that sets request.resolvedCampaignId.
//
// The boot-time access-control-allowlist plugin (a sibling file) ensures
// these factories are never wired onto a route with config.auth: 'public'
// or 'jwt-no-db' — that would short-circuit requireOnboarded and leave
// request.dbUser undefined.
//
// Spec: docs/superpowers/specs/2026-05-08-myt-39-access-control-ws-ticket-design.md §4

import type { preHandlerHookHandler } from 'fastify'
import type { Repo } from '../repo/index.js'
import type { CampaignMemberRole } from '../repo/types.js'
import { requireDbUser } from './require-db-user.js'

export function requireCampaignMember(
  repo: Repo,
  role?: CampaignMemberRole,
): preHandlerHookHandler {
  return async function requireCampaignMember(request, reply) {
    const dbUser = requireDbUser(request)
    const campaignId =
      request.resolvedCampaignId ??
      (request.params as { campaignId?: string }).campaignId
    if (!campaignId) {
      throw new Error(
        'requireCampaignMember: route has no :campaignId param and no request.resolvedCampaignId',
      )
    }
    const member = await repo.campaigns.getMembership(campaignId, dbUser.id)
    if (!member || !member.inviteAccepted) {
      return reply.code(403).send({ code: 'not_campaign_member' })
    }
    if (role && member.role !== role) {
      return reply.code(403).send({ code: `not_campaign_${role}` })
    }
    request.campaignMember = member
  }
}

export function requireWorldCreator(repo: Repo): preHandlerHookHandler {
  return async function requireWorldCreator(request, reply) {
    const dbUser = requireDbUser(request)
    const worldId = (request.params as { worldId?: string }).worldId
    if (!worldId) {
      throw new Error('requireWorldCreator: route has no :worldId param')
    }
    const world = await repo.worlds.getById(worldId)
    if (!world) {
      return reply.code(404).send({ code: 'world_not_found' })
    }
    if (world.createdBy !== dbUser.id) {
      return reply.code(403).send({ code: 'not_world_creator' })
    }
    request.world = world
  }
}
```

Note: the inner functions are named (`async function requireCampaignMember(...)` not `async (request, reply) => ...`) — the `accessControlAllowlist` plugin in Task 8 inspects `handler.name` to identify access-control-guarded routes.

- [ ] **Step 4: Run tests, verify all pass**

```
pnpm --filter backend vitest run auth/__tests__/access-control.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```
git add backend/src/auth/access-control.ts backend/src/auth/__tests__/access-control.test.ts
git commit -m "feat(myt-39): requireCampaignMember + requireWorldCreator middleware factories"
```

---

## Task 8: Create `access-control-allowlist.ts` + tests

**Files:**
- Create: `backend/src/auth/access-control-allowlist.ts`
- Create: `backend/src/auth/__tests__/access-control-allowlist.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/auth/__tests__/access-control-allowlist.test.ts`:

```typescript
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accessControlAllowlist } from '../access-control-allowlist.js'
import { requireCampaignMember, requireWorldCreator } from '../access-control.js'
import type { Repo } from '../../repo/index.js'

const fakeRepo = {
  campaigns: { getMembership: vi.fn() },
  worlds: { getById: vi.fn() },
} as unknown as Repo

describe('accessControlAllowlist', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
  })

  it('app.ready() throws when requireCampaignMember + auth: public', async () => {
    app = Fastify({ logger: false })
    await app.register(accessControlAllowlist)
    app.post(
      '/c/:campaignId/x',
      { config: { auth: 'public' }, preHandler: requireCampaignMember(fakeRepo) },
      () => ({ ok: true }),
    )
    await expect(app.ready()).rejects.toThrow(/access-control-allowlist/i)
  })

  it('app.ready() throws when requireWorldCreator + auth: jwt-no-db', async () => {
    app = Fastify({ logger: false })
    await app.register(accessControlAllowlist)
    app.get(
      '/w/:worldId',
      { config: { auth: 'jwt-no-db' }, preHandler: requireWorldCreator(fakeRepo) },
      () => ({ ok: true }),
    )
    await expect(app.ready()).rejects.toThrow(/access-control-allowlist/i)
  })

  it('app.ready() succeeds with default-auth + requireCampaignMember', async () => {
    app = Fastify({ logger: false })
    await app.register(accessControlAllowlist)
    app.post('/c/:campaignId/x', { preHandler: requireCampaignMember(fakeRepo) }, () => ({ ok: true }))
    await expect(app.ready()).resolves.not.toThrow()
  })

  it('app.ready() succeeds for unrelated public route (no access-control middleware)', async () => {
    app = Fastify({ logger: false })
    await app.register(accessControlAllowlist)
    app.get('/health', { config: { auth: 'public' } }, () => ({ ok: true }))
    await expect(app.ready()).resolves.not.toThrow()
  })

  it('lists offenders in the thrown error message', async () => {
    app = Fastify({ logger: false })
    await app.register(accessControlAllowlist)
    app.post(
      '/c/:campaignId/x',
      { config: { auth: 'public' }, preHandler: requireCampaignMember(fakeRepo) },
      () => ({ ok: true }),
    )
    await expect(app.ready()).rejects.toThrow(/POST \/c\/:campaignId\/x/)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

```
pnpm --filter backend vitest run auth/__tests__/access-control-allowlist.test.ts
```

Expected: all fail.

- [ ] **Step 3: Implement `access-control-allowlist.ts`**

Create `backend/src/auth/access-control-allowlist.ts`:

```typescript
// backend/src/auth/access-control-allowlist.ts
//
// Boot-time gate. Mirrors the JWT_NO_DB_ALLOWLIST pattern in
// require-onboarded.ts. onRoute collects every route whose preHandler
// array contains a function named `requireCampaignMember` or
// `requireWorldCreator`; onReady asserts none of them have config.auth
// set to 'public' or 'jwt-no-db'.
//
// Catches the misconfig where a contributor wires access-control onto a
// route that short-circuits requireOnboarded — without this gate, the
// route 500s only when traffic arrives.
//
// Spec: docs/superpowers/specs/2026-05-08-myt-39-access-control-ws-ticket-design.md §4

import fp from 'fastify-plugin'
import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify'

const ACCESS_CONTROL_FN_NAMES = new Set(['requireCampaignMember', 'requireWorldCreator'])

// eslint-disable-next-line @typescript-eslint/require-await
const impl: FastifyPluginAsync = async (app) => {
  const offenders: { method: string; url: string }[] = []

  app.addHook('onRoute', (routeOptions) => {
    const handlers = routeOptions.preHandler as
      | preHandlerHookHandler
      | preHandlerHookHandler[]
      | undefined
    const arr = Array.isArray(handlers) ? handlers : handlers ? [handlers] : []
    const usesAccessControl = arr.some((h) => ACCESS_CONTROL_FN_NAMES.has(h.name))
    if (!usesAccessControl) return
    const cfg = routeOptions.config as { auth?: string } | undefined
    if (cfg?.auth === 'public' || cfg?.auth === 'jwt-no-db') {
      const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method]
      for (const m of methods) {
        if (m.toUpperCase() === 'HEAD') continue
        offenders.push({ method: m, url: routeOptions.url })
      }
    }
  })

  // eslint-disable-next-line @typescript-eslint/require-await
  app.addHook('onReady', async () => {
    if (offenders.length > 0) {
      const list = offenders.map((o) => `${o.method} ${o.url}`).join(', ')
      throw new Error(
        `access-control-allowlist: route(s) with requireCampaignMember/requireWorldCreator must NOT ` +
          `set config.auth to 'public' or 'jwt-no-db' — that short-circuits requireOnboarded and leaves ` +
          `request.dbUser undefined. Offenders: ${list}`,
      )
    }
  })
}

export const accessControlAllowlist = fp(impl, {
  fastify: '5.x',
  name: 'mythrun-access-control-allowlist',
})
```

- [ ] **Step 4: Run tests, verify all pass**

```
pnpm --filter backend vitest run auth/__tests__/access-control-allowlist.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```
git add backend/src/auth/access-control-allowlist.ts backend/src/auth/__tests__/access-control-allowlist.test.ts
git commit -m "feat(myt-39): boot-time accessControlAllowlist plugin"
```

---

## Task 9: Normalize JWT plugin error shape

**Files:**
- Modify: `backend/src/auth/jwt-plugin.ts`
- Modify: `backend/src/auth/__tests__/jwt-plugin.test.ts`

- [ ] **Step 1: Update tests to expect `{code: 'unauthenticated'}`**

In `backend/src/auth/__tests__/jwt-plugin.test.ts`, find every assertion of `{ error: 'Missing Bearer token' | 'Empty Bearer token' | 'Invalid token' }` and replace with `{ code: 'unauthenticated' }`. There should be ~3 such assertions.

- [ ] **Step 2: Run tests, verify they fail**

```
pnpm --filter backend vitest run auth/__tests__/jwt-plugin.test.ts
```

Expected: 3 tests fail.

- [ ] **Step 3: Update `jwt-plugin.ts` 401 responses**

In `backend/src/auth/jwt-plugin.ts`, replace all four `reply.code(401).send({ error: '...' })` calls (around lines 87, 91, 105, 111, 115) with:

```typescript
return reply.code(401).send({ code: 'unauthenticated' })
```

- [ ] **Step 4: Run tests, verify all pass**

```
pnpm --filter backend vitest run auth/__tests__/jwt-plugin.test.ts
```

Expected: green.

- [ ] **Step 5: Run full test suite to catch any cross-test breakage**

```
pnpm --filter backend test
```

Expected: green. If anything fails, the failing test was asserting the old `{error}` shape and needs updating.

- [ ] **Step 6: Commit**

```
git add backend/src/auth/jwt-plugin.ts backend/src/auth/__tests__/jwt-plugin.test.ts
git commit -m "feat(myt-39): normalize jwt-plugin 401 error shape to {code: 'unauthenticated'}"
```

---

## Task 10: Create `routes/sessions.ts` + tests

**Files:**
- Create: `backend/src/routes/sessions.ts`
- Create: `backend/src/routes/__tests__/sessions.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/routes/__tests__/sessions.test.ts`:

```typescript
import Fastify, { type FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import type {
  CampaignMember,
  CampaignMemberRole,
  Session,
  User,
} from '../../repo/types.js'

// Mock the repo factory so routes/sessions.ts uses our stubs.
const getMembershipMock = vi.fn()
const getSessionByIdMock = vi.fn()
vi.mock('../../repo/index.js', () => ({
  createRepo: () => ({
    campaigns: { getMembership: getMembershipMock },
    sessions: { getById: getSessionByIdMock },
    worlds: { getById: vi.fn() },
  }),
}))

import { sessionsRoutes } from '../sessions.js'

const fakeUser: User = {
  id: 'u-1',
  cognitoSub: 'sub-1',
  username: 'tester',
  displayName: 'Tester',
  stripeCustomerId: null,
  freeTrialUsed: false,
  suspendedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const memberRow = (role: CampaignMemberRole = 'player'): CampaignMember => ({
  id: 'cm-1',
  campaignId: 'c-1',
  userId: 'u-1',
  role,
  inviteAccepted: true,
  joinedAt: new Date(),
})

const sessionRow: Session = {
  id: 's-1',
  campaignId: 'c-1',
  sessionNumber: 1,
  status: 'active',
  startedAt: new Date(),
  endedAt: null,
  summary: null,
  stRunningSummary: null,
  handoff: null,
}

function attachDbUserPlugin(user: User | undefined) {
  return fp(
    // eslint-disable-next-line @typescript-eslint/require-await
    async (app) => {
      // eslint-disable-next-line @typescript-eslint/require-await
      app.addHook('preHandler', async (request) => {
        if (user) {
          ;(request as unknown as { dbUser: User }).dbUser = Object.freeze(user)
        }
      })
    },
    { fastify: '5.x', name: 'fake-attach-db-user' },
  )
}

const fakePool = {} as Pool
const KEY_PREFIX = 'staging:use1:ws:ticket:'

async function build(opts: {
  user: User | undefined
  redis: Redis
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(attachDbUserPlugin(opts.user))
  await app.register(sessionsRoutes, {
    pool: fakePool,
    redisRealtime: opts.redis,
    redisKeyPrefix: KEY_PREFIX,
  })
  return app
}

describe('POST /api/sessions/:id/ws-ticket', () => {
  let app: FastifyInstance | undefined
  let redis: Redis

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    await redis.quit()
    getMembershipMock.mockReset()
    getSessionByIdMock.mockReset()
  })

  function setup() {
    redis = new IoRedisMock() as unknown as Redis
  }

  it('session does not exist → 404 session_not_found', async () => {
    setup()
    getSessionByIdMock.mockResolvedValueOnce(null)
    app = await build({ user: fakeUser, redis })
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s-1/ws-ticket' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ code: 'session_not_found' })
  })

  it('session exists, user not a member → 403 not_campaign_member', async () => {
    setup()
    getSessionByIdMock.mockResolvedValueOnce(sessionRow)
    getMembershipMock.mockResolvedValueOnce(null)
    app = await build({ user: fakeUser, redis })
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s-1/ws-ticket' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_member' })
  })

  it('member → 200 with ticket and expiresAt; ticket fetchable from Redis', async () => {
    setup()
    getSessionByIdMock.mockResolvedValueOnce(sessionRow)
    getMembershipMock.mockResolvedValueOnce(memberRow())
    app = await build({ user: fakeUser, redis })
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s-1/ws-ticket' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ticket).toMatch(/^[0-9a-f]{64}$/)
    expect(Date.parse(body.expiresAt)).not.toBeNaN()

    const stored = await redis.get(`${KEY_PREFIX}${body.ticket}`)
    expect(stored).not.toBeNull()
    expect(JSON.parse(stored!)).toEqual({
      userId: 'u-1',
      sessionId: 's-1',
      campaignId: 'c-1',
    })
  })

  it('no dbUser → 500 (boot-time misconfig surfaced)', async () => {
    setup()
    getSessionByIdMock.mockResolvedValueOnce(sessionRow)
    app = await build({ user: undefined, redis })
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s-1/ws-ticket' })
    expect(res.statusCode).toBe(500)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

```
pnpm --filter backend vitest run routes/__tests__/sessions.test.ts
```

Expected: all fail (module not found).

- [ ] **Step 3: Implement `routes/sessions.ts`**

Create `backend/src/routes/sessions.ts`:

```typescript
// backend/src/routes/sessions.ts
//
// Session-scoped routes. Currently exposes only POST /api/sessions/:id/ws-ticket
// — the HTTP half of the WebSocket ticket exchange. The actual WebSocket
// upgrade handler lives in the Session Runtime milestone and consumes
// tickets via consumeWsTicket.
//
// Spec: docs/superpowers/specs/2026-05-08-myt-39-access-control-ws-ticket-design.md §6

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { createRepo } from '../repo/index.js'
import { requireDbUser } from '../auth/require-db-user.js'
import { requireCampaignMember } from '../auth/access-control.js'
import { mintWsTicket } from '../auth/ws-ticket.js'

interface Opts {
  readonly pool: Pool
  readonly redisRealtime: Redis
  /** Includes trailing colon, e.g. "production:use1:ws:ticket:". */
  readonly redisKeyPrefix: string
}

export const sessionsRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)

  app.post<{ Params: { id: string } }>(
    '/api/sessions/:id/ws-ticket',
    {
      config: {
        // Per-USER (not per-IP) cap — CG-NAT pools would otherwise share
        // the cap. Matches the per-route opt-in pattern; the global
        // @fastify/rate-limit at app.ts is `global: false`, so without
        // this opt-in the route ships uncapped. MYT-45 swaps the
        // in-memory store for Redis-backed.
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => requireDbUser(req).id,
        },
      },
      preHandler: [
        // Step 1: resolve :id (sessionId) → its parent campaignId.
        async (request, reply) => {
          const session = await repo.sessions.getById(request.params.id)
          if (!session) {
            return reply.code(404).send({ code: 'session_not_found' })
          }
          // Set the typed augmentation field (NOT mutating request.params)
          // so the downstream requireCampaignMember can read it without
          // the route's typed Params shape becoming a partial truth.
          request.resolvedCampaignId = session.campaignId
        },
        // Step 2: verify membership.
        requireCampaignMember(repo),
      ],
    },
    async (request) => {
      const sessionId = request.params.id
      const dbUser = requireDbUser(request)
      // resolvedCampaignId is set by the upstream preHandler; non-null
      // assertion is safe — if step 1 failed, we wouldn't reach here.
      const campaignId = request.resolvedCampaignId!
      const { ticket, expiresAt } = await mintWsTicket(
        { redis: opts.redisRealtime, keyPrefix: opts.redisKeyPrefix },
        { userId: dbUser.id, sessionId, campaignId },
      )
      return { ticket, expiresAt }
    },
  )
}
```

- [ ] **Step 4: Run tests, verify all pass**

```
pnpm --filter backend vitest run routes/__tests__/sessions.test.ts
```

Expected: green.

- [ ] **Step 5: Commit**

```
git add backend/src/routes/sessions.ts backend/src/routes/__tests__/sessions.test.ts
git commit -m "feat(myt-39): POST /api/sessions/:id/ws-ticket route"
```

---

## Task 11: Wire `accessControlAllowlist` and `sessionsRoutes` in `app.ts`; thread `redisKeyPrefix` through `AppDeps`

**Files:**
- Modify: `backend/src/app-deps.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/boot/index.ts` (or wherever `AppDeps` is constructed — find via grep)
- Modify: `backend/src/__tests__/helpers/stub-deps.ts`

- [ ] **Step 1: Find where `AppDeps` is built**

```
grep -rn "AppDeps\b" backend/src/ --include='*.ts' | grep -v __tests__ | head -20
```

Identify the construction site (likely `backend/src/boot/index.ts` or `backend/src/server.ts`).

- [ ] **Step 2: Add `redisKeyPrefix` to `AppDeps`**

Modify `backend/src/app-deps.ts`:

```typescript
export interface AppDeps {
  readonly pg: Pool
  readonly redisRealtime: Redis
  readonly redisBatch: Redis
  readonly redisKeyPrefix: string  // NEW — derived from env.redisKeyPrefix
}
```

- [ ] **Step 3: Wire `redisKeyPrefix` in the `AppDeps` construction site**

Wherever `AppDeps` is built (boot/server file), add `redisKeyPrefix: env.redisKeyPrefix` to the literal.

- [ ] **Step 4: Update test helper `stub-deps.ts`**

```
grep -n "redisKeyPrefix\|redisRealtime" backend/src/__tests__/helpers/stub-deps.ts
```

Add `redisKeyPrefix: 'test:use1:ws:ticket:'` to the stub literal.

- [ ] **Step 5: Register `accessControlAllowlist` + `sessionsRoutes` in `app.ts`**

In `backend/src/app.ts`, **after** the `await app.register(requireOnboarded, { pool: deps.pg })` line and **before** the existing route registrations, add:

```typescript
  // Boot-time gate: any route using requireCampaignMember /
  // requireWorldCreator MUST default to JWT-onboarded auth (not 'public'
  // / 'jwt-no-db'). Catches the misconfig at app.ready() rather than
  // surfacing as a 500 on first traffic.
  await app.register(accessControlAllowlist)
```

And after the existing route registrations (or interleaved with them at a sensible point), register `sessionsRoutes`:

```typescript
  await app.register(sessionsRoutes, {
    pool: deps.pg,
    redisRealtime: deps.redisRealtime,
    redisKeyPrefix: deps.redisKeyPrefix,
  })
```

Add the imports at the top:

```typescript
import { accessControlAllowlist } from './auth/access-control-allowlist.js'
import { sessionsRoutes } from './routes/sessions.js'
```

- [ ] **Step 6: Run typecheck + full test suite**

```
pnpm --filter backend typecheck
pnpm --filter backend test
```

Expected: green. If anything breaks, the most likely cause is a missing `redisKeyPrefix` in a test helper or stub — search for `AppDeps` in `__tests__/` and add the field.

- [ ] **Step 7: Commit**

```
git add backend/src/app-deps.ts backend/src/app.ts \
        backend/src/boot/index.ts backend/src/__tests__/helpers/stub-deps.ts
git commit -m "feat(myt-39): register accessControlAllowlist + sessionsRoutes in app.ts"
```

(Adjust the `git add` line to match the actual path of the AppDeps construction file.)

---

## Task 12: Add `MYTHRUN_ENV` to ECS task definition

**Files:**
- Modify: `infra/modules/serving/main.tf`

- [ ] **Step 1: Find the existing common-env block**

```
grep -n 'REGION_PREFIX\|common_env' infra/modules/serving/main.tf | head -10
```

Locate the env list where `REGION_PREFIX` is defined (around line 128).

- [ ] **Step 2: Add `MYTHRUN_ENV` to the same env list**

Add the line:

```hcl
    { name = "MYTHRUN_ENV", value = var.environment },
```

(`var.environment` is the existing module variable that's `staging` or `production`. Verify via `grep -n 'variable "environment"' infra/modules/serving/variables.tf` — if the var has a different name, use whatever the module already exposes.)

- [ ] **Step 3: Run terraform plan against staging**

```
cd infra/environments/staging && terraform plan
```

Expected: a single change to the ECS task definition: `MYTHRUN_ENV=staging` added to the container env. No other diffs. **Do not apply yet** — the implementation isn't deployed; the env var change should land alongside the code via the deploy pipeline.

- [ ] **Step 4: Commit (plan output captured in commit message if useful)**

```
git add infra/modules/serving/main.tf
git commit -m "infra(myt-39): add MYTHRUN_ENV env var to ECS task definition"
```

---

## Task 13: Update `docs/specs/2026-04-13-auth-users.md`

**Files:**
- Modify: `docs/specs/2026-04-13-auth-users.md`

This task is doc-only. No tests; just text edits. Reference the design doc §9.1 for the full edit list.

- [ ] **Step 1: §6 — mark suspend-enforcement done**

Find the §6 "Token Revocation" correction note (around line 284) that says "the future `loadCurrentUser` plugin (MYT-39) will enforce `suspended_at`." Replace with:

> ✓ **Implemented in MYT-39:** `requireOnboarded` rejects requests with `suspended_at IS NOT NULL` via `403 {code: 'account_suspended'}`. The 1h ban-lag window (between admin suspension and access-token expiry) is now closed.

- [ ] **Step 2: §7 — endpoint shape, payload, TTL**

Replace the §7 endpoint flow with:

- `POST /api/sessions/:id/ws-ticket` (was `POST /api/ws/ticket`)
- Ticket payload: `{userId, sessionId, campaignId}` (was `{userId, username, displayName}`)
- TTL: 30 seconds (was 10)
- WS connect URL: `wss://api.mythrun.com/ws/session/:sessionId?ticket=...` (was `:campaignId`)
- Add: "`expiresAt` returned to the client is informational. The WS upgrade is the authority."

- [ ] **Step 3: §8 — illustrative code**

Find the §8 illustrative `requireCampaignMember`/`requireCampaignOwner` code block (around lines 330-345). Replace with:

```typescript
async function requireCampaignMember(request, reply) {
  const member = await repo.campaigns.getMembership(
    request.params.campaignId,
    request.dbUser.id,
  )
  if (!member || !member.inviteAccepted) {
    return reply.code(403).send({ code: 'not_campaign_member' })
  }
  request.campaignMember = member
}
```

Note: `request.dbUser` is set by the upstream `requireOnboarded` plugin. The owner-only variant collapses to `requireCampaignMember(repo, 'owner')` via the role parameter.

- [ ] **Step 4: §8 — text/coverage edits**

- World Access Control subsection — add: "**Launch scope:** only `requireWorldCreator` (`world.created_by === user.id`) is wired. The broader public-or-campaign-referenced matrix lands when world-sharing flows ship."
- Confirm role enum is `owner | player`. Linear issue text mentioned `dm | player | spectator` — that was wrong; the schema CHECK constraint and all wired code use `owner | player`.
- Add a new subsection "Path-param naming convention":

> Routes guarded by access-control middleware honor a fixed param-name convention:
> - Campaign-rooted routes use `:campaignId` (e.g. `/api/campaigns/:campaignId/...`)
> - World-rooted routes use `:worldId`
> - Routes whose URL carries a different identifier (e.g. `/api/sessions/:id/ws-ticket`) resolve the parent campaign via an upstream preHandler that sets `request.resolvedCampaignId`. `requireCampaignMember` reads `request.resolvedCampaignId` first, falling back to `request.params.campaignId`.

- [ ] **Step 5: §10 — auth-routes table**

Replace the row `POST /api/ws/ticket` with `POST /api/sessions/:id/ws-ticket`. Add a one-line note: "TODO MYT-40: rename `:id` → `:campaignId` on existing campaign-rooted routes when they adopt `requireCampaignMember`."

- [ ] **Step 6: Verify no other stale references**

```
grep -n 'POST /api/ws/ticket\|/ws/session/:campaignId\|requireCampaignOwner\|repo.campaignMembers' docs/specs/2026-04-13-auth-users.md
```

Expected: empty.

- [ ] **Step 7: Commit**

```
git add docs/specs/2026-04-13-auth-users.md
git commit -m "spec(myt-39): sync auth-users.md to MYT-39 design (§6/§7/§8/§10)"
```

---

## Task 14: Sync the other three source-of-truth specs

**Files:**
- Modify: `docs/specs/2026-04-13-multiplayer-session-runtime.md`
- Modify: `docs/specs/2026-04-06-production-architecture-overview.md`
- Modify: `docs/specs/2026-04-10-ux-design.md`

- [ ] **Step 1: Multiplayer session runtime**

In `docs/specs/2026-04-13-multiplayer-session-runtime.md`:
- §"Connection flow" (around lines 127-128): replace `POST /api/ws/ticket` → `POST /api/sessions/:id/ws-ticket`. Replace `wss://...?ticket=<nonce>` URL pattern's `:campaignId` segment with `:sessionId`.
- §"Reconnection protocol" step 4a (around line 494): same replacement.

- [ ] **Step 2: Production architecture overview**

In `docs/specs/2026-04-06-production-architecture-overview.md` §5 WebSocket Protocol (around lines 585-601):
- Replace endpoint `POST /api/ws/ticket` → `POST /api/sessions/:id/ws-ticket`.
- Replace TTL `10s` → `30s`.
- Replace ticket payload to include `campaignId`.
- Replace `repo.campaignMembers.get(...)` → `repo.campaigns.getMembership(...)`.

- [ ] **Step 3: UX design spec**

In `docs/specs/2026-04-10-ux-design.md` §"Auth & Identity" (around line 622): replace `POST /api/ws/ticket` → `POST /api/sessions/:id/ws-ticket`.

- [ ] **Step 4: Verify no other stale references across the docs/specs/ tree**

```
grep -rn 'POST /api/ws/ticket\|/ws/session/:campaignId' docs/specs/ docs/superpowers/
```

Expected: empty (or only the MYT-39 design doc, which references the OLD shapes only inside the §2 contract-decisions table where they're explicitly historical).

- [ ] **Step 5: Commit**

```
git add docs/specs/2026-04-13-multiplayer-session-runtime.md \
        docs/specs/2026-04-06-production-architecture-overview.md \
        docs/specs/2026-04-10-ux-design.md
git commit -m "spec(myt-39): sync session-runtime / arch-overview / ux-design to new ws-ticket shape"
```

---

## Task 15: Final verification, wiki sync, push, Linear close

**Files:** none modified by the engineer; this task is verification + close-the-loop.

- [ ] **Step 1: Run the full backend gate**

```
pnpm --filter backend typecheck
pnpm --filter backend lint
pnpm --filter backend test
```

Expected: green on all three. If anything fails, fix and re-run before proceeding.

- [ ] **Step 2: Build the backend**

```
pnpm --filter backend build
```

Expected: green (catches build-time issues that typecheck misses, such as `.txt` template copying for prompts — MYT-39 doesn't add any prompts but the build script runs anyway).

- [ ] **Step 3: Verify the source-spec edits don't break the wiki source-hash check**

```
pnpm wiki:check
```

If this reports source-hash drift on the four edited specs, that's expected — those specs don't have wiki source-hash markers. If it reports drift on something else, investigate.

- [ ] **Step 4: Dispatch the wiki-update subagent**

Per `docs/wiki/AUTHORING.md`. The subagent updates wiki content for any of the changed surfaces (auth flow, ws-ticket, access-control). It commits its own changes locally.

Use the prompt from `docs/wiki/AUTHORING.md`, parameterized with `MYT-39`. Run via `Agent` subagent.

- [ ] **Step 5: Verify the local commit log**

```
git log --oneline main..HEAD
```

Expected: ~14-15 commits — one per task plus the wiki-update commit. All should be of the form `feat(myt-39): ...` / `infra(myt-39): ...` / `spec(myt-39): ...` / `docs(wiki): myt-39 ...`.

- [ ] **Step 6: Push**

```
git push origin main
```

Watch the staging deploy in `gh run watch` — confirm the API task definition gets the new `MYTHRUN_ENV` var and the new route is reachable.

- [ ] **Step 7: Smoke-test against staging**

```
pnpm smoke:staging
```

If the smoke script doesn't yet exercise the ws-ticket route, that's fine — extending it is optional. The build-and-deploy gate is the load-bearing check.

- [ ] **Step 8: Flip the Linear issue to Done**

Use `mcp__linear-server__save_issue` with `id: 'MYT-39'`, `status: 'Done'`. The PostToolUse hook will emit a wiki-reminder; if Step 4 already ran, the wiki subagent will detect no drift and exit cleanly.

---

## Self-Review Notes

This section is the plan author's check after writing — kept here for traceability.

**Spec coverage:** Every spec section has at least one task that implements it.
- §2 contract decisions → Tasks 1, 5, 6, 7, 9, 13–14
- §3 file layout → Task structure throughout
- §4 access-control middleware → Tasks 4, 5, 7, 8
- §5 ws-ticket helpers → Tasks 1, 6
- §6 the route → Task 10
- §7 bypass-mode parity → covered implicitly by Task 5 (`requireOnboarded` already runs in bypass mode); no seed task added per scope decision (manual SQL inserts for ad-hoc dev testing until MYT-40 ships campaign-create routes)
- §8 testing → Tasks 5, 6, 7, 8, 9, 10
- §9 source-spec updates → Tasks 13, 14
- §10 out-of-scope assertions → documented in spec, no task

**Placeholder scan:** No "TBD" / "implement later" / "similar to Task N" / "add error handling" appear in the plan. Every code block is complete.

**Type consistency:** `WsTicketDeps` (Task 6) is consumed by Task 10's `mintWsTicket(...)` call with the same shape. `requireDbUser` (Task 3) is consumed by Tasks 7, 10. `accessControlAllowlist` (Task 8) reads handler `.name` fields named exactly `requireCampaignMember`/`requireWorldCreator` matching the inner-function names declared in Task 7's implementation.
