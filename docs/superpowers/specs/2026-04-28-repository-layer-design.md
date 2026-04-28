# Repository Layer — Design Spec

> **Linear issue**: [MYT-34](https://linear.app/mythrun/issue/MYT-34) — Backend Core: repository layer (UUIDv7, namespace pattern, query helpers)
> **Parent spec**: `docs/specs/2026-04-13-backend-core.md` §5 (Repository Layer)
> **Date**: 2026-04-28
> **Status**: v2 (post-blind-review)

## 1. Goal

Build the repository layer: a closure-based factory that returns typed, namespaced data-access methods over the schema landed in MYT-33. CLAUDE.md mandates "all DB access through the repository layer" — this ticket establishes that layer, scoped to namespaces whose consumers exist or are imminent.

The contract: every TS file outside `backend/src/repo/` that wants to read or write the database calls `repo.<namespace>.<method>(...)`. No raw `pool.query(...)` in route handlers, services, or workers.

## 2. Scope: 4 foundation namespaces

Spec §5.2 lists 25 namespaces. **This ticket ships 4** — `users`, `worlds`, `campaigns`, `sessions`. The remaining 21 are deferred to consumer tickets per the context-coherence rule (`feedback_context_coherence.md`): batching producer with consumer reduces wrong-shape APIs.

The deferrals from v1 of this spec were:

- **`characters`** → deferred to Prep Pipeline character-creation tickets. Per-skill/feature/equipment/spell add APIs are guesses without the character-creation flow designed. Filing a new bead `repo-deferred`.
- **`credits`** → deferred to **MYT-40** ("Billing: credit ledger schema additions + atomic debit pattern"). MYT-40 owns the atomic debit design; shipping a separate `credits.grant`/`debit`/`getBalance` here invites a TOCTOU race (concurrent session-starts both read balance=1 then both debit, user goes to -1) that MYT-40's atomic-debit work is the right place to solve. No new bead needed — MYT-40 already covers it; spec §5 deferral table updated.
- **`worlds.fork`** → deferred to Prep Pipeline. Fork semantics are explicitly Pipeline-owned (entity copy, fact deduplication, etc.); shipping the lineage-record half here without the substance creates a half-method.
- **`sessions.updateRunningSummary`** → deferred to Session Runtime + Combat L1 milestone (Slow Thinker is the consumer).
- **`users.softDelete`** → deferred. No caller in the next 2-3 tickets; the idempotency-guard nuance is exactly the kind of detail that wants a real consumer to constrain the design.

The remaining 19 namespaces from spec §5.2 are tracked via beads tagged `repo-deferred` (`bd list --label=repo-deferred`).

## 3. File layout

```
backend/src/repo/
  index.ts                 # createRepo(pool) → { users, worlds, campaigns, sessions }
  uuidv7.ts                # one-line wrapper around the uuidv7 package; testability seam
  types.ts                 # row interfaces (User, World, Campaign, Session) + Update input types
  mappers.ts               # snake_case row → camelCase TS object
  users.ts                 # createUsersRepo(pool)
  worlds.ts                # createWorldsRepo(pool)
  campaigns.ts             # createCampaignsRepo(pool)
  sessions.ts              # createSessionsRepo(pool)
  __tests__/
    users.test.ts          # real-DB integration tests, one per namespace
    worlds.test.ts
    campaigns.test.ts
    sessions.test.ts
    mappers.test.ts        # pure unit tests
backend/src/app-deps.ts    # MODIFIED — adds repo: Repo
backend/src/app.ts         # MODIFIED — buildApp signature accepts repo (still no-op consumer)
backend/src/server.ts      # MODIFIED — boot-gate path constructs repo; fallbackStart constructs repo over the stub pool (which throws on use)
backend/src/db/migrate.ts  # MODIFIED — CLI block imports uuidv7 from repo/uuidv7.ts (single seam)
```

Each namespace file is ~50–150 lines depending on method count. Closure factory pattern from spec §5:

```ts
import { type Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { type User, type CreateUserInput, type UserUpdate } from './types.js'
import { toUser, type UserDbRow } from './mappers.js'

export function createUsersRepo(pool: Pool) {
  return {
    create: async (input: CreateUserInput): Promise<User> => {
      const id = uuidv7()
      const result = await pool.query<UserDbRow>(
        `INSERT INTO users (id, cognito_sub, email, display_name, username, avatar_url, auth_provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [id, input.cognitoSub, input.email, input.displayName, input.username, input.avatarUrl ?? null, input.authProvider],
      )
      const row = result.rows[0]
      if (!row) throw new Error('users.create: INSERT returned no row')
      return toUser(row)
    },
    getById: async (id: string): Promise<User | null> => {
      const result = await pool.query<UserDbRow>('SELECT * FROM users WHERE id = $1', [id])
      const row = result.rows[0]
      return row ? toUser(row) : null
    },
    getByCognitoSub: async (sub: string): Promise<User | null> => { /* … */ },
    getByEmail: async (email: string): Promise<User | null> => { /* … */ },
    update: async (id: string, patch: UserUpdate): Promise<User> => { /* see §4.4 */ },
  }
}
```

`index.ts`:

```ts
import { type Pool } from 'pg'
import { createUsersRepo } from './users.js'
import { createWorldsRepo } from './worlds.js'
import { createCampaignsRepo } from './campaigns.js'
import { createSessionsRepo } from './sessions.js'

export function createRepo(pool: Pool) {
  return {
    users: createUsersRepo(pool),
    worlds: createWorldsRepo(pool),
    campaigns: createCampaignsRepo(pool),
    sessions: createSessionsRepo(pool),
  }
}

export type Repo = ReturnType<typeof createRepo>
```

## 4. Design decisions

### 4.1 camelCase TS surface, snake_case in SQL, mappers in between

The schema uses snake_case (`cognito_sub`, `created_by`, `geography_summary`). The TS surface is camelCase. Each row type has a `XxxDbRow` interface (matching `pool.query<XxxDbRow>` results) and a mapper function in `mappers.ts`.

```ts
// types.ts
export interface User {
  readonly id: string
  readonly cognitoSub: string
  readonly email: string
  readonly displayName: string
  readonly username: string
  readonly avatarUrl: string | null
  readonly authProvider: 'google' | 'discord'
  readonly stripeCustomerId: string | null
  readonly freeTrialUsed: boolean
  readonly suspendedAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

// Spelled-out, not Partial<Pick<User, ...>>, so exactOptionalPropertyTypes
// semantics are intentional: callers either omit a key or pass null where
// the field is nullable. Identity fields (cognitoSub/email/authProvider)
// are NOT in this type — mutating them breaks Cognito linkage.
export interface UserUpdate {
  readonly displayName?: string
  readonly username?: string
  readonly avatarUrl?: string | null
  readonly stripeCustomerId?: string | null
  readonly freeTrialUsed?: boolean
}
```

### 4.2 Narrowing helpers for enum-like CHECK columns

`auth_provider` is `TEXT` with a CHECK constraint enforcing `('google', 'discord')`. The mapper does NOT bare-cast `as 'google' | 'discord'`. Instead, a small narrowing helper:

```ts
// mappers.ts
function toAuthProvider(v: string): 'google' | 'discord' {
  if (v !== 'google' && v !== 'discord') {
    throw new Error(`unexpected auth_provider value from DB: ${v}`)
  }
  return v
}
```

Same pattern for any other enum-like field with a small fixed value set. The CHECK constraint guarantees the SQL invariant; the helper is defense in depth — if a future migration adds a new option but the TS interface is stale, the mapper fails loudly at the boundary rather than silently miscategorizing.

### 4.3 Create methods return the full row via `RETURNING *`

Spec §5 example shows `Promise<string>`. We deviate: every `create` returns the full record via `INSERT ... RETURNING *`. Saves callers a refetch, costs marginal extra bandwidth, matches what every consumer wants.

### 4.4 Update methods use fixed COALESCE; updated_at always bumped

Dynamic SQL is unnecessary for ~5 mutable columns. The fixed-form pattern:

```ts
update: async (id: string, patch: UserUpdate): Promise<User> => {
  const result = await pool.query<UserDbRow>(
    `UPDATE users
        SET display_name       = COALESCE($2, display_name),
            username           = COALESCE($3, username),
            avatar_url         = COALESCE($4, avatar_url),
            stripe_customer_id = COALESCE($5, stripe_customer_id),
            free_trial_used    = COALESCE($6, free_trial_used),
            updated_at         = now()
      WHERE id = $1
      RETURNING *`,
    [id, patch.displayName ?? null, patch.username ?? null, patch.avatarUrl ?? null,
     patch.stripeCustomerId ?? null, patch.freeTrialUsed ?? null],
  )
  const row = result.rows[0]
  if (!row) throw new Error(`users.update: no user with id ${id}`)
  return toUser(row)
}
```

**`updated_at = now()` is mandatory on every UPDATE statement** in every namespace — the schema declares `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()` but does NOT have a `BEFORE UPDATE` trigger, so manual bumping is required. Forgetting leaves `updated_at` stale forever. Each test file asserts `updated_at` advances after `update`.

The COALESCE form has nice properties: one stable SQL string (predictable EXPLAIN), no injection surface, fully parameterized, the column whitelist is in the SQL itself rather than a JS array.

Caveat: with COALESCE, "set this nullable field to NULL" is impossible (`null` means "don't change"). For nullable fields where clearing is a legitimate operation (`avatarUrl`, `stripeCustomerId`), if a real consumer needs that capability, the API can grow a sentinel later or split into `clearAvatar` / etc. methods. Not in scope today.

### 4.5 UUIDv7 in its own module

`backend/src/repo/uuidv7.ts`:

```ts
import { uuidv7 as uuidv7Pkg } from 'uuidv7'

export const uuidv7 = (): string => uuidv7Pkg()
```

Used by every `create` in the repo. `backend/src/db/migrate.ts`'s CLI block (Task 12) currently imports `uuidv7` directly from the package; this ticket switches it to `import { uuidv7 } from '../repo/uuidv7.js'` so the wrapper is the single seam. One-line change in migrate.ts.

### 4.6 Method-level decisions per namespace

**`users`**: `create`, `getById`, `getByCognitoSub`, `getByEmail`, `update`. All explicit (no implicit "and so on" — Auth will literally grep for these names).

**`worlds`**: `create`, `getById`, `listByUser`, `update`, `updateStatus`, `incrementForkCount`. `fork` deferred to Prep Pipeline. `listByUser` is `SELECT * FROM worlds WHERE created_by = $1 ORDER BY created_at DESC` — simple ownership filter, no JOIN needed. `updateStatus` is a one-purpose UPDATE on the `status` column (the prep pipeline calls this many times per run; dedicated method matches spec §5.2 + makes pipeline tracing cleaner).

**`campaigns`**: `create`, `getById`, `listByUser`, `update`. `transferOwnership` deferred to MYT-39 (it's a two-table transaction touching campaign_members which is itself deferred). `listByUser` does the JOIN with `campaign_members` directly in SQL — fine even though that's a deferred namespace; we're using the table, not exposing an API surface for it:

```sql
SELECT c.* FROM campaigns c
  JOIN campaign_members cm ON cm.campaign_id = c.id
 WHERE cm.user_id = $1 AND cm.invite_accepted = true
 ORDER BY c.created_at DESC
```

**`sessions`**: `create`, `getById`, `getActiveByCampaign`, `update`, `listByCampaign`. `updateRunningSummary` deferred to Combat L1. `getActiveByCampaign` query uses `LIMIT 1` defensively — the partial-unique index `idx_sessions_one_active` guarantees at most one row, but `LIMIT 1` makes the contract self-documenting at the SQL site:

```sql
SELECT * FROM sessions
 WHERE campaign_id = $1 AND status = 'active'
 LIMIT 1
```

Returns `Promise<Session | null>`.

## 5. AppDeps + server integration

```ts
// app-deps.ts
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { Repo } from './repo/index.js'

export interface AppDeps {
  pg: Pool
  redisRealtime: Redis
  redisBatch: Redis
  repo: Repo
}
```

Boot-gate-on path in `server.ts`:

```ts
const repo = createRepo(pgRef)
const app = buildApp({ pg: pgRef, redisRealtime: rTRRef, redisBatch: rTBRef, repo })
```

Boot-gate-off path (`fallbackStart`): the existing stub pool's `query` throws synchronously when called. We construct `createRepo(stubPool)` over it; any repo method invocation propagates that throw naturally:

```ts
const stubDeps: AppDeps = {
  pg: stubPool,
  redisRealtime: stubRedisRealtime,
  redisBatch: stubRedisBatch,
  repo: createRepo(stubPool), // method calls hit stubPool.query, which throws
}
```

No Proxy needed. The stub pool is the single seam for "this dep isn't really wired"; the repo composes over it without special-casing.

`ShutdownClients` is unchanged — the repo holds no resources of its own; the pool drain handles its lifecycle. Repo is a closure over the pool, no separate cleanup needed.

`buildApp`'s body is unchanged for now (still just `/health`); it accepts the new dep type so future plugins (Auth, Billing) can decorate the Fastify instance with `app.repo = deps.repo` or thread it directly into route handlers.

## 6. Tests

### 6.1 Per-namespace integration tests with TRUNCATE-based reset

One file per namespace under `backend/src/repo/__tests__/`. Pattern:

```ts
beforeAll: guardTestDatabase, createPgPool({ max: 1 }), run all 3 migrations once
beforeEach: TRUNCATE users, worlds, campaigns, sessions, character_skills, character_features, character_equipment, character_spells, ... RESTART IDENTITY CASCADE
afterAll: pool.end()
```

The `beforeEach` TRUNCATE is ~5ms per call — much faster than re-running all 3 migrations. CASCADE handles FK relationships (truncating `users` cascades to all owned tables). Schema stays intact across tests; only data is reset.

The test helper (`backend/src/repo/__tests__/_helpers/reset-data.ts`) lists every application table and TRUNCATEs in the right order. As future tickets add namespaces and tables, they extend this helper.

Each namespace test covers ~5–8 tests:
- `create` returns row with populated id, created_at, updated_at, all fields matching input
- `getById` returns the inserted row
- `getById` returns `null` for unknown id
- relevant getter methods (`getByCognitoSub`, `getByEmail`) return correct row / null
- `update` mutates supplied fields, leaves untouched fields alone, advances `updated_at`
- `update` of a nullable field via the COALESCE pattern is no-op when `null` passed (this is the documented limitation; the test pins it as deliberate)
- per-namespace edge cases: `worlds.listByUser` returns DESC by created_at; `campaigns.listByUser` filters out unaccepted invites; `sessions.getActiveByCampaign` returns null when no active session

Total: ~25 integration tests across 4 namespaces.

### 6.2 Mappers unit test

`mappers.test.ts` tests the row mappers + narrowing helpers directly with hand-constructed DbRow objects. Pure functions, no DB. Covers:
- happy-path conversion for every field
- `null` / `undefined` handling on optional columns
- Date column round-trips (PG returns `Date` from `TIMESTAMPTZ`; mappers preserve)
- `toAuthProvider` throws on unexpected values

~12 unit tests.

### 6.3 What we trust

Schema-parity (MYT-33's test) pins tables, indexes, CHECK constraints, FK delete rules. Repo tests don't re-verify the schema — they trust it. If a future migration breaks the schema invariants, the schema-parity test fires before any repo test runs.

## 7. Definition of Done

- 7 files in `backend/src/repo/` (index, uuidv7, types, mappers, 4 namespace files).
- 5 test files in `backend/src/repo/__tests__/` (4 namespace tests + mappers).
- 1 test helper in `backend/src/repo/__tests__/_helpers/reset-data.ts`.
- `backend/src/app-deps.ts` extends to include `repo: Repo`.
- `backend/src/server.ts` constructs the repo (real pool + stub pool) and threads it through `buildApp` in both boot paths.
- `backend/src/db/migrate.ts` CLI block imports `uuidv7` from `../repo/uuidv7.js` (single seam).
- All `pool.query` calls use parameterized SQL — no string interpolation.
- All UPDATE statements include `updated_at = now()`.
- UUIDs generated app-side via `uuidv7()` from the new module; no `gen_random_uuid()` in any SQL.
- `pnpm typecheck` + `pnpm lint` + `pnpm test` all green locally and in CI.
- ~25 integration tests + ~12 mapper unit tests passing.
- The `repo-deferred` bead label updated to include the new `characters` deferral bead. (Filed as part of this ticket's brainstorming, see §2.)

## 8. Out of scope / Follow-ups

- 21 deferred namespaces — beads filed under `repo-deferred` label.
- `characters` namespace + per-skill/feature/equipment/spell APIs — to file as new bead alongside this v2 spec.
- `credits` namespace — explicitly part of MYT-40 (no new bead).
- `worlds.fork`, `sessions.updateRunningSummary`, `users.softDelete`, `campaigns.transferOwnership`, `credits.getHistory` — deferred per the deferral table; documented inline above.
- Higher-level transaction abstraction (`repo.transaction(cb)`) — wait for a real multi-method consumer.
- Caching, read replicas, query observability — v2 concerns.
- Runtime row validation (zod) — layer in if a real bug surfaces.

## 9. Changes from v1

A blind-review round (Orion/Cassiopeia/Lyra/Draco) found:

- **2 BLOCKERs** (correctness): `credits.getBalance` returns string-from-bigint not number; `credits.{getBalance, debit}` is a TOCTOU race. Both resolved by deferring `credits` entirely to MYT-40.
- **1 three-reviewer convergence** (Cassiopeia + Lyra + Draco): the Proxy-based stub Repo for the boot-gate-off path is broken at the namespace layer (`repo.users` returns a function, so `repo.users.create()` throws on the namespace access not the method call). Resolved by composing `createRepo(stubPool)` — the stub pool's existing throw covers the case.
- **Scope cuts** (Orion, applying the project's own context-coherence rule): `characters` namespace, `worlds.fork`, `sessions.updateRunningSummary`, `users.softDelete`, `credits.getHistory` — each lacks a consumer in the next 1-2 tickets and gets deferred to the ticket where its consumer is designed. Net: 4 namespaces (was 6).
- **SHOULD FIXes**: `users.update` rewritten as fixed COALESCE (not dynamic SQL); `updated_at = now()` mandate spelled out for all UPDATE methods; `UserUpdate` type spelled out (not `Partial<Pick<>>`) to make exactOptionalPropertyTypes semantics intentional; `authProvider` narrowed via helper not bare `as`; `getByCognitoSub` explicit in the method list (Auth will grep for it); test reset switched from full migration replay to TRUNCATE for ~50× speedup; `sessions.getActiveByCampaign` adds `LIMIT 1` for self-documenting contract.
- **Padding cut**: §6.3 "What we're NOT testing" wall-of-text shortened to one paragraph; §10 from v1 dropped entirely.
