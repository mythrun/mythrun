# MYT-40: Credit Ledger Repo + Atomic Debit — Design

**Linear:** [MYT-40](https://linear.app/mythrun/issue/MYT-40)
**Spec source:** `docs/specs/2026-04-13-billing-cost-controls.md` §2
**Date:** 2026-05-01

---

## Goal

Stand up the two load-bearing primitives the rest of the billing system depends on:

1. `repo.credits.balance(userId, type)` — read available credits.
2. `repo.credits.atomicDebit({userId, ...})` — consume credits with a hard concurrency guarantee that two parallel debits cannot drive balance below zero.

Everything else in billing (Stripe webhooks, subscription tiers, packs, free trial, session-start gating, customer portal) stacks on top of these two.

## Non-goals

- Schema migration. Migration 001 already created `credit_ledger` correctly per spec §2. No new migration in MYT-40's scope.
- Stripe integration, subscription lifecycle, pack purchase flow — separate tickets.
- Credit expiry sweep / rollover grant logic — lands with the subscription rollover ticket.
- The `'rollover'` value on `source_type` — added when the rollover ticket needs it, not now.
- Session-start gating wiring — the session runtime ticket calls `atomicDebit` from its own handler.

## Function-first framing

The schema is the means, not the end. The test that says this ticket is done is: "I can read a balance, I can atomically debit, and a concurrent-debit test against real Postgres proves I can't double-spend."

## Schema

**No migration.** The existing `credit_ledger` table from `001_initial_schema.sql` already implements the design:

```sql
CREATE TABLE credit_ledger (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credit_type TEXT NOT NULL CHECK (credit_type IN ('session', 'world_gen')),
  amount INTEGER NOT NULL,                   -- positive = grant, negative = debit
  source_type TEXT NOT NULL CHECK (source_type IN
    ('purchase', 'subscription', 'gift', 'trial', 'refund', 'debit')),
  source_id UUID,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ                     -- null = never expires
);
CREATE INDEX idx_credit_ledger_user_type
  ON credit_ledger(user_id, credit_type, expires_at);
```

### Schema decisions

- **Two credit kinds (`session` + `world_gen`), not fungible.** Product-shape reason: subscription tiers and packs market concretely ("8 sessions + 2 worlds/month"), and differentiated credits prevent the pathological "user spends all monthly budget regenerating worlds, never plays" path. Rule of thumb captured in spec patch: new monetized features bundle into session credits unless the feature is consumed independently of a session AND its cadence justifies separation.
- **`amount` is an integer count, not money minor units.** A credit is one session or one world gen — fractional credits are not expressible.
- **Balance is computed via `SUM(amount)`, not stored as a snapshot column.** SUM-on-(user_id, credit_type, expires_at) hits the existing index. A snapshot column would denormalize the same fact and risk drift if a migration ever rewrites historical rows.
- **`expires_at` is kept**, even though MYT-40 itself never uses it. Spec §3's rollover toggle (no-rollover vs rollover-with-cap) is built on this column. Dropping it forecloses §3.
- **`source_type` is a category, not a polarity.** Sign of `amount` says debit/credit; `source_type` says where the entry originated. Cleaner than the `kind`-style enum that conflates the two.

## Atomic debit — locking strategy

### The bug in spec §2

Spec §2's recipe is `SELECT SUM(amount) ... FROM credit_ledger WHERE user_id = $1 ... FOR UPDATE`. **This is incorrect** when the user has zero ledger rows yet:

1. `Tx1 SELECT ... FOR UPDATE` → returns 0 rows, locks nothing.
2. `Tx2 SELECT ... FOR UPDATE` → also returns 0 rows, also locks nothing.
3. Both transactions see balance=0 (or whatever each computed), both `INSERT` debit rows, both commit.

This affects every user before their first ledger write — i.e., every new account before a subscription grant or trial credit lands. Empty-ledger debits should fail with `InsufficientCreditsError`, not silently proceed in parallel.

### Fix: lock anchor on the `users` row

```sql
BEGIN;

-- Always locks exactly one row, whether or not credit_ledger has entries.
SELECT id FROM users WHERE id = $userId FOR UPDATE;

-- Read current available balance for this credit type.
SELECT COALESCE(SUM(amount), 0) AS balance
  FROM credit_ledger
  WHERE user_id = $userId
    AND credit_type = $type
    AND (expires_at IS NULL OR expires_at > now());

-- If balance >= debit_amount: insert the debit row, COMMIT.
-- Else: ROLLBACK and throw InsufficientCreditsError.
INSERT INTO credit_ledger
  (id, user_id, credit_type, amount, source_type, source_id, granted_at)
  VALUES ($id, $userId, $type, -$amount, 'debit', $sourceId, now());

COMMIT;
```

Why this works:
- `SELECT id FROM users WHERE id = $userId FOR UPDATE` always returns exactly one row (FK constraint guarantees the user exists). That row is locked for the rest of the transaction.
- All concurrent atomic debits + grants for that user serialize on the same `users` row.
- The balance query under the lock sees a consistent snapshot — no double-spend.
- Runs under default isolation (READ COMMITTED). No SERIALIZABLE retry logic needed.

### Spec patch

This ticket includes a small patch to `docs/specs/2026-04-13-billing-cost-controls.md` §2 replacing the `SELECT ... FOR UPDATE` recipe with the users-row-anchored version above. Documents the empty-ledger rationale.

## Repo surface

```typescript
// backend/src/repo/credits.ts

export type CreditType = 'session' | 'world_gen'
export type CreditSourceType =
  | 'purchase' | 'subscription' | 'gift' | 'trial' | 'refund' | 'debit'

export interface CreditEntry {
  id: string
  userId: string
  creditType: CreditType
  amount: number              // positive = grant, negative = debit
  sourceType: CreditSourceType
  sourceId: string | null
  grantedAt: Date
  expiresAt: Date | null
}

export interface GrantInput {
  userId: string
  creditType: CreditType
  amount: number              // must be > 0
  sourceType: Exclude<CreditSourceType, 'debit'>
  sourceId?: string | null
  expiresAt?: Date | null
}

export interface DebitInput {
  userId: string
  creditType: CreditType
  amount: number              // must be > 0; recorded as negative in ledger
  sourceId?: string | null    // typically the session id being charged
}

export class InsufficientCreditsError extends Error {
  readonly code = 'INSUFFICIENT_CREDITS'
  constructor(
    readonly userId: string,
    readonly creditType: CreditType,
    readonly available: number,
    readonly requested: number,
  ) {
    super(`Insufficient ${creditType} credits: have ${available}, need ${requested}`)
  }
}

export function createCreditsRepo(pool: Pool): {
  balance(userId: string, type: CreditType): Promise<number>
  grant(input: GrantInput): Promise<CreditEntry>
  atomicDebit(input: DebitInput): Promise<CreditEntry>
  listEntries(userId: string, opts?: { limit?: number; type?: CreditType }): Promise<CreditEntry[]>
}
```

### Method semantics

- **`balance(userId, type)`**: single SELECT, returns 0 for an empty ledger. No transaction required (read-only, eventual consistency is acceptable for display).
- **`grant(input)`**: single-statement INSERT. Validates `amount > 0` and `sourceType !== 'debit'` at the application layer. Used by tests and by future Stripe webhook handlers.
- **`atomicDebit(input)`**: validates `amount > 0`, opens a transaction with the users-row lock, computes balance, inserts the debit row OR throws `InsufficientCreditsError` and rolls back. Always uses a dedicated client checked out from the pool (released in a `finally`).
- **`listEntries(userId, opts)`**: ordered DESC by `granted_at`, optional limit (default 100), optional credit-type filter. Returns ALL entries including expired ones — this is an audit view, not a balance view. Callers that need only currently-spendable entries should derive from `balance()` or filter `expiresAt` themselves.

`grant()` is technically beyond the ticket's literal scope ("balance + atomicDebit"), but every test needs to put credits in, and the next ticket (Stripe webhooks) needs the primitive too. 5 lines of code, in scope.

## Wiring

- Add `credits: createCreditsRepo(pool)` to `backend/src/repo/index.ts`.
- Add `credit_ledger` to existing `_helpers/reset-data.ts` table list — already there from the initial migration scaffold; verify.

## Errors

- `InsufficientCreditsError` (custom subclass) — thrown by `atomicDebit`. Carries `userId`, `creditType`, `available`, `requested` for the caller (HTTP layer maps to 402 Payment Required per spec §2.4).
- Validation errors (`amount <= 0`, `grant with sourceType='debit'`) — throw plain `Error` at the application layer before any SQL runs. These are programmer errors, not user-facing.
- DB errors (FK violations, connection lost) — propagate as `pg`-emitted errors; caller's responsibility (typically the request handler's error boundary).

## Tests

All tests run against a real Postgres test database via the existing repo integration pattern (`createPgPool`, `runMigrations`, `resetData` between tests).

### Read tests

1. **Empty ledger → balance returns 0.** Both credit types.
2. **Grant + balance.** Grant 5 session credits → balance('session') === 5; balance('world_gen') === 0.
3. **Multiple grants sum.** Grant 3 then 2 → balance === 5.
4. **Expired credits excluded.** Grant 5 with `expires_at` in the past → balance === 0. Grant 3 unexpired → balance === 3.
5. **Credit-type isolation.** Grant 5 session + 2 world_gen → balance('session') === 5, balance('world_gen') === 2.

### Write tests

6. **Debit happy path.** Grant 5, debit 1 → balance === 4. Ledger has two rows: one +5, one -1.
7. **Debit insufficient.** Grant 1, debit 2 → throws `InsufficientCreditsError(available=1, requested=2)`. Ledger still has only the grant row.
8. **Debit on empty ledger.** No grants, debit 1 → throws `InsufficientCreditsError(available=0, requested=1)`. Ledger empty.
9. **Debit cross-type does not bleed.** Grant 5 session, debit 1 world_gen → throws `InsufficientCreditsError`. Session balance still 5.
10. **Validation: grant with `amount <= 0` throws** before SQL.
11. **Validation: grant with `sourceType='debit'` throws** before SQL.
12. **Validation: debit with `amount <= 0` throws** before SQL.

### Concurrency test

13. **Two parallel atomicDebit attempts on a user with 1 credit → exactly one succeeds.** Spawn two debit calls via `Promise.all`, observe one resolves, one rejects with `InsufficientCreditsError`. Final balance === 0. Ledger has the original grant + exactly one debit row.
    - The default repo test pattern uses `createPgPool(url, { max: 1 })` (one connection, serial). The concurrency test needs its own pool with `max >= 2` so both transactions can run in parallel — that's the whole point of the test. Open this pool in the test's `beforeAll` and close it in `afterAll`, separate from the suite's main pool.
    - Run under default isolation (READ COMMITTED) — proves the users-row lock works without SERIALIZABLE retries.
    - Repeat the race 10 times in the same test to surface flakiness.

### `listEntries`

14. **Returns DESC by granted_at, default limit 100.**
15. **Type filter narrows correctly.**

## Out of scope (deferred to future tickets)

- HTTP route exposing `balance()` (`GET /me/credits`) — auth/billing routes ticket.
- Stripe webhook handler that calls `grant()` — Stripe ticket.
- Session-start gate that calls `atomicDebit()` — session runtime ticket.
- Rollover scheduler / `'rollover'` source_type value — rollover ticket.
- Cost-tracking metering on `session_usage` — observability ticket.
- Admin "comp credit" endpoint — admin tools ticket.

## Linear ticket update

The Linear ticket as written asks for migration 004 with a different schema (`credits_ledger` plural, `kind` enum, `amount_minor`, `balance_after_minor`). This design supersedes that. Update Linear with: "No new migration; spec patch + repo + tests against existing `credit_ledger` table."
