# Migration Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-grade SQL migration runner for Mythrun's Postgres backend (`pnpm db:migrate`), with structured pino logs, Postgres advisory-lock concurrency safety, signal-handled graceful aborts, and integration tests against a real local Postgres.

**Architecture:** Single-client pg pool. Inside the lock-held section: read `.sql` files from `backend/migrations/`, compare against `_migrations(version PK, applied_at)`, apply each unapplied file in its own transaction with `SET LOCAL statement_timeout/lock_timeout/application_name`, insert the bookkeeping row, COMMIT. Run `DISCARD ALL` before returning the client to the pool so session state never leaks. Pino with a custom `err` serializer that recurses into `cause` and redacts the password.

**Tech Stack:** TypeScript (strict + ESM + NodeNext), Node 24, `pg@^8.13`, `pino@^10.3`, `uuidv7@^1.0`, `vitest@^3`, `tsx`, `dotenv`. Local dev: docker-compose Postgres 16. CI: GitHub Actions with a Postgres service container.

**Spec:** `docs/superpowers/specs/2026-04-26-migrate-runner-design.md`

---

## File Structure

| Path | Status | Responsibility |
|------|--------|----------------|
| `backend/src/db/lock-key.ts` | NEW | Pinned `LOCK_KEY` bigint constant |
| `backend/src/db/postgres.ts` | MODIFY | Accept `Partial<PoolConfig>` overrides |
| `backend/src/db/migrate.ts` | NEW | `runMigrations()` + CLI block |
| `backend/src/db/__tests__/lock-key.test.ts` | NEW | Drift test on the literal |
| `backend/src/db/__tests__/migrate.test.ts` | NEW | Integration tests |
| `backend/src/db/__tests__/guard-db.ts` | NEW | Shared "is this a safe DB?" check |
| `backend/src/config/env.ts` | MODIFY | Read `MIGRATE_DATABASE_URL` first |
| `backend/src/config/__tests__/env.test.ts` | MODIFY | Add MIGRATE_DATABASE_URL cases |
| `backend/src/__tests__/setup-env.ts` | NEW | Vitest global dotenv loader |
| `backend/vitest.config.ts` | NEW | `setupFiles` + `fileParallelism: false` |
| `backend/package.json` | MODIFY | Add pino, uuidv7 deps + `db:migrate*` scripts |
| `backend/migrations/001_smoke.sql` | NEW | `CREATE EXTENSION IF NOT EXISTS pgcrypto;` |
| `backend/Dockerfile` | MODIFY | Runtime stage `COPY` migrations |
| `package.json` | MODIFY | Root `db:migrate` via `pnpm --filter` |
| `.github/workflows/deploy.yml` | MODIFY | Postgres service + `DATABASE_URL` for tests |

---

## Task 1: Backend deps — add pino, uuidv7

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Add the deps**

In `backend/package.json`, add `pino` and `uuidv7` to `dependencies` (alphabetized):

```json
{
  "dependencies": {
    "fastify": "^5.1.0",
    "ioredis": "^5.4.0",
    "pg": "^8.13.0",
    "pino": "^10.3.1",
    "uuidv7": "^1.0.2"
  }
}
```

- [ ] **Step 2: Install**

Run from repo root:

```bash
pnpm install --filter @mythrun/backend
```

Expected: lockfile updated, no errors. `node_modules/pino` and `node_modules/uuidv7` exist.

- [ ] **Step 3: Verify both packages resolve**

Run:

```bash
cd backend && node --input-type=module -e "import pino from 'pino'; import { uuidv7 } from 'uuidv7'; console.log(typeof pino, typeof uuidv7)"
```

Expected output: `function function`

- [ ] **Step 4: Commit**

```bash
git add backend/package.json pnpm-lock.yaml
git commit -m "chore(myt-32): add pino + uuidv7 backend deps"
```

---

## Task 2: `createPgPool` accepts overrides

**Files:**
- Modify: `backend/src/db/postgres.ts`
- Test: `backend/src/db/__tests__/postgres.test.ts` (NEW)

- [ ] **Step 1: Write the failing test**

Create `backend/src/db/__tests__/postgres.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createPgPool } from '../postgres.js'

describe('createPgPool', () => {
  it('accepts pool overrides (max, connectionTimeoutMillis)', () => {
    const pool = createPgPool('postgresql://u:p@h:5432/d', {
      max: 1,
      connectionTimeoutMillis: 10_000,
    })
    // pg-pool exposes options on the pool instance; verify they're applied.
    expect(pool.options.max).toBe(1)
    expect(pool.options.connectionTimeoutMillis).toBe(10_000)
    pool.end().catch(() => undefined)
  })

  it('works with no overrides (existing callers)', () => {
    const pool = createPgPool('postgresql://u:p@h:5432/d')
    expect(pool).toBeDefined()
    pool.end().catch(() => undefined)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd backend && pnpm vitest run src/db/__tests__/postgres.test.ts
```

Expected: TypeScript error or runtime failure — `createPgPool` doesn't take a second argument yet.

- [ ] **Step 3: Extend `createPgPool`**

Edit `backend/src/db/postgres.ts`. Change the function signature and merge overrides AFTER the SSL block:

```ts
import { Pool, type PoolConfig } from 'pg'

export function createPgPool(url: string, overrides?: Partial<PoolConfig>): Pool {
  const urlObj = new URL(url)
  const sslMode = urlObj.searchParams.get('sslmode')
  urlObj.searchParams.delete('sslmode')
  const cleanUrl = urlObj.toString()

  const config: PoolConfig = { connectionString: cleanUrl }
  if (sslMode === 'require') {
    config.ssl = { rejectUnauthorized: false }
  } else if (sslMode === 'verify-ca' || sslMode === 'verify-full') {
    config.ssl = { rejectUnauthorized: true }
  }
  // overrides win over the SSL-derived config — caller's choice if they want it.
  return new Pool({ ...config, ...overrides })
}
```

(Keep the SSL comment block from the original file unchanged.)

- [ ] **Step 4: Run, expect PASS**

```bash
cd backend && pnpm vitest run src/db/__tests__/postgres.test.ts && pnpm typecheck
```

Both should pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/postgres.ts backend/src/db/__tests__/postgres.test.ts
git commit -m "feat(myt-32): createPgPool accepts Partial<PoolConfig> overrides"
```

---

## Task 3: `loadEnv` reads `MIGRATE_DATABASE_URL` first

**Files:**
- Modify: `backend/src/config/env.ts`
- Modify: `backend/src/config/__tests__/env.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the existing `backend/src/config/__tests__/env.test.ts`, in a new `describe` block at the bottom of the file:

```ts
describe('loadEnv (MIGRATE_DATABASE_URL precedence)', () => {
  beforeEach(() => clearAll())
  afterEach(() => { process.env = { ...ORIGINAL_ENV } })

  it('uses MIGRATE_DATABASE_URL when set and non-empty', () => {
    Object.assign(process.env, URL_FORM)
    process.env.MIGRATE_DATABASE_URL = 'postgresql://m:m@m:5432/migrate'
    const env = loadEnv()
    expect(env.databaseUrl).toBe('postgresql://m:m@m:5432/migrate')
  })

  it('falls through to DATABASE_URL when MIGRATE_DATABASE_URL is empty string', () => {
    Object.assign(process.env, URL_FORM)
    process.env.MIGRATE_DATABASE_URL = ''
    const env = loadEnv()
    expect(env.databaseUrl).toBe(URL_FORM.DATABASE_URL)
  })

  it('falls through to DATABASE_URL when MIGRATE_DATABASE_URL is whitespace only', () => {
    Object.assign(process.env, URL_FORM)
    process.env.MIGRATE_DATABASE_URL = '   '
    const env = loadEnv()
    expect(env.databaseUrl).toBe(URL_FORM.DATABASE_URL)
  })

  it('falls through to DATABASE_URL when MIGRATE_DATABASE_URL is unset', () => {
    Object.assign(process.env, URL_FORM)
    const env = loadEnv()
    expect(env.databaseUrl).toBe(URL_FORM.DATABASE_URL)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd backend && pnpm vitest run src/config/__tests__/env.test.ts
```

Expected: the four new tests fail (current `loadEnv` ignores `MIGRATE_DATABASE_URL`).

- [ ] **Step 3: Extend `buildDatabaseUrl`**

Edit `backend/src/config/env.ts`. Replace the `buildDatabaseUrl` function with:

```ts
function buildDatabaseUrl(): string {
  // Migrations may run as a different role than the API (rds_superuser
  // for CREATE EXTENSION). MIGRATE_DATABASE_URL takes precedence; fallback
  // to DATABASE_URL keeps local dev working out of the box.
  // Explicit length-after-trim check — Terraform `cond ? x : null` patterns
  // emit "" rather than null, and `??` only falls through on null/undefined.
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
```

(Keep the comment block above the function unchanged.)

Add `MIGRATE_DATABASE_URL` deletion to `clearAll` in the test file:

```ts
function clearAll(): void {
  delete process.env.MIGRATE_DATABASE_URL
  delete process.env.DATABASE_URL
  // ... existing deletions
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
cd backend && pnpm vitest run src/config/__tests__/env.test.ts && pnpm typecheck
```

All env tests (existing + new) pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/config/env.ts backend/src/config/__tests__/env.test.ts
git commit -m "feat(myt-32): loadEnv reads MIGRATE_DATABASE_URL with empty/whitespace fallback"
```

---

## Task 4: Vitest config + global dotenv setup

**Files:**
- Create: `backend/vitest.config.ts`
- Create: `backend/src/__tests__/setup-env.ts`

- [ ] **Step 1: Create the setup file**

Create `backend/src/__tests__/setup-env.ts`:

```ts
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Resolve relative to this file, not CWD — works whether vitest is invoked
// from `pnpm --filter @mythrun/backend test` (CWD = backend/) or from a
// root-level `pnpm test` (CWD = repo root).
const here = fileURLToPath(import.meta.url)
config({ path: resolve(here, '../../../.env.development') })
```

- [ ] **Step 2: Create the vitest config**

Create `backend/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./src/__tests__/setup-env.ts'],
    fileParallelism: false,
  },
})
```

- [ ] **Step 3: Verify existing tests still pass with the new setup**

```bash
cd backend && pnpm test
```

Existing tests (`app.test.ts`, `server.test.ts`, `shutdown.test.ts`, `env.test.ts`, `postgres.test.ts`) should all stay green. The setup file loads dotenv globally; non-DB tests should be unaffected (they don't read `DATABASE_URL`).

- [ ] **Step 4: Commit**

```bash
git add backend/vitest.config.ts backend/src/__tests__/setup-env.ts
git commit -m "test(myt-32): vitest config with global dotenv loader (no fileParallelism)"
```

---

## Task 5: DB safety guard

**Files:**
- Create: `backend/src/db/__tests__/guard-db.ts`
- Test: `backend/src/db/__tests__/guard-db.test.ts` (NEW)

- [ ] **Step 1: Write the failing test**

Create `backend/src/db/__tests__/guard-db.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { guardTestDatabase } from './guard-db.js'

describe('guardTestDatabase', () => {
  it('throws when databaseUrl is empty', async () => {
    await expect(guardTestDatabase('')).rejects.toThrow(/DATABASE_URL not set/)
  })

  it('throws on remote host', async () => {
    await expect(
      guardTestDatabase('postgresql://u:p@rds.amazonaws.com:5432/mythrun'),
    ).rejects.toThrow(/Refusing/)
  })

  it('throws on disallowed db name', async () => {
    await expect(
      guardTestDatabase('postgresql://u:p@127.0.0.1:5432/production'),
    ).rejects.toThrow(/Refusing/)
  })

  it('accepts localhost mythrun', async () => {
    await expect(
      guardTestDatabase('postgresql://u:p@localhost:5432/mythrun'),
    ).resolves.toBeUndefined()
  })

  it('accepts 127.0.0.1 mythrun_test', async () => {
    await expect(
      guardTestDatabase('postgresql://u:p@127.0.0.1:5432/mythrun_test'),
    ).resolves.toBeUndefined()
  })

  it('accepts 127.0.0.1 mythrun_ci', async () => {
    await expect(
      guardTestDatabase('postgresql://u:p@127.0.0.1:5432/mythrun_ci'),
    ).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd backend && pnpm vitest run src/db/__tests__/guard-db.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement**

Create `backend/src/db/__tests__/guard-db.ts`:

```ts
const ALLOWED_DBS = /^mythrun(_test|_ci)?$/

export async function guardTestDatabase(databaseUrl: string): Promise<void> {
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL not set — run `pnpm db:up` and ensure backend/.env.development exists, or set DATABASE_URL in CI',
    )
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

- [ ] **Step 4: Run, expect PASS**

```bash
cd backend && pnpm vitest run src/db/__tests__/guard-db.test.ts && pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/__tests__/guard-db.ts backend/src/db/__tests__/guard-db.test.ts
git commit -m "test(myt-32): guardTestDatabase blocks destructive runs on wrong DB"
```

---

## Task 6: `LOCK_KEY` constant + drift test

**Files:**
- Create: `backend/src/db/lock-key.ts`
- Create: `backend/src/db/__tests__/lock-key.test.ts`

> **Implementer note:** the LOCK_KEY value comes from running `SELECT hashtextextended('mythrun_migrate', 0);` against the local docker-compose Postgres 16. Run `pnpm db:up` first if you haven't. Capture the bigint result and pin it as the literal in `lock-key.ts`. The literal `-3411702991737540243n` in this plan is the expected value but the implementer MUST run the SQL and confirm — if it differs, use the actual value and update the test to match. Once pinned, never regenerate.

- [ ] **Step 1: Capture the literal**

Run:

```bash
pnpm db:up
docker exec -i mythrun-postgres-1 psql -U mythrun -d mythrun -tAc "SELECT hashtextextended('mythrun_migrate', 0);"
```

Expected output: a bigint, e.g. `-3411702991737540243`. Note this value; you'll use it in step 3.

- [ ] **Step 2: Write the failing test**

Create `backend/src/db/__tests__/lock-key.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { LOCK_KEY } from '../lock-key.js'

describe('LOCK_KEY', () => {
  it('is the pinned literal from hashtextextended("mythrun_migrate", 0)', () => {
    // DO NOT REGENERATE THIS VALUE. See lock-key.ts comment for why.
    // If this assertion fails, somebody changed LOCK_KEY in source —
    // that is a bug, not a fix.
    expect(LOCK_KEY).toBe(-3411702991737540243n)
  })

  it('is a bigint that fits signed 64-bit', () => {
    const min = -(2n ** 63n)
    const max = 2n ** 63n - 1n
    expect(LOCK_KEY >= min && LOCK_KEY <= max).toBe(true)
  })
})
```

(If your captured literal differs, replace `-3411702991737540243n` in the assertion with the actual value.)

- [ ] **Step 3: Run, expect FAIL**

```bash
cd backend && pnpm vitest run src/db/__tests__/lock-key.test.ts
```

Expected: module not found.

- [ ] **Step 4: Create the constant**

Create `backend/src/db/lock-key.ts`:

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

(Use the actual literal you captured in step 1.)

- [ ] **Step 5: Run, expect PASS**

```bash
cd backend && pnpm vitest run src/db/__tests__/lock-key.test.ts && pnpm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/lock-key.ts backend/src/db/__tests__/lock-key.test.ts
git commit -m "feat(myt-32): pin LOCK_KEY bigint constant + drift test"
```

---

## Task 7: Filename grammar + dollar-quote-aware validator (pure functions)

**Files:**
- Create: `backend/src/db/migrate.ts` (initial — only the validators; full runner added in Task 9)
- Create: `backend/src/db/__tests__/migrate-validator.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/db/__tests__/migrate-validator.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  isValidMigrationFilename,
  validateNoTransactionStatements,
} from '../migrate.js'

describe('isValidMigrationFilename', () => {
  it('accepts NNN_lowercase_snake.sql', () => {
    expect(isValidMigrationFilename('001_smoke.sql')).toBe(true)
    expect(isValidMigrationFilename('042_create_users_table.sql')).toBe(true)
  })

  it('rejects uppercase, spaces, unicode, missing prefix', () => {
    expect(isValidMigrationFilename('001_Smoke.sql')).toBe(false)
    expect(isValidMigrationFilename('001 smoke.sql')).toBe(false)
    expect(isValidMigrationFilename('001_première.sql')).toBe(false)
    expect(isValidMigrationFilename('smoke.sql')).toBe(false)
    expect(isValidMigrationFilename('1_x.sql')).toBe(false) // need 3+ digits
    expect(isValidMigrationFilename('001_smoke.SQL')).toBe(false)
    expect(isValidMigrationFilename('.001_smoke.sql')).toBe(false)
  })
})

describe('validateNoTransactionStatements', () => {
  it('accepts a normal CREATE TABLE statement', () => {
    expect(() =>
      validateNoTransactionStatements('a.sql', 'CREATE TABLE x (id INT);'),
    ).not.toThrow()
  })

  it('accepts a DO block containing BEGIN/END', () => {
    const sql = `DO $$ BEGIN RAISE NOTICE 'hi'; END $$;`
    expect(() => validateNoTransactionStatements('a.sql', sql)).not.toThrow()
  })

  it('accepts a CREATE FUNCTION with BEGIN/END body', () => {
    const sql = `CREATE OR REPLACE FUNCTION f() RETURNS void AS $$
BEGIN
  RAISE NOTICE 'hi';
END
$$ LANGUAGE plpgsql;`
    expect(() => validateNoTransactionStatements('a.sql', sql)).not.toThrow()
  })

  it('accepts a tagged dollar-quoted block', () => {
    const sql = `CREATE FUNCTION g() RETURNS void AS $body$
BEGIN
  PERFORM 1;
END
$body$ LANGUAGE plpgsql;`
    expect(() => validateNoTransactionStatements('a.sql', sql)).not.toThrow()
  })

  it('rejects a top-level COMMIT;', () => {
    expect(() =>
      validateNoTransactionStatements('a.sql', 'CREATE TABLE x (id INT);\nCOMMIT;'),
    ).toThrow(/forbidden top-level transaction statement.*COMMIT/i)
  })

  it('rejects a top-level BEGIN;', () => {
    expect(() =>
      validateNoTransactionStatements('a.sql', 'BEGIN;\nCREATE TABLE x (id INT);'),
    ).toThrow(/forbidden top-level transaction statement.*BEGIN/i)
  })

  it('rejects ROLLBACK on its own line', () => {
    expect(() =>
      validateNoTransactionStatements('a.sql', '  rollback ; '),
    ).toThrow(/forbidden top-level transaction statement.*ROLLBACK/i)
  })

  it('rejects START TRANSACTION', () => {
    expect(() =>
      validateNoTransactionStatements('a.sql', 'START TRANSACTION;'),
    ).toThrow(/forbidden top-level transaction statement/i)
  })

  it('ignores BEGIN inside a single-line --comment', () => {
    expect(() =>
      validateNoTransactionStatements('a.sql', '-- BEGIN;\nCREATE TABLE x (id INT);'),
    ).not.toThrow()
  })

  it('error message includes filename and line number', () => {
    try {
      validateNoTransactionStatements('999_bad.sql', '\n\nCOMMIT;\n')
      throw new Error('expected throw')
    } catch (err) {
      expect((err as Error).message).toContain('999_bad.sql')
      expect((err as Error).message).toContain('line 3')
    }
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd backend && pnpm vitest run src/db/__tests__/migrate-validator.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement the validators in migrate.ts**

Create `backend/src/db/migrate.ts` with the validators only (the full runner is added in Task 9):

```ts
const FILENAME_RE = /^[0-9]{3,}_[a-z0-9_]+\.sql$/

export function isValidMigrationFilename(name: string): boolean {
  return FILENAME_RE.test(name)
}

const FORBIDDEN_RE = /^(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END)\s*;?\s*$/i

/**
 * Reject top-level transaction-control statements. Dollar-quote-aware:
 * PL/pgSQL bodies (`DO $$ BEGIN ... END $$`, `CREATE FUNCTION ... AS $$ ... $$`)
 * contain literal BEGIN/END and must not be falsely rejected.
 */
export function validateNoTransactionStatements(
  filename: string,
  contents: string,
): void {
  // Strip dollar-quoted runs in place by replacing them with newlines so line
  // numbers are preserved for error messages.
  const stripped = stripDollarQuoted(contents)
  const lines = stripped.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    // Strip line comment.
    const noComment = raw.replace(/--.*$/, '').trim()
    if (noComment === '') continue
    const match = FORBIDDEN_RE.exec(noComment)
    if (match) {
      const token = (match[1] ?? '').toUpperCase()
      throw new Error(
        `migration ${filename} contains forbidden top-level transaction statement '${token}' at line ${i + 1}. ` +
          `The runner wraps each file in BEGIN/COMMIT; nested transaction control is not allowed. ` +
          `Remove the statement or split into a separate file.`,
      )
    }
  }
}

/**
 * Replace each dollar-quoted block with a same-line-count newline run.
 * Tags: $$, $tag$, $custom_tag$ — must match opening to closing tag exactly.
 * Preserves source-line numbering so validator error messages stay useful.
 */
function stripDollarQuoted(input: string): string {
  let out = ''
  let i = 0
  while (i < input.length) {
    if (input[i] === '$') {
      // Try to match an opening tag: $tag$
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(input.slice(i))
      if (tagMatch) {
        const fullTag = tagMatch[0] // e.g. "$$" or "$body$"
        const closeIdx = input.indexOf(fullTag, i + fullTag.length)
        if (closeIdx >= 0) {
          // Replace the dollar-quoted run with newlines matching the count
          // of newlines inside it, preserving line numbers.
          const inner = input.slice(i, closeIdx + fullTag.length)
          const newlineCount = (inner.match(/\n/g) ?? []).length
          out += '\n'.repeat(newlineCount)
          i = closeIdx + fullTag.length
          continue
        }
      }
    }
    out += input[i]
    i++
  }
  return out
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
cd backend && pnpm vitest run src/db/__tests__/migrate-validator.test.ts && pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/migrate.ts backend/src/db/__tests__/migrate-validator.test.ts
git commit -m "feat(myt-32): filename grammar + dollar-quote-aware migration validator"
```

---

## Task 8: Smoke migration file + Dockerfile copy

**Files:**
- Create: `backend/migrations/001_smoke.sql`
- Modify: `backend/Dockerfile`

- [ ] **Step 1: Create the smoke migration**

Create `backend/migrations/001_smoke.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

- [ ] **Step 2: Update the Dockerfile runtime stage**

In `backend/Dockerfile`, find the line:

```dockerfile
COPY --from=builder --chown=mythrun:mythrun /app/deploy ./
```

Add this line **after** it:

```dockerfile
COPY --from=builder --chown=mythrun:mythrun /app/backend/migrations ./migrations
```

- [ ] **Step 3: Verify the build still works**

```bash
docker build --build-arg BASE_IMAGE_REGISTRY=public.ecr.aws -t mythrun-test -f backend/Dockerfile .
```

Expected: build succeeds. (If Docker isn't running, skip this verification — the integration test in Task 13 will exercise the binary path.)

- [ ] **Step 4: Verify the file is at the expected runtime path**

```bash
docker run --rm --entrypoint sh mythrun-test -c "ls /app/migrations/"
```

Expected output: `001_smoke.sql`

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/001_smoke.sql backend/Dockerfile
git commit -m "feat(myt-32): smoke migration + Dockerfile copies migrations/ to runtime"
```

---

## Task 9: Core `runMigrations` — happy path

**Files:**
- Modify: `backend/src/db/migrate.ts` (add `runMigrations`, `MigrationOptions`, `AppliedMigration`, `MigrateLogger`)
- Test: `backend/src/db/__tests__/migrate.test.ts` (NEW — Tests 1, 4, 5 from spec §10.7)

> **Implementer note:** this task adds the runner's happy path. Error paths, abort, and CLI come in Tasks 10–12. Read the spec's §5 algorithm carefully before writing code; the SET LOCAL ordering and DISCARD ALL placement are load-bearing.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/db/__tests__/migrate.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { createPgPool } from '../postgres.js'
import { runMigrations } from '../migrate.js'
import { guardTestDatabase } from './guard-db.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

async function resetSchema(pool: Pool): Promise<void> {
  await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
  await pool.query('DROP SCHEMA public CASCADE')
  await pool.query('CREATE SCHEMA public')
  await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
  await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
}

function makeFixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'myt-32-'))
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents)
  }
  return dir
}

function makeSpyLogger(): { logger: ReturnType<typeof pino>; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = []
  const sink: DestinationStream = {
    write: (s: string) => {
      lines.push(JSON.parse(s) as Record<string, unknown>)
    },
  }
  const logger = pino({
    base: { component: 'migrate' },
    serializers: { err: pino.stdSerializers.err },
  }, sink)
  return { logger, lines }
}

describe('runMigrations (integration)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 5 })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetSchema(pool)
  })

  let fixtureDir: string | undefined
  afterEach(() => {
    if (fixtureDir) {
      rmSync(fixtureDir, { recursive: true, force: true })
      fixtureDir = undefined
    }
  })

  it('Test 1: empty DB — applies all migrations in order', async () => {
    fixtureDir = makeFixtureDir({
      '001_a.sql': 'CREATE TABLE a (id INT);',
      '002_b.sql': 'CREATE TABLE b (id INT);',
      '003_c.sql': 'CREATE TABLE c (id INT);',
    })
    const { logger } = makeSpyLogger()
    const applied = await runMigrations({ pool, migrationsDir: fixtureDir, logger })

    expect(applied.map((m) => m.version)).toEqual(['001_a.sql', '002_b.sql', '003_c.sql'])
    for (const m of applied) {
      expect(m.durationMs).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(m.durationMs)).toBe(true)
    }
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`,
    )
    expect(tables.rows.map((r) => r.table_name)).toEqual(['_migrations', 'a', 'b', 'c'])
    const rows = await pool.query<{ version: string }>(
      `SELECT version FROM _migrations ORDER BY version`,
    )
    expect(rows.rows.map((r) => r.version)).toEqual(['001_a.sql', '002_b.sql', '003_c.sql'])
  })

  it('Test 4: empty migrations directory — returns []', async () => {
    fixtureDir = makeFixtureDir({})
    const { logger } = makeSpyLogger()
    const applied = await runMigrations({ pool, migrationsDir: fixtureDir, logger })
    expect(applied).toEqual([])
    const exists = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='_migrations'`,
    )
    expect(exists.rows[0]?.count).toBe('1')
  })

  it('Test 5: second run is a no-op', async () => {
    fixtureDir = makeFixtureDir({
      '001_a.sql': 'CREATE TABLE a (id INT);',
      '002_b.sql': 'CREATE TABLE b (id INT);',
    })
    const { logger } = makeSpyLogger()
    const first = await runMigrations({ pool, migrationsDir: fixtureDir, logger })
    expect(first.map((m) => m.version)).toEqual(['001_a.sql', '002_b.sql'])
    const second = await runMigrations({ pool, migrationsDir: fixtureDir, logger })
    expect(second).toEqual([])
    const rows = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM _migrations`,
    )
    expect(rows.rows[0]?.count).toBe('2')
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Make sure `pnpm db:up` is running, then:

```bash
cd backend && pnpm vitest run src/db/__tests__/migrate.test.ts
```

Expected: `runMigrations` not exported from `migrate.ts`.

- [ ] **Step 3: Implement `runMigrations` (happy path)**

Append to `backend/src/db/migrate.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Pool } from 'pg'
import type pino from 'pino'
import { LOCK_KEY } from './lock-key.js'

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
  readonly runId?: string | undefined
}

export async function runMigrations(opts: MigrationOptions): Promise<AppliedMigration[]> {
  const { pool, migrationsDir, logger, abortSignal } = opts
  const runId = opts.runId ?? cryptoRandomId()
  const runStart = performance.now()
  const appliedSoFar: AppliedMigration[] = []

  const versionRow = await pool.query<{ version: string }>('SELECT version() AS version')
  const pgServerVersion = versionRow.rows[0]?.version
  logger.info(
    { event: 'migrate.start', runId, migrationsDir, pgServerVersion, nodeVersion: process.version },
    'migrate.start',
  )

  const client = await pool.connect()
  let lockStart = 0
  let acquiredLock = false
  let errorPath: Error | undefined

  try {
    lockStart = performance.now()
    await acquireAdvisoryLockWithHeartbeat(client, runId, logger, abortSignal)
    acquiredLock = true
    logger.info(
      { event: 'migrate.lock_acquired', runId, waitMs: Math.round(performance.now() - lockStart) },
      'migrate.lock_acquired',
    )

    await client.query(
      'CREATE TABLE IF NOT EXISTS _migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    )

    const allFiles = (await readdir(migrationsDir)).filter(
      (n) => n.endsWith('.sql') && !n.startsWith('.'),
    )
    for (const f of allFiles) {
      if (!isValidMigrationFilename(f)) {
        throw new Error(
          `invalid migration filename: ${f}. Required grammar: ^[0-9]{3,}_[a-z0-9_]+\\.sql$`,
        )
      }
    }
    const files = allFiles.sort()
    if (files.length === 0) {
      logger.info({ event: 'migrate.no_migrations_found', runId }, 'migrate.no_migrations_found')
      return appliedSoFar
    }

    const appliedRows = await client.query<{ version: string }>(
      'SELECT version FROM _migrations',
    )
    const applied = new Set(appliedRows.rows.map((r) => r.version))
    const pending = files.filter((f) => !applied.has(f))
    logger.info(
      { event: 'migrate.plan', runId, pending: pending.length, total: files.length, pendingVersions: pending },
      'migrate.plan',
    )

    for (const file of pending) {
      if (abortSignal?.aborted) {
        logger.warn(
          {
            event: 'migrate.aborted',
            runId,
            appliedSoFar: appliedSoFar.length,
            remaining: pending.length - appliedSoFar.length,
          },
          'migrate.aborted',
        )
        return appliedSoFar
      }

      const contents = await readFile(join(migrationsDir, file), 'utf8')
      validateNoTransactionStatements(file, contents)

      const start = performance.now()
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL statement_timeout = 0')
        await client.query("SET LOCAL lock_timeout = '30s'")
        await client.query("SET LOCAL application_name = 'mythrun-migrate'")
        await client.query(contents)
        await client.query('INSERT INTO _migrations (version) VALUES ($1)', [file])
        await client.query('COMMIT')
      } catch (pgErr) {
        try {
          await client.query('ROLLBACK')
        } catch {
          /* swallow; reported below */
        }
        const durationMs = Math.round(performance.now() - start)
        logger.error(
          { event: 'migrate.failed', runId, version: file, durationMs, err: pgErr },
          'migrate.failed',
        )
        const err = pgErr instanceof Error ? pgErr : new Error(String(pgErr))
        const wrapped = new Error(`migration ${file} failed: ${err.message}`, { cause: err })
        errorPath = wrapped
        throw wrapped
      }
      const durationMs = Math.round(performance.now() - start)
      logger.info(
        { event: 'migrate.applied', runId, version: file, durationMs },
        'migrate.applied',
      )
      appliedSoFar.push({ version: file, durationMs })
    }

    return appliedSoFar
  } catch (err) {
    if (!errorPath) errorPath = err instanceof Error ? err : new Error(String(err))
    throw errorPath
  } finally {
    if (acquiredLock) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY.toString()])
        logger.info(
          { event: 'migrate.lock_released', runId, holdMs: Math.round(performance.now() - lockStart) },
          'migrate.lock_released',
        )
      } catch (unlockErr) {
        logger.warn(
          { event: 'migrate.unlock_failed', runId, err: unlockErr },
          'migrate.unlock_failed',
        )
      }
    }
    if (errorPath) {
      client.release(errorPath)
    } else {
      try {
        await client.query('DISCARD ALL')
      } catch {
        /* best-effort */
      }
      client.release()
    }
    logger.info(
      { event: 'migrate.done', runId, applied: appliedSoFar.length, totalMs: Math.round(performance.now() - runStart) },
      'migrate.done',
    )
  }
}

async function acquireAdvisoryLockWithHeartbeat(
  client: import('pg').PoolClient,
  runId: string,
  logger: MigrateLogger,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  const lockArg = LOCK_KEY.toString()
  const tryRes = await client.query<{ ok: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS ok',
    [lockArg],
  )
  if (tryRes.rows[0]?.ok) return

  const lockStart = performance.now()
  let lastHeartbeatAt = 0
  const heartbeatIntervalMs = 5000
  for (;;) {
    if (abortSignal?.aborted) {
      throw new Error('migrate aborted while waiting for advisory lock')
    }
    const now = performance.now()
    if (now - lastHeartbeatAt >= heartbeatIntervalMs) {
      const holder = await queryHolder(client).catch(() => null)
      logger.info(
        {
          event: 'migrate.lock_waiting',
          runId,
          waitMsSoFar: Math.round(now - lockStart),
          holder,
        },
        'migrate.lock_waiting',
      )
      lastHeartbeatAt = now
    }
    await new Promise((r) => setTimeout(r, 500))
    const again = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS ok',
      [lockArg],
    )
    if (again.rows[0]?.ok) return
  }
}

interface LockHolder {
  pid: number
  applicationName: string | null
  state: string | null
  queryStartedAt: string | null
  queryPreview: string | null
}

async function queryHolder(client: import('pg').PoolClient): Promise<LockHolder | null> {
  // pg_locks splits the bigint advisory key across classid (high 32) + objid (low 32),
  // with objsubid = 1 marking int8-style advisory locks.
  const sql = `
    SELECT psa.pid, psa.application_name, psa.state,
           psa.query_start, psa.query
      FROM pg_locks pl
      JOIN pg_stat_activity psa ON psa.pid = pl.pid
     WHERE pl.locktype = 'advisory'
       AND pl.classid  = (($1::bigint >> 32) & x'FFFFFFFF'::bigint)::int
       AND pl.objid    = ($1::bigint & x'FFFFFFFF'::bigint)::int
       AND pl.objsubid = 1
       AND pl.granted  = true
     LIMIT 1
  `
  const res = await client.query<{
    pid: number
    application_name: string | null
    state: string | null
    query_start: Date | null
    query: string | null
  }>(sql, [LOCK_KEY.toString()])
  const row = res.rows[0]
  if (!row) return null
  return {
    pid: row.pid,
    applicationName: row.application_name,
    state: row.state,
    queryStartedAt: row.query_start ? row.query_start.toISOString() : null,
    queryPreview: row.query ? row.query.slice(0, 200) : null,
  }
}

function cryptoRandomId(): string {
  // Fallback when caller doesn't supply runId — full uuidv7 is preferred but
  // we don't import the package here so server-boot wiring can pass its own.
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
```

- [ ] **Step 4: Run tests**

```bash
cd backend && pnpm vitest run src/db/__tests__/migrate.test.ts
```

Expected: Tests 1, 4, 5 pass.

- [ ] **Step 5: Run typecheck + lint**

```bash
cd backend && pnpm typecheck && pnpm lint
```

Both pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/migrate.ts backend/src/db/__tests__/migrate.test.ts
git commit -m "feat(myt-32): runMigrations — happy path with advisory lock + heartbeat"
```

---

## Task 10: Error paths — partial state, failed migration, drift, out-of-order, banned statements

**Files:**
- Modify: `backend/src/db/migrate.ts` (add out-of-order detection + drift warning)
- Modify: `backend/src/db/__tests__/migrate.test.ts` (Tests 2, 3, 3b, 6, 7, 7b, 14, 15)

- [ ] **Step 1: Write the failing tests**

Append these tests to `backend/src/db/__tests__/migrate.test.ts` inside the same `describe` block:

```ts
  it('Test 2: partial state — only unapplied migrations run', async () => {
    fixtureDir = makeFixtureDir({
      '001_a.sql': 'CREATE TABLE a (id INT)',
      '002_b.sql': 'CREATE TABLE b (id INT)',
      '003_c.sql': 'CREATE TABLE c (id INT)',
    })
    // Pre-state: 001 already "applied", and table a pre-exists
    await pool.query(
      'CREATE TABLE IF NOT EXISTS _migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    )
    await pool.query("INSERT INTO _migrations (version) VALUES ('001_a.sql')")
    await pool.query('CREATE TABLE a (id INT)')

    const { logger } = makeSpyLogger()
    const applied = await runMigrations({ pool, migrationsDir: fixtureDir, logger })
    expect(applied.map((m) => m.version)).toEqual(['002_b.sql', '003_c.sql'])
    const rows = await pool.query<{ version: string }>(
      `SELECT version FROM _migrations ORDER BY version`,
    )
    expect(rows.rows.map((r) => r.version)).toEqual(['001_a.sql', '002_b.sql', '003_c.sql'])
  })

  it('Test 3: failed migration aborts the run', async () => {
    fixtureDir = makeFixtureDir({
      '001_a.sql': 'CREATE TABLE a (id INT)',
      '002_broken.sql': 'THIS IS NOT VALID SQL;',
      '003_c.sql': 'CREATE TABLE c (id INT)',
    })
    const { logger } = makeSpyLogger()
    await expect(
      runMigrations({ pool, migrationsDir: fixtureDir, logger }),
    ).rejects.toThrow(/002_broken\.sql/)

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('a','c')`,
    )
    expect(tables.rows.map((r) => r.table_name)).toEqual(['a'])
    const rows = await pool.query<{ version: string }>(
      `SELECT version FROM _migrations ORDER BY version`,
    )
    expect(rows.rows.map((r) => r.version)).toEqual(['001_a.sql'])
  })

  it('Test 3b: bookkeeping insert is inside the transaction', async () => {
    fixtureDir = makeFixtureDir({
      '001_ok.sql': 'CREATE TABLE ok (id INT)',
      '002_writes_then_fails.sql': 'CREATE TABLE x (id INT); SELECT 1/0;',
    })
    const { logger } = makeSpyLogger()
    await expect(
      runMigrations({ pool, migrationsDir: fixtureDir, logger }),
    ).rejects.toThrow()
    const xExists = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='x'`,
    )
    expect(xExists.rows[0]?.count).toBe('0')
    const rows = await pool.query<{ version: string }>(`SELECT version FROM _migrations`)
    expect(rows.rows.map((r) => r.version)).not.toContain('002_writes_then_fails.sql')
  })

  it('Test 6: non-.sql files and dotfiles are ignored', async () => {
    fixtureDir = makeFixtureDir({
      '001_a.sql': 'CREATE TABLE a (id INT)',
      '002_b.sql': 'CREATE TABLE b (id INT)',
      'README.md': '# notes',
      '.DS_Store': 'binary-noise',
      'notes.txt': 'plain',
    })
    const { logger } = makeSpyLogger()
    const applied = await runMigrations({ pool, migrationsDir: fixtureDir, logger })
    expect(applied.map((m) => m.version)).toEqual(['001_a.sql', '002_b.sql'])
  })

  it('Test 7: top-level COMMIT is rejected', async () => {
    fixtureDir = makeFixtureDir({
      '001_bad.sql': 'CREATE TABLE x (id INT);\nCOMMIT;',
    })
    const { logger } = makeSpyLogger()
    await expect(
      runMigrations({ pool, migrationsDir: fixtureDir, logger }),
    ).rejects.toThrow(/forbidden top-level transaction statement/)
    const rows = await pool.query<{ count: string }>(`SELECT count(*)::text FROM _migrations`)
    expect(rows.rows[0]?.count).toBe('0')
  })

  it('Test 7b: PL/pgSQL DO blocks and CREATE FUNCTION bodies are accepted', async () => {
    fixtureDir = makeFixtureDir({
      '001_do_block.sql': `DO $$ BEGIN RAISE NOTICE 'hi'; END $$;`,
      '002_function.sql': `CREATE OR REPLACE FUNCTION f() RETURNS void AS $$
BEGIN
  RAISE NOTICE 'hi';
END
$$ LANGUAGE plpgsql;`,
    })
    const { logger } = makeSpyLogger()
    const applied = await runMigrations({ pool, migrationsDir: fixtureDir, logger })
    expect(applied.map((m) => m.version)).toEqual(['001_do_block.sql', '002_function.sql'])
  })

  it('Test 14: out-of-order migration is rejected', async () => {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS _migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    )
    await pool.query(
      "INSERT INTO _migrations (version) VALUES ('001_a.sql'), ('003_c.sql')",
    )
    fixtureDir = makeFixtureDir({
      '001_a.sql': 'CREATE TABLE a (id INT)',
      '002_b.sql': 'CREATE TABLE b (id INT)',
      '003_c.sql': 'CREATE TABLE c (id INT)',
    })
    const { logger } = makeSpyLogger()
    await expect(
      runMigrations({ pool, migrationsDir: fixtureDir, logger }),
    ).rejects.toThrow(/out-of-order.*002_b\.sql/)
    const exists = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='b'`,
    )
    expect(exists.rows[0]?.count).toBe('0')
  })

  it('Test 15: drift warning when applied row has no file on disk', async () => {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS _migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    )
    await pool.query("INSERT INTO _migrations (version) VALUES ('999_ghost.sql')")
    fixtureDir = makeFixtureDir({ '001_a.sql': 'CREATE TABLE a (id INT)' })
    const { logger, lines } = makeSpyLogger()
    const applied = await runMigrations({ pool, migrationsDir: fixtureDir, logger })
    expect(applied.map((m) => m.version)).toEqual(['001_a.sql'])
    const drift = lines.find((l) => l['event'] === 'migrate.drift_missing_files')
    expect(drift).toBeDefined()
    expect(drift?.['missing']).toEqual(['999_ghost.sql'])
  })
```

- [ ] **Step 2: Run, expect FAIL on Tests 14 + 15**

```bash
cd backend && pnpm vitest run src/db/__tests__/migrate.test.ts
```

Expected: Tests 2, 3, 3b, 6, 7, 7b pass already (the implementation from Task 9 covers them). Tests 14 and 15 fail because out-of-order detection and drift warning are not yet implemented.

- [ ] **Step 3: Add out-of-order + drift detection**

In `backend/src/db/migrate.ts`, in `runMigrations`, replace this block:

```ts
    const appliedRows = await client.query<{ version: string }>(
      'SELECT version FROM _migrations',
    )
    const applied = new Set(appliedRows.rows.map((r) => r.version))
    const pending = files.filter((f) => !applied.has(f))
```

with:

```ts
    const appliedRows = await client.query<{ version: string }>(
      'SELECT version FROM _migrations',
    )
    const applied = new Set(appliedRows.rows.map((r) => r.version))
    const pending = files.filter((f) => !applied.has(f))

    // Drift: applied rows without a file on disk. Warn and continue.
    const fileSet = new Set(files)
    const missing = [...applied].filter((v) => !fileSet.has(v)).sort()
    if (missing.length > 0) {
      logger.warn(
        { event: 'migrate.drift_missing_files', runId, missing },
        'migrate.drift_missing_files',
      )
    }

    // Out-of-order: pending versions lex-less than the highest applied.
    if (applied.size > 0) {
      const maxApplied = [...applied].sort().at(-1) ?? ''
      const outOfOrder = pending.filter((p) => p < maxApplied)
      if (outOfOrder.length > 0) {
        throw new Error(
          `out-of-order migrations detected: ${outOfOrder.join(', ')} ` +
            `precede already-applied ${maxApplied}. ` +
            `Rebase to a version greater than the highest applied. ` +
            `If you intentionally need to backfill, see spec §12 Recovery.`,
        )
      }
    }
```

- [ ] **Step 4: Run, expect PASS**

```bash
cd backend && pnpm vitest run src/db/__tests__/migrate.test.ts && pnpm typecheck && pnpm lint
```

All migrate tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/migrate.ts backend/src/db/__tests__/migrate.test.ts
git commit -m "feat(myt-32): runMigrations — out-of-order rejection + drift warning + error tests"
```

---

## Task 11: Abort signal + logger contract tests (Tests 8, 9, 11, 13)

**Files:**
- Modify: `backend/src/db/__tests__/migrate.test.ts`

> **Implementer note:** the runner's abort and logger code already lives in Task 9's implementation. This task is test-only — pinning the contract.

- [ ] **Step 1: Write the failing tests**

Append to the same `describe` block in `migrate.test.ts`:

```ts
  it('Test 8: abortSignal requests a graceful stop between migrations', async () => {
    fixtureDir = makeFixtureDir({
      '001_a.sql': 'CREATE TABLE a (id INT)',
      '002_b.sql': 'CREATE TABLE b (id INT)',
      '003_c.sql': 'CREATE TABLE c (id INT)',
    })
    const controller = new AbortController()
    const lines: Array<Record<string, unknown>> = []
    const sink: DestinationStream = {
      write: (s: string) => {
        const obj = JSON.parse(s) as Record<string, unknown>
        lines.push(obj)
        if (obj['event'] === 'migrate.applied') {
          controller.abort()
        }
      },
    }
    const logger = pino({ base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } }, sink)
    const applied = await runMigrations({
      pool, migrationsDir: fixtureDir, logger, abortSignal: controller.signal,
    })
    expect(applied.map((m) => m.version)).toEqual(['001_a.sql'])
    const bExists = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='b'`,
    )
    expect(bExists.rows[0]?.count).toBe('0')
    const aborted = lines.find((l) => l['event'] === 'migrate.aborted')
    expect(aborted).toBeDefined()
  })

  it('Test 9: logger contract — emits expected events with shared runId', async () => {
    fixtureDir = makeFixtureDir({
      '001_a.sql': 'CREATE TABLE a (id INT)',
      '002_b.sql': 'CREATE TABLE b (id INT)',
      '003_c.sql': 'CREATE TABLE c (id INT)',
    })
    const { logger, lines } = makeSpyLogger()
    await runMigrations({ pool, migrationsDir: fixtureDir, logger, runId: 'fixed-run-id' })
    const events = lines.map((l) => l['event'])
    expect(events).toContain('migrate.start')
    expect(events).toContain('migrate.lock_acquired')
    expect(events).toContain('migrate.plan')
    expect(events.filter((e) => e === 'migrate.applied')).toHaveLength(3)
    expect(events).toContain('migrate.lock_released')
    expect(events).toContain('migrate.done')
    expect(events).not.toContain('migrate.failed')
    for (const line of lines) {
      if (line['event'] === 'migrate.signal_received') continue
      expect(line['runId']).toBe('fixed-run-id')
    }
    for (const line of lines) {
      expect(line['component']).toBe('migrate')
    }
    const applied = lines.filter((l) => l['event'] === 'migrate.applied')
    for (const a of applied) {
      expect(a['version']).toMatch(/^00\d_[abc]\.sql$/)
      expect(typeof a['durationMs']).toBe('number')
    }
  })

  it('Test 11: error logs include serialized stack and pg fields', async () => {
    fixtureDir = makeFixtureDir({ '001_broken.sql': 'NOT SQL;' })
    const { logger, lines } = makeSpyLogger()
    await expect(runMigrations({ pool, migrationsDir: fixtureDir, logger })).rejects.toThrow()
    const failed = lines.find((l) => l['event'] === 'migrate.failed')
    expect(failed).toBeDefined()
    const err = failed?.['err'] as Record<string, unknown> | undefined
    expect(typeof err?.['message']).toBe('string')
    expect(typeof err?.['stack']).toBe('string')
    // pg's std serializer captures `code` (SQLSTATE).
    expect(typeof err?.['code']).toBe('string')
  })

  it('Test 13: lock-wait heartbeat fires with holder info', async () => {
    fixtureDir = makeFixtureDir({ '001_a.sql': 'CREATE TABLE a (id INT)' })
    // Hold the lock from a separate client.
    const holder = createPgPool(databaseUrl, { max: 1 })
    const holderClient = await holder.connect()
    await holderClient.query("SET application_name = 'test-holder'")
    await holderClient.query('SELECT pg_advisory_lock($1)', [
      (-3411702991737540243n).toString(),
    ])
    try {
      const { logger, lines } = makeSpyLogger()
      const runPromise = runMigrations({ pool, migrationsDir: fixtureDir, logger })
      // Wait long enough for at least one heartbeat (5s + jitter).
      await new Promise((r) => setTimeout(r, 6500))
      // Release the holder so the runner can proceed.
      await holderClient.query('SELECT pg_advisory_unlock_all()')
      await runPromise
      const waiting = lines.filter((l) => l['event'] === 'migrate.lock_waiting')
      expect(waiting.length).toBeGreaterThanOrEqual(1)
      const first = waiting[0] ?? {}
      expect(typeof first['waitMsSoFar']).toBe('number')
      const heldBy = first['holder'] as { applicationName: string | null } | null | undefined
      expect(heldBy?.applicationName).toBe('test-holder')
    } finally {
      holderClient.release()
      await holder.end()
    }
  }, 30_000)
```

- [ ] **Step 2: Run tests**

```bash
cd backend && pnpm vitest run src/db/__tests__/migrate.test.ts
```

Expected: all four pass. (The implementation from Task 9 already supports them; Task 11 is verification.)

- [ ] **Step 3: Commit**

```bash
git add backend/src/db/__tests__/migrate.test.ts
git commit -m "test(myt-32): pin abortSignal + logger contract + lock-wait heartbeat"
```

---

## Task 12: CLI block — pino with redaction, signals, env hints

**Files:**
- Modify: `backend/src/db/migrate.ts` (append the CLI block)
- Modify: `backend/package.json` (add `db:migrate` + `db:migrate:compiled` scripts)
- Modify: root `package.json` (add filter-shim `db:migrate` script)

> **Implementer note:** the CLI block runs only when migrate.ts is invoked directly (not when imported). Test 16/17 from the spec are integration tests that exercise this block; we cover them through the end-to-end run in Task 13.

- [ ] **Step 1: Append the CLI block to `backend/src/db/migrate.ts`**

```ts
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { uuidv7 } from 'uuidv7'
import pino from 'pino'
import { loadEnv } from '../config/env.js'
import { createPgPool } from './postgres.js'
import { installSignalHandlers } from '../boot/signal-handlers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const DEFAULT_MIGRATIONS_DIR = resolve(__dirname, '../../migrations')

const argv1 = process.argv[1]
if (argv1 && import.meta.url === pathToFileURL(argv1).href) {
  // env is declared BEFORE the logger so the err serializer's closure
  // can read env?.databaseUrl when it fires.
  let env: ReturnType<typeof loadEnv> | undefined

  // Recursive password-redaction wrapper around pino.stdSerializers.err.
  // Pino's `redact: { paths }` does NOT match arbitrary depth — `*.password`
  // matches one level only — so we enumerate known leak paths AND keep
  // this serializer as the primary defense.
  const stripPgConnectionFields = (
    obj: Record<string, unknown>,
    password: string | undefined,
  ): void => {
    delete obj['connectionParameters']
    delete obj['connectionString']
    if (password) {
      const escaped = password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(escaped, 'g')
      if (typeof obj['message'] === 'string') {
        obj['message'] = (obj['message'] as string).replace(re, '[REDACTED]')
      }
      if (typeof obj['stack'] === 'string') {
        obj['stack'] = (obj['stack'] as string).replace(re, '[REDACTED]')
      }
    }
    if (obj['cause'] && typeof obj['cause'] === 'object') {
      stripPgConnectionFields(obj['cause'] as Record<string, unknown>, password)
    }
  }
  const errSerializer = (err: unknown): Record<string, unknown> => {
    const base = pino.stdSerializers.err(err as Error) as Record<string, unknown>
    let password: string | undefined
    try {
      password = env?.databaseUrl ? new URL(env.databaseUrl).password || undefined : undefined
    } catch {
      /* malformed URL */
    }
    stripPgConnectionFields(base, password)
    return base
  }

  const logger = pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    base: { component: 'migrate' },
    serializers: { err: errSerializer },
    redact: {
      paths: [
        'err.connectionParameters',
        'err.connectionParameters.password',
        'err.connectionString',
        'err.cause.connectionParameters',
        'err.cause.connectionParameters.password',
        'err.cause.connectionString',
      ],
      remove: true,
    },
  })

  const abortController = new AbortController()
  installSignalHandlers(abortController)
  abortController.signal.addEventListener('abort', () => {
    logger.warn({ event: 'migrate.signal_received' }, 'migrate.signal_received')
  })

  try {
    env = loadEnv()
  } catch (err) {
    logger.error(
      { event: 'migrate.fatal', err },
      'migrate.fatal — check DATABASE_URL or backend/.env.development. ' +
        'For local dev: run `pnpm db:up` and copy `.env.development.example` to `.env.development`.',
    )
    process.exitCode = 1
    process.exit()
  }

  const pool = createPgPool(env.databaseUrl, {
    max: 1,
    connectionTimeoutMillis: 10_000,
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
      {
        event: applied.length === 0 ? 'migrate.no_pending' : 'migrate.complete',
        runId,
        count: applied.length,
        versions: applied.map((m) => m.version),
      },
      applied.length === 0 ? 'migrate.no_pending' : 'migrate.complete',
    )
    if (abortController.signal.aborted) {
      process.exitCode = 130
    }
  } catch (err) {
    const cause = (err instanceof Error && err.cause) ?? err
    const code = (cause as { code?: string })?.code
    let hint: string | undefined
    if (code === '42501') {
      hint = 'insufficient_privilege. Common causes: (1) migration role lacks rds_superuser for CREATE EXTENSION (see spec §8.4); (2) role lacks USAGE/CREATE on target schema; (3) RLS policy blocks the statement.'
    } else if (code === '28P01') {
      hint = 'auth failed. Verify MIGRATE_DATABASE_URL / DATABASE_URL credentials match the role secret.'
    } else if (code === '3D000') {
      hint = 'database does not exist. For local dev, run `pnpm db:up`. For RDS, verify the dbname.'
    } else if (code === 'ECONNREFUSED') {
      hint = 'Postgres unreachable. For local dev, run `pnpm db:up`. For staging/prod, check the security group.'
    } else if (code === 'ENOTFOUND') {
      hint = 'hostname could not be resolved. Verify the DB host in the URL.'
    } else if (code === 'ETIMEDOUT') {
      hint = 'connection timed out (10s). Likely a security group / VPC routing issue.'
    }
    logger.error(
      {
        event: 'migrate.fatal',
        runId,
        err,
        ...(hint && { hint }),
        nextStep: `query CloudWatch with: filter component='migrate' and runId='${runId}'`,
      },
      'migrate.fatal',
    )
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

// Re-export the runtime-MIGRATE_DATABASE_URL guard logic for completeness:
// loadEnv() handles MIGRATE_DATABASE_URL precedence per Task 3.
```

- [ ] **Step 2: Add scripts to `backend/package.json`**

In the `scripts` block, add:

```json
{
  "scripts": {
    "dev": "tsx watch --env-file=.env.development src/server.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src --no-error-on-unmatched-pattern",
    "typecheck": "tsc --noEmit",
    "db:migrate": "tsx --env-file=.env.development src/db/migrate.ts",
    "db:migrate:compiled": "node dist/db/migrate.js"
  }
}
```

- [ ] **Step 3: Add the root shim**

In root `package.json` `scripts`, add (alphabetized near other `db:*` scripts):

```json
"db:migrate": "pnpm --filter @mythrun/backend db:migrate",
```

So the existing block becomes:

```json
{
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint",
    "test": "pnpm -r test",
    "build": "pnpm -r build",
    "dev": "pnpm --filter backend dev",
    "db:up": "docker compose up -d --wait",
    "db:down": "docker compose down",
    "db:reset": "docker compose down -v && docker compose up -d --wait",
    "db:migrate": "pnpm --filter @mythrun/backend db:migrate",
    "wiki:build": "pnpm --filter @mythrun/wiki build",
    ...
  }
}
```

- [ ] **Step 4: Type/lint check**

```bash
pnpm typecheck && pnpm lint
```

Both pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/migrate.ts backend/package.json package.json
git commit -m "feat(myt-32): CLI entrypoint with pino redact, signal handling, hint table"
```

---

## Task 13: End-to-end verification — run `pnpm db:migrate` against local Postgres

**Files:** none — this is a manual verification that proves the binary path works.

- [ ] **Step 1: Reset the local DB**

```bash
pnpm db:reset
```

Expected: docker-compose stops and re-creates the Postgres container with an empty volume.

- [ ] **Step 2: First run — applies the smoke migration**

```bash
pnpm db:migrate
```

Expected output (JSON pino lines):

- A `migrate.start` event
- A `migrate.lock_acquired` event
- A `migrate.plan` event with `pending: 1, total: 1, pendingVersions: ["001_smoke.sql"]`
- A `migrate.applied` event with `version: "001_smoke.sql"`, `durationMs >= 0`
- A `migrate.lock_released` event
- A `migrate.done` event
- A `migrate.complete` summary line

Process exits 0.

- [ ] **Step 3: Verify the smoke migration landed**

```bash
docker exec -i mythrun-postgres-1 psql -U mythrun -d mythrun -c "SELECT version, applied_at FROM _migrations ORDER BY version"
```

Expected: one row, `001_smoke.sql`.

```bash
docker exec -i mythrun-postgres-1 psql -U mythrun -d mythrun -c "SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'"
```

Expected: `pgcrypto` row exists.

- [ ] **Step 4: Second run — no-op**

```bash
pnpm db:migrate
```

Expected output:

- A `migrate.plan` event with `pending: 0, total: 1`
- A `migrate.no_pending` summary line
- No `migrate.applied` events

Process exits 0.

- [ ] **Step 5: Verify all checks**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

All three pass. Migration tests run against the live local DB.

- [ ] **Step 6: Commit nothing — this is verification only**

If everything passes, no commit is needed. Move on to the CI task.

---

## Task 14: CI Postgres service container

**Files:**
- Modify: `.github/workflows/deploy.yml`

> **Implementer note:** the deploy workflow currently runs `pnpm test` with no Postgres available. Without this change, the integration tests added in Tasks 9–11 will fail in CI and red-light every deploy.

- [ ] **Step 1: Read the current deploy.yml to find the build job**

```bash
grep -n "pnpm.*test" .github/workflows/deploy.yml
```

Note the line number where `pnpm --filter @mythrun/backend test` runs.

- [ ] **Step 2: Add the Postgres service to the build job**

In `.github/workflows/deploy.yml`, find the build job (the one that runs `pnpm --filter @mythrun/backend test`). Add a `services:` block at the job level (sibling of `steps:`):

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

- [ ] **Step 3: Add `DATABASE_URL` to the test step**

Find the line:

```yaml
      - run: pnpm --filter @mythrun/backend test
```

Replace with:

```yaml
      - run: pnpm --filter @mythrun/backend test
        env:
          DATABASE_URL: postgresql://mythrun:mythrun_dev@127.0.0.1:5432/mythrun
```

- [ ] **Step 4: Validate the YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml'))"
```

Expected: no output (valid YAML).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci(myt-32): postgres:16-alpine service + DATABASE_URL for backend tests"
```

- [ ] **Step 6: Push and verify on GitHub**

```bash
git push
```

Open the GitHub Actions run; verify the build job has a "postgres" service container in the logs and that `pnpm --filter @mythrun/backend test` passes.

---

## Self-Review

1. **Spec coverage**:
   - §2 file layout → all files created/modified across tasks 1–14 ✓
   - §3 runner contract → Task 9 ✓
   - §4 tracking table → Task 9 (CREATE TABLE IF NOT EXISTS in algorithm) ✓
   - §5 algorithm + lock heartbeat + LOCK_KEY + validators + out-of-order + drift → Tasks 6, 7, 9, 10 ✓
   - §6 CLI → Task 12 ✓
   - §7 logging contract → covered by Tasks 9, 11, 12 (events emitted; Test 9 pins them) ✓
   - §8 build & invocation (createPgPool, Dockerfile, scripts, RDS privilege docs) → Tasks 2, 8, 12 ✓
   - §9 smoke migration → Task 8 ✓
   - §10 testing infra (CI service, vitest, dotenv, guard, reset, fixtures, Tests 1–17) → Tasks 4, 5, 9, 10, 11, 14 ✓
   - §11 error matrix → covered by tests in Tasks 10, 11; runtime by Task 9 + 12 ✓
   - §12 recovery → documentation only; no code task needed ✓
   - §13 follow-ups → out of scope (correct) ✓
   - §14 DoD: all bullet points map to tasks. **Wiki and manual staging-RDS verification** are explicitly NOT in DoD per spec §14 closing notes — wiki via post-Linear-close hook, staging in §13. ✓
   - Tests 16 (password redaction) and 17 (empty MIGRATE_DATABASE_URL) — Test 17 is covered functionally by Task 3's env tests. **Test 16 is not yet in the plan**; adding here is best done as a unit test against `errSerializer` directly without needing a real failed pg connection. See gap fix below.

2. **Placeholder scan**: no TBDs, all code blocks complete, all commands concrete. ✓

3. **Type consistency**:
   - `MigrateLogger`, `MigrationOptions`, `AppliedMigration` defined once in Task 9, used consistently ✓
   - `LOCK_KEY` is `bigint` everywhere; passed to pg as `LOCK_KEY.toString()` (pg-js maps bigint → numeric string for params) ✓
   - `runId` propagation: CLI → `MigrationOptions.runId` → every log payload ✓

**Gap fix — adding Task 11b for Test 16 (password redaction unit test):**

---

## Task 11b: Password redaction unit test (Test 16)

**Files:**
- Create: `backend/src/db/__tests__/migrate-redact.test.ts`

> **Implementer note:** the err serializer is defined inside the CLI block (Task 12), making it hard to import directly. Refactor: extract the redaction helper into a small named export so the test can exercise it without spawning a process.

- [ ] **Step 1: Refactor — extract `buildErrSerializer` from the CLI block**

In `backend/src/db/migrate.ts`, BEFORE the `if (argv1 && ...)` guard, add a module-level export:

```ts
export function buildErrSerializer(databaseUrl: string | undefined) {
  const stripPgConnectionFields = (
    obj: Record<string, unknown>,
    password: string | undefined,
  ): void => {
    delete obj['connectionParameters']
    delete obj['connectionString']
    if (password) {
      const escaped = password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(escaped, 'g')
      if (typeof obj['message'] === 'string') {
        obj['message'] = (obj['message'] as string).replace(re, '[REDACTED]')
      }
      if (typeof obj['stack'] === 'string') {
        obj['stack'] = (obj['stack'] as string).replace(re, '[REDACTED]')
      }
    }
    if (obj['cause'] && typeof obj['cause'] === 'object') {
      stripPgConnectionFields(obj['cause'] as Record<string, unknown>, password)
    }
  }
  return (err: unknown): Record<string, unknown> => {
    const base = pino.stdSerializers.err(err as Error) as Record<string, unknown>
    let password: string | undefined
    try {
      password = databaseUrl ? new URL(databaseUrl).password || undefined : undefined
    } catch {
      /* malformed URL */
    }
    stripPgConnectionFields(base, password)
    return base
  }
}
```

Then in the CLI block, replace the inline `errSerializer` with:

```ts
  const errSerializer = buildErrSerializer(undefined) // env not yet loaded
  // ... after env = loadEnv() succeeds, rebuild logger? No — instead pass a getter.
```

**Better:** thread the URL via a closure that reads `env` lazily. Rewrite as:

```ts
  const errSerializer = (() => {
    const cached = buildErrSerializer.bind(null)
    return (err: unknown) => cached(env?.databaseUrl)(err)
  })()
```

Actually cleanest: change `buildErrSerializer` signature to take a getter:

```ts
export function buildErrSerializer(getDatabaseUrl: () => string | undefined) {
  // ... same body, replace `databaseUrl` with `getDatabaseUrl()`
}
```

And in the CLI:

```ts
  const errSerializer = buildErrSerializer(() => env?.databaseUrl)
```

Apply that variant.

- [ ] **Step 2: Write the failing test**

Create `backend/src/db/__tests__/migrate-redact.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildErrSerializer } from '../migrate.js'

describe('buildErrSerializer', () => {
  const PASSWORD = 'pw123secret'
  const url = `postgresql://user:${PASSWORD}@host:5432/mythrun`
  const serialize = buildErrSerializer(() => url)

  it('redacts password from message at top level', () => {
    const err = new Error(`connect failed for postgresql://user:${PASSWORD}@host:5432/mythrun`)
    const out = serialize(err)
    expect((out['message'] as string)).not.toContain(PASSWORD)
    expect((out['message'] as string)).toContain('[REDACTED]')
  })

  it('redacts password from cause chain', () => {
    const inner = new Error(`auth failed for ${PASSWORD}`)
    const outer = new Error('outer', { cause: inner })
    const out = serialize(outer)
    const cause = out['cause'] as Record<string, unknown>
    expect((cause['message'] as string)).not.toContain(PASSWORD)
    expect((cause['message'] as string)).toContain('[REDACTED]')
  })

  it('strips connectionParameters and connectionString', () => {
    type FakePgError = Error & {
      connectionParameters?: { password: string }
      connectionString?: string
    }
    const err = Object.assign(new Error('boom'), {
      connectionParameters: { password: PASSWORD },
      connectionString: url,
    }) as FakePgError
    const out = serialize(err)
    expect(out['connectionParameters']).toBeUndefined()
    expect(out['connectionString']).toBeUndefined()
  })

  it('strips connectionParameters from cause as well', () => {
    type FakePgError = Error & { connectionParameters?: { password: string } }
    const inner = Object.assign(new Error('inner'), {
      connectionParameters: { password: PASSWORD },
    }) as FakePgError
    const outer = new Error('outer', { cause: inner })
    const out = serialize(outer)
    const cause = out['cause'] as Record<string, unknown>
    expect(cause['connectionParameters']).toBeUndefined()
  })

  it('handles a malformed URL gracefully (no throw)', () => {
    const fn = buildErrSerializer(() => 'not a real url')
    const err = new Error('boom')
    expect(() => fn(err)).not.toThrow()
  })

  it('passes through normal Errors without a configured URL', () => {
    const fn = buildErrSerializer(() => undefined)
    const err = new Error('something happened')
    const out = fn(err)
    expect(out['message']).toBe('something happened')
    expect(typeof out['stack']).toBe('string')
  })
})
```

- [ ] **Step 3: Run, expect PASS**

```bash
cd backend && pnpm vitest run src/db/__tests__/migrate-redact.test.ts && pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/db/migrate.ts backend/src/db/__tests__/migrate-redact.test.ts
git commit -m "test(myt-32): pin password redaction (top-level + cause chain)"
```

---

## Plan Summary

15 tasks (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11b, 12, 13, 14) covering deps, pool overrides, env extension, vitest infra, DB guard, lock-key constant, validators, smoke migration + Dockerfile, runner happy path, error paths, abort/logger contracts, password redaction, CLI block, end-to-end verification, CI Postgres service.

Plan complete and saved to `docs/superpowers/plans/2026-04-26-migrate-runner.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
