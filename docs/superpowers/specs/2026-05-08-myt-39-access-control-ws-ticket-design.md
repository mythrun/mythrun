# MYT-39 — Access Control + WebSocket Ticket Design

> **Linear:** [MYT-39 — Auth: ownership/access control + WebSocket ticket-based auth](https://linear.app/mythrun/issue/MYT-39)
> **Source spec:** `docs/specs/2026-04-13-auth-users.md` §7 + §8
> **Status:** design — implementation pending

## 1. Goal

Ship two related auth pieces that close out the Platform-milestone Auth track:

1. **Per-resource access-control middleware** — Fastify `preHandler` factories that check campaign membership / world ownership before the route handler runs.
2. **WebSocket ticket exchange (mint half)** — an HTTP endpoint that mints a short-lived single-use ticket the browser uses to authenticate the WebSocket upgrade. Plus a `consumeWsTicket` helper for the future WS server to use.

The actual WebSocket server is not in scope — it lives in the Session Runtime milestone.

## 2. Contract decisions (resolved against the source spec + Linear issue)

The Linear issue text and `docs/specs/2026-04-13-auth-users.md` §7/§8 disagree on several points. The contract this design implements:

| Axis | This design | Source-spec drift |
|---|---|---|
| Role enum | `owner \| player` | Linear issue said `dm \| player \| spectator`. Schema CHECK constraint (`migrations/001_initial_schema.sql`) is `('owner', 'player')`. The AI is the DM in Mythrun; no human DM seat. No spectator concept anywhere in the schema. No migration. |
| Status code for non-member | **403** | Linear issue said 404 ("don't leak existence"). Source spec §8 body uses 403. Existence of a campaign isn't sensitive — confirmed by user. |
| Endpoint shape | `POST /api/sessions/:id/ws-ticket` (session-bound) | Source spec §7/§10 said `POST /api/ws/ticket` (user-only). Binding the ticket to a session at mint lets `requireCampaignMember` check membership at mint time, gives MYT-39 a real consumer of the access-control middleware, and simplifies the future WS server's job to a single GETDEL. |
| Ticket payload | `{ userId, sessionId }` | Source spec §7 said `{ userId, username, displayName }`. Display name + username aren't needed by the WS server (it can fetch them from the DB once the userId is known) and are not authentication data; keeping the payload minimal reduces what leaks if the ticket lands somewhere unexpected. |
| Ticket TTL | **30 seconds** | Source spec §7 said 10s, Linear issue said 60s. 30s tolerates SPA hydration / mobile network blips; still negligible if the ticket appears in a log. |
| `requireWorldCreator` (renamed from `requireWorldAccess`) | Creator-only (`world.created_by === user.id`) | Source spec's full matrix (public + private-via-campaign + collaborators) is deferred. Renamed to `requireWorldCreator` to make the actual check explicit and to leave the name `requireWorldAccess` available for the broader matrix when world-sharing flows ship. |
| Error response shape | `{code: '<snake_case>'}` matching `routes/invites.ts` / `routes/users.ts` / `routes/billing.ts` | Codebase-wide convention. The Linear issue and source spec §8 illustrative code used `{error: '...'}`; that drifts from every existing 4xx in the API. The JWT plugin's existing `{error: '...'}` 401 responses are normalized to `{code: '...'}` in the same commit. |
| Redis key prefix | `${MYTHRUN_ENV}:${REGION_PREFIX}:ws:ticket:` | Per `docs/specs/2026-04-10-infrastructure-devops.md` §"Region prefix on Redis keys" — staging and production share a single ElastiCache cluster (`infra/modules/data/main.tf:206-207`); env+region prefixing prevents cross-environment key namespace overlap. MYT-39 is the first code consumer of this convention; the env-var wiring (`MYTHRUN_ENV` ∈ `{staging, production, development}`, already-existing `REGION_PREFIX`) is added to `backend/src/config/env.ts` in this commit. |
| Ticket payload | `{ userId, sessionId, campaignId }` | Embedding `campaignId` saves the future WS server one DB query per upgrade — the campaignId is already resolved in the mint route's preHandler (`session.campaignId`) so embedding is free at mint time. The WS server still re-validates membership on upgrade (see §10), but it doesn't have to re-fetch the session row to find the campaignId. |
| `suspended_at` enforcement | Added to `requireOnboarded` | Source spec §6 line 284 (correction note) explicitly committed MYT-39's onboarded-user gate to enforcing `suspended_at`. Closes the up-to-1h ban-lag window between admin-suspending a user and their access token expiring. |
| Cognito-sub → user.id resolution | Extend `requireOnboarded` to attach `request.dbUser`; access-control reads it | Source spec §8 illustrative code referenced `request.user.id` — but `AuthUser.sub` is the Cognito sub, not the DB id. Either access-control re-fetches (extra DB hit per protected request) or `requireOnboarded` exposes what it already fetched. We pick the latter. |

The source spec (`docs/specs/2026-04-13-auth-users.md`) §7 will be updated to match this contract in the same commit as the MYT-39 implementation. §8 is mostly already aligned (uses 403); the body example referencing `request.user.id` will be tweaked to `request.dbUser.id`, and the role enum reference (`'owner'`) is already correct.

## 3. File layout

```
backend/src/auth/
  access-control.ts        # NEW — requireCampaignMember, requireWorldCreator factories
  access-control-allowlist.ts # NEW — boot-time onRoute+onReady gate, mirrors JWT_NO_DB_ALLOWLIST pattern
  ws-ticket.ts             # NEW — mintWsTicket, consumeWsTicket (Redis helpers)
  require-onboarded.ts     # MODIFY — attach frozen request.dbUser; reject suspended_at
  require-db-user.ts       # NEW — requireDbUser(request): User helper, parallels require-user.ts
  types.ts                 # MODIFY — add request.dbUser / .campaignMember / .world / .resolvedCampaignId augmentation; consolidate FastifyContextConfig.auth
  jwt-plugin.ts            # MODIFY — error-shape normalization {error} → {code: 'unauthenticated'}
  __tests__/
    access-control.test.ts # NEW
    ws-ticket.test.ts      # NEW
backend/src/config/
  env.ts                   # MODIFY — read MYTHRUN_ENV + REGION_PREFIX, expose redisKeyPrefix derivation
backend/src/types/
  fastify.d.ts             # DELETE — duplicate FastifyContextConfig.auth declaration consolidated into auth/types.ts
backend/src/routes/
  sessions.ts              # NEW — POST /api/sessions/:id/ws-ticket (only this route in scope)
  __tests__/
    sessions.test.ts       # NEW
backend/src/app.ts         # MODIFY — register sessionsRoutes, pass redisRealtime
backend/package.json       # MODIFY — add ioredis-mock to devDependencies
```

Four new code files, one new route file, six modified, one deleted. Ws-ticket helpers live next to the auth concerns rather than in a new top-level `ws/` folder — there's no other WS code yet, and a single-file folder is noise.

**Sessions-routes registration order in `app.ts`:** MUST be registered AFTER `requireOnboarded` and AFTER the rate-limit plugin, mirroring the existing `usersRoutes` / `billingRoutes` placement at `backend/src/app.ts:146-156`. Placing it earlier means `request.dbUser` is undefined at the route's preHandler time and every request 500s. The same trap is documented at `app.ts:97-105` for the public-route allowlist hook.

**Type-augmentation cleanup:** `backend/src/types/fastify.d.ts` currently declares `FastifyContextConfig.auth?: 'public' | 'jwt'` and `backend/src/auth/types.ts` declares `auth?: 'public' | 'jwt-no-db'`. TypeScript declaration merging unions these to `'public' | 'jwt' | 'jwt-no-db'`. The `'jwt'` literal is stale (no code uses it; default-auth omits the field). MYT-39 consolidates both declarations into `auth/types.ts` and deletes `types/fastify.d.ts`. Implementation steps: (1) `git rm backend/src/types/fastify.d.ts`, (2) verify `grep -rn "from.*types/fastify"` returns empty, (3) `pnpm typecheck` passes.

## 4. Access-control middleware

### 4.1 Shape

Factory functions that take the `repo` at registration time and return a Fastify `preHandlerHookHandler`. This matches how `webhookRoutes` / `billingRoutes` already take a `pool` at register-time.

```typescript
// backend/src/auth/access-control.ts

import type { preHandlerHookHandler } from 'fastify'
import type { Repo } from '../repo/index.js'
import type { CampaignMemberRole } from '../repo/types.js'
import { requireDbUser } from './require-db-user.js'

// Param convention: routes guarded by these middlewares MUST use `:campaignId`
// or `:worldId` in the URL. Routes whose URL carries a different identifier
// (e.g. `:id` for sessionId) resolve the upstream identifier in a preceding
// preHandler that sets request.resolvedCampaignId; see routes/sessions.ts.
//
// The boot-time gate in access-control-allowlist.ts ensures these factories
// are never wired onto a route with `config.auth: 'public'` (which would
// short-circuit requireOnboarded and leave request.dbUser undefined).

export function requireCampaignMember(
  repo: Repo,
  role?: CampaignMemberRole,
): preHandlerHookHandler {
  return async (request, reply) => {
    const dbUser = requireDbUser(request)
    const campaignId =
      request.resolvedCampaignId ??
      (request.params as { campaignId?: string }).campaignId
    if (!campaignId) {
      throw new Error('requireCampaignMember: route has no :campaignId param and no resolvedCampaignId')
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
  return async (request, reply) => {
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

The factories are **not `fastify-plugin`-wrapped** (they return per-route hook handlers, not plugins). They are also **not safe to hoist to parent-scope** as `app.addHook('preHandler', ...)` — at parent scope they fire on the 404 path with empty params and would throw 500 on every 404. Per-route preHandler arrays cleanly avoid this because Fastify dispatches them only on a matched route.

The earlier draft included a `request.user.sub === dbUser.cognitoSub` cross-check tripwire. **Dropped:** `request.dbUser` is `Object.freeze`-d at attach time (see §4.1 modified `requireOnboarded` body), which prevents in-place mutation of the User row. An attacker who could replace `request.dbUser` wholesale could equally replace `request.user` and the cross-check would pass trivially — the freeze is the actual guarantee, the cross-check was theater. (Round-2 Cumulus I5.)

```typescript
// backend/src/auth/require-db-user.ts (NEW — parallels require-user.ts)

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

```typescript
// backend/src/auth/access-control-allowlist.ts — boot-time gate
//
// Mirrors the JWT_NO_DB_ALLOWLIST pattern in require-onboarded.ts.
// onRoute collects every route that uses requireCampaignMember /
// requireWorldCreator in its preHandler array; onReady asserts none of
// them have `config.auth: 'public'`. Catches the misconfig where a
// contributor wires access-control onto a public route and the runtime
// would silently 500 only when traffic arrives.

import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'

const ACCESS_CONTROL_FN_NAMES = new Set(['requireCampaignMember', 'requireWorldCreator'])

const impl: FastifyPluginAsync = async (app) => {
  const observed: { method: string; url: string }[] = []
  app.addHook('onRoute', (routeOptions) => {
    const handlers = routeOptions.preHandler
    const arr = Array.isArray(handlers) ? handlers : handlers ? [handlers] : []
    const usesAccessControl = arr.some((h) => ACCESS_CONTROL_FN_NAMES.has(h.name))
    if (!usesAccessControl) return
    const cfg = routeOptions.config as { auth?: string } | undefined
    if (cfg?.auth === 'public' || cfg?.auth === 'jwt-no-db') {
      const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method]
      for (const m of methods) {
        if (m.toUpperCase() === 'HEAD') continue
        observed.push({ method: m, url: routeOptions.url })
      }
    }
  })
  // eslint-disable-next-line @typescript-eslint/require-await
  app.addHook('onReady', async () => {
    if (observed.length > 0) {
      throw new Error(
        `access-control-allowlist: route(s) with requireCampaignMember/requireWorldCreator must NOT set ` +
          `config.auth to 'public' or 'jwt-no-db' — that short-circuits requireOnboarded and leaves ` +
          `request.dbUser undefined. Offenders: ${observed.map((o) => `${o.method} ${o.url}`).join(', ')}`,
      )
    }
  })
}

export const accessControlAllowlist = fp(impl, {
  fastify: '5.x',
  name: 'mythrun-access-control-allowlist',
})
```

```typescript
// backend/src/auth/require-onboarded.ts — modified body of the preHandler hook

const row = await users.getByCognitoSubWithTimeout(
  request.user.sub,
  REQUIRE_ONBOARDED_LOOKUP_TIMEOUT_MS,
)
if (!row) {
  return reply.code(403).send({ code: 'username_required' })
}
if (row.suspendedAt !== null) {
  // Closes the up-to-1h ban-lag window between admin-suspending a user
  // and their access token expiring. Source spec §6 line 284 commits
  // MYT-39 to this. Banned users see {code: 'account_suspended'} on
  // every protected request until they're reactivated.
  return reply.code(403).send({ code: 'account_suspended' })
}
// Frozen so a buggy / malicious downstream hook can't swap fields in place.
// TS `readonly` is structural-only; runtime freeze is the actual guarantee.
request.dbUser = Object.freeze(row)
```

`request.dbUser` is **never attached on `auth: 'jwt-no-db'` routes** — those routes (currently `POST /api/users/register` and `GET /api/users/check-username`) intentionally run before a users row exists. The `requireOnboarded` preHandler short-circuits with `if (cfg === 'public' || cfg === 'jwt-no-db') return` before the lookup, so `request.dbUser` is `undefined` on those paths. The boot-time `accessControlAllowlist` plugin (above) is the gate that prevents access-control middleware from being wired onto those routes.

```typescript
// backend/src/auth/require-db-user.ts (NEW — parallels require-user.ts)

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

```typescript
// backend/src/auth/require-onboarded.ts — modified body of the preHandler hook

const row = await users.getByCognitoSubWithTimeout(
  request.user.sub,
  REQUIRE_ONBOARDED_LOOKUP_TIMEOUT_MS,
)
if (!row) {
  return reply.code(403).send({ code: 'username_required' })
}
// Frozen so a buggy / malicious downstream hook can't swap fields in place.
// TS `readonly` is structural-only; runtime freeze is the actual guarantee.
request.dbUser = Object.freeze(row)
```

`request.dbUser` is **never attached on `auth: 'jwt-no-db'` routes** — those routes (currently `POST /api/users/register` and `GET /api/users/check-username`) intentionally run before a users row exists. The `requireOnboarded` preHandler short-circuits with `if (cfg === 'public' || cfg === 'jwt-no-db') return` before the lookup, so `request.dbUser` is `undefined` on those paths and `requireDbUser()` throws. Access-control middleware MUST NOT be wired onto a `jwt-no-db` route; the JWT_NO_DB_ALLOWLIST in `require-onboarded.ts` is the boot-time gate against accidentally landing one there.

The factories are **not `fastify-plugin`-wrapped**. They return per-route `preHandler` hook handlers, not Fastify plugins, and per-route preHandler arrays don't go through encapsulation in the first place. (Contrast `jwt-plugin.ts:134-137`, which is wrapped because it adds an `onRequest` hook + decorator at the parent scope.)

### 4.2 Param-name convention

The middleware reads `:campaignId` and `:worldId` by name from `request.params`. This convention is load-bearing — every route under `/api/campaigns/:campaignId/*` or `/api/worlds/:worldId/*` honors it.

For routes whose URL doesn't directly carry `:campaignId` (e.g. `/api/sessions/:id/ws-ticket`, where `:id` is a sessionId), the route file uses a small upstream `preHandler` that resolves the URL param to a campaignId and splices it into `request.params.campaignId`. See §6.

### 4.3 Error semantics

| Condition | Status |
|---|---|
| Caller's account is suspended (`users.suspended_at IS NOT NULL`) | 403 `{code: "account_suspended"}` (from `requireOnboarded`) |
| Caller is not a member of the campaign | 403 `{code: "not_campaign_member"}` |
| Caller is a member but doesn't satisfy the role gate (e.g. `'owner'`) | 403 `{code: "not_campaign_owner"}` |
| World does not exist | 404 `{code: "world_not_found"}` |
| World exists but caller is not the creator | 403 `{code: "not_world_creator"}` |
| Caller's `request.dbUser` is missing | thrown Error → Fastify 500 + structured log (boot-time misconfig if `accessControlAllowlist` somehow missed it; otherwise impossible) |
| Route has no `:campaignId` and no `request.resolvedCampaignId` | thrown Error → Fastify 500 (boot-time misconfig) |

The error-shape matches the codebase-wide `{code: '<snake_case>'}` convention used by `routes/users.ts`, `routes/invites.ts`, `routes/billing.ts`. The JWT plugin's existing `{error: '...'}` 401 responses are normalized in the same commit (e.g. `Missing Bearer token` → `{code: 'unauthenticated'}`).

Boot-time misconfig: the `accessControlAllowlist` plugin (§3 file layout) flags any access-control-guarded route whose `config.auth` is `'public'` or `'jwt-no-db'` at `app.ready()` time, throwing a clear error before the app accepts traffic. The runtime "thrown Error → 500" path is a backstop for that boot-time gate; it should never fire in normal operation.

### 4.4 Request decoration

`requireCampaignMember` attaches `request.campaignMember = member`; `requireWorldCreator` attaches `request.world = world`. Handlers that need the row don't re-query.

Type augmentation in `auth/types.ts` — also consolidates the stale `FastifyContextConfig.auth` declaration from `types/fastify.d.ts` (deleted in this issue):

```typescript
declare module 'fastify' {
  interface FastifyRequest {
    dbUser?: User                 // attached by requireOnboarded; frozen
    campaignMember?: CampaignMember  // attached by requireCampaignMember
    world?: World                 // attached by requireWorldCreator
    resolvedCampaignId?: string   // attached by upstream resolvers (e.g. session→campaign)
  }
  interface FastifyContextConfig {
    // Consolidated declaration. The stale 'jwt' literal from
    // backend/src/types/fastify.d.ts is deleted in this commit.
    auth?: 'public' | 'jwt-no-db'
  }
}
```

## 5. WS ticket helpers

### 5.1 Shape

Framework-agnostic. Both the mint route (Fastify) and the future WS upgrade handler (raw HTTP) call them directly.

```typescript
// backend/src/auth/ws-ticket.ts

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
  readonly expiresAt: string  // ISO-8601 — see §5.4 for authority/skew notes
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
  // ioredis 5.x ships a typed redis.getdel; preferred over redis.call('GETDEL', ...)
  // because it returns Promise<string | null> directly without an `unknown` cast.
  const value = await deps.redis.getdel(`${deps.keyPrefix}${ticket}`)
  if (value === null) return null
  if (typeof value !== 'string') {
    // Buffer mode is incompatible with this string contract. The shared
    // realtime client today is string-mode (backend/src/redis/client.ts);
    // if a future client config enables Buffer mode, this branch trips
    // every consume. Belt-and-suspenders for the regression.
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

### 5.2 Why GETDEL

`GETDEL` (Redis 6.2+) is atomic: read-and-delete in a single command, single round-trip. ElastiCache for Redis supports it. A non-atomic `GET` then `DEL` would race — two concurrent consumers could both read before either deleted, both succeed, and the ticket would be used twice. Lua-wrapped GET+DEL has the same atomicity but adds round-trip + scripting overhead with no benefit over native `GETDEL`.

### 5.3 Nonce shape

`crypto.randomBytes(32)` → 32 bytes → 64 hex chars. 256 bits of entropy. Brute-forcing the keyspace before TTL expires is not credible.

The load-bearing security property is *single-use* (`GETDEL` atomicity), not nonce entropy alone. Even a leaked-via-side-channel ticket (CDN log, browser extension, screen-share) is bounded by single-use semantics: the legitimate client typically consumes within ~1–2 seconds of mint, after which the ticket is gone.

### 5.4 Payload validation on consume

A corrupt or unparseable payload returns `null` (treated as a miss). Catches a serializer regression early — the WS server doesn't blindly trust whatever it pulls from Redis.

**Consumer contract for `null`:** consumers (the future WS server) treat `null` as "reject the upgrade with no further reasoning." The four causes — ticket never existed, ticket already consumed (single-use), ticket TTL expired, payload corrupt — are deliberately indistinguishable by design. Consumers MUST NOT add telemetry or branching logic that tries to distinguish them.

**Redis errors are NOT `null`.** A Redis transient (`MaxRetriesPerRequestError`, connection-refused during failover) is rejected as a Promise rejection from `getdel`, surfaced to the upgrade handler as a 5xx — operationally distinguishable from a `null` 401. The WS server SHOULD respond with 503 + a backoff hint on Redis errors and 401 on `null`; the SPA's reconnect logic differentiates the two.

**`expiresAt` is informational, not authoritative.** It's computed locally at mint via `Date.now() + WS_TICKET_TTL_SECONDS * 1000`, which runs *after* the `SET ... EX 30` round-trip — so the returned `expiresAt` is biased later than the Redis-side TTL by network round-trip and event-loop scheduling, *plus* up to a few seconds under cross-host clock skew (Fargate task and ElastiCache nodes synchronize independently to AWS Time Sync; observed cross-host skew is typically sub-second but can spike under chrony pathologies). Clients MUST treat the value as a soft upper bound and rely on the WS upgrade's accept/reject as the ground truth.

**Forward-compat semantics:** `consumeWsTicket` validates only the required keys (`userId`, `sessionId`, `campaignId`). Extra fields in a future payload (e.g. when the WS server starts caring about a `clientVersion` field) parse cleanly. Removing or renaming a required field is a wire break.

### 5.5 Which Redis client and key prefix

**Client:** `redisRealtime`. Tickets are ephemeral and tied to the realtime connection layer. Today `redisRealtime` and `redisBatch` resolve to the same single-cluster ElastiCache instance (per `backend/src/config/env.ts:27-30`). The pin is forward-looking: when the split lands, the ws-ticket store MUST live on whichever cluster the WS upgrade handler will read from — otherwise `consumeWsTicket` becomes a cross-cluster lookup and 100% misses. Tickets MUST NOT live on `redisBatch` for the additional reason that BullMQ uses `bull:` namespace conventions; future BullMQ upgrades adding `bull:ws:` would not collide with `ws:ticket:` only by coincidence.

**Key prefix:** `${MYTHRUN_ENV}:${REGION_PREFIX}:ws:ticket:` (e.g. `production:use1:ws:ticket:`, `staging:use1:ws:ticket:`). Per `docs/specs/2026-04-10-infrastructure-devops.md` §"Region prefix on Redis keys", staging and production share a single ElastiCache replication group; env+region prefixing prevents cross-environment key namespace overlap. MYT-39 is the first code consumer of this convention. The prefix is derived in `backend/src/config/env.ts` from existing `REGION_PREFIX` (already wired in `infra/modules/serving/main.tf:128`) and a new `MYTHRUN_ENV` env var (`production` | `staging` | `development`), exposed as `env.redisKeyPrefix` and threaded through `WsTicketDeps.keyPrefix`. Reserves the `ws:` sub-namespace for WebSocket-related state.

**Availability posture:** the realtime cluster today is `automatic_failover_enabled = false`, single-AZ, `num_cache_clusters = 1` (per `infra/modules/data/main.tf`). A node failure makes ticket mint + consume both unavailable until manual intervention. This matches the rest of the realtime layer's availability profile; HA for ticket store is not a launch goal. Side benefit: at the moment of forced cluster replacement, leaked tickets vanish along with the keyspace, collapsing any residual leak window.

### 5.6 Mint-time leakage

If `mintWsTicket` succeeds in Redis but the HTTP 200 response is lost (network partition, ALB blip), the client retries; a second mint creates a second ticket; the first ticket sits in Redis until TTL. Two consequences: (a) up to 2× per-user ticket count in the cluster — benign at our load; (b) a network attacker who intercepted the lost TLS-protected response would have 30s to use the leaked ticket — bounded by the same single-use property that bounds any leak. No mitigation needed; explicitly documenting so future readers don't assume the design is missing it.

## 6. The ws-ticket route

```typescript
// backend/src/routes/sessions.ts

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
  readonly redisKeyPrefix: string  // e.g. "production:use1:ws:ticket:" — derived in env.ts
}

export const sessionsRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)

  app.post<{ Params: { id: string } }>(
    '/api/sessions/:id/ws-ticket',
    {
      config: {
        // Per-USER mint cap, not per-IP — a CG-NAT pool would otherwise
        // share the cap. Matches the per-route pattern in routes/users.ts.
        // The global @fastify/rate-limit at app.ts:128 is registered with
        // `global: false`, so without this opt-in the route would be
        // uncapped. MYT-45 swaps the in-memory store for Redis-backed.
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => requireDbUser(req).id,
        },
      },
      preHandler: [
        async (request, reply) => {
          const session = await repo.sessions.getById(request.params.id)
          if (!session) return reply.code(404).send({ code: 'session_not_found' })
          // Use a typed augmentation field rather than mutating request.params.
          // The `Params: { id: string }` route declaration becomes a partial
          // truth at the type level if we splice; OpenAPI/route-introspection
          // tools that read the typed shape would not see `campaignId`.
          // (Note: Fastify v5 actually populates request.params during routing
          // before any preHandler/preValidation, so a splice would NOT trip
          // schema validation — but it would still confuse type-introspection.)
          request.resolvedCampaignId = session.campaignId
        },
        requireCampaignMember(repo),
      ],
    },
    async (request) => {
      const sessionId = request.params.id
      const dbUser = requireDbUser(request)
      const campaignId = request.resolvedCampaignId!  // set by upstream preHandler
      const { ticket, expiresAt } = await mintWsTicket(
        { redis: opts.redisRealtime, keyPrefix: opts.redisKeyPrefix },
        { userId: dbUser.id, sessionId, campaignId },
      )
      return { ticket, expiresAt }
    },
  )
}
```

### 6.1 Two-step preHandler chain

Step 1 resolves the URL's `:id` (a sessionId) to its parent campaignId via the typed `request.resolvedCampaignId` augmentation field. Step 2 is `requireCampaignMember`, which prefers `request.resolvedCampaignId` and falls back to `request.params.campaignId` for routes whose URL carries the id directly.

The earlier draft of this section spliced `campaignId` directly into `request.params` and justified the augmentation-field choice by claiming the splice would break schema validators. That justification was technically wrong: Fastify v5 populates `request.params` during routing (before any hook fires) and route-level JSON-schema validation runs in `preValidation` *before* `preHandler` — so a splice in `preHandler` is invisible to the validator. The augmentation field is still the right call for a different reason: the route's `Params: { id: string }` typed shape becomes a partial truth, and OpenAPI or route-introspection tools that read the typed shape would never see `campaignId`. Named augmentation makes the data flow explicit.

A resolver-lambda alternative was considered (`requireCampaignMember(repo, { resolveCampaignId: req => fetchSession(req.params.id).campaignId })`). It keeps everything inside the middleware factory at the cost of bundling an unrelated DB-fetch contract into the auth middleware. For Mythrun's scale and the small number of routes that need cross-resource resolution, the upstream-preHandler shape is cleaner.

### 6.2 Status codes

| Condition | Status |
|---|---|
| Session does not exist | 404 `{code: "session_not_found"}` |
| Session exists but caller is not a member of its parent campaign | 403 `{code: "not_campaign_member"}` |
| Authenticated, member of the campaign | 200 `{ticket, expiresAt}` |

The 404/403 split here is fine: the session URL is a public-shaped endpoint, and a non-existent session's existence is no more sensitive than a campaign's. Sessions and campaigns use UUIDv7 — non-enumerable in practice (74 bits of per-id randomness on top of a millisecond timestamp prefix; brute-force is not credible) — so the existence-leak via the split is keyspace-protected. The trade would need re-evaluation only if any URL-bound resource ever uses a non-random id.

### 6.3 Rate limiting

The route ships with a per-user cap of `30/min` via `config.rateLimit` (visible in §6's code). The global `@fastify/rate-limit` registration at `backend/src/app.ts:128-132` is `global: false`, so without the per-route opt-in this endpoint would be uncapped — an authenticated user could mint tickets in a tight loop against Redis + Postgres. MYT-45 swaps the in-memory rate-limit store for Redis-backed (so caps survive multi-task deploys); the per-route cap stays.

### 6.4 Membership race on consume

If a user is removed from `campaign_members` between `requireCampaignMember`'s membership check and `mintWsTicket`, the ticket is issued anyway and grants ~30s of WS-connect window. Wrapping the check + mint in a transaction is overkill — the WS server MUST re-validate membership on the upgrade handler. The ticket payload carries `campaignId` so the re-validation is a single `repo.campaigns.getMembership(payload.campaignId, payload.userId)` query, no `sessions.getById` lookup needed. See §10 (Out of Scope) for the load-bearing assertion.

### 6.5 Transient 401 on consume-by-attacker

If a ticket leaks during the 30s window and an attacker consumes it before the legitimate WS connect, the legit client's WS upgrade returns 401. The SPA re-mints; retry succeeds. End-user observes a 1–2-second blip. The WS server MUST treat 401-on-upgrade as "re-mint and retry" rather than a hard error.

## 7. Bypass-mode parity

`requireOnboarded` runs in both real and bypass modes (it's not auth-mode-specific). In bypass, `request.user.sub === 'bypass:dev-1'`, and `requireOnboarded` looks up that row in the users table. **Precondition:** a `bypass:dev-1` users row must exist in the local dev seed, `suspended_at IS NULL`, with at least one campaign-member row giving it `owner` access on a dev campaign with at least one session — otherwise `pnpm dev` against any access-controlled route 403s.

The implementation plan checks the existing dev-seed location (the bead lands the seed addition in whichever file the codebase already uses for dev-data bootstrap; if no such file exists, the plan creates `backend/src/dev/seed.ts` and wires it into the `pnpm dev` startup). At bypass-plugin boot, a one-shot lookup logs a structured warning if the `bypass:dev-1` row is missing — closes the onboarding-cliff hazard for the next contributor who pulls main and finds protected routes 403'ing.

We don't need bypass-mode parity for the production deploy (bypass-plugin's existing layers reject staging/prod activation); we need it for `pnpm dev` to keep working when MYT-39 ships.

## 8. Testing

Three test files. Match existing codebase conventions (integration-style with built `app`, `ioredis-mock` for the unit Redis tests, mocked Postgres at the repo seam).

### 8.1 `auth/__tests__/access-control.test.ts`

```
requireCampaignMember
  - member with no role gate: passes, attaches request.campaignMember
  - member with role gate matching ('owner'): passes
  - member with role gate mismatching: 403 {code: 'not_campaign_owner'}
  - non-member: 403 {code: 'not_campaign_member'}
  - member with invite_accepted=false: 403 {code: 'not_campaign_member'}
  - resolvedCampaignId path (no :campaignId in URL): passes when set, throws when both missing
  - missing request.dbUser: throws (caught as 500)
  - handler reads request.campaignMember after the chain (regression test for the chain wiring)
  - request.dbUser is frozen (Object.isFrozen returns true)

requireWorldCreator
  - creator: passes, attaches request.world
  - non-creator: 403 {code: 'not_world_creator'}
  - world doesn't exist: 404 {code: 'world_not_found'}
  - missing :worldId: throws
  - missing request.dbUser: throws

requireOnboarded (modifications)
  - suspended_at IS NULL: attaches request.dbUser (frozen)
  - suspended_at IS NOT NULL: 403 {code: 'account_suspended'}, request.dbUser undefined
  - jwt-no-db route: short-circuits, request.dbUser undefined

accessControlAllowlist
  - route with requireCampaignMember + auth: 'public' → app.ready() throws
  - route with requireWorldCreator + auth: 'jwt-no-db' → app.ready() throws
  - route with requireCampaignMember + default auth → app.ready() succeeds
  - route without access-control middleware + auth: 'public' → app.ready() succeeds (unrelated)
```

### 8.2 `auth/__tests__/ws-ticket.test.ts`

```
mintWsTicket
  - returns 64-char hex string
  - stores key ${prefix}<nonce> with payload JSON (prefix from WsTicketDeps.keyPrefix)
  - PTTL on the key is in (27000, 30000] immediately after mint (loose bound for slow CI)
  - returns expiresAt ~30s in future (ISO-8601 parseable)
  - payload includes campaignId in addition to userId, sessionId

consumeWsTicket
  - returns payload, key is gone after
  - N parallel consumers, exactly one returns the payload (others return null)
  - nonexistent ticket: null
  - corrupt JSON payload: null
  - payload with extra fields (forward-compat): returns parsed payload (extras ignored)
  - payload missing userId / sessionId / campaignId: null
  - Redis error during getdel: rejects (NOT silently null)
```

### 8.3 `routes/__tests__/sessions.test.ts`

Integration tests: real Fastify, `ioredis-mock` (added as devDependency), mocked Postgres at the repo seam.

```
POST /api/sessions/:id/ws-ticket
  - unauthenticated: 401 {code: 'unauthenticated'}
  - authenticated, no users row: 403 {code: 'username_required'} (from requireOnboarded)
  - authenticated, account suspended: 403 {code: 'account_suspended'}
  - authenticated, session does not exist: 404 {code: 'session_not_found'}
  - authenticated, session exists, not a member of its campaign: 403 {code: 'not_campaign_member'}
  - authenticated, member: 200 {ticket, expiresAt}; ticket fetchable from Redis with env+region prefix
  - authenticated, member: ticket payload matches {userId, sessionId, campaignId} exactly
  - authenticated, member: expiresAt is ISO-8601 parseable
  - rate limit: 31st request in 60s window from same user returns 429 (per-user keying, not per-IP)
  - bypass mode happy path
```

### 8.4 `app.ts` integration

```
boot-time access-control allowlist
  - registering a route with requireCampaignMember + config.auth: 'public' → app.ready() throws with offender list
  - registering sessionsRoutes (the canonical good shape) → app.ready() succeeds
```

## 9. Source-spec updates

The MYT-39 implementation commit also updates four source-of-truth specs that currently document the old `POST /api/ws/ticket` endpoint or other contracts that this design changes. Atomic single-commit edits keep the source-of-truth and the implementation consistent.

### 9.1 `docs/specs/2026-04-13-auth-users.md`

- **§7 — Ticket-Based WebSocket Auth**
  - Replace TTL `10` → `30`.
  - Replace endpoint `POST /api/ws/ticket` → `POST /api/sessions/:id/ws-ticket`.
  - Replace payload `{userId, username, displayName}` → `{userId, sessionId, campaignId}`.
  - Replace WS connect URL `wss://api.mythrun.com/ws/session/:campaignId?ticket=...` → `wss://api.mythrun.com/ws/session/:sessionId?ticket=...` (the WS server connects via sessionId, not campaignId — the ticket payload carries the campaignId for the membership re-check).
  - Add: "`expiresAt` returned to the client is informational. The WS upgrade is the authority."
  - Keep the "Why Not JWT in Query Params" subsection unchanged.
- **§6 — Token Lifecycle**
  - The "future `loadCurrentUser` plugin (MYT-39)" correction note (line 284): mark complete. `requireOnboarded` now enforces `suspended_at`.
- **§8 — Ownership and Access Control**
  - **Illustrative code:**
    - `request.user.id` → `request.dbUser.id`. Note that `requireOnboarded` is the producer of `request.dbUser`.
    - `repo.campaignMembers.get(...)` → `repo.campaigns.getMembership(...)` (the actual API per `backend/src/repo/campaigns.ts:95`).
    - Replace standalone `requireCampaignOwner` with the `requireCampaignMember(repo, role?)` factory shape (`requireCampaignOwner` collapses to `requireCampaignMember(repo, 'owner')`).
    - Replace `{error: '...'}` responses with `{code: '...'}` to match codebase convention.
  - **Text/coverage:**
    - "preHandler hook for routes under `/api/campaigns/:campaignId/*` and `/api/prep/:campaignId/*`" — confirm `/api/prep/...` reuses `requireCampaignMember`. If yes, no change. If different access model, add a §8 subsection.
    - World Access Control subsection: add a launch-scope note: "At launch only `requireWorldCreator` is wired; the broader public-or-campaign-referenced matrix lands when world-sharing flows ship."
    - Access-control matrix table: confirm the role enum is `owner | player` (no DM, no spectator); Linear issue text was wrong, not §8.
    - **New:** add a "Path-param naming convention" subsection — campaign-rooted routes use `:campaignId`, world-rooted routes use `:worldId`, session routes use `:id` (sessionId) and resolve campaignId via an upstream preHandler. This is the canonical anchor for the convention; MYT-40+ implementers who write new routes will find it here.
- **§10 — API Routes**
  - Auth-routes table: replace `POST /api/ws/ticket` row with `POST /api/sessions/:id/ws-ticket`.
  - Add a "TODO MYT-40: param rename `:id` → `:campaignId`" note for the existing campaign-membership routes (`POST /api/campaigns/:id/invites` etc.). Renaming source-tree-only; not wire-breaking.

### 9.2 `docs/specs/2026-04-13-multiplayer-session-runtime.md`

- §"Connection flow" (around lines 127–128): replace `POST /api/ws/ticket` and the `wss://api.mythrun.com/ws/session/:campaignId?ticket=<nonce>` URL shape per §9.1 above.
- §"Reconnection protocol" step 4a (around line 494): same endpoint shape replacement.

### 9.3 `docs/specs/2026-04-06-production-architecture-overview.md`

- §5 WebSocket Protocol (around lines 585–601):
  - Replace endpoint shape and TTL per §9.1.
  - Replace `repo.campaignMembers.get(...)` with `repo.campaigns.getMembership(...)`.

### 9.4 `docs/specs/2026-04-10-ux-design.md`

- §"Auth & Identity" API surface (around line 622): replace `POST /api/ws/ticket` with `POST /api/sessions/:id/ws-ticket`.

### 9.5 Backend code (in same commit)

- `backend/src/auth/jwt-plugin.ts` lines 87, 91, 105, 111, 115: replace `{error: 'Missing Bearer token' | 'Empty Bearer token' | 'Invalid token'}` with `{code: 'unauthenticated'}`. Single shape across the auth chain.

## 10. Out of scope (and load-bearing assertions for the WS server)

**Out of scope for this issue:**
- The actual WebSocket server. Lives in Session Runtime milestone. We ship `consumeWsTicket` for it to use; we do not ship a WS upgrade handler.
- Other session/campaign routes from spec §10 — e.g., `/api/campaigns/:id/...`, `/api/sessions/:id/...` (other than the ws-ticket mint). Those land in MYT-40+ and reuse `requireCampaignMember`. MYT-40+ also renames `:id` → `:campaignId` on the existing campaign-rooted routes (see §9).
- World collaborators, public-world flows, fork flows — no schema, no routes. Future. The full `requireWorldAccess` matrix is reserved for that future work; this issue ships only `requireWorldCreator`.
- Per-tier role expansion (DM/spectator). `owner | player` is the launch model. The schema CHECK constraint pins this.
- ALB access logs and `Referrer-Policy` SPA header for ticket-leakage hardening. ALB access logs are not enabled today (`infra/environments/shared/main.tf`); the SPA header is a frontend concern. Both belong in the WS-server design.
- Per-route rate-limit *store* upgrade. The cap is enforced today (in-memory store). MYT-45 swaps to Redis-backed.

**Load-bearing assertions the WS server MUST honor:**
1. **Re-validate `campaign_members` on upgrade.** `consumeWsTicket` returning a payload only proves that *some* member of the campaign minted the ticket within the last 30s. It does NOT prove membership at upgrade time. The WS server's upgrade handler MUST re-query `repo.campaigns.getMembership(payload.campaignId, payload.userId)` and reject if absent. The ticket payload carries `campaignId` directly so this is a single query, no `sessions.getById` lookup needed.
2. **Distinguish `null` from Redis errors.** `null` → 401 (ticket invalid). Redis error (Promise rejection from `getdel`) → 503 (transient store unavailability). The SPA's reconnect logic differentiates: 401 → re-mint and retry; 503 → backoff and retry. Don't collapse them.
3. **Treat `expiresAt` as informational only.** The WS upgrade's accept/reject is the ground truth.
4. **Surface 401-on-upgrade as a re-mintable error.** A leaked-and-consumed ticket manifests as 401; the SPA re-mints. See §6.5.
5. **Don't try to distinguish causes of `null`.** Ticket never existed / already consumed / TTL expired / payload corrupt are deliberately indistinguishable. Don't add telemetry that branches on the cause.

## 11. Estimate

~0.5 working day. Final Auth issue. Closes the Platform-milestone Auth track.
