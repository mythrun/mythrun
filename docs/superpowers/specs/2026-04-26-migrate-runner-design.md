# Migration Runner — Design Spec

> **Linear issue**: [MYT-32](https://linear.app/mythrun/issue/MYT-32) — Backend Core: schema migration runner (`migrate.ts`)
> **Parent spec**: `docs/specs/2026-04-13-backend-core.md` §3 (Migration Runner)
> **Date**: 2026-04-26
> **Status**: Draft v4 (post-second-blind-review)

## 1. Goal

Ship a small, reliable SQL migration runner so the Postgres schema can be evolved in append-only `.sql` files. This ticket builds the runner only — the actual Backend Core schema lands in a separate Platform issue. A single placeholder migration is included to exercise the runner end-to-end.

The runner must be:

- **Idempotent** (running twice is a no-op the second time).
- **Atomic per file** (a failed migration leaves no half-applied state).
- **Concurrency-safe** via Postgres advisory lock (two ECS tasks racing on deploy is a real scenario).
- **Append-only honor system** (we trust the rule "never edit applied migrations"; no checksum drift detection in v1).
- **Usable as a CLI** (`pnpm db:migrate`) **and as an importable function** (so future code can call it from server boot).
- **Production-grade observability** — structured pino logs with stable `event` keys queryable from CloudWatch Logs Insights, per-migration `durationMs`, a per-run `runId`, `application_name` set on the migration session for `pg_stat_activity`/Performance Insights triage.
- **Production-grade operability** — SIGTERM/SIGINT handled via the existing `installSignalHandlers` helper, exit codes that distinguish graceful-stop from crash, recovery procedure that names the actual mechanism (ECS Exec / one-off task), and a verified-against-staging-RDS gate before the ticket closes.

Out of scope: server-boot wiring, `CREATE INDEX CONCURRENTLY` support (handled by a future no-transaction header), checksum drift detection, the actual schema migrations, automatic rollback.

## 2. File Layout

```
backend/
  migrations/                              # NEW — outside src/, never compiled
    001_smoke.sql                          # CREATE EXTENSION IF NOT EXISTS pgcrypto;
  src/
    db/
      postgres.ts                          # already exists (createPgPool)
      migrate.ts                           # NEW — runner logic + CLI entrypoint
      lock-key.ts                          # NEW — pinned LOCK_KEY constant
      __tests__/
        migrate.test.ts                    # NEW — integration tests
        lock-key.test.ts                   # NEW — drift test for LOCK_KEY
        guard-db.ts                        # NEW — shared "is this a safe DB?" check
  vitest.config.ts                         # NEW — at backend/, loads .env.development
  Dockerfile                               # MODIFIED — runtime stage copies migrations/
.github/workflows/
  deploy.yml                               # MODIFIED — adds Postgres service for tests
```

Rationale (locked in during brainstorm):

- **Code under `src/db/`** keeps the data layer cohesive (next to `postgres.ts`, future `repository.ts`).
- **`.sql` files outside `src/`** so `tsc` never sees them and no build-step copy is required.
- **Tests co-located** under `__tests__/` per the project test convention.
- **`lock-key.ts` as its own module** so the constant has a clear home and the drift test has something to import.

## 3. Runner Contract

```ts
// backend/src/db/migrate.ts

import type { Pool } from 'pg'
import type { Logger } from 'pino'

export interface AppliedMigration {
  readonly version: string
  readonly durationMs: number
}

export interface MigrateOptions {
  readonly pool: Pool
  readonly migrationsDir: string
  readonly logger: Logger
  readonly abortSignal?: AbortSignal
  readonly runId?: string                   // caller-supplied for cross-system correlation; default uuidv7()
}

export async function runMigrations(
  opts: MigrateOptions,
): Promise<AppliedMigration[]>
```

- Returns migrations applied **during this invocation**, each with the wall-clock duration of its transaction. Empty array = nothing was pending.
- Throws on first failure. Does not attempt subsequent files.
- The caller owns the pool's lifecycle (the runner does not call `pool.end()`).
- `logger` is required (no default). The CLI passes a pino instance configured with the `err` serializer; future server-boot wiring will pass the Fastify logger; tests pass a writable-stream-spy logger.
- `abortSignal` lets the CLI's signal handler request a graceful stop after the in-flight transaction commits. When fired, the runner finishes the current migration (or rolls it back on error) and returns; subsequent unapplied migrations are deferred to the next run.
- `runId` is included on every log event so interleaved concurrent-runner output in CloudWatch can be untangled. CLI generates `uuidv7()` if not supplied.

## 4. Tracking Table

```sql
CREATE TABLE IF NOT EXISTS _migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- Underscore prefix marks it as framework metadata.
- `version` is the full filename — natural key, no surrogate id.
- The `CREATE TABLE IF NOT EXISTS` runs *inside the advisory-lock-held section* (§5) so a fresh-DB race doesn't collide on `duplicate_table`.

## 5. Algorithm

```
0. logger.info({ event: 'migrate.start', runId, migrationsDir,
                 pgServerVersion, dbHost, nodeVersion }, 'migrate.start')
1. client = await pool.connect()
   try:
     SET application_name = 'mythrun-migrate'         // surfaces in pg_stat_activity
     2. lockStart = performance.now()
        await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
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
          d. SET LOCAL statement_timeout = 0
          e. SET LOCAL lock_timeout = '30s'
          f. client.query(fileContents)
          g. INSERT INTO _migrations (version) VALUES ($1)
          h. COMMIT
          i. durationMs = round(performance.now() - start)
          j. logger.info({ event: 'migrate.applied', runId, version, durationMs },
                         'migrate.applied')
          k. appliedSoFar.push({ version, durationMs })
        on error in (c)–(g):
          - try client.query('ROLLBACK')
          - durationMs = round(performance.now() - start)
          - logger.error({ event: 'migrate.failed', runId, version, durationMs,
                           err: pgErr }, 'migrate.failed')
          - throw new Error(`migration ${version} failed: ${pgErr.message}`,
                            { cause: pgErr })
   finally:
     - try await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY])
       logger.info({ event: 'migrate.lock_released', runId,
                     holdMs: round(performance.now() - lockStart) },
                   'migrate.lock_released')
     - if error path: client.release(true)
       else:           client.release()
     - logger.info({ event: 'migrate.done', runId,
                     applied: appliedSoFar.length,
                     totalMs: round(performance.now() - runStart) },
                   'migrate.done')
```

**Why the advisory lock.** Two runners both `SELECT version FROM _migrations` simultaneously, both see "001 not applied," both run the same `CREATE TABLE` — second runner gets `duplicate_table`. `pg_advisory_lock` is a session-level mutex Postgres provides exactly for this. Held for the run duration; auto-releases on connection close (so a crashed runner doesn't wedge subsequent ones).

**Why `SET LOCAL statement_timeout = 0`.** RDS parameter groups commonly set a non-zero default. A real schema migration may exceed it. `SET LOCAL` scopes the change to the current transaction. Same logic for `lock_timeout`, capped at 30s so a migration blocked on someone else's `AccessExclusiveLock` fails loud.

**Why `application_name`.** Without it, `pg_stat_activity` and Performance Insights show the connection as `node`, identical to the API server. Setting it surfaces "this connection is the migration job" during 3am triage.

**Why one client throughout.** Advisory locks are session-scoped; the bookkeeping insert and the migration SQL must share a session for transactional consistency. `pool.query()` may use a different physical connection per call.

**Why `release(true)` on error.** If `ROLLBACK` itself failed (broken connection), the client is in an indeterminate state. `release(true)` destroys the underlying socket so the pool doesn't hand it to the next caller.

### 5.1 LOCK_KEY (`backend/src/db/lock-key.ts`)

```ts
/**
 * Stable bigint passed to pg_advisory_lock.
 *
 * DO NOT REGENERATE THIS VALUE. It was computed once via:
 *
 *   SELECT hashtextextended('mythrun_migrate', 0);
 *
 * Re-deriving against a different Postgres version (or a different seed)
 * would produce a different bigint, causing a runner built from new code
 * to use a different lock from a runner built from old code — defeating
 * the concurrency guard during a rolling deploy.
 *
 * If a second app ever shares this RDS, prefix with a stack-id high-32-bits
 * and re-pin (and document the migration path).
 */
export const LOCK_KEY = -3411702991737540243n
```

The exact bigint is captured at implementation time by running the SQL above against the local docker-compose Postgres, written into the source file, and never regenerated. `lock-key.test.ts` asserts the literal so a future contributor who refactors can't silently change it.

### 5.2 Migration File Validation

Before executing each file, regex-reject any of these statements at line-start (case-insensitive, ignoring leading whitespace):

```
^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END)\s*[;]?\s*$
```

Reason: pg's simple-query protocol runs `client.query(multipleStatements)` as a batch *inside our outer BEGIN/COMMIT*. If the file contains its own `COMMIT`, our outer transaction terminates early and subsequent statements run in implicit individual transactions — partial application without our knowledge.

`CREATE INDEX CONCURRENTLY` is also incompatible with our wrapper transaction; it'll be supported in a future ticket via an opt-in `-- pg-migrate: no-transaction` header.

## 6. CLI Entrypoint

At the bottom of `migrate.ts`:

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

  const env = loadEnv()
  const pool = createPgPool(env.databaseUrl)
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
      // Aborted-but-graceful: in-flight migration committed. Exit 130 by
      // convention so the deploy script in §13 can key on "told to stop"
      // vs "crashed" (exit 1) when picking the prod-invocation pattern.
      process.exitCode = 130
    }
  } catch (err) {
    logger.error({ event: 'migrate.fatal', runId, err }, 'migrate.fatal')
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}
```

The `argv1 &&` guard is required — under `noUncheckedIndexedAccess`, `process.argv[1]` is `string | undefined`, and `pathToFileURL('')` throws.

**Signal handling**: reuses `installSignalHandlers` from MYT-29. SIGTERM is what ECS sends during deploys (default 30s grace). The handler trips the `AbortController`; the runner finishes the in-flight transaction (or rolls it back on error) and returns at the next iteration boundary.

**Note on signal-during-query**: SIGTERM does **not** cancel pg's open syscall. Node's signal handler runs in the JS event loop, trips `abortController.abort()`, but the `pg.Client.query` continues until the server replies. The migration runs to completion; the abort check fires before the next file; CLI exits 130. If the migration is genuinely too slow for the ECS grace window, ECS escalates to SIGKILL — server-side rollback handles it (advisory lock auto-releases on socket close), and the next deploy task converges. See §11 for the full failure matrix.

**Note on shutdown bound**: `pool.end()` waits for in-flight queries to drain. Bounded by the in-flight migration's duration; SIGKILL is the backstop.

## 7. Logging

Pino, structured JSON, injected via `MigrateOptions.logger`. The runner uses an explicit top-level `event` field (in addition to pino's default `msg`) so CloudWatch Logs Insights can do structured queries:

```
filter event = "migrate.applied"
| stats avg(durationMs), max(durationMs) by version
```

Without the `event` field, querying would devolve to substring match on `@message`, which collides on similar names (`migrate.applied` matches `migrate.applied_index_concurrent`).

| `event` value | Level | Fields | When |
|--------------|-------|--------|------|
| `migrate.start` | info | `runId`, `migrationsDir`, `pgServerVersion`, `dbHost`, `nodeVersion` | Top of `runMigrations` |
| `migrate.lock_acquired` | info | `runId`, `waitMs` | After `pg_advisory_lock` returns |
| `migrate.lock_released` | info | `runId`, `holdMs` | `finally` block, after unlock |
| `migrate.no_migrations_found` | info | `runId` | Migrations dir empty after filter |
| `migrate.plan` | info | `runId`, `pending`, `total`, `pendingVersions` | After comparing applied vs available |
| `migrate.applied` | info | `runId`, `version`, `durationMs` | After each successful `COMMIT` |
| `migrate.failed` | error | `runId`, `version`, `durationMs`, `err` | After `ROLLBACK` on failed migration |
| `migrate.aborted` | warn | `runId`, `appliedSoFar`, `remaining` | When `abortSignal` fires between migrations |
| `migrate.done` | info | `runId`, `applied`, `totalMs` | `finally`, after lock release |
| `migrate.signal_received` | warn | `signal` | CLI-level handler |
| `migrate.complete` / `migrate.no_pending` | info | `runId`, `count`, `versions` | CLI summary |
| `migrate.fatal` | error | `runId`, `err` | CLI-level catch |

**Pino configuration choices, written down so they don't drift:**

- **`serializers: { err: pino.stdSerializers.err }`** — REQUIRED. Without it, `{ err: pgErr }` serializes as `{}` (Error fields are non-enumerable). The std serializer captures `message`, `stack`, `cause`, and pg-specific fields (`code`, `position`, `severity`, etc.).
- **`base: { component: 'migrate' }`** — every event tagged with `component=migrate` for cross-component CloudWatch queries.
- **No async transport** — pino with no `transport` config writes synchronously to stdout. Logs are not lost on `process.exitCode = 1` shutdown. If anyone later adds `transport: { target: 'pino-pretty' }`, they must also call `await logger.flush()` before exit; this is called out in a comment at the pino construction site.
- **`pid`/`hostname`** — pino emits these by default; they're noise in CloudWatch (which already has task-ARN context). Suppress via a custom `formatters.bindings` if it bothers operators in practice. Not pinned in v1 to avoid YAGNI on the suppression direction; tracked as a follow-up if log volume becomes an issue.

**Log levels per environment:**

- Dev: `LOG_LEVEL=debug` recommended (still uses info as default).
- CI: `LOG_LEVEL=info`.
- Prod (staging/prod ECS): `LOG_LEVEL=info`.

`migrate.lock_acquired` and `migrate.lock_released` were demoted from debug to info specifically because "did we acquire the lock and how long did we hold it?" is the post-incident question.

## 8. Build & Invocation

### 8.1 Dockerfile

The runtime stage currently copies only `/app/deploy/`. Add, after the existing `COPY ... /app/deploy ./`:

```dockerfile
COPY --from=builder --chown=mythrun:mythrun /app/backend/migrations ./migrations
```

This places `.sql` files at `/app/migrations`. From `/app/dist/db/migrate.js`, `../../migrations` resolves to `/app/migrations` — same code path as local.

### 8.2 Scripts

In `backend/package.json`:

```json
"db:migrate": "tsx --env-file=.env.development src/db/migrate.ts",
"db:migrate:compiled": "node dist/db/migrate.js"
```

In root `package.json`:

```json
"db:migrate": "pnpm --filter @mythrun/backend db:migrate"
```

CI/prod invokes `node dist/db/migrate.js` directly with env injected by the task definition.

### 8.3 RDS Privilege Requirement (important)

The smoke migration is `CREATE EXTENSION IF NOT EXISTS pgcrypto`. On RDS, `CREATE EXTENSION` for whitelisted extensions (pgcrypto is whitelisted) requires `rds_superuser`. Implication:

- The role used to run migrations against staging/prod must have `rds_superuser`. By default this is the master/owner role created by Terraform.
- The role used by the running API service (per Auth & Users spec) is a less-privileged app role and **must not** be used to run migrations.

This becomes a hard prerequisite for the prod-invocation-pattern decision (§13). The deploy ticket for that pattern must document which role/secret is used and verify the privilege exists before flipping the switch.

### 8.4 Prod Invocation Pattern (informational)

The actual ECS wiring is a follow-up ticket (§13). Patterns the operator will pick from:

- **One-off ECS task** triggered before service update. Cleanest separation; uses a different task definition with the migration-role secret.
- **Server entrypoint chains the migration**: `node dist/db/migrate.js && node dist/server.js`. Simpler ops, but every container restart re-acquires the advisory lock. Also requires the API container to have the migration-role secret — undesirable.

This spec doesn't pick — but ensures the binary, SQL files, env contract, signal handling, and exit codes work for either approach without further code changes.

## 9. Smoke Migration

`backend/migrations/001_smoke.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

Idempotent. Confirms `_migrations.version = '001_smoke.sql'` after first run; second run is a no-op. Privilege model documented in §8.3.

## 10. Testing

### 10.1 CI Postgres service (REQUIRED)

`pnpm --filter @mythrun/backend test` runs in `.github/workflows/deploy.yml` today **without a Postgres service**. As written, `migrate.test.ts` will trip `guardTestDatabase` and red-light deploys. This ticket adds a `services:` block to the build job:

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

And exposes `DATABASE_URL` to the test step:

```yaml
- run: pnpm --filter @mythrun/backend test
  env:
    DATABASE_URL: postgresql://mythrun:mythrun_dev@127.0.0.1:5432/mythrun
```

Same docker-compose config, in CI form. This is a build-system change inside the ticket's scope.

### 10.2 Vitest setup

`backend/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./src/__tests__/setup-env.ts'],
    fileParallelism: false,    // tests share one Postgres database; serialize at file level
  },
})
```

`backend/src/__tests__/setup-env.ts`:

```ts
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Resolve relative to this file, not CWD — works from `pnpm --filter`
// (CWD = backend/) or from a root-level `pnpm test` (CWD = repo root).
const here = fileURLToPath(import.meta.url)
config({ path: resolve(here, '../../../.env.development') })
```

The file is loaded by **every** vitest test file (vitest's `setupFiles` is global). It only loads dotenv — it does **not** import `guardTestDatabase` directly. Tests that hit Postgres call the guard explicitly in their own `beforeAll`. This keeps non-DB tests (`app.test.ts`, `env.test.ts`, etc.) green.

### 10.3 DB Safety Guard (`guard-db.ts`)

```ts
import { Client } from 'pg'

const ALLOWED_DBS = /^mythrun(_test|_ci)?$/

export async function guardTestDatabase(databaseUrl: string): Promise<void> {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL not set — run `pnpm db:up` and ensure backend/.env.development exists, or set DATABASE_URL explicitly in CI')
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

Called from `migrate.test.ts`'s top-level `beforeAll`.

### 10.4 Per-Test Reset

`beforeEach` issues, against the test pool's pre-existing connection:

```sql
DROP EXTENSION IF EXISTS pgcrypto CASCADE;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO PUBLIC;
GRANT ALL ON SCHEMA public TO CURRENT_USER;
```

Why each line: see v3 spec text — handles PG 15+ default-privilege regression and stale extension state.

### 10.5 Pool Lifecycle

One `pg.Pool` per test file:

- `beforeAll`: call `guardTestDatabase(process.env.DATABASE_URL!)`; create `pool = createPgPool(databaseUrl)`.
- `beforeEach`: run reset SQL above against `pool`.
- `afterAll`: `await pool.end()`.

`fileParallelism: false` ensures only one file at a time uses the pool; multiple `describe` blocks within `migrate.test.ts` share the file-level pool.

### 10.6 Fixture Migrations

Each test creates its own temp directory of `.sql` files via `fs.mkdtempSync(path.join(os.tmpdir(), 'myt-32-'))` and passes that path to `runMigrations`. Fixtures never touch `backend/migrations/`. `afterEach` removes the temp dir.

### 10.7 Test Cases

**Test 1 — empty DB, all migrations apply.**
Fixtures: `001_a.sql` (`CREATE TABLE a (id INT)`), `002_b.sql`, `003_c.sql`.
Assertions:
- `runMigrations` returns 3 entries with versions in order.
- Each entry's `durationMs` is `>= 0` and finite.
- Tables `a`, `b`, `c` exist.
- `_migrations` rows match.

**Test 2 — partial state, only unapplied run.** (as v3)

**Test 3 — failed migration aborts the run.**
- `runMigrations` throws; error message contains `002_broken.sql`.
- Cause is preserved (`err.cause` has the original `pgErr`).
- Tables and `_migrations` state as v3.

**Test 3b — bookkeeping insert is inside the transaction.** (as v3)

**Test 4 — empty migrations directory.** (as v3)

**Test 5 — second run is a no-op.** (as v3)

**Test 6 — non-`.sql` files and dotfiles are ignored.** (as v3)

**Test 7 — banned transaction statement is rejected.** (as v3)

**Test 8 — `abortSignal` requests a graceful stop between migrations.**
Fixtures: `001_a.sql`, `002_b.sql`, `003_c.sql` (all valid).
Setup: pre-arm an `AbortController`. Use a logger spy that calls `abortController.abort()` when it sees the first `event: 'migrate.applied'`.
Assertions:
- `runMigrations` returns 1 entry (`001_a.sql`).
- Tables `b` and `c` do **not** exist; `_migrations` has only `001_a.sql`.
- A `migrate.aborted` event was logged.
- Re-running without abort completes the remaining two — convergence.

**Test 9 — pino logger contract.**
Use a writable-stream-spy logger:

```ts
const lines: string[] = []
const sink = { write: (s: string) => { lines.push(s); return true } }
const logger = pino(
  { base: { component: 'migrate' },
    serializers: { err: pino.stdSerializers.err } },
  sink as unknown as SonicBoom,
)
```

Fixtures: same as Test 1.
Assertions:
- Captured events include exactly: `migrate.start`, `migrate.lock_acquired`, `migrate.plan`, three `migrate.applied`, `migrate.lock_released`, `migrate.done`.
- Each `migrate.applied` has `event`, `runId`, `version`, `durationMs`.
- `migrate.start` has `pgServerVersion`, `dbHost`, `nodeVersion`.
- All events share the same `runId`.
- No `migrate.failed` event.
- `component` is `'migrate'` on every event.

**Test 10 — `LOCK_KEY` literal drift test** (in `lock-key.test.ts`).
```ts
import { LOCK_KEY } from '../lock-key.js'

it('LOCK_KEY is the pinned literal — see lock-key.ts comment for why', () => {
  expect(LOCK_KEY).toBe(-3411702991737540243n)
})
```

If a future contributor changes the constant, this test fails and the comment in `lock-key.ts` explains the consequence.

**Test 11 — error logging includes serialized stack.**
Fixtures: `001_broken.sql` (syntax error).
Setup: writable-stream-spy logger as in Test 9.
Assertions:
- Captured `migrate.failed` event has `err.message` non-empty.
- `err.stack` is a string (verifies the std serializer is wired).
- `err.cause` references the pg error or `err.code` is set (pg's std-serializer captures `code`).

### 10.8 What we're NOT testing here

- Concurrent runners racing — covered in design via advisory lock; integration test would require parallel processes, deferred.
- `CREATE INDEX CONCURRENTLY`, checksum drift, very large files — deferred per scope.

## 11. Error Handling Summary

| Failure | Behavior |
|---------|----------|
| `DATABASE_URL` unset (CLI) | `loadEnv()` throws → CLI catches → exit 1 |
| `DATABASE_URL` unset (tests) | `setup-env.ts` loads dotenv; if still unset, `guardTestDatabase` throws with actionable message |
| `DATABASE_URL` points at wrong host/db (tests) | `guardTestDatabase` throws |
| Postgres unreachable | `pool.connect()` rejects → CLI logs `migrate.fatal` → exit 1 |
| Another runner holding the advisory lock | Block (do not error) until released |
| `migrationsDir` missing | `readdir` throws ENOENT → CLI exits 1 |
| File contains `BEGIN`/`COMMIT`/`ROLLBACK` | Validation rejects before any DB work; error names file + token |
| SQL error in migration | `ROLLBACK` (best-effort) → `migrate.failed` log → throw with `cause` → CLI exits 1; client destroyed (`release(true)`) |
| `CREATE EXTENSION` fails on RDS due to missing privilege | Surfaces as a SQL error (above row); operator must run as `rds_superuser`. See §8.3. |
| `pool.end()` failure during CLI shutdown | Logged at error level but doesn't change exit code |
| SIGTERM/SIGINT between migrations | `abortController.abort()` fires → `migrate.aborted` log → runner returns appliedSoFar → CLI exits 130. Re-run converges. |
| SIGTERM/SIGINT during a migration's transaction | Signal does NOT cancel the in-flight pg query. Migration runs to completion (or fails normally and falls into the SQL-error row). Abort check fires at next iteration; CLI exits 130. |
| ECS grace window too short for a long migration | SIGTERM at second 28 of 30s grace, SIGKILL at second 30 mid-COMMIT. Postgres rolls back server-side; advisory lock auto-releases on socket close. **Convergence is impossible if the migration genuinely exceeds grace** — operator must run such migrations out-of-band (one-off ECS task with no grace deadline). Documented as an explicit prerequisite in §13. |
| Process killed with SIGKILL | No graceful path. Server-side rollback + lock auto-release + re-run converges (as above). |

No retries anywhere. Convergence is the deploy orchestrator's job (re-run the task). Exit code 130 vs 1 is a convention this CLI emits; the deploy script in §13 keys on it.

## 12. Recovery

When a migration ships buggy or the wrong file was applied:

1. The runner has no automated rollback. Recovery is manual SQL.
2. **Mechanism for staging/prod**: open a session via **ECS Exec** on a running task (`aws ecs execute-command --task ... --command "/bin/sh"`), or launch a one-off task with `psql` available. The Backend Core runbook (to be written as part of the prod-invocation ticket, §13) names the exact commands.
3. **Procedure**:
   1. Connect with the migration role (the one with `rds_superuser` if extensions were affected).
   2. Apply the corrective SQL by hand. Commit.
   3. `DELETE FROM _migrations WHERE version = '<filename>'` if you want the next run to reapply it; otherwise leave the row in place and ship a new migration `NNN_fix_*.sql` that brings the DB to the desired state.
4. **Never edit an applied migration file.** Append-only is enforced by convention; see Backend Core spec §3 "Migration Discipline."

A runbook stub is filed as a follow-up bead (§13).

## 13. Follow-up Beads (Not This Ticket)

To create after this ticket lands:

- Wire `runMigrations` into server boot before `app.listen`.
- Pick the prod invocation pattern (one-off ECS task vs. server CMD chain), wire the Terraform task definition with the migration-role secret, and verify `rds_superuser` privilege is in place. Includes a budget check that any expected migration fits the ECS grace window.
- Write the recovery runbook for staging/prod, referenced by §12.
- Add `CREATE INDEX CONCURRENTLY` support via a `-- pg-migrate: no-transaction` header.
- Add file-checksum drift detection on `_migrations`.
- Suppress pino `pid`/`hostname` in production if log volume becomes a concern.

## 14. Definition of Done

- `backend/src/db/migrate.ts` implements `runMigrations` + the CLI block (§3, §5, §6).
- `backend/src/db/lock-key.ts` exports `LOCK_KEY` as a pinned bigint literal with the "DO NOT REGENERATE" comment.
- `backend/migrations/001_smoke.sql` exists with `CREATE EXTENSION IF NOT EXISTS pgcrypto`.
- `backend/Dockerfile` runtime stage copies `migrations/` into the container.
- `backend/vitest.config.ts` sets `fileParallelism: false` and loads `.env.development` via the setup file.
- `backend/src/db/__tests__/migrate.test.ts` covers Tests 1, 2, 3, 3b, 4, 5, 6, 7, 8, 9, 11.
- `backend/src/db/__tests__/lock-key.test.ts` covers Test 10.
- `.github/workflows/deploy.yml` adds the `postgres:16-alpine` service container and `DATABASE_URL` env to the test step.
- `pino` is a direct dependency of `backend/package.json` (was transitive via Fastify).
- `uuidv7` (or equivalent) is a direct dependency for `runId` generation.
- `pnpm db:migrate` works locally: first run applies `001_smoke.sql`, second run is a no-op.
- **Manual verification against staging RDS**: run `node dist/db/migrate.js` against staging once via ECS Exec or a one-off task. Capture the structured log output (must include `migrate.start`, `migrate.lock_acquired`, `migrate.applied`, `migrate.done` with non-empty `durationMs`) and attach it to the ticket. This is the only way to confirm the binary, env contract, TLS handling, and `rds_superuser` privilege all line up before the prod-invocation ticket lands.
- `pnpm typecheck` + `pnpm lint` + `pnpm test` all green locally and in CI.

## 15. Changes in v4 (post-second-blind-review)

Reviewed by four blind subagents (Vermillion/logging, Chartreuse/signals, Periwinkle/tests, Mauve/prod). Convergent findings drove these revisions:

1. **`event` top-level field added to every log call** (Vermillion) — substring matching on `msg` collides; `event` makes CW Insights queries structured.
2. **`runId` (UUIDv7) propagated through every event** (Vermillion) — interleaved concurrent-runner output is otherwise unreadable.
3. **`pino.stdSerializers.err` configured** (Vermillion BLOCKER) — without it, `migrate.failed` logs `err: {}` because Error fields are non-enumerable. Real bug, fixed.
4. **`migrate.start` payload extended** with `pgServerVersion`, `dbHost`, `nodeVersion` (Vermillion) — cross-deploy correlation.
5. **`migrate.lock_acquired`/`migrate.lock_released` promoted to info with `holdMs`** (Vermillion) — post-incident query.
6. **Test 9 spy concretized** (Vermillion) — explicit writable-stream sink, not `pino.destination()`.
7. **Test 11 added** — verifies the `err` serializer actually serializes (catches a future regression of #3).
8. **`installSignalHandlers` reused** from MYT-29's `boot/signal-handlers.ts` (Chartreuse) — no inlined duplicate.
9. **§11 SIGTERM rows corrected** (Chartreuse) — signal does NOT cancel pg syscall; migration completes; abort fires next iteration.
10. **§11 SIGKILL-from-tight-grace row added** (Chartreuse) — explicit acknowledgment that long migrations must run out-of-band.
11. **§13 follow-up calls out grace-window budget check** (Chartreuse).
12. **CI workflow update is in scope** (Periwinkle BLOCKER) — `deploy.yml` adds Postgres service container; otherwise tests can't run in CI and DoD is unverifiable.
13. **`guardTestDatabase` accepts `mythrun|mythrun_test|mythrun_ci`** (Periwinkle) — CI-friendly.
14. **dotenv path resolved via `import.meta.url`** (Periwinkle) — CWD-independent.
15. **`setup-env.ts` does NOT call the guard** (Periwinkle) — only loads dotenv globally; only DB-touching tests call the guard. Keeps `app.test.ts` etc. green.
16. **Pool lifecycle made explicit** (Periwinkle) — one pool per file, top-level beforeAll/afterAll.
17. **`LOCK_KEY` extracted to its own module** with literal pinning + drift test (Mauve) — Test 10.
18. **`SET application_name = 'mythrun-migrate'`** added to the migration session (Mauve) — Performance Insights / `pg_stat_activity` triage.
19. **§8.3 RDS privilege requirement** documented (Mauve) — `CREATE EXTENSION` requires `rds_superuser`.
20. **Manual staging-RDS verification added to DoD** (Mauve) — close the local-vs-RDS gap.
21. **§12 recovery names ECS Exec / one-off task** (Mauve) — actionable, not handwave.
22. **`migrate.done` includes `totalMs`** — wall-clock budget visible.
23. **Throw uses `Error(..., { cause })`** — preserved across v3.
24. **Exit-130 framing softened** (Chartreuse) — convention for the deploy script, not an ECS-orchestrator-native distinction.
25. **`uuidv7` becomes a direct dep** alongside pino — needed for `runId`.

## 16. Earlier Versions

- **v1** (initial brainstorm output) — ran through 4 blind reviewers (Bert/SQL, Ernie/tests, Oscar/ops, Big Bird/scope).
- **v2** (post-first-review) — fixed advisory lock, statement timeouts, BEGIN/COMMIT validation, `release(true)` on error, PG15 default-privilege handling, vitest parallelism, dotenv setup, guard-db, argv guard, Dockerfile copy, workspace script convention, Tests 3b/6/7.
- **v3** (post-production-lens) — restored `durationMs`, swapped console for pino, added AbortSignal + signal handling, structured event names, Test 8 (graceful abort), Test 9 (logger contract). Saved `feedback_production_lens.md` to memory.
- **v4** (this version) — items 1–25 above.
