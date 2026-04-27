# Migration Runner — Design Spec

> **Linear issue**: [MYT-32](https://linear.app/mythrun/issue/MYT-32) — Backend Core: schema migration runner (`migrate.ts`)
> **Parent spec**: `docs/specs/2026-04-13-backend-core.md` §3 (Migration Runner)
> **Date**: 2026-04-26
> **Status**: Draft v5 (post-third-blind-review)

## 1. Goal

Ship a production-grade SQL migration runner so the Postgres schema can be evolved in append-only `.sql` files. This ticket builds the runner only — the actual Backend Core schema lands in a separate Platform issue. A single placeholder migration is included to exercise the runner end-to-end.

The runner must be:

- **Idempotent** (running twice is a no-op the second time).
- **Atomic per file** (a failed migration leaves no half-applied state).
- **Concurrency-safe** via Postgres advisory lock.
- **Append-only honor system** (no checksum drift detection in v1).
- **Usable as a CLI** (`pnpm db:migrate`) **and as an importable function** (server boot, runbook scripts).
- **Production-grade observability** — pino structured logs with stable `event` keys queryable from CloudWatch Logs Insights, per-migration `durationMs`, per-run `runId`, lock-wait heartbeats, `application_name` on the migration session for `pg_stat_activity`/Performance Insights triage.
- **Production-grade operability** — SIGTERM/SIGINT via existing `installSignalHandlers`, exit codes that distinguish graceful-stop from crash, recovery procedure with paste-ready commands, verified-against-staging-RDS gate before close.
- **Pool-hygiene-aware** — uses a single-client pool with bounded connection timeout; restores session state before returning the client so a future shared-pool topology can't leak `application_name` to the API server.

Out of scope: server-boot wiring, `CREATE INDEX CONCURRENTLY` support, checksum drift detection, the actual schema migrations, automatic rollback, `--dry-run`/`--list-pending` (roadmap, §13).

## 2. File Layout

```
backend/
  migrations/                              # NEW — outside src/, never compiled
    001_smoke.sql                          # CREATE EXTENSION IF NOT EXISTS pgcrypto;
  src/
    config/
      env.ts                               # MODIFIED — adds MIGRATE_DATABASE_URL fallback
    db/
      postgres.ts                          # MODIFIED — accepts Partial<PoolConfig> overrides
      lock-key.ts                          # NEW — pinned LOCK_KEY constant
      migrate.ts                           # NEW — runner logic + CLI entrypoint
      __tests__/
        migrate.test.ts                    # NEW — integration tests
        lock-key.test.ts                   # NEW — drift test
        guard-db.ts                        # NEW — shared "is this a safe DB?" check
  vitest.config.ts                         # NEW — at backend/, loads .env.development
  Dockerfile                               # MODIFIED — runtime stage copies migrations/
.github/workflows/
  deploy.yml                               # MODIFIED — adds Postgres service for tests
docs/wiki/content/runtime/
  migrations.html                          # NEW — wiki page per CLAUDE.md mandate
```

## 3. Runner Contract

```ts
// backend/src/db/migrate.ts

import type { Pool } from 'pg'
import type pino from 'pino'

/**
 * Narrow logger interface: anything that exposes pino-style level methods.
 * pino.Logger and Fastify's FastifyBaseLogger both satisfy this — important
 * for future server-boot wiring where the host passes app.log.
 */
export type MigrateLogger = Pick<pino.BaseLogger, 'info' | 'warn' | 'error' | 'debug'>

export interface AppliedMigration {
  readonly version: string
  readonly durationMs: number
}

export interface MigrationOptions {
  readonly pool: Pool
  readonly migrationsDir: string
  readonly logger: MigrateLogger
  readonly abortSignal?: AbortSignal | undefined
  readonly runId?: string | undefined            // default: uuidv7()
}

export async function runMigrations(
  opts: MigrationOptions,
): Promise<AppliedMigration[]>
```

**Notes on the type shape:**

- `MigrateLogger` is a narrowed `Pick` of pino's `BaseLogger`, not `pino.Logger` itself. Fastify's `FastifyBaseLogger` is a structural superset of pino's `BaseLogger` and satisfies this without a cast — important when server-boot wiring lands and the host passes `app.log`.
- Optional fields use `T | undefined` (not bare `?`) to interoperate with `exactOptionalPropertyTypes: true`. Callers may pass `undefined` or omit; both work.
- Return type carries per-migration `durationMs` so consumers (server-boot logger, deploy script) can surface timing without re-running with `time`.

**Behavior:**

- Returns migrations applied **during this invocation**. Empty array = nothing pending.
- Throws on first failure; subsequent files are not attempted. Caller's `catch` sees `Error` with `cause` chained to the original pg error.
- Caller owns the pool's lifecycle. After a thrown error, calling `pool.end()` from the caller is safe — the runner destroys its failing client (`release(err)`) so the pool only holds idle/healthy connections at that point.
- `abortSignal` requests a graceful stop *between* migrations (it cannot cancel an in-flight pg query — see §6 / §11).
- `runId` propagates onto every log event for cross-system correlation.

## 4. Tracking Table

```sql
CREATE TABLE IF NOT EXISTS _migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- Underscore prefix is the framework-metadata convention. **No application table uses an underscore prefix** — `_migrations` is the only `_*` table this codebase will ever have unless we add another framework table (e.g. `_schema_locks`).
- `version` is the full filename — natural key, no surrogate id.
- Created inside the advisory-lock-held section so a fresh-DB race doesn't `duplicate_table`.

## 5. Algorithm

```
0. logger.info({ event: 'migrate.start', runId, migrationsDir,
                 pgServerVersion, dbHost, nodeVersion }, 'migrate.start')
1. client = await pool.connect()
   try:
     // Set inside the BEGIN/COMMIT span via SET LOCAL — see 6c.
     // We must NOT do `SET application_name = ...` outside a transaction
     // here, because release() returns the client to the pool with that
     // session state preserved, polluting future checkouts.
     2. lockStart = performance.now()
        await acquireAdvisoryLockWithHeartbeat(client, runId, logger)
        logger.info({ event: 'migrate.lock_acquired', runId,
                      waitMs: round(performance.now() - lockStart) },
                    'migrate.lock_acquired')
     3. await client.query('CREATE TABLE IF NOT EXISTS _migrations ...')
     4. files = (readdir migrationsDir)
                  .filter(name → name.endsWith('.sql') && !name.startsWith('.'))
                  .sort()
        if files.length === 0:
          logger.info({ event: 'migrate.no_migrations_found', runId },
                      'migrate.no_migrations_found')
          return []
     5. applied = SELECT version FROM _migrations
        pending = files \ applied
        logger.info({ event: 'migrate.plan', runId,
                      pending: pending.length, total: files.length,
                      pendingVersions: pending },
                    'migrate.plan')
     6. for each file in pending, in order:
          if abortSignal?.aborted:
            logger.warn({ event: 'migrate.aborted', runId,
                          appliedSoFar: appliedSoFar.length,
                          remaining: pending.length - appliedSoFar.length },
                        'migrate.aborted')
            return appliedSoFar
          a. validateNoTransactionStatements(fileContents)
          b. start = performance.now()
          c. BEGIN
             SET LOCAL statement_timeout = 0
             SET LOCAL lock_timeout = '30s'
             SET LOCAL application_name = 'mythrun-migrate'   // scoped to this txn
             // Each migration's own SET LOCAL inside the file overrides ours
             // by design (escape hatch for slow migrations needing tighter
             // timeouts).
          d. client.query(fileContents)
          e. INSERT INTO _migrations (version) VALUES ($1)
          f. COMMIT
          g. durationMs = round(performance.now() - start)
          h. logger.info({ event: 'migrate.applied', runId, version, durationMs },
                         'migrate.applied')
          i. appliedSoFar.push({ version, durationMs })
        on error in (c)–(f):
          - try { client.query('ROLLBACK') } catch { /* swallow; reported below */ }
          - durationMs = round(performance.now() - start)
          - logger.error({ event: 'migrate.failed', runId, version, durationMs,
                           err: pgErr }, 'migrate.failed')
          - throw new Error(`migration ${version} failed: ${pgErr.message}`,
                            { cause: pgErr })
   finally:
     - try {
         await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY])
         logger.info({ event: 'migrate.lock_released', runId,
                       holdMs: round(performance.now() - lockStart) },
                     'migrate.lock_released')
       } catch (unlockErr) {
         logger.warn({ event: 'migrate.unlock_failed', runId, err: unlockErr },
                     'migrate.unlock_failed')
         // Backstop: advisory locks auto-release on socket close.
       }
     - if error path: client.release(pgErr)        // pg-pool: release(err) destroys
       else:           client.release()
     - logger.info({ event: 'migrate.done', runId,
                     applied: appliedSoFar.length,
                     totalMs: round(performance.now() - runStart) },
                   'migrate.done')
```

**Why the advisory lock with heartbeat (§5.1).** Two runners both `SELECT version FROM _migrations` simultaneously, both see "001 not applied," both run the same `CREATE TABLE` — second runner gets `duplicate_table` from Postgres. `pg_advisory_lock` is the session-level mutex Postgres provides for this. Held for the run; auto-releases on socket close.

**Why `SET LOCAL application_name`, not bare `SET`.** A bare `SET application_name = 'mythrun-migrate'` outside a transaction (or with `SET` instead of `SET LOCAL`) survives `release()` back to the pool. The next checkout — eventually the API server, when MYT-32's runner shares a pool with server boot — would see itself as `mythrun-migrate` in `pg_stat_activity` until it reconnects. `SET LOCAL` scopes to the current transaction; on `COMMIT`/`ROLLBACK` the value resets.

**Why one client throughout.** Advisory locks are session-scoped. The lock, the bookkeeping insert, and the migration SQL must share a session.

**Why `release(err)` on error.** pg-pool's `release(err)` destroys the underlying socket if `err` is truthy. Passing the actual pg error (rather than `true`) lets pool internals log the cause and matches the documented signature.

**Why the unlock has its own try/catch.** If the connection is broken, `pg_advisory_unlock` rejects. Without a local catch, that rejection masks the original migration error in the `finally`. Auto-release on socket close is the backstop, so logging at `warn` and continuing is correct.

### 5.1 Lock-Wait Heartbeat

`acquireAdvisoryLockWithHeartbeat`:

```
Try pg_try_advisory_lock(LOCK_KEY).
If acquired immediately: return.
Otherwise:
  Loop:
    logger.info({ event: 'migrate.lock_waiting', runId,
                  waitMsSoFar: ... }, 'migrate.lock_waiting')
    setTimeout(500ms)             // small initial poll
    Try pg_try_advisory_lock again.
    If acquired: return.
  After 5s, switch to a 5s heartbeat interval (pg_try_advisory_lock
  every 500ms but emit the heartbeat log once every 5s).
  Honors abortSignal between attempts.
```

Without this, a runner blocked behind another runner's lock emits `migrate.start` then silence until acquisition, leaving the operator unable to distinguish "wedged" from "crashed." The heartbeat surfaces wait time as a queryable metric.

### 5.2 LOCK_KEY (`backend/src/db/lock-key.ts`)

```ts
/**
 * Stable bigint passed to pg_advisory_lock.
 *
 * DO NOT REGENERATE THIS VALUE. It was computed once via:
 *
 *   SELECT hashtextextended('mythrun_migrate', 0);
 *
 * against PostgreSQL 16. Re-deriving against a different PG version
 * (or different seed) produces a different bigint, causing a runner
 * built from new code to use a different lock from a runner built
 * from old code — defeating the concurrency guard during a rolling
 * deploy.
 *
 * If a second app ever shares this RDS, prefix with a stack-id
 * high-32-bits and re-pin (and document the migration path).
 */
export const LOCK_KEY = -3411702991737540243n
```

`lock-key.test.ts` asserts the literal so a future contributor refactoring can't silently change it.

The exact bigint is captured at implementation time by running the SQL above against the local docker-compose Postgres, written into the source, and never regenerated.

### 5.3 Migration File Validation

Before executing each file, regex-reject any of these statements at line-start (case-insensitive, ignoring leading whitespace):

```
^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END)\s*[;]?\s*$
```

`CREATE INDEX CONCURRENTLY` is also incompatible with our wrapper transaction; supported in a future ticket via an opt-in `-- pg-migrate: no-transaction` header.

## 6. CLI Entrypoint

```ts
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { uuidv7 } from 'uuidv7'
import pino from 'pino'
import { loadEnv } from '../config/env.js'
import { createPgPool } from './postgres.js'
import { installSignalHandlers } from '../boot/signal-handlers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const DEFAULT_MIGRATIONS_DIR = resolve(__dirname, '../../migrations')

const argv1 = process.argv[1]
if (argv1 && import.meta.url === pathToFileURL(argv1).href) {
  // Pino — sync stdout (no transport), so logs flush on process exit
  // even on error paths. Std `err` serializer captures stack/cause.
  // If anyone later adds `transport: { target: 'pino-pretty' }`, they
  // MUST also call `await logger.flush()` before exit or `migrate.fatal`
  // events will be lost.
  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { component: 'migrate' },
    serializers: { err: pino.stdSerializers.err },
  })

  const abortController = new AbortController()
  installSignalHandlers(abortController)
  abortController.signal.addEventListener('abort', () => {
    logger.warn({ event: 'migrate.signal_received' }, 'migrate.signal_received')
  })

  let env
  try {
    env = loadEnv()
  } catch (err) {
    // Friendlier first-time experience than a raw stack trace.
    logger.error(
      { event: 'migrate.fatal', err },
      'migrate.fatal — check DATABASE_URL or backend/.env.development. ' +
      'For local dev: run `pnpm db:up` and copy `.env.development.example` to `.env.development`.',
    )
    process.exitCode = 1
    process.exit()
  }

  // Migrations may run as a different role than the API (rds_superuser
  // for CREATE EXTENSION). MIGRATE_DATABASE_URL takes precedence; fallback
  // to DATABASE_URL keeps local dev working out of the box.
  const databaseUrl = process.env.MIGRATE_DATABASE_URL ?? env.databaseUrl

  const pool = createPgPool(databaseUrl, {
    max: 1,                       // CLI uses one client; no point in 10
    connectionTimeoutMillis: 10_000,  // bounded; default 0 hangs forever
  })

  const runId = uuidv7()
  try {
    const applied = await runMigrations({
      pool,
      migrationsDir: DEFAULT_MIGRATIONS_DIR,
      logger,
      abortSignal: abortController.signal,
      runId,
    })
    logger.info(
      { event: applied.length === 0 ? 'migrate.no_pending' : 'migrate.complete',
        runId, count: applied.length, versions: applied.map((m) => m.version) },
      applied.length === 0 ? 'migrate.no_pending' : 'migrate.complete',
    )
    if (abortController.signal.aborted) {
      // Aborted-but-graceful: in-flight migration committed. Exit 130
      // by convention — the deploy script in §13 keys on this to
      // distinguish "told to stop" from "crashed" (exit 1).
      process.exitCode = 130
    }
  } catch (err) {
    // Privilege errors get a hint so the operator knows where to look.
    const pgErr = (err instanceof Error && err.cause) ?? err
    const hint = (pgErr as { code?: string })?.code === '42501'
      ? 'Postgres rejected the statement with insufficient_privilege. ' +
        'On RDS, CREATE EXTENSION requires rds_superuser — verify the ' +
        'migration role (see Backend Core §8.3).'
      : undefined
    logger.error({ event: 'migrate.fatal', runId, err, ...(hint && { hint }) }, 'migrate.fatal')
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}
```

The `argv1 &&` guard is required — `pathToFileURL('')` throws `ERR_INVALID_ARG_VALUE` and `process.argv[1]` is `string | undefined` under `noUncheckedIndexedAccess`.

**Signal handling**: SIGTERM does **not** cancel an in-flight pg query. The handler trips the `AbortController`; the in-flight migration completes (or fails normally and falls into the SQL-error path); the abort check fires before the next file; CLI exits 130. If a migration genuinely exceeds the ECS grace window, ECS escalates to SIGKILL — Postgres rolls back server-side, advisory lock auto-releases on socket close, and the next deploy task converges. See §11.

**Shutdown bound**: `pool.end()` waits for in-flight queries to drain. With `max: 1` and the runner's client released, this returns essentially instantly on the success path. SIGKILL is the backstop.

## 7. Logging

Pino, structured JSON, injected via `MigrationOptions.logger`. Every event has an explicit top-level `event` field (in addition to pino's default `msg`) so CloudWatch Logs Insights can do structured queries.

| `event` value | Level | Fields | When |
|--------------|-------|--------|------|
| `migrate.start` | info | `runId`, `migrationsDir`, `pgServerVersion`, `dbHost`, `nodeVersion` | Top of `runMigrations` |
| `migrate.lock_waiting` | info | `runId`, `waitMsSoFar` | Heartbeat while waiting for advisory lock |
| `migrate.lock_acquired` | info | `runId`, `waitMs` | Lock obtained |
| `migrate.lock_released` | info | `runId`, `holdMs` | Lock unlocked in `finally` |
| `migrate.unlock_failed` | warn | `runId`, `err` | Unlock failed (non-fatal; auto-release backstops) |
| `migrate.no_migrations_found` | info | `runId` | Migrations dir empty after filter |
| `migrate.plan` | info | `runId`, `pending`, `total`, `pendingVersions` | After applied/available comparison |
| `migrate.applied` | info | `runId`, `version`, `durationMs` | After each successful `COMMIT` |
| `migrate.failed` | error | `runId`, `version`, `durationMs`, `err` | After `ROLLBACK` |
| `migrate.aborted` | warn | `runId`, `appliedSoFar`, `remaining` | When `abortSignal` fires between migrations |
| `migrate.done` | info | `runId`, `applied`, `totalMs` | `finally`, after lock release |
| `migrate.signal_received` | warn | `signal` | CLI signal handler |
| `migrate.no_pending` | info | `runId`, `count`, `versions` | CLI summary, nothing to do |
| `migrate.complete` | info | `runId`, `count`, `versions` | CLI summary, success |
| `migrate.fatal` | error | `runId`, `err`, `hint?` | CLI top-level catch |

**Pino configuration choices, written down so they don't drift:**

- `serializers: { err: pino.stdSerializers.err }` — REQUIRED. Without it, `{ err: pgErr }` serializes as `{}` because Error fields are non-enumerable. The std serializer captures `message`, `stack`, `cause`, and pg-specific fields (`code`, `position`, `severity`, etc.).
- `base: { component: 'migrate' }` — every event tagged for cross-component CloudWatch queries.
- No async transport. Stdout is sync; logs are not lost on `process.exitCode` shutdown.
- Default `pid`/`hostname` accepted in v1; suppression is a follow-up if log volume becomes an issue (§13).

**Log levels per environment:**

- Dev: `LOG_LEVEL=info` default; `debug` available for future per-statement timing.
- CI: `LOG_LEVEL=info`.
- Prod: `LOG_LEVEL=info`.

`migrate.lock_acquired`/`migrate.lock_waiting`/`migrate.lock_released` are info-level on purpose — these are exactly the events an incident-investigating operator wants visible by default.

### 7.1 CloudWatch Insights Cookbook

For the runbook (§12). Log group is the ECS task's log group; replace `<lg>`.

```
# Recent failures with context
filter component = "migrate" and event = "migrate.failed"
| fields @timestamp, runId, version, durationMs, err.code, err.message
| sort @timestamp desc
| limit 50

# Slow migrations (look for outliers)
filter component = "migrate" and event = "migrate.applied"
| stats avg(durationMs), max(durationMs), count(*) by version
| sort max(durationMs) desc

# Lock-contention investigation
filter component = "migrate" and (event = "migrate.lock_waiting" or event = "migrate.lock_acquired")
| fields @timestamp, runId, waitMsSoFar, waitMs
| sort @timestamp desc

# Reconstruct a single run end-to-end
filter component = "migrate" and runId = "<paste-runId-here>"
| sort @timestamp asc

# Did the last deploy actually migrate anything?
filter component = "migrate" and (event = "migrate.complete" or event = "migrate.no_pending")
| fields @timestamp, runId, count, versions
| sort @timestamp desc
| limit 10
```

These five queries cover ~95% of incident triage. The wiki page (§14 DoD) duplicates them for runbook discoverability.

## 8. Build & Invocation

### 8.1 `createPgPool` Extension

`backend/src/db/postgres.ts` is extended to accept overrides:

```ts
export function createPgPool(url: string, overrides?: Partial<PoolConfig>): Pool
```

Implementation: spread `overrides` over the existing config object after the SSL handling. Existing callers (`server.ts`) pass no overrides and behavior is unchanged.

### 8.2 Dockerfile

Add to the runtime stage, after the existing `COPY ... /app/deploy ./`:

```dockerfile
COPY --from=builder --chown=mythrun:mythrun /app/backend/migrations ./migrations
```

Path verified: `/app/dist/db/migrate.js` → `../../migrations` → `/app/migrations`.

### 8.3 Scripts

`backend/package.json`:

```json
"db:migrate": "tsx --env-file=.env.development src/db/migrate.ts",
"db:migrate:compiled": "node dist/db/migrate.js"
```

Root `package.json`:

```json
"db:migrate": "pnpm --filter @mythrun/backend db:migrate"
```

CI/prod invokes `node dist/db/migrate.js` directly with env injected by the task definition.

### 8.4 RDS Privilege Requirement

The smoke migration is `CREATE EXTENSION IF NOT EXISTS pgcrypto`. On RDS, `CREATE EXTENSION` for whitelisted extensions requires `rds_superuser`. Implications:

- **Migration role**: `rds_superuser`. By default this is the master role created by Terraform.
- **API service role**: less-privileged app role per Auth & Users spec; **not** used for migrations.
- **Two roles, one URL contract**: `MIGRATE_DATABASE_URL` overrides `DATABASE_URL` if set. The deploy task definition (follow-up §13) sets `MIGRATE_DATABASE_URL` to the migration role's secret; the API task uses `DATABASE_URL` for the app role.

`loadEnv()` already supports `DATABASE_URL` plus the component-form fallback (`DB_HOST`/`DB_USER`/etc.). This ticket extends it to read `MIGRATE_DATABASE_URL` first, falling back to `DATABASE_URL` — a pure addition, no breaking change to existing consumers.

The CLI surfaces `code: '42501'` (insufficient_privilege) errors with a hint pointing operators at this section.

### 8.5 Staging Gap (between this ticket and §13)

When this ticket ships, the runner is built into the container but **the deploy pipeline does not call it**. The smoke migration sits in `backend/migrations/` unused on staging until the prod-invocation ticket lands. Verification that the binary works against staging RDS happens via the manual ECS-Exec gate in DoD (§14) — not via automated deploy. The staging schema is unchanged in the gap.

### 8.6 Prod Invocation Patterns (informational)

Follow-up ticket (§13) picks one. The runner supports both:

- **One-off ECS task** with the migration role secret, triggered before service update.
- **Server entrypoint chains the migration**: `node dist/db/migrate.js && node dist/server.js`. Requires the API container to also have `MIGRATE_DATABASE_URL`, which is undesirable — operators should prefer the one-off task pattern.

## 9. Smoke Migration

`backend/migrations/001_smoke.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

Idempotent. First run inserts `_migrations.version = '001_smoke.sql'`; second run is a no-op. Privilege model: §8.4.

## 10. Testing

### 10.1 CI Postgres Service (REQUIRED)

`.github/workflows/deploy.yml` adds a Postgres service container to the test job:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    env:
      POSTGRES_USER: mythrun
      POSTGRES_PASSWORD: mythrun_dev
      POSTGRES_DB: mythrun
    ports:
      - 5432:5432
    options: >-
      --health-cmd "pg_isready -U mythrun"
      --health-interval 5s
      --health-timeout 3s
      --health-retries 10
```

And exposes the URL to the test step:

```yaml
- run: pnpm --filter @mythrun/backend test
  env:
    DATABASE_URL: postgresql://mythrun:mythrun_dev@127.0.0.1:5432/mythrun
```

Without this, every `migrate.test.ts` run trips `guardTestDatabase` and red-lights deploys.

### 10.2 Vitest Setup

`backend/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./src/__tests__/setup-env.ts'],
    fileParallelism: false,
  },
})
```

`backend/src/__tests__/setup-env.ts`:

```ts
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Resolve relative to this file, not CWD — works from `pnpm --filter`
// or from a root-level invocation.
const here = fileURLToPath(import.meta.url)
config({ path: resolve(here, '../../../.env.development') })
```

Setup loads dotenv globally; only DB-touching tests call `guardTestDatabase` in their own `beforeAll` (§10.3). Non-DB tests (`app.test.ts`, `env.test.ts`) stay green.

### 10.3 DB Safety Guard (`guard-db.ts`)

```ts
const ALLOWED_DBS = /^mythrun(_test|_ci)?$/

export async function guardTestDatabase(databaseUrl: string): Promise<void> {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL not set — run `pnpm db:up` and ensure backend/.env.development exists, or set DATABASE_URL in CI')
  }
  const url = new URL(databaseUrl)
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  const dbName = url.pathname.slice(1)
  if (!isLocal || !ALLOWED_DBS.test(dbName)) {
    throw new Error(
      `Refusing to run destructive tests against ${url.hostname}/${dbName}. ` +
      `Tests require localhost with one of: mythrun, mythrun_test, mythrun_ci.`,
    )
  }
}
```

### 10.4 Per-Test Reset

`beforeEach`:

```sql
DROP EXTENSION IF EXISTS pgcrypto CASCADE;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO PUBLIC;
GRANT ALL ON SCHEMA public TO CURRENT_USER;
```

### 10.5 Pool Lifecycle

One `pg.Pool` per test file (`max: 5` is fine for tests since they do parallel `beforeEach` queries):

- `beforeAll`: call `guardTestDatabase(...)`; `pool = createPgPool(databaseUrl, { max: 5 })`.
- `beforeEach`: run reset SQL above against `pool`.
- `afterAll`: `await pool.end()`.

### 10.6 Fixture Migrations

Each test creates `mkdtempSync(path.join(os.tmpdir(), 'myt-32-'))` and writes its `.sql` files into it. Fixtures never touch `backend/migrations/`. `afterEach` removes the temp dir.

### 10.7 Test Cases

Tests 1–11 from v4, plus:

**Test 12 — `application_name` does not leak through pool checkout.**
Setup: a pool with `max: 1` (one shared client). Run a successful migration. Then check out the same client and query `current_setting('application_name')`.
Assertion: returns the empty string (or whatever the pool's default is), **not** `'mythrun-migrate'`. This pins the `SET LOCAL` invariant — an implementation that uses bare `SET` would fail this test.

**Test 13 — lock-wait heartbeat fires.**
Setup: in a separate `pg.Client`, `SELECT pg_advisory_lock(LOCK_KEY)`. Run `runMigrations` against the same DB; it will block. After 6s, log spy should have at least one `migrate.lock_waiting` event with a non-zero `waitMsSoFar`. Release the external lock; assert acquisition completes and `migrate.lock_acquired` records `waitMs >= ~6000`.

**Test 9 (logger contract) — concretized sink.**

```ts
import pino, { type DestinationStream } from 'pino'
const lines: string[] = []
const sink: DestinationStream = { write: (s: string) => { lines.push(s) } }
const logger = pino({
  base: { component: 'migrate' },
  serializers: { err: pino.stdSerializers.err },
}, sink)
```

No `as unknown as` cast — `DestinationStream` is the structural type pino expects.

### 10.8 What we're NOT testing here

- Concurrent runners racing across processes — covered in design via advisory lock; integration test would require parallel processes, deferred.
- `CREATE INDEX CONCURRENTLY`, checksum drift, very large files — deferred per scope.

## 11. Error Handling Summary

| Failure | Behavior |
|---------|----------|
| `DATABASE_URL` and `MIGRATE_DATABASE_URL` both unset (CLI) | `loadEnv()` throws → CLI logs `migrate.fatal` with first-run hint → exit 1 |
| `DATABASE_URL` unset (tests) | `guardTestDatabase` throws |
| `DATABASE_URL` points at wrong host/db (tests) | `guardTestDatabase` throws |
| Postgres unreachable | `pool.connect()` rejects within `connectionTimeoutMillis` → CLI `migrate.fatal` → exit 1 |
| Another runner holding the advisory lock | `migrate.lock_waiting` heartbeats every 5s; blocks until released |
| `migrationsDir` missing | `readdir` throws ENOENT → CLI exits 1 |
| File contains `BEGIN`/`COMMIT`/`ROLLBACK` | Validation rejects before any DB work |
| SQL error in migration | `ROLLBACK` (best-effort) → `migrate.failed` log → throw with `cause` → CLI exits 1; client destroyed (`release(err)`) |
| `CREATE EXTENSION` fails on RDS due to missing privilege (code 42501) | Surfaces as SQL error; CLI logs `migrate.fatal` with hint pointing at §8.4 |
| `pg_advisory_unlock` fails in `finally` | `migrate.unlock_failed` warn-level; auto-release on socket close backstops |
| `pool.end()` failure during CLI shutdown | Logged; doesn't change exit code |
| SIGTERM/SIGINT between migrations | Abort fires → `migrate.aborted` → return appliedSoFar → CLI exit 130 |
| SIGTERM/SIGINT during a migration's transaction | Signal does NOT cancel the pg query. Migration runs to completion. Abort check fires at next iteration; CLI exit 130. |
| ECS grace window too short for a long migration | SIGTERM → SIGKILL mid-COMMIT. Server-side rollback; lock auto-released on socket close. **Convergence impossible if the migration genuinely exceeds grace** — operator must run such migrations out-of-band (§13 picks the prod-invocation pattern with this in mind). |
| Process killed with SIGKILL | Server-side rollback + lock auto-release + re-run converges. |

No retries anywhere. Convergence is the deploy orchestrator's job. Exit 130 vs 1 is a convention this CLI emits; the deploy script (§13) keys on it.

## 12. Recovery

When a migration ships buggy or the wrong file was applied:

### 12.1 Mechanism (staging/prod)

Open a session via **ECS Exec** on a running task:

```bash
# Find the running task ARN
aws ecs list-tasks \
  --cluster mythrun \
  --service-name mythrun-staging-api \
  --region us-east-1

# Exec into the container (requires `enable-execute-command` on the service —
# verified during the Ops Foundation work)
aws ecs execute-command \
  --cluster mythrun \
  --task <TASK_ARN> \
  --container api \
  --interactive \
  --command "/bin/sh"
```

Or launch a one-off task with `psql` baked in (the prod-invocation ticket §13 will set this up).

### 12.2 Procedure

1. Connect with the migration role (the one with `rds_superuser` if extensions are involved).
2. Apply corrective SQL by hand. Commit.
3. If you want the next run to reapply the fixed migration: `DELETE FROM _migrations WHERE version = '<filename>'`. Otherwise leave the row and ship a new `NNN_fix_*.sql`.
4. **Never edit an applied migration file.** Append-only; see Backend Core spec §3.

### 12.3 Identifying What Went Wrong

```
# Last failed run
filter component = "migrate" and event = "migrate.failed"
| sort @timestamp desc | limit 1

# Reconstruct that run
filter component = "migrate" and runId = "<from-above>"
| sort @timestamp asc
```

A full runbook with screenshots is filed as a follow-up bead (§13).

## 13. Follow-up Beads (Not This Ticket)

- Wire `runMigrations` into server boot before `app.listen`. Order: `waitFor(pg)` → `runMigrations(pool)` → `app.listen`. Server passes `app.log` (Fastify logger satisfies `MigrateLogger`).
- Pick the prod invocation pattern, wire the Terraform task definition with the migration-role secret + `MIGRATE_DATABASE_URL`, verify `rds_superuser`, and budget-check that any expected migration fits the ECS grace window.
- Write the recovery runbook for staging/prod, referenced by §12.
- Reconcile Backend Core spec §6 (still describes `runMigrations(pool)` single-arg, `pool.ts`, and a `createServer()` shape that doesn't match the MYT-29 boot gate).
- `--dry-run` flag (acquires lock, prints plan, releases) and `--list-pending` (no lock).
- `CREATE INDEX CONCURRENTLY` support via `-- pg-migrate: no-transaction` header.
- File-checksum drift detection.
- Suppress pino `pid`/`hostname` in production if log volume becomes a concern.

## 14. Definition of Done

- `backend/src/db/migrate.ts` implements `runMigrations` + the CLI block (§3, §5, §6).
- `backend/src/db/lock-key.ts` exports `LOCK_KEY` as a pinned bigint literal with the "DO NOT REGENERATE" comment.
- `backend/src/db/postgres.ts` accepts `Partial<PoolConfig>` overrides; existing callers unaffected.
- `backend/src/config/env.ts` reads `MIGRATE_DATABASE_URL` first, falls back to `DATABASE_URL`.
- `backend/migrations/001_smoke.sql` exists with `CREATE EXTENSION IF NOT EXISTS pgcrypto`.
- `backend/Dockerfile` runtime stage copies `migrations/` into the container.
- `backend/vitest.config.ts` sets `fileParallelism: false` and loads `.env.development` via the setup file.
- `backend/src/db/__tests__/migrate.test.ts` covers Tests 1, 2, 3, 3b, 4, 5, 6, 7, 8, 9, 11, 12, 13.
- `backend/src/db/__tests__/lock-key.test.ts` covers Test 10.
- `.github/workflows/deploy.yml` adds the `postgres:16-alpine` service and `DATABASE_URL` to the test step.
- `pino` and `uuidv7` are direct dependencies of `backend/package.json`. Versions pinned in `package.json`: `pino@^10.3.1`, `uuidv7@^1.0.2` (or current).
- `pnpm db:migrate` works locally: first run applies `001_smoke.sql`, second is a no-op.
- **Manual verification against staging RDS**: run `node dist/db/migrate.js` against staging once via ECS Exec or a one-off task. Capture the structured log output (must include `migrate.start`, `migrate.lock_acquired`, `migrate.applied`, `migrate.done` with non-empty `durationMs`) and attach to the ticket. Only way to confirm binary, env contract, TLS, and `rds_superuser` privilege all line up before §13 lands.
- **Wiki**: a new page at `docs/wiki/content/runtime/migrations.html` (or extension to an existing runtime page) documents the runner contract, `pnpm db:migrate`, the CloudWatch Insights cookbook, and the recovery pointer to §12. Per CLAUDE.md "wiki is not optional."
- `pnpm typecheck` + `pnpm lint` + `pnpm test` all green locally and in CI.

## 15. Changes in v5 (post-third-blind-review)

Reviewed by Cavatappi/Orecchiette/Pici/Bucatini. Convergent findings:

1. **Pool size constrained to `max: 1`** + `connectionTimeoutMillis: 10_000` (Orecchiette) — was wasteful default-10 + unbounded timeout.
2. **`createPgPool` extended to accept `Partial<PoolConfig>`** (Orecchiette) — clean API for #1.
3. **`SET LOCAL application_name`** instead of bare `SET` (Bucatini BLOCKER) — bare `SET` survives `release()` and pollutes the next pool checkout.
4. **`release(err)` not `release(true)`** (Orecchiette) — pg-pool's documented signature; pass the actual pg error.
5. **Unlock try/catch wrapped explicitly** (Orecchiette) — broken-socket unlock failure was masking the original migration error.
6. **Lock-wait heartbeat (`migrate.lock_waiting`)** (Cavatappi) — runner blocked behind another lock was previously invisible.
7. **`MIGRATE_DATABASE_URL` env var** with `loadEnv()` extension (Bucatini BLOCKER for §13) — migration role and API role need different secrets; making this a pure addition to `loadEnv()` keeps local dev untouched.
8. **`MigrateLogger` narrowed to `Pick<pino.BaseLogger, ...>`** (Bucatini) — Fastify logger satisfies it without a cast; future server-boot wiring works without type gymnastics.
9. **Test 9 sink uses `DestinationStream`, not `as unknown as SonicBoom`** (Pici BLOCKER) — code-conventions violation removed.
10. **Tests 12 (application_name leak) and 13 (lock-wait heartbeat)** added — pin invariants 3 and 6.
11. **CLI catches `loadEnv()` failures with first-run hint** (Cavatappi) — better DX for new contributors.
12. **CLI surfaces 42501 (insufficient_privilege) with `hint` pointing at §8.4** (Cavatappi) — fast path during 3am triage.
13. **CloudWatch Insights cookbook (§7.1)** — five paste-ready queries for incident response.
14. **§12 Recovery includes paste-ready ECS Exec commands** (Cavatappi) — actionable, not handwave.
15. **Optional fields use `T | undefined`** (Pici) — interoperates with `exactOptionalPropertyTypes`.
16. **Naming: `MigrationOptions` over `MigrateOptions`** (Pici) — consistent with `AppliedMigration`.
17. **Pino and uuidv7 versions pinned in DoD** (Pici).
18. **Wiki coverage in DoD** (Bucatini) — CLAUDE.md mandates it; was missing.
19. **Backend Core §6 reconciliation as a follow-up bead** (Bucatini) — three contradictions with v5 + actual `server.ts`.
20. **§8.5 staging-gap note** (Bucatini) — clarifies that the smoke migration is dormant on staging until §13 lands.
21. **`MigrationOptions.runId?: string | undefined`** + caller guidance in §3.
22. **§13 explicit ordering note** (Bucatini): `waitFor(pg)` → `runMigrations` → `app.listen`.
23. **`pg_advisory_unlock` documented to fail-warn-and-continue** with auto-release as backstop (Orecchiette + Pici).
24. **Idle-timeout invariant inside open transaction documented** (Orecchiette).
25. **`SET LOCAL` override-by-migration-script semantics documented** as intentional escape hatch (Orecchiette).

## 16. Earlier Versions

- **v1** — initial brainstorm output.
- **v2** — first blind review (Bert/SQL, Ernie/tests, Oscar/ops, Big Bird/scope): advisory lock, statement timeouts, BEGIN/COMMIT validation, `release()` discipline, PG15 default privileges, vitest parallelism, dotenv, guard-db, argv guard, Dockerfile copy, workspace scripts, Tests 3b/6/7.
- **v3** — production-lens correction: restored `durationMs`, swapped console for pino, AbortSignal + signal handling, structured event names, Tests 8/9. Saved `feedback_production_lens.md`.
- **v4** — second blind review (Vermillion/Chartreuse/Periwinkle/Mauve): pino `err` serializer, `event` field, `runId`, `application_name`, RDS privilege docs, CI Postgres service, `installSignalHandlers` reuse, recovery actionability, staging-RDS DoD gate, Test 11.
- **v5** — this version, items 1–25 above.
