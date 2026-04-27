# Migration Runner — Design Spec

> **Linear issue**: [MYT-32](https://linear.app/mythrun/issue/MYT-32) — Backend Core: schema migration runner (`migrate.ts`)
> **Parent spec**: `docs/specs/2026-04-13-backend-core.md` §3 (Migration Runner)
> **Date**: 2026-04-26
> **Status**: Draft v2 (post-blind-review)

## 1. Goal

Ship a small, reliable SQL migration runner so the Postgres schema can be evolved in append-only `.sql` files. This ticket builds the runner only — the actual Backend Core schema (initial tables + indexes + SRD) lands in a separate Platform issue. A single placeholder migration is included to exercise the runner end-to-end.

The runner must be:

- Idempotent (running twice is a no-op the second time).
- Atomic per file (a failed migration leaves no half-applied state).
- Concurrency-safe via Postgres advisory lock (two ECS tasks racing on deploy is a real scenario, not a hypothetical).
- Append-only honor system (we trust the rule "never edit applied migrations"; no checksum drift detection in v1).
- Usable as a CLI (`pnpm db:migrate`) and as an importable function (so future code can call it from server boot).

Out of scope: server-boot wiring, `CREATE INDEX CONCURRENTLY` support (handled by a future no-transaction header), checksum drift detection, the actual schema migrations, structured/JSON logging, automatic rollback.

## 2. File Layout

```
backend/
  migrations/                              # NEW — outside src/, never compiled
    001_smoke.sql                          # CREATE EXTENSION IF NOT EXISTS pgcrypto;
  src/
    db/
      postgres.ts                          # already exists (createPgPool)
      migrate.ts                           # NEW — runner logic + CLI entrypoint
      __tests__/
        migrate.test.ts                    # NEW — integration tests
        guard-db.ts                        # NEW — shared "is this a safe DB?" check
  vitest.config.ts                         # NEW — at backend/, loads .env.development
  Dockerfile                               # MODIFIED — runtime stage copies migrations/
```

Rationale (locked in during brainstorm):

- **Code under `src/db/`** keeps the data layer cohesive (next to `postgres.ts`, future `repository.ts`).
- **`.sql` files outside `src/`** so `tsc` never sees them and no build-step copy is required.
- **Tests co-located** under `__tests__/` per the project test convention.

## 3. Runner Contract

```ts
// backend/src/db/migrate.ts

import type { Pool } from 'pg'

export interface AppliedMigration {
  readonly version: string
}

export async function runMigrations(
  pool: Pool,
  migrationsDir: string,
): Promise<AppliedMigration[]>
```

- Returns the list of migrations applied **during this invocation**. Empty array = nothing was pending.
- Throws on first failure. Does not attempt subsequent files.
- The caller owns the pool's lifecycle (the runner does not call `pool.end()`).
- `durationMs` was considered and dropped — nothing in the DoD asserts on it. The CLI logs wall time of each `applied_at` differential if humans want it; the structured return shape stays minimal.

## 4. Tracking Table

```sql
CREATE TABLE IF NOT EXISTS _migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- Underscore prefix marks it as framework metadata (sorts to the bottom of `\dt`, signals "don't touch").
- `version` is the full filename (e.g. `001_smoke.sql`) — natural key, no surrogate id.
- The `CREATE TABLE IF NOT EXISTS` runs every time the runner starts, *inside the advisory-lock-held section* (§5) so a fresh-DB race doesn't collide on `duplicate_table`.

## 5. Algorithm

```
1. client = await pool.connect()                                // one dedicated session
   try:
     2. await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
        // LOCK_KEY: a stable BIGINT computed once via Postgres itself —
        // `SELECT hashtextextended('mythrun_migrate', 0)` — captured as a
        // module-level constant rather than recomputed each run, so a
        // future Postgres hash-function change can't desync runners.
        // Blocks (does not error) if another runner is mid-migration.
     3. await client.query('CREATE TABLE IF NOT EXISTS _migrations ...')
     4. files = (readdir migrationsDir)
                  .filter(name → name.endsWith('.sql') && !name.startsWith('.'))
                  .sort()
        if files.length === 0: return []
     5. applied = SELECT version FROM _migrations
     6. for each file in files \ applied, in order:
          a. validateNoTransactionStatements(fileContents)      // see §5.1
          b. BEGIN
          c. SET LOCAL statement_timeout = 0
          d. SET LOCAL lock_timeout = '30s'
          e. client.query(fileContents)
          f. INSERT INTO _migrations (version) VALUES ($1)
          g. COMMIT
          h. console.log('✓ applied <version>')
        on error in (b)–(f):
          - try client.query('ROLLBACK')                        // best-effort
          - console.error('✗ migration <version> failed: <pgmsg>')
          - throw new Error(`migration ${version} failed: ${pgErr.message}`)
   finally:
     - try await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY])
     - if error path: client.release(true)                      // destroy
       else:           client.release()                          // back to pool
```

**Why the advisory lock.** Two runners both `SELECT version FROM _migrations` simultaneously, both see "001 not applied," both run the same `CREATE TABLE` — second runner gets `duplicate_table` from Postgres, not the unique-PK violation we'd hoped would save us. `pg_advisory_lock` is a session-level mutex Postgres provides exactly for this: serializes startup work without modifying schema. Held for the duration of the run.

**Why `SET LOCAL statement_timeout = 0`.** RDS parameter groups commonly set a non-zero default (often 30s). A real schema migration may exceed that. `SET LOCAL` scopes the change to the current transaction so we don't leak the override into the session pool. Same logic for `lock_timeout`, capped at 30s so a stuck migration fails loud rather than blocking forever on someone else's `AccessExclusiveLock`.

**Why one client throughout.** `pool.query()` may use a different physical connection per call. Advisory locks are session-scoped; the bookkeeping insert and the migration SQL must share a session for transactional consistency.

**Why `release(true)` on error.** If `ROLLBACK` itself failed (broken connection), the client is in an indeterminate state. `release(true)` destroys the underlying socket so the pool doesn't hand it to the next caller. Without this, `pool.end()` in the CLI's `finally` can hang.

### 5.1 Migration File Validation

Before executing each file, regex-reject any of these statements at line-start (case-insensitive, ignoring leading whitespace):

```
^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END)\s*[;]?\s*$
```

Reason: pg's simple-query protocol runs `client.query(multipleStatements)` as a batch *inside our outer BEGIN/COMMIT*. If the file contains its own `COMMIT`, our outer transaction terminates early and subsequent statements run in implicit individual transactions — partial application without our knowledge. Banning these tokens is simpler than parsing SQL.

`CREATE INDEX CONCURRENTLY` is also incompatible with our wrapper transaction; it'll be supported in a future ticket via an opt-in `-- pg-migrate: no-transaction` header. Until then, files using `CONCURRENTLY` will fail with a clear pg error and operators can split them.

## 6. CLI Entrypoint

At the bottom of `migrate.ts`:

```ts
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { loadEnv } from '../config/env.js'
import { createPgPool } from './postgres.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

// From src/db/migrate.ts (tsx)         → ../../migrations  → backend/migrations
// From dist/db/migrate.js (compiled)   → ../../migrations  → /app/migrations  (in container)
const DEFAULT_MIGRATIONS_DIR = resolve(__dirname, '../../migrations')

const argv1 = process.argv[1]
if (argv1 && import.meta.url === pathToFileURL(argv1).href) {
  const env = loadEnv()
  const pool = createPgPool(env.databaseUrl)
  try {
    const applied = await runMigrations(pool, DEFAULT_MIGRATIONS_DIR)
    if (applied.length === 0) console.log('No pending migrations.')
    else console.log(`Applied ${applied.length} migration(s).`)
  } catch (err) {
    console.error('✗ Migration failed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}
```

The `argv1 &&` guard is required — under `noUncheckedIndexedAccess`, `process.argv[1]` is `string | undefined`, and `pathToFileURL('')` throws `ERR_INVALID_ARG_VALUE`.

## 7. Logging

Plain `console.log` / `console.error`. The runner is a developer/CI tool — there's no Fastify instance to attach pino to and no consumer that needs structured JSON. This matches the tone of MYT-29's boot output (`✓ Postgres ready`).

Output is emitted **after** the `COMMIT` returns, never before — we don't want to claim success for a transaction that hasn't landed.

```
✓ applied 001_smoke.sql
✓ applied 002_indexes.sql
Applied 2 migration(s).
```

On failure:

```
✗ migration 002_broken.sql failed: syntax error at or near "FOO"
✗ Migration failed: migration 002_broken.sql failed: syntax error at or near "FOO"
```

Structured logging, per-file timing, and CloudWatch metrics are deliberate omissions for v1 — captured as follow-up beads (§13).

## 8. Build & Invocation

### 8.1 Dockerfile

The runtime stage currently copies only `/app/deploy/` (which is `dist/` + `package.json`). Migrations are not in the container today. Add to the runtime stage, **after** the existing `COPY --from=builder ... /app/deploy ./`:

```dockerfile
COPY --from=builder --chown=mythrun:mythrun /app/backend/migrations ./migrations
```

This places `.sql` files at `/app/migrations`. From `/app/dist/db/migrate.js`, the path resolution `../../migrations` lands on `/app/migrations` — same code path as local development.

`HEALTHCHECK --start-period=5s` stays untouched; it's already tracked by `myth-ccf` for a separate bump.

### 8.2 Scripts

In `backend/package.json`:

```json
"db:migrate": "tsx --env-file=.env.development src/db/migrate.ts",
"db:migrate:compiled": "node dist/db/migrate.js"
```

In root `package.json`, exposed via the workspace convention used elsewhere:

```json
"db:migrate": "pnpm --filter @mythrun/backend db:migrate"
```

Local dev uses `pnpm db:migrate` from the repo root → tsx, no precompile, env auto-loaded.
CI/prod will invoke `node dist/db/migrate.js` directly with env injected by the task definition; the CLI guard at the bottom of `migrate.ts` runs identically in both modes.

### 8.3 Prod invocation pattern (informational)

How this gets wired into ECS deploys is a follow-up ticket (§13). Two reasonable patterns the operator will pick from when that lands:

- **One-off ECS task** triggered before service update. Cleanest separation; requires a slightly different task definition.
- **Server entrypoint chains the migration**: `node dist/db/migrate.js && node dist/server.js` as the container `CMD`. Simpler ops, but every container restart re-acquires the advisory lock. Acceptable because the lock is fast and the migration list is short after the first apply.

This spec doesn't pick — but it does ensure the binary, the SQL files, and the env contract are all available so either approach works without further code changes.

## 9. Smoke Migration

`backend/migrations/001_smoke.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

`pgcrypto` is also the first statement of the real `001_initial_schema.sql` in spec §4, so this isn't throwaway — it's a real first migration that will be idempotent against the schema migration when it lands. Confirms `_migrations.version = '001_smoke.sql'` after first run; second run is a no-op.

## 10. Testing

### 10.1 Setup

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
import { resolve } from 'node:path'

// CWD is `backend/` when invoked via `pnpm --filter @mythrun/backend test`.
config({ path: resolve(process.cwd(), '.env.development') })
```

Explicit `config({ path })` rather than the side-effect import — `import 'dotenv/config'` looks for `.env`, not `.env.development`, and once it has run there's no way to redirect it.

### 10.2 DB Safety Guard (`guard-db.ts`)

Tests issue `DROP SCHEMA public CASCADE` against `process.env.DATABASE_URL`. If that variable accidentally points at a real database, this is destructive. The guard runs once in `beforeAll`:

```ts
import { Client } from 'pg'

export async function guardTestDatabase(databaseUrl: string): Promise<void> {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL not set — run `pnpm db:up` and ensure backend/.env.development exists')
  }
  const url = new URL(databaseUrl)
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  const dbName = url.pathname.slice(1)
  if (!isLocal || dbName !== 'mythrun') {
    throw new Error(
      `Refusing to run destructive tests against ${url.hostname}/${dbName}. ` +
      `Tests require localhost/mythrun (the docker-compose DB).`,
    )
  }
}
```

`setup-env.ts` calls `guardTestDatabase(process.env.DATABASE_URL ?? '')` immediately after loading dotenv, so the failure surfaces during test boot, not deep in a fixture.

### 10.3 Per-Test Reset

`beforeEach` issues:

```sql
DROP EXTENSION IF EXISTS pgcrypto CASCADE;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO PUBLIC;
GRANT ALL ON SCHEMA public TO CURRENT_USER;
```

Why each line:

- `DROP EXTENSION pgcrypto CASCADE` — extensions live in `pg_extension`, not the schema. Dropping `public` does NOT drop the extension by itself, so on PG 16+ the next `CREATE EXTENSION IF NOT EXISTS` is a no-op against a stale-state extension. Drop it explicitly first.
- `DROP SCHEMA public CASCADE` — removes all tables, sequences, functions, types created by previous tests' fixtures. Also removes default ACLs on the schema.
- `CREATE SCHEMA public` — fresh.
- `GRANT ALL ON SCHEMA public TO PUBLIC` + `TO CURRENT_USER` — PG 15+ no longer grants `CREATE` on `public` to `PUBLIC` by default. Without these, fixture migrations run by the test role can fail with permission errors when creating tables.

### 10.4 Fixture Migrations

Each test creates its own temp directory of `.sql` files via `fs.mkdtempSync(path.join(os.tmpdir(), 'myt-32-'))` and passes that path to `runMigrations`. Fixtures never touch `backend/migrations/`. `afterEach` removes the temp dir.

### 10.5 Test Cases

**Test 1 — empty DB, all migrations apply.**
Fixtures: `001_a.sql` (`CREATE TABLE a (id INT)`), `002_b.sql` (`CREATE TABLE b (id INT)`), `003_c.sql` (`CREATE TABLE c (id INT)`).
Assertions:
- `runMigrations` returns 3 entries with versions `001_a.sql`, `002_b.sql`, `003_c.sql` in that order.
- Tables `a`, `b`, `c` exist.
- `SELECT version FROM _migrations ORDER BY version` returns the three filenames.

**Test 2 — partial state, only unapplied run.**
Setup: pre-create `_migrations` with `('001_a.sql')` already inserted, and pre-create table `a` (so the migration would conflict if it ran).
Fixtures: same three files as Test 1.
Assertions:
- `runMigrations` returns 2 entries (`002_b.sql`, `003_c.sql`).
- Tables `b` and `c` exist; table `a` exists exactly once (the pre-created one).
- `_migrations` has all three rows.

**Test 3 — failed migration aborts the run.**
Fixtures: `001_a.sql` (valid), `002_broken.sql` (`THIS IS NOT VALID SQL;`), `003_c.sql` (valid).
Assertions:
- `runMigrations` throws; the error message contains the substring `002_broken.sql`.
- Table `a` exists (committed before the failure).
- Table `c` does **not** exist (run aborted before reaching it).
- `_migrations` contains exactly `('001_a.sql')`.

**Test 3b — bookkeeping insert is inside the transaction.**
Fixtures: `001_ok.sql` (valid), `002_writes_then_fails.sql`:
```sql
CREATE TABLE x (id INT);
SELECT 1/0;
```
Assertions:
- `runMigrations` throws.
- Table `x` does **not** exist (rolled back).
- `_migrations` does **not** contain `002_writes_then_fails.sql`.

This explicitly catches the "wrote to `_migrations` outside the transaction" implementation bug, which Test 3 alone wouldn't.

**Test 4 — empty migrations directory.**
Fixtures: empty temp dir.
Assertions:
- `runMigrations` returns `[]`.
- `_migrations` table exists but is empty.

**Test 5 — second run is a no-op.**
Fixtures: same three files as Test 1. Run `runMigrations` twice.
Assertions:
- First call returns 3 entries.
- Second call returns `[]`.
- `_migrations` has 3 rows (no duplicates).

**Test 6 — non-`.sql` files and dotfiles are ignored.**
Fixtures: `001_a.sql` (valid), `002_b.sql` (valid), `README.md`, `.DS_Store`, `notes.txt`, `003_C.SQL` (uppercase extension).
Assertions:
- `runMigrations` applies exactly two migrations: `001_a.sql`, `002_b.sql` — in order, and `003_C.SQL` is skipped because the filter is case-sensitive `.sql`.

**Test 7 — banned transaction statement is rejected.**
Fixtures: `001_bad.sql` containing `COMMIT;` on its own line.
Assertions:
- `runMigrations` throws before any DB work; error mentions transaction-statement validation.
- `_migrations` table exists but is empty (validation fires before the loop body runs against this file).

### 10.6 What we're NOT testing here

- Concurrent runners racing — covered in design via advisory lock; integration test would require parallel processes, deferred.
- `CREATE INDEX CONCURRENTLY` — deferred (separate ticket).
- Checksum/drift detection — deferred (separate ticket).
- Very large migration files — performance, not correctness.

## 11. Error Handling Summary

| Failure | Behavior |
|---------|----------|
| `DATABASE_URL` unset (CLI) | `loadEnv()` throws → CLI catches → exit 1 |
| `DATABASE_URL` unset (tests) | `setup-env.ts` throws with actionable message |
| `DATABASE_URL` points at wrong DB (tests) | `guardTestDatabase` throws — refuses to run |
| Postgres unreachable | `pool.connect()` rejects → CLI logs and exits 1 |
| Another runner holding the advisory lock | Block (do not error) until released. Standard Postgres behavior. |
| `migrationsDir` missing | `readdir` throws ENOENT → CLI exits 1 |
| File contains `BEGIN`/`COMMIT`/`ROLLBACK` | Validation rejects before any DB work; error names the file and the offending token |
| SQL error in migration | `ROLLBACK` (best-effort) → log version + pg message → throw → CLI exits 1; client destroyed (`release(true)`) |
| `pool.end()` failure during CLI shutdown | Logged but doesn't change exit code |
| SIGINT/SIGTERM mid-run | Process exits; Postgres rolls back the open transaction server-side; advisory lock auto-releases on connection close. Operator re-runs to converge. |

No retries anywhere. The runner is a one-shot tool.

## 12. Recovery (informational)

If a migration shipped buggy code or the wrong file was applied:

1. The runner has no rollback path. Recovery is manual SQL.
2. To "undo" a migration: write a corrective SQL session against the DB, then `DELETE FROM _migrations WHERE version = '<filename>'` so the next run will reapply it (or replace it with a new file `NNN_fix_*.sql` left in place).
3. **Never edit an applied migration file.** The append-only rule is enforced by convention; see Backend Core spec §3 "Migration Discipline."

## 13. Follow-up Beads (Not This Ticket)

To create after this ticket lands:

- Wire `runMigrations` into server boot before `app.listen` (per spec §6).
- Add `CREATE INDEX CONCURRENTLY` support via a `-- pg-migrate: no-transaction` header.
- Add file-checksum drift detection on `_migrations` (extra column, fail if previously-applied file's hash changed).
- Pick the prod invocation pattern (one-off ECS task vs. server CMD chain) and wire the deploy.
- Add structured logging + per-migration timing if operability demands.
- SIGINT handler that prints "interrupted — re-run to converge" and exits 130 (currently relies on default abort).

## 14. Definition of Done

- `backend/src/db/migrate.ts` implements `runMigrations` + the CLI block as specified (§3, §5, §6).
- `backend/migrations/001_smoke.sql` exists with `CREATE EXTENSION IF NOT EXISTS pgcrypto`.
- `backend/Dockerfile` runtime stage copies `migrations/` so the compiled binary can find them in the container.
- `backend/vitest.config.ts` sets `fileParallelism: false` and loads `.env.development` via the setup file.
- `backend/src/db/__tests__/migrate.test.ts` covers Tests 1, 2, 3, 3b, 4, 5, 6, 7 against the real local Postgres, behind the `guardTestDatabase` check.
- `pnpm db:migrate` works against `pnpm db:up`'d Postgres: first run applies `001_smoke.sql`, second run is a no-op.
- `pnpm typecheck` + `pnpm lint` + `pnpm test` all green.
- Backend Core spec §3 directory + tracking-table details match the design (already updated during brainstorming).

## 15. Changes Since v1 (post-blind-review)

Recorded for traceability. v1 was reviewed by four subagents in parallel. Convergent findings drove these revisions:

1. **Advisory lock around the run** (Bert + Oscar) — replaces the broken "unique-PK-violation as concurrency guard" story.
2. **`SET LOCAL statement_timeout = 0` + `lock_timeout = '30s'`** per transaction (Oscar) — guards against RDS parameter-group defaults.
3. **Migration file validation rejects `BEGIN`/`COMMIT`/`ROLLBACK`** (Bert) — closes the multi-statement-with-embedded-COMMIT loophole.
4. **`client.release(true)` on error path** (Bert + Ernie) — destroys the client instead of returning a wedged one to the pool.
5. **`DROP EXTENSION pgcrypto CASCADE`** before schema reset, plus explicit `GRANT ALL ON SCHEMA public TO PUBLIC` after recreate (Bert + Ernie) — handles PG 15+ default-privilege regression and stale-extension state.
6. **`vitest.config.ts` at `backend/`, `fileParallelism: false`** (Ernie + Big Bird) — pinned location, prevents parallel-file collision on the shared DB.
7. **Real `dotenv.config({ path })` in setup-env.ts** (Ernie + Big Bird) — replaces the broken side-effect import.
8. **`guardTestDatabase` function** (Ernie) — refuses to run if DB isn't `localhost/mythrun`.
9. **`if (argv1 && import.meta.url === pathToFileURL(argv1).href)`** (Big Bird) — `pathToFileURL('')` crashes; needed under `noUncheckedIndexedAccess`.
10. **Dockerfile copies `migrations/` into runtime stage** (Oscar) — without this, the compiled binary in the container has no `.sql` files to read.
11. **`db:migrate` script lives in `backend/package.json`, exposed at root via `pnpm --filter`** (Big Bird) — matches the rest of the workspace.
12. **Tests 3b, 6, 7 added** (Ernie) — bookkeeping-inside-transaction, ignored-files, banned-statement validation.
13. **`durationMs` removed from `AppliedMigration`** (Big Bird) — YAGNI; nothing asserted on it.
14. **Recovery section added** (Oscar) — short note on manual remediation.
15. **§8.3 prod-invocation note added** (Oscar) — documents the patterns without picking one, so the deploy ticket has the surface area it needs.
