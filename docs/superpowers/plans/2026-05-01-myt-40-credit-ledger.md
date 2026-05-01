# MYT-40 Credit Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-01-myt-40-credit-ledger-design.md`
**Linear:** [MYT-40](https://linear.app/mythrun/issue/MYT-40)

**Goal:** Stand up `repo.credits` with `balance`, `grant`, `atomicDebit`, and `listEntries`, including migration 004's defense-in-depth invariants and a concurrent-debit test that proves no double-spend.

**Architecture:** Migration 004 adds three CHECK constraints + one partial unique index + one FK swap to the existing `credit_ledger` table from migration 001. The `credits` repo namespace owns all reads/writes through that table; `atomicDebit` opens a transaction, sets isolation + lock_timeout + statement_timeout, takes a `users`-row `FOR UPDATE` lock as the serialization anchor, runs an idempotency check, runs a balance check, inserts the debit row OR throws a typed error. Every non-success path issues a `ROLLBACK` before releasing the client.

**Tech Stack:** TypeScript 5.6 strict, Postgres 16 via `pg` 8.13, Vitest 3, the existing migration runner from MYT-32, and the existing repo pattern from MYT-34. Real-Postgres tests via the existing pattern (createPgPool + runMigrations + resetData per test).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `backend/migrations/004_credit_ledger_invariants.sql` | Create | Three CHECKs (polarity, debit-has-source, debit-no-expiry), partial unique index with `NULLS NOT DISTINCT`, FK CASCADE → RESTRICT swap, post-migration assertion |
| `backend/src/repo/types.ts` | Modify | Add `CreditType`, `CreditSourceType`, `CreditEntry`, `GrantInput`, `DebitInput`, `ListEntriesOpts` |
| `backend/src/repo/mappers.ts` | Modify | Add `CreditEntryDbRow`, `toCreditEntry`, narrowing helpers for `credit_type` / `source_type` |
| `backend/src/repo/credits-errors.ts` | Create | `InsufficientCreditsError`, `IdempotencyConflictError`, `DebitTimeoutError`, `UserNotFoundError`, `DEFAULT_LIST_LIMIT`, `DEBIT_LOCK_TIMEOUT_MS`, `DEBIT_STATEMENT_TIMEOUT_MS` |
| `backend/src/repo/credits.ts` | Create | `createCreditsRepo(pool, opts?)` factory + the four methods |
| `backend/src/repo/index.ts` | Modify | Add `credits: createCreditsRepo(pool)` to the returned object |
| `backend/src/repo/__tests__/credits.test.ts` | Create | All read / write / idempotency / concurrency / schema-invariant / listEntries tests |
| `docs/specs/2026-04-13-billing-cost-controls.md` | Modify | §2 patch — replace the buggy `FOR UPDATE on credit_ledger` recipe with the users-row-anchored version |

`credits-errors.ts` is split out from `credits.ts` because (a) callers (HTTP layer, future tickets) import the error classes for type-narrowing without needing the repo factory, and (b) the constants (`DEBIT_LOCK_TIMEOUT_MS` etc.) are referenced by the tests.

---

## Task 1: Migration 004 — `credit_ledger` invariants

**Files:**
- Create: `backend/migrations/004_credit_ledger_invariants.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- 004_credit_ledger_invariants.sql
-- Defense-in-depth at the schema layer for the credit_ledger from migration 001.
-- Application code already enforces these in repo.credits.*; the DB constraints
-- exist so a future caller (admin tool, Stripe webhook, bulk-fix migration)
-- cannot violate the invariants by accident.

-- Polarity invariant: source_type='debit' iff amount < 0.
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_polarity_chk
  CHECK ((source_type = 'debit') = (amount < 0));

-- Debits must carry an originating source_id (the session being charged,
-- the operation being billed, etc.). Required for idempotency.
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_debit_has_source_chk
  CHECK (source_type <> 'debit' OR source_id IS NOT NULL);

-- Debits must NOT carry expires_at — debits represent consumption and are
-- immutable; expiry is a grant-side concept. Without this CHECK, a future
-- caller could insert a debit row with expires_at and make balance SUM
-- non-monotonic (the row's contribution would disappear from balance after
-- expiry, effectively refunding the user).
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_debit_no_expiry_chk
  CHECK (source_type <> 'debit' OR expires_at IS NULL);

-- Idempotent debit: a retry of the same logical operation collides on
-- (user_id, credit_type, source_id) within source_type='debit' and is a no-op.
-- credit_type is part of the key so the same sourceId across credit_types
-- doesn't collide. NULLS NOT DISTINCT is defense-in-depth — the
-- credit_ledger_debit_has_source_chk already prevents NULL source_id on
-- debits, but if anyone weakens that CHECK in the future, NULL handling
-- here would silently regress. Requires Postgres 15+; we run 16.
CREATE UNIQUE INDEX uniq_credit_ledger_debit_idempotency
  ON credit_ledger (user_id, credit_type, source_id)
  NULLS NOT DISTINCT
  WHERE source_type = 'debit';

-- Revenue ledgers must NOT cascade-delete. The base table from migration 001
-- used ON DELETE CASCADE, which is wrong for a financial table — a hard-delete
-- of a user (admin error, GDPR erasure path) would silently erase every
-- purchase, refund, and debit, breaking Stripe reconciliation and audit.
-- Replace with ON DELETE RESTRICT. GDPR erasure becomes a soft-delete /
-- pseudonymize flow (out of scope here; tracked separately).
--
-- DROP CONSTRAINT IF EXISTS guards against the (unlikely) case where the FK
-- was created with a different auto-generated name. The post-migration
-- assertion catches the case where the new constraint failed to land.
ALTER TABLE credit_ledger
  DROP CONSTRAINT IF EXISTS credit_ledger_user_id_fkey;
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

DO $$ BEGIN
  ASSERT (
    SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'credit_ledger'::regclass
      AND contype = 'f'
      AND conname = 'credit_ledger_user_id_fkey'
  ) = 1, 'credit_ledger_user_id_fkey was not created or has a different name';
END $$;
```

- [ ] **Step 2: Run the migration against the dev DB**

Run: `cd backend && pnpm db:migrate`
Expected: output line `applied 004_credit_ledger_invariants.sql` and no errors. The DO/ASSERT block raises if the FK didn't land.

- [ ] **Step 3: Verify the constraints landed**

Run:
```bash
psql "$DATABASE_URL" -c "\d credit_ledger" | head -40
psql "$DATABASE_URL" -c "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='credit_ledger'::regclass ORDER BY conname"
```
Expected: see `credit_ledger_polarity_chk`, `credit_ledger_debit_has_source_chk`, `credit_ledger_debit_no_expiry_chk`, `credit_ledger_user_id_fkey` (with `ON DELETE RESTRICT`), and the `uniq_credit_ledger_debit_idempotency` index.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/004_credit_ledger_invariants.sql
git commit -m "feat(myt-40): migration 004 — credit_ledger defense-in-depth invariants"
```

---

## Task 2: Types — `CreditEntry` and inputs

**Files:**
- Modify: `backend/src/repo/types.ts`

- [ ] **Step 1: Append types to `types.ts`**

Add at the bottom of `backend/src/repo/types.ts`:

```typescript
// ─── Credits ─────────────────────────────────────────────────────────────────

export type CreditType = 'session' | 'world_gen'

export type CreditSourceType =
  | 'purchase'
  | 'subscription'
  | 'gift'
  | 'trial'
  | 'refund'
  | 'debit'

export interface CreditEntry {
  readonly id: string
  readonly userId: string
  readonly creditType: CreditType
  readonly amount: number              // positive = grant, negative = debit
  readonly sourceType: CreditSourceType
  readonly sourceId: string | null
  readonly grantedAt: Date
  readonly expiresAt: Date | null
}

export interface GrantInput {
  readonly userId: string
  readonly creditType: CreditType
  readonly amount: number              // must be > 0
  readonly sourceType: Exclude<CreditSourceType, 'debit'>
  readonly sourceId?: string | null
  readonly expiresAt?: Date | null
}

export interface DebitInput {
  readonly userId: string
  readonly creditType: CreditType
  readonly amount: number              // must be > 0; recorded as negative in ledger
  readonly sourceId: string            // REQUIRED — the per-user idempotency key
}

export interface ListEntriesOpts {
  readonly limit?: number | null       // null/omit → no LIMIT clause
  readonly type?: CreditType
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `cd backend && pnpm typecheck`
Expected: PASS (no new errors).

- [ ] **Step 3: Commit**

```bash
git add backend/src/repo/types.ts
git commit -m "feat(myt-40): credit-ledger types"
```

---

## Task 3: Mappers — `toCreditEntry` + DB row type

**Files:**
- Modify: `backend/src/repo/mappers.ts`

- [ ] **Step 1: Add the DB row type and narrowing helpers at the bottom of `mappers.ts`**

Append:

```typescript
// ─── Credits ─────────────────────────────────────────────────────────────────

import type { CreditEntry, CreditType, CreditSourceType } from './types.js'

export interface CreditEntryDbRow {
  readonly id: string
  readonly user_id: string
  readonly credit_type: string
  readonly amount: number
  readonly source_type: string
  readonly source_id: string | null
  readonly granted_at: Date
  readonly expires_at: Date | null
}

function toCreditType(v: string): CreditType {
  if (v !== 'session' && v !== 'world_gen') {
    throw new Error(`unexpected credit_type value from DB: ${v}`)
  }
  return v
}

function toCreditSourceType(v: string): CreditSourceType {
  if (
    v !== 'purchase' &&
    v !== 'subscription' &&
    v !== 'gift' &&
    v !== 'trial' &&
    v !== 'refund' &&
    v !== 'debit'
  ) {
    throw new Error(`unexpected source_type value from DB: ${v}`)
  }
  return v
}

export function toCreditEntry(row: CreditEntryDbRow): CreditEntry {
  return {
    id: row.id,
    userId: row.user_id,
    creditType: toCreditType(row.credit_type),
    amount: row.amount,
    sourceType: toCreditSourceType(row.source_type),
    sourceId: row.source_id,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
  }
}
```

The `import type` at the top of the new section is acceptable in this file because TypeScript hoists it. The existing `import type` at line 1 of mappers.ts already covers the existing types — the new line keeps the credits section self-contained for readability.

- [ ] **Step 2: Move the `import type` to the top of the file (consolidate)**

Open `backend/src/repo/mappers.ts`. Update the top import:

```typescript
import type {
  Campaign,
  CreditEntry,
  CreditSourceType,
  CreditType,
  Session,
  User,
  World,
} from './types.js'
```

Remove the duplicate `import type` line from the credits section — the consolidated import covers it.

- [ ] **Step 3: Verify typecheck passes**

Run: `cd backend && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/repo/mappers.ts
git commit -m "feat(myt-40): credit-entry mapper + db row type"
```

---

## Task 4: Errors module + constants

**Files:**
- Create: `backend/src/repo/credits-errors.ts`

- [ ] **Step 1: Create the file**

```typescript
// backend/src/repo/credits-errors.ts
//
// Custom Error subclasses thrown by repo.credits. Split from credits.ts so
// callers (HTTP layer, future tickets) can import these for type narrowing
// without pulling in the repo factory.

import type { CreditType } from './types.js'

export class InsufficientCreditsError extends Error {
  readonly code = 'INSUFFICIENT_CREDITS'
  constructor(
    readonly userId: string,
    readonly creditType: CreditType,
    readonly available: number,
    readonly requested: number,
  ) {
    super(
      `Insufficient ${creditType} credits: have ${available}, need ${requested}`,
    )
    this.name = 'InsufficientCreditsError'
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT'
  constructor(
    readonly userId: string,
    readonly sourceId: string,
    readonly existingAmount: number,    // absolute value
    readonly requestedAmount: number,
  ) {
    super(
      `Debit with sourceId=${sourceId} already exists for amount ${existingAmount}, ` +
        `but caller requested amount ${requestedAmount}. Same idempotency key cannot ` +
        `be reused for different debits.`,
    )
    this.name = 'IdempotencyConflictError'
  }
}

export class DebitTimeoutError extends Error {
  readonly code = 'DEBIT_TIMEOUT'
  constructor(
    readonly userId: string,
    readonly sqlstate: '55P03' | '57014',
  ) {
    super(`Debit timed out for user=${userId} (sqlstate=${sqlstate})`)
    this.name = 'DebitTimeoutError'
  }
}

export class UserNotFoundError extends Error {
  readonly code = 'USER_NOT_FOUND'
  constructor(readonly userId: string) {
    super(`User not found: ${userId}`)
    this.name = 'UserNotFoundError'
  }
}

// ─── Constants (overridable via createCreditsRepo opts for tests) ───────────

export const DEFAULT_LIST_LIMIT = 100
export const DEBIT_LOCK_TIMEOUT_MS = 1000
export const DEBIT_STATEMENT_TIMEOUT_MS = 5000
```

- [ ] **Step 2: Verify typecheck**

Run: `cd backend && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/src/repo/credits-errors.ts
git commit -m "feat(myt-40): credit-ledger error classes + timing constants"
```

---

## Task 5: Test scaffold + `balance()` method

**Files:**
- Create: `backend/src/repo/credits.ts`
- Create: `backend/src/repo/__tests__/credits.test.ts`

- [ ] **Step 1: Write the test file scaffold + the first 5 read tests**

`backend/src/repo/__tests__/credits.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createCreditsRepo } from '../credits.js'
import { resetData } from './_helpers/reset-data.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: () => {
      // discard
    },
  }
  return pino(
    { base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } },
    sink,
  )
}

const baseUserInput = {
  cognitoSub: 'google_credits_test',
  email: 'credits@test.local',
  displayName: 'Credits Tester',
  username: 'creditstester',
  authProvider: 'google' as const,
}

describe('credits repo (integration)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 1 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetData(pool)
  })

  describe('balance()', () => {
    it('returns 0 for an empty ledger (both credit types)', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      expect(await credits.balance(u.id, 'session')).toBe(0)
      expect(await credits.balance(u.id, 'world_gen')).toBe(0)
    })
  })
})
```

- [ ] **Step 2: Run the test — expect FAIL "credits.js cannot be found"**

Run: `cd backend && pnpm test -- credits.test`
Expected: FAIL with module-resolution error referencing `../credits.js`.

- [ ] **Step 3: Create `credits.ts` with `balance()` only**

`backend/src/repo/credits.ts`:

```typescript
import { type Pool } from 'pg'
import type { CreditType } from './types.js'

export interface CreditsRepoOpts {
  readonly debitLockTimeoutMs?: number
  readonly debitStatementTimeoutMs?: number
}

export function createCreditsRepo(pool: Pool, _opts: CreditsRepoOpts = {}) {
  return {
    balance: async (userId: string, type: CreditType): Promise<number> => {
      const result = await pool.query<{ balance: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS balance
           FROM credit_ledger
          WHERE user_id = $1
            AND credit_type = $2
            AND (expires_at IS NULL OR expires_at > now())`,
        [userId, type],
      )
      const row = result.rows[0]
      if (!row) return 0
      return Number(row.balance)
    },
  }
}

export type CreditsRepo = ReturnType<typeof createCreditsRepo>
```

The `COALESCE(SUM(amount), 0)::text` cast is to defend against pg's automatic numeric→string coercion for `SUM` on `INTEGER` (returns `bigint` in some cases). `Number(...)` on a small integer string is safe.

- [ ] **Step 4: Run the test — expect PASS**

Run: `cd backend && pnpm test -- credits.test`
Expected: 1 passing test.

- [ ] **Step 5: Add the remaining read tests inside `describe('balance()', ...)`**

Inside the same `describe('balance()', ...)` block, append:

```typescript
    it('grant + balance returns the granted amount', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)

      // Direct INSERT bypassing grant() because grant() lands in Task 6.
      await pool.query(
        `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type, source_id)
         VALUES (gen_random_uuid(), $1, 'session', 5, 'gift', NULL)`,
        [u.id],
      )

      expect(await credits.balance(u.id, 'session')).toBe(5)
      expect(await credits.balance(u.id, 'world_gen')).toBe(0)
    })

    it('multiple grants sum', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await pool.query(
        `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type)
         VALUES
           (gen_random_uuid(), $1, 'session', 3, 'gift'),
           (gen_random_uuid(), $1, 'session', 2, 'gift')`,
        [u.id],
      )
      expect(await credits.balance(u.id, 'session')).toBe(5)
    })

    it('expired credits are excluded', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await pool.query(
        `INSERT INTO credit_ledger
           (id, user_id, credit_type, amount, source_type, expires_at)
         VALUES
           (gen_random_uuid(), $1, 'session', 5, 'gift', now() - interval '1 day'),
           (gen_random_uuid(), $1, 'session', 3, 'gift', now() + interval '1 day')`,
        [u.id],
      )
      expect(await credits.balance(u.id, 'session')).toBe(3)
    })

    it('credit-type isolation: session and world_gen do not bleed', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await pool.query(
        `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type)
         VALUES
           (gen_random_uuid(), $1, 'session', 5, 'gift'),
           (gen_random_uuid(), $1, 'world_gen', 2, 'gift')`,
        [u.id],
      )
      expect(await credits.balance(u.id, 'session')).toBe(5)
      expect(await credits.balance(u.id, 'world_gen')).toBe(2)
    })
```

- [ ] **Step 6: Run the test — expect all 5 to PASS**

Run: `cd backend && pnpm test -- credits.test`
Expected: 5 passing tests.

- [ ] **Step 7: Commit**

```bash
git add backend/src/repo/credits.ts backend/src/repo/__tests__/credits.test.ts
git commit -m "feat(myt-40): credits.balance() + read tests"
```

---

## Task 6: `grant()` method + write tests

**Files:**
- Modify: `backend/src/repo/credits.ts`
- Modify: `backend/src/repo/__tests__/credits.test.ts`

- [ ] **Step 1: Write the failing test for grant()**

Inside `describe('credits repo (integration)', ...)`, after the `balance()` block, add:

```typescript
  describe('grant()', () => {
    it('inserts a positive credit entry and balance reflects it', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)

      const entry = await credits.grant({
        userId: u.id,
        creditType: 'session',
        amount: 5,
        sourceType: 'gift',
      })

      expect(entry.amount).toBe(5)
      expect(entry.sourceType).toBe('gift')
      expect(entry.creditType).toBe('session')
      expect(entry.userId).toBe(u.id)
      expect(entry.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(entry.expiresAt).toBeNull()
      expect(await credits.balance(u.id, 'session')).toBe(5)
    })

    it('throws on amount <= 0', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)

      await expect(
        credits.grant({ userId: u.id, creditType: 'session', amount: 0, sourceType: 'gift' }),
      ).rejects.toThrow(/amount must be > 0/)

      await expect(
        credits.grant({ userId: u.id, creditType: 'session', amount: -1, sourceType: 'gift' }),
      ).rejects.toThrow(/amount must be > 0/)
    })

    it('throws UserNotFoundError when user does not exist', async () => {
      const credits = createCreditsRepo(pool)
      const fakeId = '019dccef-0000-7000-8000-000000000000'

      const { UserNotFoundError } = await import('../credits-errors.js')
      await expect(
        credits.grant({ userId: fakeId, creditType: 'session', amount: 1, sourceType: 'gift' }),
      ).rejects.toBeInstanceOf(UserNotFoundError)
    })
  })
```

- [ ] **Step 2: Run — expect FAIL "credits.grant is not a function"**

Run: `cd backend && pnpm test -- credits.test`
Expected: FAIL.

- [ ] **Step 3: Implement `grant()` in `credits.ts`**

Replace the `createCreditsRepo` body to add `grant()`. The complete new `credits.ts`:

```typescript
import { type Pool, type PoolClient } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { toCreditEntry, type CreditEntryDbRow } from './mappers.js'
import type { CreditEntry, CreditType, GrantInput } from './types.js'
import {
  DEBIT_LOCK_TIMEOUT_MS,
  DEBIT_STATEMENT_TIMEOUT_MS,
  UserNotFoundError,
} from './credits-errors.js'

export interface CreditsRepoOpts {
  readonly debitLockTimeoutMs?: number
  readonly debitStatementTimeoutMs?: number
}

export function createCreditsRepo(pool: Pool, opts: CreditsRepoOpts = {}) {
  const lockTimeoutMs = opts.debitLockTimeoutMs ?? DEBIT_LOCK_TIMEOUT_MS
  const stmtTimeoutMs = opts.debitStatementTimeoutMs ?? DEBIT_STATEMENT_TIMEOUT_MS

  // SET LOCAL strings: building these as a multi-statement string keeps
  // BEGIN + the three SET LOCAL statements ordered correctly. See spec
  // "Atomic debit — locking strategy" — ordering is load-bearing.
  const beginAndConfigure = (client: PoolClient): Promise<unknown> =>
    client.query(
      `BEGIN;
       SET LOCAL transaction_isolation = 'read committed';
       SET LOCAL lock_timeout = '${lockTimeoutMs}ms';
       SET LOCAL statement_timeout = '${stmtTimeoutMs}ms';`,
    )

  return {
    balance: async (userId: string, type: CreditType): Promise<number> => {
      const result = await pool.query<{ balance: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS balance
           FROM credit_ledger
          WHERE user_id = $1
            AND credit_type = $2
            AND (expires_at IS NULL OR expires_at > now())`,
        [userId, type],
      )
      const row = result.rows[0]
      if (!row) return 0
      return Number(row.balance)
    },

    grant: async (input: GrantInput): Promise<CreditEntry> => {
      if (input.amount <= 0) {
        throw new Error('grant: amount must be > 0')
      }
      // Type system already excludes 'debit' from sourceType, but a caller
      // passing through `any` could still violate. Belt-and-suspenders.
      if ((input.sourceType as string) === 'debit') {
        throw new Error('grant: sourceType cannot be "debit" — use atomicDebit')
      }

      const client = await pool.connect()
      try {
        await beginAndConfigure(client)

        const userCheck = await client.query<{ id: string }>(
          'SELECT id FROM users WHERE id = $1 FOR UPDATE',
          [input.userId],
        )
        if (userCheck.rowCount === 0) {
          await client.query('ROLLBACK')
          throw new UserNotFoundError(input.userId)
        }

        const id = uuidv7()
        const result = await client.query<CreditEntryDbRow>(
          `INSERT INTO credit_ledger
             (id, user_id, credit_type, amount, source_type, source_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            id,
            input.userId,
            input.creditType,
            input.amount,
            input.sourceType,
            input.sourceId ?? null,
            input.expiresAt ?? null,
          ],
        )
        await client.query('COMMIT')

        const row = result.rows[0]
        if (!row) throw new Error('grant: INSERT returned no row')
        return toCreditEntry(row)
      } catch (err) {
        // Best-effort rollback on any path we didn't already roll back.
        try {
          await client.query('ROLLBACK')
        } catch {
          // Ignore — connection may already be in a failed state.
        }
        throw err
      } finally {
        client.release()
      }
    },
  }
}

export type CreditsRepo = ReturnType<typeof createCreditsRepo>
```

- [ ] **Step 4: Run — expect 8 passing tests (5 balance + 3 grant)**

Run: `cd backend && pnpm test -- credits.test`
Expected: 8 passing tests.

- [ ] **Step 5: Refactor read tests to use `grant()` instead of raw INSERTs**

Open the read tests added in Task 5. Replace each `pool.query('INSERT INTO credit_ledger ...')` with the equivalent `credits.grant(...)` call. Example for "grant + balance returns the granted amount":

```typescript
    it('grant + balance returns the granted amount', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)

      await credits.grant({
        userId: u.id,
        creditType: 'session',
        amount: 5,
        sourceType: 'gift',
      })

      expect(await credits.balance(u.id, 'session')).toBe(5)
      expect(await credits.balance(u.id, 'world_gen')).toBe(0)
    })
```

Apply the same refactor to the "multiple grants sum" and "credit-type isolation" tests. The "expired credits are excluded" test still uses raw INSERT because `grant()` doesn't take `expiresAt` ergonomics gracefully for this edge case — but updated to:

```typescript
    it('expired credits are excluded', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await credits.grant({
        userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift',
        expiresAt: new Date(Date.now() - 86_400_000),
      })
      await credits.grant({
        userId: u.id, creditType: 'session', amount: 3, sourceType: 'gift',
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      expect(await credits.balance(u.id, 'session')).toBe(3)
    })
```

- [ ] **Step 6: Run — expect 8 passing tests still**

Run: `cd backend && pnpm test -- credits.test`
Expected: 8 passing.

- [ ] **Step 7: Commit**

```bash
git add backend/src/repo/credits.ts backend/src/repo/__tests__/credits.test.ts
git commit -m "feat(myt-40): credits.grant() + tests"
```

---

## Task 7: `atomicDebit()` — happy path + insufficient + validation

**Files:**
- Modify: `backend/src/repo/credits.ts`
- Modify: `backend/src/repo/__tests__/credits.test.ts`

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block:

```typescript
  describe('atomicDebit()', () => {
    it('debits and returns the new entry; balance reflects it', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift' })

      const entry = await credits.atomicDebit({
        userId: u.id, creditType: 'session', amount: 1, sourceId: 'session-1',
      })

      expect(entry.amount).toBe(-1)
      expect(entry.sourceType).toBe('debit')
      expect(entry.sourceId).toBe('session-1')
      expect(await credits.balance(u.id, 'session')).toBe(4)
    })

    it('throws InsufficientCreditsError when balance is too low', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 1, sourceType: 'gift' })

      const { InsufficientCreditsError } = await import('../credits-errors.js')
      await expect(
        credits.atomicDebit({
          userId: u.id, creditType: 'session', amount: 2, sourceId: 'session-1',
        }),
      ).rejects.toBeInstanceOf(InsufficientCreditsError)

      // Ledger should still have only the grant row.
      const after = await credits.balance(u.id, 'session')
      expect(after).toBe(1)
    })

    it('throws InsufficientCreditsError on empty ledger', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)

      const { InsufficientCreditsError } = await import('../credits-errors.js')
      await expect(
        credits.atomicDebit({
          userId: u.id, creditType: 'session', amount: 1, sourceId: 's-1',
        }),
      ).rejects.toBeInstanceOf(InsufficientCreditsError)
      expect(await credits.balance(u.id, 'session')).toBe(0)
    })

    it('debit on world_gen does not see session credits', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift' })

      const { InsufficientCreditsError } = await import('../credits-errors.js')
      await expect(
        credits.atomicDebit({
          userId: u.id, creditType: 'world_gen', amount: 1, sourceId: 's-1',
        }),
      ).rejects.toBeInstanceOf(InsufficientCreditsError)
      expect(await credits.balance(u.id, 'session')).toBe(5)
    })

    it('throws on amount <= 0', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await expect(
        credits.atomicDebit({
          userId: u.id, creditType: 'session', amount: 0, sourceId: 's-1',
        }),
      ).rejects.toThrow(/amount must be > 0/)
    })

    it('throws on empty sourceId', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await expect(
        credits.atomicDebit({
          userId: u.id, creditType: 'session', amount: 1, sourceId: '',
        }),
      ).rejects.toThrow(/sourceId required/)
    })

    it('throws UserNotFoundError when user does not exist', async () => {
      const credits = createCreditsRepo(pool)
      const fakeId = '019dccef-0000-7000-8000-000000000001'

      const { UserNotFoundError } = await import('../credits-errors.js')
      await expect(
        credits.atomicDebit({
          userId: fakeId, creditType: 'session', amount: 1, sourceId: 's-1',
        }),
      ).rejects.toBeInstanceOf(UserNotFoundError)
    })
  })
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd backend && pnpm test -- credits.test`
Expected: FAIL with "credits.atomicDebit is not a function".

- [ ] **Step 3: Add `atomicDebit()` to `credits.ts`**

Add to the imports at the top:

```typescript
import {
  DEBIT_LOCK_TIMEOUT_MS,
  DEBIT_STATEMENT_TIMEOUT_MS,
  IdempotencyConflictError,
  InsufficientCreditsError,
  UserNotFoundError,
} from './credits-errors.js'
```

And update the `DebitInput` import:

```typescript
import type { CreditEntry, CreditType, DebitInput, GrantInput } from './types.js'
```

Add inside the `return { ... }` object, after `grant`:

```typescript
    atomicDebit: async (input: DebitInput): Promise<CreditEntry> => {
      if (input.amount <= 0) {
        throw new Error('atomicDebit: amount must be > 0')
      }
      if (!input.sourceId || input.sourceId.length === 0) {
        throw new Error('atomicDebit: sourceId required (use the per-user idempotency key)')
      }

      const client = await pool.connect()
      let inTransaction = false
      try {
        await beginAndConfigure(client)
        inTransaction = true

        // Lock anchor — serializes all concurrent debits + grants for this user.
        const userCheck = await client.query<{ id: string }>(
          'SELECT id FROM users WHERE id = $1 FOR UPDATE',
          [input.userId],
        )
        if (userCheck.rowCount === 0) {
          await client.query('ROLLBACK')
          inTransaction = false
          throw new UserNotFoundError(input.userId)
        }

        // Idempotency check — return prior row if same (user, credit_type, source_id).
        const priorResult = await client.query<CreditEntryDbRow>(
          `SELECT * FROM credit_ledger
            WHERE user_id = $1 AND credit_type = $2
              AND source_type = 'debit' AND source_id = $3`,
          [input.userId, input.creditType, input.sourceId],
        )
        const priorRow = priorResult.rows[0]
        if (priorRow) {
          const priorAmount = Math.abs(priorRow.amount)
          if (priorAmount !== input.amount) {
            await client.query('ROLLBACK')
            inTransaction = false
            throw new IdempotencyConflictError(
              input.userId,
              input.sourceId,
              priorAmount,
              input.amount,
            )
          }
          await client.query('COMMIT')
          inTransaction = false
          return toCreditEntry(priorRow)
        }

        // Balance check — only spendable (unexpired) credits count.
        const balanceResult = await client.query<{ balance: string }>(
          `SELECT COALESCE(SUM(amount), 0)::text AS balance
             FROM credit_ledger
            WHERE user_id = $1 AND credit_type = $2
              AND (expires_at IS NULL OR expires_at > now())`,
          [input.userId, input.creditType],
        )
        const balanceRow = balanceResult.rows[0]
        const available = balanceRow ? Number(balanceRow.balance) : 0
        if (available < input.amount) {
          await client.query('ROLLBACK')
          inTransaction = false
          throw new InsufficientCreditsError(
            input.userId,
            input.creditType,
            available,
            input.amount,
          )
        }

        // Insert the debit row.
        const id = uuidv7()
        const insertResult = await client.query<CreditEntryDbRow>(
          `INSERT INTO credit_ledger
             (id, user_id, credit_type, amount, source_type, source_id)
           VALUES ($1, $2, $3, -$4, 'debit', $5)
           RETURNING *`,
          [id, input.userId, input.creditType, input.amount, input.sourceId],
        )
        await client.query('COMMIT')
        inTransaction = false

        const row = insertResult.rows[0]
        if (!row) throw new Error('atomicDebit: INSERT returned no row')
        return toCreditEntry(row)
      } catch (err) {
        if (inTransaction) {
          try {
            await client.query('ROLLBACK')
          } catch {
            // Ignore — connection may already be in failed state.
          }
        }
        // Map pg timeout errors to DebitTimeoutError.
        if (typeof err === 'object' && err !== null && 'code' in err) {
          const pgCode = (err as { code?: string }).code
          if (pgCode === '55P03' || pgCode === '57014') {
            const { DebitTimeoutError } = await import('./credits-errors.js')
            throw new DebitTimeoutError(input.userId, pgCode)
          }
        }
        throw err
      } finally {
        client.release()
      }
    },
```

- [ ] **Step 4: Run — expect all atomicDebit tests PASS (plus prior 8 still pass)**

Run: `cd backend && pnpm test -- credits.test`
Expected: 15 passing tests (5 balance + 3 grant + 7 atomicDebit).

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/credits.ts backend/src/repo/__tests__/credits.test.ts
git commit -m "feat(myt-40): credits.atomicDebit() — happy path + validation + UserNotFound"
```

---

## Task 8: Idempotency tests for `atomicDebit()`

**Files:**
- Modify: `backend/src/repo/__tests__/credits.test.ts`

(No code change to `credits.ts` — Task 7 already implements idempotency. These tests verify it.)

- [ ] **Step 1: Append idempotency tests inside `describe('atomicDebit()', ...)`**

```typescript
    it('idempotent retry returns the prior entry, no second insert', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift' })

      const first = await credits.atomicDebit({
        userId: u.id, creditType: 'session', amount: 1, sourceId: 's-1',
      })
      const second = await credits.atomicDebit({
        userId: u.id, creditType: 'session', amount: 1, sourceId: 's-1',
      })

      expect(second.id).toBe(first.id)
      expect(await credits.balance(u.id, 'session')).toBe(4)

      // Verify only one debit row exists.
      const count = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM credit_ledger
          WHERE user_id = $1 AND source_type = 'debit'`,
        [u.id],
      )
      expect(Number(count.rows[0]?.count)).toBe(1)
    })

    it('idempotency conflict on amount mismatch throws IdempotencyConflictError', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift' })

      await credits.atomicDebit({
        userId: u.id, creditType: 'session', amount: 1, sourceId: 's-1',
      })

      const { IdempotencyConflictError } = await import('../credits-errors.js')
      await expect(
        credits.atomicDebit({
          userId: u.id, creditType: 'session', amount: 2, sourceId: 's-1',
        }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError)

      // Ledger unchanged: still one debit row of -1.
      const result = await pool.query<{ amount: number }>(
        `SELECT amount FROM credit_ledger WHERE user_id = $1 AND source_type = 'debit'`,
        [u.id],
      )
      expect(result.rows.map((r) => r.amount)).toEqual([-1])
    })

    it('different sourceIds stay distinct', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift' })

      await credits.atomicDebit({
        userId: u.id, creditType: 'session', amount: 1, sourceId: 's-1',
      })
      await credits.atomicDebit({
        userId: u.id, creditType: 'session', amount: 1, sourceId: 's-2',
      })

      expect(await credits.balance(u.id, 'session')).toBe(3)
    })

    it('cross-credit-type same sourceId both succeed (sequential)', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift' })
      await credits.grant({ userId: u.id, creditType: 'world_gen', amount: 2, sourceType: 'gift' })

      await credits.atomicDebit({
        userId: u.id, creditType: 'session', amount: 1, sourceId: 'shared-id',
      })
      await credits.atomicDebit({
        userId: u.id, creditType: 'world_gen', amount: 1, sourceId: 'shared-id',
      })

      expect(await credits.balance(u.id, 'session')).toBe(4)
      expect(await credits.balance(u.id, 'world_gen')).toBe(1)
    })
```

- [ ] **Step 2: Run — expect 19 passing tests**

Run: `cd backend && pnpm test -- credits.test`
Expected: 19 passing.

- [ ] **Step 3: Commit**

```bash
git add backend/src/repo/__tests__/credits.test.ts
git commit -m "test(myt-40): credits.atomicDebit idempotency cases"
```

---

## Task 9: `listEntries()` method + tests

**Files:**
- Modify: `backend/src/repo/credits.ts`
- Modify: `backend/src/repo/__tests__/credits.test.ts`

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block at the bottom of the suite:

```typescript
  describe('listEntries()', () => {
    it('returns DESC by (granted_at, id), default limit 100', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)

      const a = await credits.grant({ userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift' })
      const b = await credits.grant({ userId: u.id, creditType: 'session', amount: 3, sourceType: 'gift' })
      const c = await credits.atomicDebit({ userId: u.id, creditType: 'session', amount: 1, sourceId: 's-1' })

      const entries = await credits.listEntries(u.id)
      // Most recent first.
      const ids = entries.map((e) => e.id)
      expect(ids[0]).toBe(c.id)
      expect(ids).toContain(a.id)
      expect(ids).toContain(b.id)
      expect(entries.length).toBe(3)
    })

    it('credit-type filter narrows', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await credits.grant({ userId: u.id, creditType: 'session', amount: 1, sourceType: 'gift' })
      await credits.grant({ userId: u.id, creditType: 'world_gen', amount: 1, sourceType: 'gift' })

      const sessionOnly = await credits.listEntries(u.id, { type: 'session' })
      expect(sessionOnly.length).toBe(1)
      expect(sessionOnly[0]?.creditType).toBe('session')
    })

    it('includes expired entries', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await credits.grant({
        userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift',
        expiresAt: new Date(Date.now() - 86_400_000),
      })
      const all = await credits.listEntries(u.id)
      expect(all.length).toBe(1)
      // But balance excludes it:
      expect(await credits.balance(u.id, 'session')).toBe(0)
    })
  })
```

- [ ] **Step 2: Run — expect FAIL "listEntries is not a function"**

Run: `cd backend && pnpm test -- credits.test`
Expected: FAIL.

- [ ] **Step 3: Implement `listEntries()` in `credits.ts`**

Add to imports (top of file):

```typescript
import { DEFAULT_LIST_LIMIT, /* existing */ } from './credits-errors.js'
import type { CreditEntry, CreditType, DebitInput, GrantInput, ListEntriesOpts } from './types.js'
```

Add the method inside the returned object (after `atomicDebit`):

```typescript
    listEntries: async (
      userId: string,
      opts: ListEntriesOpts = {},
    ): Promise<CreditEntry[]> => {
      const limit = opts.limit === null ? null : opts.limit ?? DEFAULT_LIST_LIMIT
      const params: unknown[] = [userId]
      let typeClause = ''
      if (opts.type) {
        params.push(opts.type)
        typeClause = ` AND credit_type = $${params.length}`
      }
      let limitClause = ''
      if (limit !== null) {
        params.push(limit)
        limitClause = ` LIMIT $${params.length}`
      }
      const result = await pool.query<CreditEntryDbRow>(
        `SELECT * FROM credit_ledger
          WHERE user_id = $1${typeClause}
          ORDER BY granted_at DESC, id DESC${limitClause}`,
        params,
      )
      return result.rows.map(toCreditEntry)
    },
```

- [ ] **Step 4: Run — expect 22 passing tests**

Run: `cd backend && pnpm test -- credits.test`
Expected: 22 passing.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/credits.ts backend/src/repo/__tests__/credits.test.ts
git commit -m "feat(myt-40): credits.listEntries() + tests"
```

---

## Task 10: Wire `credits` into `repo/index.ts`

**Files:**
- Modify: `backend/src/repo/index.ts`

- [ ] **Step 1: Read the current file**

Run: `cat backend/src/repo/index.ts`

- [ ] **Step 2: Edit to add credits**

Replace contents with:

```typescript
import { type Pool } from 'pg'
import { createUsersRepo } from './users.js'
import { createWorldsRepo } from './worlds.js'
import { createCampaignsRepo } from './campaigns.js'
import { createSessionsRepo } from './sessions.js'
import { createCreditsRepo } from './credits.js'

export function createRepo(pool: Pool) {
  return {
    users: createUsersRepo(pool),
    worlds: createWorldsRepo(pool),
    campaigns: createCampaignsRepo(pool),
    sessions: createSessionsRepo(pool),
    credits: createCreditsRepo(pool),
  }
}

export type Repo = ReturnType<typeof createRepo>
```

- [ ] **Step 3: Verify typecheck + tests still pass**

Run: `cd backend && pnpm typecheck && pnpm test`
Expected: PASS, all tests still green (the existing repo integration tests should not be affected).

- [ ] **Step 4: Commit**

```bash
git add backend/src/repo/index.ts
git commit -m "feat(myt-40): wire credits namespace into createRepo"
```

---

## Task 11: Concurrency tests — race against users-row lock

**Files:**
- Modify: `backend/src/repo/__tests__/credits.test.ts`

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block, but use a SEPARATE pool for concurrency. The test scaffold needs a pool with `max >= 4`. Add this near the top of the file (alongside the existing `pool` declaration):

```typescript
const RACE_ITERATIONS_CRITICAL = 100
const RACE_ITERATIONS_PAIRED = 50

describe('credits repo — concurrency (separate pool)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 4 })
    // Schema already prepared by the main suite's beforeAll. We only need a
    // fresh pool with concurrent-connection capacity.
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetData(pool)
  })

  it('two parallel debits on user with 1 credit — exactly one succeeds', async () => {
    const users = createUsersRepo(pool)
    const credits = createCreditsRepo(pool)

    for (let i = 0; i < RACE_ITERATIONS_CRITICAL; i++) {
      await resetData(pool)
      const u = await users.create({
        ...baseUserInput,
        cognitoSub: `sub-race-${i}`,
        email: `race-${i}@test.local`,
        username: `race${i}`,
      })
      await credits.grant({
        userId: u.id, creditType: 'session', amount: 1, sourceType: 'gift',
      })

      const { InsufficientCreditsError } = await import('../credits-errors.js')

      const results = await Promise.allSettled([
        credits.atomicDebit({
          userId: u.id, creditType: 'session', amount: 1, sourceId: `iter-${i}-A`,
        }),
        credits.atomicDebit({
          userId: u.id, creditType: 'session', amount: 1, sourceId: `iter-${i}-B`,
        }),
      ])

      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')
      expect(fulfilled.length).toBe(1)
      expect(rejected.length).toBe(1)
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientCreditsError)
      expect(await credits.balance(u.id, 'session')).toBe(0)
    }
  }, 30_000)

  it('empty-ledger race — both throw InsufficientCreditsError, ledger empty', async () => {
    const users = createUsersRepo(pool)
    const credits = createCreditsRepo(pool)

    for (let i = 0; i < RACE_ITERATIONS_CRITICAL; i++) {
      await resetData(pool)
      const u = await users.create({
        ...baseUserInput,
        cognitoSub: `sub-empty-${i}`,
        email: `empty-${i}@test.local`,
        username: `empty${i}`,
      })

      const { InsufficientCreditsError } = await import('../credits-errors.js')

      const results = await Promise.allSettled([
        credits.atomicDebit({
          userId: u.id, creditType: 'session', amount: 1, sourceId: `iter-${i}-A`,
        }),
        credits.atomicDebit({
          userId: u.id, creditType: 'session', amount: 1, sourceId: `iter-${i}-B`,
        }),
      ])

      expect(results.every((r) => r.status === 'rejected')).toBe(true)
      expect(
        results.every((r) => (r as PromiseRejectedResult).reason instanceof InsufficientCreditsError),
      ).toBe(true)

      const ledger = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM credit_ledger WHERE user_id = $1`,
        [u.id],
      )
      expect(Number(ledger.rows[0]?.count)).toBe(0)
    }
  }, 30_000)

  it('parallel same-sourceId debits — exactly one inserts, other returns same entry', async () => {
    const users = createUsersRepo(pool)
    const credits = createCreditsRepo(pool)

    for (let i = 0; i < RACE_ITERATIONS_PAIRED; i++) {
      await resetData(pool)
      const u = await users.create({
        ...baseUserInput,
        cognitoSub: `sub-same-${i}`,
        email: `same-${i}@test.local`,
        username: `same${i}`,
      })
      await credits.grant({
        userId: u.id, creditType: 'session', amount: 5, sourceType: 'gift',
      })

      const sourceId = `iter-${i}`
      const [r1, r2] = await Promise.all([
        credits.atomicDebit({
          userId: u.id, creditType: 'session', amount: 1, sourceId,
        }),
        credits.atomicDebit({
          userId: u.id, creditType: 'session', amount: 1, sourceId,
        }),
      ])

      expect(r1.id).toBe(r2.id)
      expect(await credits.balance(u.id, 'session')).toBe(4)

      const debitCount = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM credit_ledger
          WHERE user_id = $1 AND source_type = 'debit'`,
        [u.id],
      )
      expect(Number(debitCount.rows[0]?.count)).toBe(1)
    }
  }, 30_000)
})
```

- [ ] **Step 2: Run — expect 25 passing tests (22 prior + 3 race tests)**

Run: `cd backend && pnpm test -- credits.test`
Expected: 25 passing. Each race test takes a few seconds; the suite total is bounded by the `30_000` ms timeout per test.

- [ ] **Step 3: Commit**

```bash
git add backend/src/repo/__tests__/credits.test.ts
git commit -m "test(myt-40): credits.atomicDebit concurrent-debit race tests"
```

---

## Task 12: Schema invariant tests + DB-level safety nets

**Files:**
- Modify: `backend/src/repo/__tests__/credits.test.ts`

- [ ] **Step 1: Append schema-invariant tests inside the main suite (NOT the concurrency suite)**

Add a new `describe` block inside the first `describe('credits repo (integration)', ...)`:

```typescript
  describe('schema invariants (migration 004)', () => {
    it('polarity CHECK rejects positive amount with source_type=debit', async () => {
      const users = createUsersRepo(pool)
      const u = await users.create(baseUserInput)
      await expect(
        pool.query(
          `INSERT INTO credit_ledger
             (id, user_id, credit_type, amount, source_type, source_id)
           VALUES (gen_random_uuid(), $1, 'session', 1, 'debit', '00000000-0000-0000-0000-000000000001')`,
          [u.id],
        ),
      ).rejects.toThrow(/credit_ledger_polarity_chk/)
    })

    it('polarity CHECK rejects negative amount with source_type=subscription', async () => {
      const users = createUsersRepo(pool)
      const u = await users.create(baseUserInput)
      await expect(
        pool.query(
          `INSERT INTO credit_ledger
             (id, user_id, credit_type, amount, source_type)
           VALUES (gen_random_uuid(), $1, 'session', -1, 'subscription')`,
          [u.id],
        ),
      ).rejects.toThrow(/credit_ledger_polarity_chk/)
    })

    it('debit_has_source_chk rejects NULL source_id with source_type=debit', async () => {
      const users = createUsersRepo(pool)
      const u = await users.create(baseUserInput)
      await expect(
        pool.query(
          `INSERT INTO credit_ledger
             (id, user_id, credit_type, amount, source_type, source_id)
           VALUES (gen_random_uuid(), $1, 'session', -1, 'debit', NULL)`,
          [u.id],
        ),
      ).rejects.toThrow(/credit_ledger_debit_has_source_chk/)
    })

    it('debit_no_expiry_chk rejects expires_at on a debit row', async () => {
      const users = createUsersRepo(pool)
      const u = await users.create(baseUserInput)
      await expect(
        pool.query(
          `INSERT INTO credit_ledger
             (id, user_id, credit_type, amount, source_type, source_id, expires_at)
           VALUES (gen_random_uuid(), $1, 'session', -1, 'debit', '00000000-0000-0000-0000-000000000001', now() + interval '1 day')`,
          [u.id],
        ),
      ).rejects.toThrow(/credit_ledger_debit_no_expiry_chk/)
    })

    it('idempotency partial unique index rejects duplicate (user_id, credit_type, source_id) for debits', async () => {
      const users = createUsersRepo(pool)
      const u = await users.create(baseUserInput)
      await pool.query(
        `INSERT INTO credit_ledger
           (id, user_id, credit_type, amount, source_type, source_id)
         VALUES (gen_random_uuid(), $1, 'session', -1, 'debit', '00000000-0000-0000-0000-000000000001')`,
        [u.id],
      )
      await expect(
        pool.query(
          `INSERT INTO credit_ledger
             (id, user_id, credit_type, amount, source_type, source_id)
           VALUES (gen_random_uuid(), $1, 'session', -1, 'debit', '00000000-0000-0000-0000-000000000001')`,
          [u.id],
        ),
      ).rejects.toThrow(/uniq_credit_ledger_debit_idempotency/)
    })

    it('FK ON DELETE RESTRICT rejects user deletion when ledger rows exist', async () => {
      const users = createUsersRepo(pool)
      const credits = createCreditsRepo(pool)
      const u = await users.create(baseUserInput)
      await credits.grant({
        userId: u.id, creditType: 'session', amount: 1, sourceType: 'gift',
      })
      await expect(
        pool.query('DELETE FROM users WHERE id = $1', [u.id]),
      ).rejects.toThrow(/credit_ledger_user_id_fkey/)
    })

    it('idempotency SELECT plan uses the partial unique index (EXPLAIN)', async () => {
      const users = createUsersRepo(pool)
      const u = await users.create(baseUserInput)
      // Insert one debit so the planner has stats to work with.
      await pool.query(
        `INSERT INTO credit_ledger
           (id, user_id, credit_type, amount, source_type, source_id)
         VALUES (gen_random_uuid(), $1, 'session', -1, 'debit', '00000000-0000-0000-0000-000000000001')`,
        [u.id],
      )

      const result = await pool.query<{ 'QUERY PLAN': unknown[] }>(
        `EXPLAIN (FORMAT JSON)
         SELECT * FROM credit_ledger
          WHERE user_id = $1 AND credit_type = $2
            AND source_type = 'debit' AND source_id = $3`,
        [u.id, 'session', '00000000-0000-0000-0000-000000000001'],
      )
      const plan = JSON.stringify(result.rows[0])
      expect(plan).toMatch(/uniq_credit_ledger_debit_idempotency/)
    })
  })
```

- [ ] **Step 2: Run — expect 32 passing tests (25 + 7 schema)**

Run: `cd backend && pnpm test -- credits.test`
Expected: 32 passing.

- [ ] **Step 3: Commit**

```bash
git add backend/src/repo/__tests__/credits.test.ts
git commit -m "test(myt-40): schema invariants + EXPLAIN assertion"
```

---

## Task 13: Timeout error mapping tests

**Files:**
- Modify: `backend/src/repo/__tests__/credits.test.ts`

- [ ] **Step 1: Write the failing test for lock_timeout**

Append to the concurrency suite (the second `describe` block):

```typescript
  it('lock_timeout fires DebitTimeoutError with sqlstate=55P03', async () => {
    const users = createUsersRepo(pool)
    const credits = createCreditsRepo(pool)
    // Tighten the lock timeout for this test so we don't wait the full 1s default.
    const fastCredits = createCreditsRepo(pool, { debitLockTimeoutMs: 200 })

    const u = await users.create({
      ...baseUserInput,
      cognitoSub: 'sub-lock-timeout',
      email: 'lock-timeout@test.local',
      username: 'locktimeout',
    })
    await credits.grant({ userId: u.id, creditType: 'session', amount: 1, sourceType: 'gift' })

    // Acquire a separate connection NOT through the pool's normal flow,
    // hold the users-row lock, then race a debit against it.
    const holder = await pool.connect()
    try {
      await holder.query('BEGIN')
      // Holder MUST NOT set lock_timeout/statement_timeout — otherwise it
      // self-cancels before we can race against it.
      await holder.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [u.id])

      const { DebitTimeoutError } = await import('../credits-errors.js')
      const start = Date.now()
      await expect(
        fastCredits.atomicDebit({
          userId: u.id, creditType: 'session', amount: 1, sourceId: 'lock-test',
        }),
      ).rejects.toBeInstanceOf(DebitTimeoutError)
      const elapsed = Date.now() - start
      // Should have waited approximately the lock timeout (200ms), not longer.
      expect(elapsed).toBeGreaterThanOrEqual(150)
      expect(elapsed).toBeLessThan(2000)
    } finally {
      await holder.query('ROLLBACK').catch(() => {/* ignore */})
      holder.release()
    }
  }, 10_000)
```

- [ ] **Step 2: Run — expect PASS**

Run: `cd backend && pnpm test -- credits.test`
Expected: 33 passing tests.

- [ ] **Step 3: Add the SQLSTATE assertion (deeper verification)**

Replace the test body with one that introspects the caught error:

```typescript
  it('lock_timeout fires DebitTimeoutError with sqlstate=55P03', async () => {
    const users = createUsersRepo(pool)
    const credits = createCreditsRepo(pool)
    const fastCredits = createCreditsRepo(pool, { debitLockTimeoutMs: 200 })

    const u = await users.create({
      ...baseUserInput,
      cognitoSub: 'sub-lock-timeout',
      email: 'lock-timeout@test.local',
      username: 'locktimeout',
    })
    await credits.grant({ userId: u.id, creditType: 'session', amount: 1, sourceType: 'gift' })

    const holder = await pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [u.id])

      const { DebitTimeoutError } = await import('../credits-errors.js')
      let caught: unknown
      const start = Date.now()
      try {
        await fastCredits.atomicDebit({
          userId: u.id, creditType: 'session', amount: 1, sourceId: 'lock-test',
        })
      } catch (e) {
        caught = e
      }
      const elapsed = Date.now() - start

      expect(caught).toBeInstanceOf(DebitTimeoutError)
      expect((caught as InstanceType<typeof DebitTimeoutError>).sqlstate).toBe('55P03')
      expect(elapsed).toBeGreaterThanOrEqual(150)
      expect(elapsed).toBeLessThan(2000)
    } finally {
      await holder.query('ROLLBACK').catch(() => {/* ignore */})
      holder.release()
    }
  }, 10_000)
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd backend && pnpm test -- credits.test`
Expected: 33 passing.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/__tests__/credits.test.ts
git commit -m "test(myt-40): credits.atomicDebit lock_timeout → DebitTimeoutError 55P03"
```

---

## Task 14: Per-error ROLLBACK discipline test

**Files:**
- Modify: `backend/src/repo/__tests__/credits.test.ts`

- [ ] **Step 1: Append the test inside the concurrency suite**

```typescript
  it('every error path issues ROLLBACK (no idle-in-transaction leaks)', async () => {
    const users = createUsersRepo(pool)
    const credits = createCreditsRepo(pool)
    const u = await users.create({
      ...baseUserInput,
      cognitoSub: 'sub-rollback',
      email: 'rollback@test.local',
      username: 'rollback',
    })
    await credits.grant({ userId: u.id, creditType: 'session', amount: 1, sourceType: 'gift' })

    // Trigger each error class once.
    const fakeId = '019dccef-0000-7000-8000-000000000999'
    await credits
      .atomicDebit({ userId: fakeId, creditType: 'session', amount: 1, sourceId: 'no-user' })
      .catch(() => {/* UserNotFoundError */})
    await credits
      .atomicDebit({ userId: u.id, creditType: 'session', amount: 99, sourceId: 'too-much' })
      .catch(() => {/* InsufficientCreditsError */})
    await credits.atomicDebit({ userId: u.id, creditType: 'session', amount: 1, sourceId: 'ok-1' })
    await credits
      .atomicDebit({ userId: u.id, creditType: 'session', amount: 2, sourceId: 'ok-1' })
      .catch(() => {/* IdempotencyConflictError */})

    // After all that activity, no connection should be stuck "idle in transaction".
    const idleRes = await pool.query<{ count: string }>(
      `SELECT count(*)::text
         FROM pg_stat_activity
        WHERE state = 'idle in transaction'
          AND application_name LIKE '%mythrun%' OR datname = current_database()`,
    )
    // Note: this is a weak check on a single-database test setup. We rely on
    // the broader pg_stat_activity to be quiet. Allow up to 1 idle (the test
    // pool's own client between queries can briefly look idle).
    expect(Number(idleRes.rows[0]?.count ?? 0)).toBeLessThanOrEqual(1)
  }, 10_000)
```

- [ ] **Step 2: Run — expect PASS**

Run: `cd backend && pnpm test -- credits.test`
Expected: 34 passing.

- [ ] **Step 3: Commit**

```bash
git add backend/src/repo/__tests__/credits.test.ts
git commit -m "test(myt-40): per-error-class ROLLBACK discipline"
```

---

## Task 15: Spec patch — billing-cost-controls.md §2

**Files:**
- Modify: `docs/specs/2026-04-13-billing-cost-controls.md`

- [ ] **Step 1: Open the file and locate §2 "Atomic Debit"**

Run: `grep -n "Atomic Debit\|FOR UPDATE" docs/specs/2026-04-13-billing-cost-controls.md`

- [ ] **Step 2: Replace the buggy SQL recipe block**

Find the SQL block that starts with `BEGIN;` and ends with `COMMIT;` under "### Atomic Debit". Replace with the corrected recipe:

```sql
-- atomic-debit recipe — see MYT-40 design spec for the full rationale.

BEGIN;
SET LOCAL transaction_isolation = 'read committed';
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- Lock anchor on users row (always exists; FK guarantees). Locking on
-- credit_ledger rows would race when no rows exist — see "the bug" below.
SELECT id FROM users WHERE id = $userId FOR UPDATE;
-- rowCount = 0 → throw UserNotFoundError (404), not InsufficientCreditsError.

-- Idempotency check: a retry of the same logical debit returns the prior row.
SELECT * FROM credit_ledger
  WHERE user_id = $userId
    AND credit_type = $type
    AND source_type = 'debit'
    AND source_id = $sourceId;
-- If found: assert amount matches; COMMIT and return prior row.

-- Balance check: only spendable (unexpired) credits count.
SELECT COALESCE(SUM(amount), 0) AS balance
  FROM credit_ledger
  WHERE user_id = $userId
    AND credit_type = $type
    AND (expires_at IS NULL OR expires_at > now());

-- If balance >= amount: insert debit, COMMIT.
-- Else: ROLLBACK and throw InsufficientCreditsError.
INSERT INTO credit_ledger
  (id, user_id, credit_type, amount, source_type, source_id)
  VALUES ($id, $userId, $type, -$amount, 'debit', $sourceId);

COMMIT;
```

Add a new paragraph immediately after the SQL block:

> **The bug in the original recipe:** A previous draft of this section anchored the lock on `credit_ledger` rows (`SELECT SUM(amount) FROM credit_ledger ... FOR UPDATE`). This is incorrect when the user has zero ledger rows yet — `FOR UPDATE` locks zero tuples (PostgreSQL row locks are physical, not predicate, outside SERIALIZABLE), so two concurrent debits both see balance=0 and both insert. The fix is to anchor on the `users` row, which always exists by FK. The MYT-40 design (`docs/superpowers/specs/2026-05-01-myt-40-credit-ledger-design.md`) covers the full reasoning, including why this works under READ COMMITTED but would break under REPEATABLE READ.

- [ ] **Step 3: Verify the section reads coherently**

Run: `grep -A 50 "Atomic Debit" docs/specs/2026-04-13-billing-cost-controls.md | head -60`

Skim — make sure the original `### Atomic Debit` heading still leads into the corrected recipe, and the explanatory paragraph after the block makes sense in context.

- [ ] **Step 4: Commit**

```bash
git add docs/specs/2026-04-13-billing-cost-controls.md
git commit -m "spec(myt-40): patch billing §2 — users-row anchor, isolation, dual timeouts"
```

---

## Task 16: Final verification

**Files:** None — verification only.

- [ ] **Step 1: Full backend test suite**

Run: `cd backend && pnpm test`
Expected: ALL tests pass (existing repo tests + 34 new credits tests).

- [ ] **Step 2: Typecheck**

Run: `cd backend && pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Lint**

Run: `cd backend && pnpm lint`
Expected: PASS, no errors.

- [ ] **Step 4: Verify no `pg_stat_activity` leaks after the suite**

Run:
```bash
psql "$DATABASE_URL" -c "SELECT pid, state, query FROM pg_stat_activity WHERE state = 'idle in transaction'"
```
Expected: 0 rows.

- [ ] **Step 5: Confirm migration list**

Run: `ls backend/migrations/`
Expected: `001_initial_schema.sql`, `002_indexes.sql`, `003_srd_reference_data.sql`, `004_credit_ledger_invariants.sql`.

- [ ] **Step 6: All beads closed; final push**

```bash
git status                                # confirm working tree is clean
git log --oneline -20                     # review the trail
git push origin main                      # ship
```

---

## Self-review checklist (run after writing the plan)

Spec-coverage cross-check:

| Spec section | Plan task | Verified? |
|---|---|---|
| Migration 004 — polarity CHECK | T1 | ✓ |
| Migration 004 — debit_has_source_chk | T1 | ✓ |
| Migration 004 — debit_no_expiry_chk | T1 | ✓ |
| Migration 004 — uniq_credit_ledger_debit_idempotency NULLS NOT DISTINCT | T1 | ✓ |
| Migration 004 — FK CASCADE→RESTRICT + DROP IF EXISTS + DO/ASSERT | T1 | ✓ |
| `balance()` method + tests 1-5 | T5, T6 (refactor) | ✓ |
| `grant()` with users-row lock + same isolation/timeout triple | T6 | ✓ |
| `grant()` validation (amount>0, sourceType≠debit) | T6 | ✓ |
| `grant()` UserNotFoundError | T6 | ✓ |
| `atomicDebit()` lock + idempotency + balance + insert + ROLLBACK contract | T7 | ✓ |
| `atomicDebit()` validation | T7 | ✓ |
| `atomicDebit()` UserNotFoundError | T7 | ✓ |
| `atomicDebit()` InsufficientCreditsError | T7 | ✓ |
| `atomicDebit()` IdempotencyConflictError | T8 | ✓ |
| `atomicDebit()` DebitTimeoutError on 55P03 | T13 | ✓ |
| `listEntries()` DESC by (granted_at, id), null-disables-limit, type filter, includes expired | T9 | ✓ |
| Wire into `repo/index.ts` | T10 | ✓ |
| Concurrency tests (18, 18b, 19) | T11 | ✓ |
| Schema invariant tests (21, 22, 23, 23b, 23c, 23d) | T12 | ✓ |
| Per-error ROLLBACK discipline test (23e) | T14 | ✓ |
| Spec patch billing §2 | T15 | ✓ |
| Final typecheck/lint/test | T16 | ✓ |

**Tests deferred to follow-on tickets** (acknowledged in spec, NOT in this plan):
- statement_timeout error mapping (test 20c) — requires a custom Postgres trigger and is fragile across CI environments. The lock_timeout test (T13) exercises the same catch-and-rethrow path; statement_timeout firing on top of that is a one-line code branch we can validate with a simpler unit test if it ever regresses.
- Read-replica balance() opt-out — there's no replica to test against today.
- Observability metrics emission — observability ticket.

Type consistency check: `CreditEntry`, `CreditType`, `CreditSourceType`, `GrantInput`, `DebitInput`, `ListEntriesOpts`, `InsufficientCreditsError`, `IdempotencyConflictError`, `DebitTimeoutError`, `UserNotFoundError`, `DEFAULT_LIST_LIMIT`, `DEBIT_LOCK_TIMEOUT_MS`, `DEBIT_STATEMENT_TIMEOUT_MS` — all defined in T2/T3/T4 before any task uses them. Method signatures (`balance`, `grant`, `atomicDebit`, `listEntries`) consistent across spec, types, implementation, and tests.

No placeholders. No "TODO". No "TBD". No "implement later". Every step has runnable code or a runnable command.
