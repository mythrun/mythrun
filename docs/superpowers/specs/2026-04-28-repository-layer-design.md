# Repository Layer — Design Spec

> **Linear issue**: [MYT-34](https://linear.app/mythrun/issue/MYT-34) — Backend Core: repository layer (UUIDv7, namespace pattern, query helpers)
> **Parent spec**: `docs/specs/2026-04-13-backend-core.md` §5 (Repository Layer)
> **Date**: 2026-04-28
> **Status**: v1

## 1. Goal

Build the repository layer: a closure-based factory that returns typed, namespaced data-access methods over the schema landed in MYT-33. CLAUDE.md mandates "all DB access through the repository layer" — this ticket establishes that layer, scoped to the namespaces whose consumers exist or are about to exist (Auth/Billing/Sessions need `users` immediately).

The contract: every TS file outside `backend/src/repo/` that wants to read or write the database calls `repo.<namespace>.<method>(...)`. No raw `pool.query(...)` in route handlers, services, or workers.

## 2. Scope: foundation namespaces only

Spec §5.2 lists 25 namespaces. **This ticket ships 6** — the foundation set whose consumers are cross-cutting and already designed (or about to be):

- `users`, `worlds`, `campaigns`, `sessions`, `characters`, `credits`

The other 19 are deferred to the downstream tickets where their consumers are designed. The deferral policy and tracking beads are documented in Backend Core spec §5 ("Namespace Deferral Policy" subsection); a future agent picking up Auth/Billing/Pipeline/Sessions runs `bd list --label=repo-deferred` to find what to add inline.

Rationale (saved as `feedback_context_coherence.md`): batching producer code with consumer context produces fewer wrong-shape APIs than designing in isolation. Even though the total work is the same, the design-coherence cost of guessing at consumer needs across multiple agent sessions is real.

## 3. File layout

```
backend/src/repo/
  index.ts                 # createRepo(pool) → { users, worlds, campaigns, sessions, characters, credits }
  uuidv7.ts                # thin wrapper around the uuidv7 package; testability seam
  types.ts                 # row interfaces (User, World, Campaign, Session, Character, CreditLedgerEntry, …)
  mappers.ts               # snake_case row → camelCase TS object
  users.ts                 # createUsersRepo(pool)
  worlds.ts                # createWorldsRepo(pool)
  campaigns.ts             # createCampaignsRepo(pool)
  sessions.ts              # createSessionsRepo(pool)
  characters.ts            # createCharactersRepo(pool)
  credits.ts               # createCreditsRepo(pool)
  __tests__/
    users.test.ts          # real-DB integration tests, one per namespace
    worlds.test.ts
    campaigns.test.ts
    sessions.test.ts
    characters.test.ts
    credits.test.ts
    mappers.test.ts        # pure unit tests
backend/src/app-deps.ts    # MODIFIED — adds repo: Repo
backend/src/app.ts         # MODIFIED — buildApp signature accepts the new field (still no-op consumer)
backend/src/server.ts      # MODIFIED — constructs repo from pool, passes to buildApp
```

Each namespace file is ~50–150 lines depending on method count. Methods follow the closure factory pattern from spec §5:

```ts
import { type Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { type User, type UserUpdate } from './types.js'
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
    // …
  }
}
```

`index.ts` composes:

```ts
import { type Pool } from 'pg'
import { createUsersRepo } from './users.js'
import { createWorldsRepo } from './worlds.js'
// …

export function createRepo(pool: Pool) {
  return {
    users: createUsersRepo(pool),
    worlds: createWorldsRepo(pool),
    campaigns: createCampaignsRepo(pool),
    sessions: createSessionsRepo(pool),
    characters: createCharactersRepo(pool),
    credits: createCreditsRepo(pool),
  }
}

export type Repo = ReturnType<typeof createRepo>
```

## 4. Design decisions

Captured during brainstorming; all defaults to "what the spec/Linear issue would suggest" except where the brainstorm landed differently.

### 4.1 camelCase TS surface, snake_case in SQL, mappers in between

The schema uses snake_case (`cognito_sub`, `created_by`, `geography_summary`). The TS surface is camelCase (`cognitoSub`, `createdBy`, `geographySummary`). Each row type has a row interface (`UserDbRow` with snake_case keys, matching `pool.query<UserDbRow>` results) and a mapper (`toUser(row)`) that converts to the camelCase `User` interface.

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

// mappers.ts
export interface UserDbRow {
  id: string
  cognito_sub: string
  email: string
  display_name: string
  username: string
  avatar_url: string | null
  auth_provider: string
  stripe_customer_id: string | null
  free_trial_used: boolean
  suspended_at: Date | null
  created_at: Date
  updated_at: Date
}

export function toUser(row: UserDbRow): User {
  return {
    id: row.id,
    cognitoSub: row.cognito_sub,
    email: row.email,
    displayName: row.display_name,
    username: row.username,
    avatarUrl: row.avatar_url,
    authProvider: row.auth_provider as 'google' | 'discord',
    stripeCustomerId: row.stripe_customer_id,
    freeTrialUsed: row.free_trial_used,
    suspendedAt: row.suspended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
```

One file (`mappers.ts`) holds all six mappers. Pure functions; tested in `mappers.test.ts` without a DB.

### 4.2 Create methods return the full row via `RETURNING *`

Spec §5 example shows `Promise<string>` (returns the new ID). We deviate: every `create` returns the full record, populated with DB-generated `created_at`/`updated_at` via `INSERT ... RETURNING *`. Saves callers a refetch, costs marginal extra bandwidth, matches what almost every consumer wants.

The same pattern applies to `update` methods: `UPDATE ... SET ... WHERE id = $1 RETURNING *`. Caller gets the new row in one round-trip.

### 4.3 `as` assertions for row typing

`pool.query<UserDbRow>(...)` types the rows; mappers convert. No runtime validation (zod) at the row boundary in v1 — the MYT-33 schema-parity test catches schema-vs-interface drift. If a real bug surfaces from this gap, layer in zod later.

The single `as` assertion that does runtime work is on enum-like CHECK columns: `auth_provider` is `TEXT` in SQL with a CHECK constraint, but TS types it as `'google' | 'discord'`. The mapper `as`-casts it. If a future migration adds a third option, the schema-parity test catches the CHECK clause change before code can read an unknown value.

### 4.4 UUIDv7 in its own module

`backend/src/repo/uuidv7.ts`:

```ts
import { uuidv7 as uuidv7Pkg } from 'uuidv7'

/**
 * UUIDv7 generator — time-ordered keys for B-tree locality on PK indexes.
 * Wraps the `uuidv7` package as a single-line module so:
 *   1. Tests can vi.mock('./uuidv7.js') if deterministic IDs are needed.
 *   2. A future migration to a different UUIDv7 lib is a one-file change.
 */
export const uuidv7 = (): string => uuidv7Pkg()
```

Every `create` method imports and calls this. UUIDs are generated app-side per Backend Core spec §5; the schema's `id UUID PRIMARY KEY` columns have no DB default.

### 4.5 Method-level decisions

- **`users.softDelete`**: `UPDATE users SET suspended_at = now() WHERE id = $1 AND suspended_at IS NULL`. The `suspended_at IS NULL` guard makes the operation idempotent (re-running on an already-suspended user is a no-op). The schema has no `deleted_at` column; `suspended_at` is the soft-delete signal.
- **`users.update`**: accepts `UserUpdate = Partial<Pick<User, 'displayName' | 'username' | 'avatarUrl' | 'stripeCustomerId' | 'freeTrialUsed'>>`. Identity fields (`cognitoSub`, `email`, `authProvider`) are NOT in this type — mutating them breaks Cognito linkage and audit trails. The implementation uses dynamic SQL building (only updates supplied keys) but with a hard whitelist on the column names so no caller can inject column names through TypeScript-bypassed paths.
- **`worlds.fork(sourceWorldId, input)`**: inserts a new world record with `source_world_id = sourceWorldId`, increments `source.fork_count` in the same transaction (`pool.connect()` + BEGIN/COMMIT). Does NOT deep-copy entities/facts/relationships — those namespaces are deferred to Prep Pipeline, where the prep engine's fork semantics determine what gets copied vs regenerated. This method just establishes the world-record lineage.
- **`worlds.listByUser(userId)`**: `SELECT * FROM worlds WHERE created_by = $1 ORDER BY created_at DESC`. No JOIN needed; simple ownership filter.
- **`campaigns.listByUser(userId)`**: `SELECT c.* FROM campaigns c JOIN campaign_members cm ON cm.campaign_id = c.id WHERE cm.user_id = $1 AND cm.invite_accepted = true ORDER BY c.created_at DESC`. The JOIN with `campaign_members` is fine even though that's a deferred namespace — we're using the table in SQL, not exposing a campaignMembers API surface.
- **`campaigns.transferOwnership` is deferred** to MYT-39. It needs to update both `campaigns.created_by` AND swap the `campaign_members` role rows (current owner → player, target → owner) in one transaction. Since `campaign_members` is itself deferred, the cleaner path is to ship the whole transfer atomically when MYT-39 lands. Documented in `myth-ij6` (the MYT-39 deferral bead).
- **`sessions.getActiveByCampaign(campaignId)`**: `SELECT * FROM sessions WHERE campaign_id = $1 AND status = 'active'`. The schema has `idx_sessions_one_active` (partial-unique on `(campaign_id) WHERE status = 'active'`), so this method returns either zero or one row. Type signature: `Promise<Session | null>`.
- **`sessions.updateRunningSummary(sessionId, summary)`**: dedicated method instead of going through `update()`. Reason: this is called by the Slow Thinker on every turn, has a clear single-purpose contract, and surfaces in pipeline tracing as a distinct event.
- **`characters.{addSkill,addFeature,addEquipment,addSpell}`** insert into `character_skills` / `character_features` / `character_equipment` / `character_spells` with the parent `character_id`. The matching `getSkills` / `getFeatures` / `getEquipment` / `getSpells` methods read all rows for a character.
- **`credits.grant(input)` / `credits.debit(input)`**: both INSERT into `credit_ledger`. `grant` requires `amount > 0`; `debit` requires `amount > 0` and inserts `-amount`. Argument validation throws `Error('credits.grant: amount must be positive')` if violated — TS types alone can't enforce non-zero positive integers, so a runtime check at the boundary is justified. Both methods return the inserted ledger row.
- **`credits.getBalance(userId, creditType)`**: `SELECT COALESCE(SUM(amount), 0) AS balance FROM credit_ledger WHERE user_id = $1 AND credit_type = $2 AND (expires_at IS NULL OR expires_at > now())`. Returns `Promise<number>`. The COALESCE handles the empty-ledger case (SUM returns NULL on no rows).
- **`credits.getHistory(userId, opts?)`**: `SELECT * FROM credit_ledger WHERE user_id = $1 ORDER BY granted_at DESC LIMIT $2 OFFSET $3`. `opts.limit` defaults to 100, `opts.offset` to 0 — bounded by default to prevent unbounded result sets in dev/debug paths.

### 4.6 Transaction support

Single-statement methods don't need transactions. Multi-statement operations (`worlds.fork` increments + insert; `campaigns.transferOwnership` when it lands; future debit-and-record-purchase) use `pool.connect()` + manual `BEGIN`/`COMMIT`/`ROLLBACK`/`client.release()`. No higher-level abstraction (e.g., a `repo.transaction(callback)` helper) in this ticket — wait until a real consumer needs it.

The migration runner (MYT-32) already has the `BEGIN/COMMIT/ROLLBACK + release(err)` pattern documented and tested; copy that shape inside repo methods that need it.

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

`server.ts` constructs the repo immediately after creating the pool, in the boot-gate path:

```ts
// server.ts inside main(), after createPgPool / createRedisClient and waitFor probes
const repo = createRepo(pgRef)
const app = buildApp({ pg: pgRef, redisRealtime: rTRRef, redisBatch: rTBRef, repo })
```

The fallbackStart path (boot gate disabled) gets a stub repo that throws on any method call, since the dormant API doesn't actually use it:

```ts
const stubRepo: Repo = new Proxy({} as Repo, {
  get: () => () => { throw new Error('repo unavailable: BOOT_GATE_ENABLED is off') },
})
```

`buildApp` continues to accept the AppDeps and threads `deps.repo` to whatever future plugin needs it. v1 still has only the `/health` route, which doesn't touch the repo — the wiring is structural for future tickets.

## 6. Tests

### 6.1 Per-namespace integration tests

Same shape as MYT-33's `migrate-schema.test.ts`. One file per namespace:

```ts
// users.test.ts
beforeAll: guardTestDatabase, createPgPool({ max: 1 })
beforeEach: drop+recreate public schema, run migrations 001+002+003 via runMigrations
afterAll: pool.end()
```

Each test file covers ~5–10 tests:
- create returns row with populated id, created_at, updated_at, all fields matching input
- getById returns the inserted row
- getById returns null for unknown id
- relevant getter methods (getByCognitoSub, getByEmail, etc.) return correct row / null
- update mutates only supplied fields, returns updated row, leaves untouched fields alone
- soft-delete / archive methods set the correct timestamp column
- per-namespace edge cases: `credits.getBalance` excludes expired credits; `worlds.fork` increments fork_count; `sessions.getActiveByCampaign` returns null when no active session; `characters.addSkill` allows duplicates (the schema does not have a unique constraint on `(character_id, skill_name)` — repo doesn't add one either; if duplicate skills become a real bug, add the constraint at the schema level in a future migration)

The `beforeEach` schema reset is expensive (~50ms per test) but correctness matters more than test speed; with `fileParallelism: false` from MYT-32, total test wall time is bounded.

Reuse `runMigrations` from MYT-32 to apply migrations in `beforeEach`. The schema-parity test from MYT-33 already verifies the migrations produce the expected schema; here we just trust them.

### 6.2 Mappers unit test

`mappers.test.ts` tests the six row mappers directly with hand-constructed DbRow objects. Pure functions, no DB. Covers:
- happy-path conversion for every field
- `null` / `undefined` handling on optional columns
- Date column round-trips (PG returns `Date` objects from `TIMESTAMPTZ` columns; mappers preserve)
- Enum-as-string assertions: `authProvider as 'google' | 'discord'` is the only narrowing cast; verify it doesn't blow up on unexpected values (the CHECK constraint guarantees the SQL never produces them, but defensive verification is cheap)

### 6.3 What we're NOT testing here

- Concurrent access to the same row (PG handles it; testing is overkill)
- Transaction isolation levels (default `READ COMMITTED` is fine; no method depends on stricter)
- Performance / index usage (the schema-parity test from MYT-33 pins indexes; this ticket trusts them)

## 7. Definition of Done

- 8 files in `backend/src/repo/` (index, uuidv7, types, mappers, 6 namespace files).
- 7 test files in `backend/src/repo/__tests__/` (6 namespace tests + mappers).
- `backend/src/app-deps.ts` extends to include `repo: Repo`.
- `backend/src/server.ts` constructs the repo and threads it through `buildApp`. Fallback path (boot gate off) uses a throwing stub.
- `backend/src/app.ts` accepts the new dep type but has no new consumer (still `/health` only).
- All `repo.<namespace>.<method>` calls go through parameterized `pool.query` — no string interpolation anywhere.
- UUIDs generated app-side via `uuidv7()` from the new module; no `gen_random_uuid()` in any SQL.
- `pnpm typecheck` + `pnpm lint` + `pnpm test` all green locally and in CI.
- ~50 integration tests + ~20 mapper unit tests passing.
- The 7 deferred-namespace beads (`myth-ij6`, `myth-u7k`, `myth-0fi`, `myth-d1h`, `myth-cug`, `myth-5nb`, `myth-tx3`) tagged `repo-deferred` and discoverable via `bd list --label=repo-deferred`. (Already done as part of brainstorming; flagged in DoD for completeness.)

## 8. Out of scope / Follow-ups

- 19 deferred namespaces (`campaignMembers`, `campaignInvites`, billing namespaces, world-content namespaces, pipeline+snapshot namespaces, session-runtime namespaces, srd, settings) — beads filed.
- `transferOwnership` on campaigns — deferred to MYT-39.
- Higher-level transaction abstraction (`repo.transaction(cb)`) — wait for a real multi-method consumer.
- Caching, read replicas, query observability — v2 concerns once Auth/Billing/Sessions land and we see real query patterns.
- Runtime row validation (zod) — layer in if a real bug surfaces from `as`-cast drift.
