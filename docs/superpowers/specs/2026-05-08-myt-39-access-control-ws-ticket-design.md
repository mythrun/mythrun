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
| `requireWorldCreator` (renamed from `requireWorldAccess`) | Creator-only (`world.created_by === user.id`) | Source spec §8.6's full matrix (public + private-via-campaign + collaborators) is deferred. Renamed to `requireWorldCreator` to make the actual check explicit and to leave the name `requireWorldAccess` available for the broader matrix when world-sharing flows ship. |
| Error response shape | `{code: '<snake_case>'}` matching `routes/invites.ts` / `routes/users.ts` / `routes/billing.ts` | Codebase-wide convention. The Linear issue and source spec §8 illustrative code used `{error: '...'}`; that drifts from every existing 4xx in the API. |
| Cognito-sub → user.id resolution | Extend `requireOnboarded` to attach `request.dbUser`; access-control reads it | Source spec §8 illustrative code referenced `request.user.id` — but `AuthUser.sub` is the Cognito sub, not the DB id. Either access-control re-fetches (extra DB hit per protected request) or `requireOnboarded` exposes what it already fetched. We pick the latter. |

The source spec (`docs/specs/2026-04-13-auth-users.md`) §7 will be updated to match this contract in the same commit as the MYT-39 implementation. §8 is mostly already aligned (uses 403); the body example referencing `request.user.id` will be tweaked to `request.dbUser.id`, and the role enum reference (`'owner'`) is already correct.

## 3. File layout

```
backend/src/auth/
  access-control.ts        # NEW — requireCampaignMember, requireWorldCreator factories
  ws-ticket.ts             # NEW — mintWsTicket, consumeWsTicket (Redis helpers)
  require-onboarded.ts     # MODIFY — attach request.dbUser (frozen)
  require-db-user.ts       # NEW — requireDbUser(request): User helper, parallels require-user.ts
  types.ts                 # MODIFY — add request.dbUser / .campaignMember / .world / .resolvedCampaignId augmentation; consolidate FastifyContextConfig.auth
  __tests__/
    access-control.test.ts # NEW
    ws-ticket.test.ts      # NEW
backend/src/types/
  fastify.d.ts             # MODIFY — delete duplicate FastifyContextConfig.auth declaration (consolidated into auth/types.ts)
backend/src/routes/
  sessions.ts              # NEW — POST /api/sessions/:id/ws-ticket (only this route in scope)
  __tests__/
    sessions.test.ts       # NEW
backend/src/app.ts         # MODIFY — register sessionsRoutes, pass redisRealtime
```

Three new code files in `auth/`, one new route file, four modified files. Ws-ticket helpers live next to the auth concerns rather than in a new top-level `ws/` folder — there's no other WS code yet, and a single-file folder is noise.

**Type-augmentation cleanup:** `backend/src/types/fastify.d.ts` currently declares `FastifyContextConfig.auth?: 'public' | 'jwt'` and `backend/src/auth/types.ts` declares `auth?: 'public' | 'jwt-no-db'`. TypeScript declaration merging unions these to `'public' | 'jwt' | 'jwt-no-db'`. The `'jwt'` literal is stale (no code uses it; default-auth omits the field). MYT-39 consolidates both declarations into `auth/types.ts` and deletes `types/fastify.d.ts`'s duplicate, so the `auth?` discriminator has one canonical home.

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

export function requireCampaignMember(
  repo: Repo,
  role?: CampaignMemberRole,
): preHandlerHookHandler {
  return async (request, reply) => {
    const dbUser = requireDbUser(request)
    // Defense-in-depth cross-check: dbUser must correspond to the
    // currently-authenticated principal. If a future preHandler swap-out
    // mutates dbUser, the membership lookup would resolve to a different
    // user; this guard stops that.
    if (request.user && request.user.sub !== dbUser.cognitoSub) {
      throw new Error('requireCampaignMember: request.dbUser does not match request.user')
    }
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
| Caller is not a member of the campaign | 403 `{code: "not_campaign_member"}` |
| Caller is a member but doesn't satisfy the role gate (e.g. `'owner'`) | 403 `{code: "not_campaign_owner"}` |
| World does not exist | 404 `{code: "world_not_found"}` |
| World exists but caller is not the creator | 403 `{code: "not_world_creator"}` |
| Caller's `request.dbUser` is missing (boot-time misconfig) | thrown Error → Fastify 500 + structured log |
| Route has no `:campaignId` and no `request.resolvedCampaignId` (boot-time misconfig) | thrown Error → Fastify 500 + structured log |
| `request.dbUser` does not match `request.user` (defense-in-depth tripwire) | thrown Error → Fastify 500 + structured log |

The error-shape matches the codebase-wide `{code: '<snake_case>'}` convention used by `routes/users.ts`, `routes/invites.ts`, `routes/billing.ts`. Boot-time misconfig surfaces as a thrown Error rather than a clean 4xx — operators see a clear message in CloudWatch on the very first protected request. Once we have E2E tests in CI, those throws become CI failures and the 500 path becomes unreachable in normal operation.

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
const REDIS_KEY_PREFIX = 'ws:ticket:'

export interface WsTicketPayload {
  readonly userId: string
  readonly sessionId: string
}

export interface MintedTicket {
  readonly ticket: string
  readonly expiresAt: string  // ISO-8601
}

export async function mintWsTicket(
  redis: Redis,
  payload: WsTicketPayload,
): Promise<MintedTicket> {
  const ticket = randomBytes(32).toString('hex')
  const value = JSON.stringify(payload)
  await redis.set(`${REDIS_KEY_PREFIX}${ticket}`, value, 'EX', WS_TICKET_TTL_SECONDS)
  const expiresAt = new Date(Date.now() + WS_TICKET_TTL_SECONDS * 1000).toISOString()
  return { ticket, expiresAt }
}

export async function consumeWsTicket(
  redis: Redis,
  ticket: string,
): Promise<WsTicketPayload | null> {
  const value = await redis.call('GETDEL', `${REDIS_KEY_PREFIX}${ticket}`)
  if (typeof value !== 'string') return null
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
    typeof (parsed as { sessionId?: unknown }).sessionId !== 'string'
  ) {
    return null
  }
  return parsed as WsTicketPayload
}
```

### 5.2 Why GETDEL

`GETDEL` (Redis 6.2+) is atomic: read-and-delete in a single command, single round-trip. ElastiCache for Redis supports it. A non-atomic `GET` then `DEL` would race — two concurrent consumers could both read before either deleted, both succeed, and the ticket would be used twice. Lua-wrapped GET+DEL has the same atomicity but adds round-trip + scripting overhead with no benefit over native `GETDEL`.

### 5.3 Nonce shape

`crypto.randomBytes(32)` → 32 bytes → 64 hex chars. 256 bits of entropy. Brute-force the keyspace before TTL expires is not credible.

### 5.4 Payload validation on consume

A corrupt or unparseable payload returns `null` (treated as a miss). Catches a serializer regression early — the WS server doesn't blindly trust whatever it pulls from Redis.

**Consumer contract for `null`:** consumers (the future WS server) treat `null` as "reject the upgrade with no further reasoning." The four causes — ticket never existed, ticket already consumed (single-use), ticket TTL expired, payload corrupt — are deliberately indistinguishable by design. Consumers MUST NOT add telemetry or branching logic that tries to distinguish them; that surface is not security-relevant and the indistinguishability is the safety property.

**`expiresAt` is informational, not authoritative.** It's computed locally at mint via `Date.now() + WS_TICKET_TTL_SECONDS * 1000`, which runs *after* the `SET ... EX 30` round-trip — so the returned `expiresAt` is biased a few ms later than the Redis-side TTL. Clients MUST treat the value as a soft upper bound and rely on the WS upgrade's accept/reject as the ground truth. If a client races the deadline and the WS upgrade rejects (`null` from `consumeWsTicket`), the client re-mints. Rationale: server-authoritative expiry would require a `PEXPIRETIME` round-trip per mint for negligible UX gain.

### 5.5 Which Redis client

`redisRealtime`. Tickets are ephemeral and tied to the realtime connection layer.

**Today, `redisRealtime` and `redisBatch` resolve to the same single-cluster ElastiCache instance** (per `backend/src/config/env.ts:27-30` — "Prod currently has a single Redis cluster shared between realtime + batch; the two-cluster split is a future ticket"). The choice of `redisRealtime` here is forward-looking: when the split lands, the ws-ticket store MUST live on whichever cluster the WS upgrade handler will read from — otherwise `consumeWsTicket` becomes a cross-cluster lookup and 100% misses. This file is the authoritative pin.

**Availability posture:** the realtime cluster today is `automatic_failover_enabled = false`, single-AZ, `num_cache_clusters = 1` (per `infra/modules/data/main.tf`). A node failure makes ticket mint + consume both unavailable until manual intervention; this matches the rest of the realtime layer's availability profile. HA for ticket store is not a launch goal.

### 5.6 Mint-time leakage

If `mintWsTicket` succeeds in Redis but the HTTP 200 response is lost (network partition, ALB blip), the client retries; a second mint creates a second ticket; the first ticket sits in Redis until TTL. Two consequences: (a) up to 2× per-user ticket count in the cluster — benign at our load; (b) a network attacker who intercepted the lost TLS-protected response would have 30s to use the leaked ticket — bounded by the same single-use property that bounds any leak. No mitigation needed; explicitly documenting so future readers don't assume the design is missing it.

## 6. The ws-ticket route

```typescript
// backend/src/routes/sessions.ts

import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { createRepo } from '../repo/index.js'
import { requireDbUser } from '../auth/require-db-user.js'
import { requireCampaignMember } from '../auth/access-control.js'
import { mintWsTicket } from '../auth/ws-ticket.js'

interface Opts {
  readonly pool: Pool
  readonly redisRealtime: Redis
}

export const sessionsRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)

  app.post<{ Params: { id: string } }>(
    '/api/sessions/:id/ws-ticket',
    {
      config: {
        // Per-user mint cap. Matches the per-route pattern in routes/users.ts.
        // The global @fastify/rate-limit at app.ts:128 is registered with
        // `global: false`, so without this opt-in the route would be
        // uncapped. MYT-45 swaps the in-memory store for Redis-backed.
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
      preHandler: [
        async (request, reply) => {
          const session = await repo.sessions.getById(request.params.id)
          if (!session) return reply.code(404).send({ code: 'session_not_found' })
          // Use a typed augmentation field rather than mutating request.params.
          // Mutating params confuses future JSON-schema validators and
          // OpenAPI generators (which read the route's typed Params shape).
          request.resolvedCampaignId = session.campaignId
        },
        requireCampaignMember(repo),
      ],
    },
    async (request) => {
      const sessionId = request.params.id
      const userId = requireDbUser(request).id
      const { ticket, expiresAt } = await mintWsTicket(opts.redisRealtime, {
        userId,
        sessionId,
      })
      return { ticket, expiresAt }
    },
  )
}
```

### 6.1 Two-step preHandler chain

Step 1 resolves the URL's `:id` (a sessionId) to its parent campaignId via the typed `request.resolvedCampaignId` augmentation field. Step 2 is `requireCampaignMember`, which prefers `request.resolvedCampaignId` and falls back to `request.params.campaignId` for routes whose URL carries the id directly.

The earlier draft of this section spliced `campaignId` directly into `request.params`. That works in Fastify v5 (params are populated in `preValidation`, which fires before any `preHandler`), but it's a foot-gun for future readers and tools: the route's `Params: { id: string }` declaration becomes a partial truth, and JSON-schema or OpenAPI generators that read the typed shape will not see `campaignId`. The named augmentation field makes the data flow explicit.

### 6.2 Status codes

| Condition | Status |
|---|---|
| Session does not exist | 404 `{code: "session_not_found"}` |
| Session exists but caller is not a member of its parent campaign | 403 `{code: "not_campaign_member"}` |
| Authenticated, member of the campaign | 200 `{ticket, expiresAt}` |

The 404/403 split here is fine: the session URL is a public-shaped endpoint, and a non-existent session's existence is no more sensitive than a campaign's. Sessions and campaigns use UUIDv7 (122 bits of randomness, not enumerable), so the existence-leak via the split is keyspace-protected — the trade would need re-evaluation only if any URL-bound resource ever uses a non-random id.

### 6.3 Rate limiting

The route ships with a per-user cap of `30/min` via `config.rateLimit` (visible in §6's code). The global `@fastify/rate-limit` registration at `backend/src/app.ts:128-132` is `global: false`, so without the per-route opt-in this endpoint would be uncapped — an authenticated user could mint tickets in a tight loop against Redis + Postgres. MYT-45 swaps the in-memory rate-limit store for Redis-backed (so caps survive multi-task deploys); the per-route cap stays.

### 6.4 Membership race on consume

If a user is removed from `campaign_members` between `requireCampaignMember`'s membership check and `mintWsTicket`, the ticket is issued anyway and grants ~30s of WS-connect window. Wrapping the check + mint in a transaction is overkill — the WS server MUST re-validate membership on the upgrade handler (per source-spec §6's "WebSocket Token Re-validation"); see §10 (Out of Scope) for the load-bearing assertion.

### 6.5 Transient 401 on consume-by-attacker

If a ticket leaks during the 30s window and an attacker consumes it before the legitimate WS connect, the legit client's WS upgrade returns 401. The SPA re-mints; retry succeeds. End-user observes a 1–2-second blip. The WS server MUST treat 401-on-upgrade as "re-mint and retry" rather than a hard error.

## 7. Bypass-mode parity

`requireOnboarded` runs in both real and bypass modes (it's not auth-mode-specific). In bypass, `request.user.sub === 'bypass:dev-1'`, and `requireOnboarded` looks up that row in the users table. **Precondition:** a `bypass:dev-1` users row must exist in the local dev seed, with at least one campaign-member row giving it `owner` access on a dev campaign with at least one session — otherwise `pnpm dev` against any access-controlled route 403s.

If the dev seed doesn't already have this, the implementation plan adds a small seed task. We don't need bypass-mode parity for the production deploy; we need it for `pnpm dev` to keep working when MYT-39 ships.

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
  - request.dbUser does not match request.user: throws (cross-check tripwire)
  - missing request.dbUser: throws (caught as 500)
  - handler reads request.campaignMember after the chain (regression test for the chain wiring)

requireWorldCreator
  - creator: passes, attaches request.world
  - non-creator: 403 {code: 'not_world_creator'}
  - world doesn't exist: 404 {code: 'world_not_found'}
  - missing :worldId: throws
  - missing request.dbUser: throws
```

### 8.2 `auth/__tests__/ws-ticket.test.ts`

```
mintWsTicket
  - returns 64-char hex string
  - stores key ws:ticket:<nonce> with payload JSON
  - PTTL on the key is in (28000, 30000] immediately after mint (locks in EX semantics)
  - returns expiresAt ~30s in future (ISO-8601 parseable)

consumeWsTicket
  - returns payload, key is gone after
  - N parallel consumers, exactly one returns the payload (others return null)
  - nonexistent ticket: null
  - corrupt JSON payload: null
  - payload with extra fields (forward-compat): returns parsed payload
  - payload missing userId or sessionId: null
```

### 8.3 `routes/__tests__/sessions.test.ts`

Integration tests: real Fastify, real `ioredis-mock`, mocked Postgres at the repo seam.

```
POST /api/sessions/:id/ws-ticket
  - unauthenticated: 401
  - authenticated, no users row: 403 {code: 'username_required'} (from requireOnboarded)
  - authenticated, session does not exist: 404 {code: 'session_not_found'}
  - authenticated, session exists, not a member of its campaign: 403 {code: 'not_campaign_member'}
  - authenticated, member: 200 {ticket, expiresAt}; ticket fetchable from Redis
  - authenticated, member: ticket payload matches {userId, sessionId} exactly (no extra fields)
  - authenticated, member: expiresAt is ISO-8601 parseable
  - rate limit: 31st request in 60s window returns 429
  - bypass mode happy path
```

## 9. Source-spec updates

Same commit as the implementation. `docs/specs/2026-04-13-auth-users.md`:

- **§7** — replace TTL (10→30), endpoint shape (`/api/ws/ticket` → `/api/sessions/:id/ws-ticket`), payload (`{userId, username, displayName}` → `{userId, sessionId}`). Keep the "Why Not JWT in Query Params" subsection unchanged. Add a one-line note clarifying that `expiresAt` returned to the client is informational; the WS upgrade is the authority.
- **§8 — illustrative code:**
  - Change `request.user.id` → `request.dbUser.id`. Note that `requireOnboarded` is the producer of `request.dbUser`.
  - Replace the standalone `requireCampaignOwner` function with the `requireCampaignMember(repo, role?)` factory shape — `requireCampaignOwner` collapses to `requireCampaignMember(repo, 'owner')`.
  - Update the illustrative error responses from `{error: '...'}` to `{code: '...'}` to match the codebase convention.
- **§8 — text/coverage:**
  - The "preHandler hook for routes under `/api/campaigns/:campaignId/*` and `/api/prep/:campaignId/*`" sentence: confirm `/api/prep/...` will reuse `requireCampaignMember`. If yes, no change. If prep routes have a different access model, add a §8 subsection.
  - §8.6 (World Access Control) — add a launch-scope note: "At launch only `requireWorldCreator` is wired; the broader public-or-campaign-referenced matrix lands when world-sharing flows ship."
  - §8 access-control matrix table — confirm the role enum is `owner | player` (no DM, no spectator); the Linear issue text was wrong, not §8.
- **§10 — auth-routes table:**
  - Replace `POST /api/ws/ticket` row with `POST /api/sessions/:id/ws-ticket`.
  - Path-param convention: existing campaign-membership routes (`POST /api/campaigns/:id/invites`, etc.) use `:id`. The new convention introduced by this design is `:campaignId` for campaign-rooted routes — but renaming the existing routes is a breaking-on-the-source-tree change, not a wire-breaking change. Defer the rename to MYT-40+ when those routes adopt `requireCampaignMember`; flag in §10 with a "TODO MYT-40: param rename `:id`→`:campaignId`" note so the rename isn't lost.

The source-spec edits land in the **same commit** as the MYT-39 implementation (not the same PR — same commit) so the design contract and the source-of-truth spec are atomically consistent.

## 10. Out of scope (and load-bearing assertions for the WS server)

**Out of scope for this issue:**
- The actual WebSocket server. Lives in Session Runtime milestone. We ship `consumeWsTicket` for it to use; we do not ship a WS upgrade handler.
- Other session/campaign routes from spec §10 — e.g., `/api/campaigns/:id/...`, `/api/sessions/:id/...` (other than the ws-ticket mint). Those land in MYT-40+ and reuse `requireCampaignMember`. MYT-40+ also renames `:id` → `:campaignId` on the existing campaign-rooted routes (see §9).
- World collaborators, public-world flows, fork flows — no schema, no routes. Future. The full `requireWorldAccess` matrix is reserved for that future work; this issue ships only `requireWorldCreator`.
- Per-tier role expansion (DM/spectator). `owner | player` is the launch model. The schema CHECK constraint pins this.
- ALB access logs and `Referrer-Policy` SPA header for ticket-leakage hardening. ALB access logs are not enabled today (`infra/environments/shared/main.tf`); the SPA header is a frontend concern. Both belong in the WS-server design.
- Per-route rate-limit *store* upgrade. The cap is enforced today (in-memory store). MYT-45 swaps to Redis-backed.

**Load-bearing assertions the WS server MUST honor:**
1. **Re-validate `campaign_members` on upgrade.** `consumeWsTicket` returning a payload only proves that *some* member of the campaign minted the ticket within the last 30s. It does NOT prove membership at upgrade time. The WS server's upgrade handler MUST re-query `repo.campaigns.getMembership(payload.sessionId → campaignId, payload.userId)` and reject if absent. (Source-spec §6.5 already commits to this; restated here so the contract is unmissable.)
2. **Treat `null` from `consumeWsTicket` as opaque.** Don't add telemetry or branching that tries to distinguish "never existed" / "already consumed" / "expired" / "corrupt." See §5.4.
3. **Treat `expiresAt` as informational only.** The WS upgrade's accept/reject is the ground truth.
4. **Surface 401-on-upgrade as a re-mintable error.** A leaked-and-consumed ticket manifests as 401; the SPA re-mints. See §6.5.

## 11. Estimate

~0.5 working day. Final Auth issue. Closes the Platform-milestone Auth track.
