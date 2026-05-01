# MYT-40: Credit Ledger Repo + Atomic Debit — Design

**Linear:** [MYT-40](https://linear.app/mythrun/issue/MYT-40)
**Spec source:** `docs/specs/2026-04-13-billing-cost-controls.md` §2
**Date:** 2026-05-01

---

## Goal

Stand up the two load-bearing primitives the rest of the billing system depends on:

1. `repo.credits.balance(userId, type)` — read available credits.
2. `repo.credits.atomicDebit({userId, ...})` — consume credits with a hard concurrency guarantee that two parallel debits cannot drive balance below zero, and a hard idempotency guarantee that retried debits cannot double-charge.

Everything else in billing (Stripe webhooks, subscription tiers, packs, free trial, session-start gating, customer portal) stacks on top of these two.

## Non-goals

- Stripe integration, subscription lifecycle, pack purchase flow — separate tickets.
- Credit expiry sweep / rollover grant logic — lands with the subscription rollover ticket.
- The `'rollover'` value on `source_type` — added when the rollover ticket needs it, not now.
- Session-start gating wiring — the session runtime ticket calls `atomicDebit` from its own handler.

## Function-first framing

The schema is the means, not the end. The test that says this ticket is done is: "I can read a balance, I can atomically debit, the concurrent-debit test against real Postgres proves I can't double-spend, and the retry test proves I can't double-charge."

## Schema

The base `credit_ledger` table from `001_initial_schema.sql` stays as-is. MYT-40 ships migration **004** to add three defense-in-depth invariants the original schema lacks:

```sql
CREATE TABLE credit_ledger (                  -- shipped in migration 001
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credit_type TEXT NOT NULL CHECK (credit_type IN ('session', 'world_gen')),
  amount INTEGER NOT NULL,                    -- positive = grant, negative = debit
  source_type TEXT NOT NULL CHECK (source_type IN
    ('purchase', 'subscription', 'gift', 'trial', 'refund', 'debit')),
  source_id UUID,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ                      -- null = never expires
);
CREATE INDEX idx_credit_ledger_user_type
  ON credit_ledger(user_id, credit_type, expires_at);
```

### Migration 004 — `credit_ledger` invariants

```sql
-- 004_credit_ledger_invariants.sql
-- Defense-in-depth at the schema layer for the credit ledger.
-- Application code already enforces these in repo.credits.*; the DB
-- constraints exist so a future caller (admin tool, Stripe webhook,
-- bulk-fix migration) cannot violate the invariants by accident.

-- Polarity invariant: source_type='debit' iff amount < 0.
-- Prevents an "accidental refund" with positive amount + source_type='debit'
-- and the symmetric grant-with-negative-amount class of bugs.
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_polarity_chk
  CHECK ((source_type = 'debit') = (amount < 0));

-- Debit rows must carry an originating source_id (the session being
-- charged, the operation being billed, etc.). Required for idempotency.
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_debit_has_source_chk
  CHECK (source_type <> 'debit' OR source_id IS NOT NULL);

-- Idempotent debit: a retry of the same logical operation collides on
-- (user_id, source_id) within source_type='debit' and is a no-op.
-- The application's atomicDebit() detects the collision pre-INSERT under
-- the users-row lock; this index is the DB-level safety net.
CREATE UNIQUE INDEX credit_ledger_idempotent_debit
  ON credit_ledger (user_id, source_id)
  WHERE source_type = 'debit';
```

### Schema decisions

- **Two credit kinds (`session` + `world_gen`), not fungible.** Product-shape reason: subscription tiers and packs market concretely ("8 sessions + 2 worlds/month"), and differentiated credits prevent the pathological "user spends all monthly budget regenerating worlds, never plays" path. Rule of thumb captured in spec patch: new monetized features bundle into session credits unless the feature is consumed independently of a session AND its cadence justifies separation.
- **`amount` is an integer count, not money minor units.** A credit is one session or one world gen — fractional credits are not expressible.
- **Balance is computed via `SUM(amount)`, not stored as a snapshot column.** A snapshot column would denormalize the same fact and risk drift if a migration ever rewrites historical rows. Balance queries scan the `(user_id, credit_type, expires_at)` index for the equality prefix and filter on `expires_at` in-heap; the disjunction `expires_at IS NULL OR expires_at > now()` does not produce a clean range scan, but at expected per-user row counts (low tens) the filter cost is negligible. Out of scope for MYT-40, in scope for the rollover/sweep ticket: a periodic deletion of long-expired rows to keep the per-user scan bounded.
- **`expires_at` is kept**, even though MYT-40 itself never uses it. Spec §3's rollover toggle (no-rollover vs rollover-with-cap) is built on this column. Dropping it forecloses §3.
- **`source_type` is a category, not a polarity.** Sign of `amount` says debit/credit; `source_type` says where the entry originated. The string `'debit'` doubles as both an origin tag and a polarity tag, which is a small wart — acknowledged, not migrated. Migration 004's polarity CHECK enforces consistency.
- **`source_id` shape contract**: for `source_type='debit'` the `source_id` is the session id being charged. For `'purchase'`, the `purchases.id`. For `'subscription'`, the `user_subscriptions.id`. For `'trial'`/`'gift'`, may be `NULL` (admin operations). Migration 004's `credit_ledger_debit_has_source_chk` enforces non-null for debits.

## Atomic debit — locking strategy

### The bug in spec §2

Spec §2's recipe is `SELECT SUM(amount) ... FROM credit_ledger WHERE user_id = $1 ... FOR UPDATE`. **This is incorrect** when the user has zero ledger rows yet:

1. `Tx1 SELECT ... FOR UPDATE` → returns 0 rows, locks nothing.
2. `Tx2 SELECT ... FOR UPDATE` → also returns 0 rows, also locks nothing.
3. Both transactions see balance=0, both `INSERT` debit rows, both commit.

This affects every user before their first ledger write — i.e., every new account before a subscription grant or trial credit lands. Empty-ledger debits should fail with `InsufficientCreditsError`, not silently proceed in parallel.

PostgreSQL row locks are physical (per-tuple). There is no predicate-locking under READ COMMITTED — that's a SERIALIZABLE feature. A `FOR UPDATE` against a query returning zero rows acquires zero locks.

### Fix: lock anchor on the `users` row

```sql
BEGIN;
SET LOCAL statement_timeout = '2s';

-- Always locks exactly one row, whether or not credit_ledger has entries.
SELECT id FROM users WHERE id = $userId FOR UPDATE;

-- Idempotency check: if a debit with this (user_id, source_id) already
-- exists, return it without further work. Caller-supplied source_id is
-- the idempotency key (typically the session id).
SELECT * FROM credit_ledger
  WHERE user_id = $userId
    AND source_type = 'debit'
    AND source_id = $sourceId;
-- If a row is returned: assert amount matches the requested debit;
-- COMMIT (releasing the lock) and return that row. Mismatched amount
-- with the same idempotency key is a programmer error → throw
-- IdempotencyConflictError, ROLLBACK.

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
- All concurrent atomic debits + (lock-taking) grants for that user serialize on the same `users` row.
- Each statement under READ COMMITTED takes a fresh snapshot, so the SUM after lock acquisition sees any concurrent grant that committed before we got the lock.
- The idempotency SELECT runs *under* the lock, so a retry blocked behind a first-attempt's lock will see the inserted row when it unblocks. The DB-level `credit_ledger_idempotent_debit` unique index is the safety net for any future caller that bypasses this function.
- `SET LOCAL statement_timeout = '2s'` caps how long a stuck client can hold the lock. Connection-pool exhaustion under load becomes a 2-second-bounded queue, not a hang.
- Runs under default isolation (READ COMMITTED). No SERIALIZABLE retry logic needed.

### Grant takes the same lock

`grant()` also acquires the `users`-row lock for symmetry:

```sql
BEGIN;
SET LOCAL statement_timeout = '2s';
SELECT id FROM users WHERE id = $userId FOR UPDATE;
INSERT INTO credit_ledger (...) VALUES (...);
COMMIT;
```

Why: today, `grant()` only inserts positive amounts, so a lock-free grant cannot drive balance negative — the bug story is one-sided. But `source_type='refund'` will eventually be used for negative grants (clawbacks, charge reversals), and an admin "remove credit" tool is plausible. Making `grant()` lock-symmetric removes the "remember to update the lock rule when you add a clawback path" cognitive load. The cost is one extra row lock per grant — a Stripe webhook is rare and rate-limited, so this is free.

**Invariant statement:** any operation that reads balance for a decision OR writes a ledger row that could decrease available balance MUST acquire the `users`-row lock. The `balance()` reader is exempt because it never makes a decision.

### Spec patch

This ticket includes a patch to `docs/specs/2026-04-13-billing-cost-controls.md` §2 replacing the `SELECT ... FOR UPDATE` recipe with the users-row-anchored version above, documenting the empty-ledger rationale, and adding the idempotency + statement_timeout pieces.

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
  sourceId: string            // REQUIRED — the idempotency key (typically sessionId)
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

- **`balance(userId, type)`**: single SELECT, returns 0 for an empty ledger. No transaction required (read-only, single-statement consistency is sufficient for display).

  **Do not gate on `balance()`.** A caller that does `if (await balance(u, 'session') > 0) { /* allow */ }` reintroduces a TOCTOU race. The `atomicDebit` call IS the gate — let it throw `InsufficientCreditsError` and translate to a 402. This warning lives in the function's TSDoc.

- **`grant(input)`**: validates `amount > 0` and `sourceType !== 'debit'` at the application layer (DB CHECK is the safety net), opens a transaction, takes the users-row lock, inserts. Returns the new entry.

- **`atomicDebit(input)`**: validates `amount > 0` and `sourceId` non-empty, opens a transaction, sets `statement_timeout = '2s'`, takes the users-row lock, runs the idempotency check (returns prior row if found, or throws `IdempotencyConflictError` on amount mismatch), runs the balance check, inserts the debit row OR throws `InsufficientCreditsError`. Always uses a dedicated client checked out from the pool (released in a `finally`).

- **`listEntries(userId, opts)`**: ordered DESC by `granted_at`. `limit` defaults to 100; pass an explicit `Infinity` (or just a very large number) to disable. Optional credit-type filter. Returns ALL entries including expired ones — this is an audit view, not a balance view.

`grant()` and `listEntries()` are technically beyond the ticket's literal scope ("balance + atomicDebit"), but every test needs to put credits in, the next ticket (Stripe webhooks) needs `grant()`, and `listEntries` is trivial + audit-useful. Worth including.

## Wiring

- Add `credits: createCreditsRepo(pool)` to `backend/src/repo/index.ts`.
- Verify `credit_ledger` is in `_helpers/reset-data.ts` table list (it should be from migration 001 scaffold).

## Errors

- `InsufficientCreditsError` (custom subclass) — thrown by `atomicDebit`. Carries `userId`, `creditType`, `available`, `requested`. HTTP layer maps to 402 Payment Required per spec §2.4.
- `IdempotencyConflictError` (custom subclass) — thrown by `atomicDebit` when the same `sourceId` is reused with a different `amount`. Programmer error. HTTP layer maps to 500 (this should never happen in production paths).
- Validation errors (`amount <= 0`, `grant with sourceType='debit'`, missing `sourceId`) — throw plain `Error` at the application layer before any SQL runs.
- DB CHECK violations from migration 004 (polarity mismatch, missing source_id on debit) — propagate as `pg`-emitted errors. Should never reach production callers; if they do, that's a bug to fix.
- DB connection lost / FK violations — propagate as `pg`-emitted errors; caller's responsibility (typically the request handler's error boundary).

## Tests

All tests run against a real Postgres test database via the existing repo integration pattern (`createPgPool`, `runMigrations`, `resetData` between tests).

### Read tests

1. **Empty ledger → balance returns 0.** Both credit types.
2. **Grant + balance.** Grant 5 session credits → balance('session') === 5; balance('world_gen') === 0.
3. **Multiple grants sum.** Grant 3 then 2 → balance === 5.
4. **Expired credits excluded.** Grant 5 with `expires_at` in the past → balance === 0. Grant 3 unexpired → balance === 3.
5. **Credit-type isolation.** Grant 5 session + 2 world_gen → balance('session') === 5, balance('world_gen') === 2.

### Write tests

6. **Debit happy path.** Grant 5, debit 1 with sourceId='s-1' → balance === 4. Ledger has two rows: one +5, one -1.
7. **Debit insufficient.** Grant 1, debit 2 → throws `InsufficientCreditsError(available=1, requested=2)`. Ledger still has only the grant row.
8. **Debit on empty ledger.** No grants, debit 1 → throws `InsufficientCreditsError(available=0, requested=1)`. Ledger empty.
9. **Debit cross-type does not bleed.** Grant 5 session, debit 1 world_gen → throws `InsufficientCreditsError`. Session balance still 5.
10. **Validation: grant with `amount <= 0` throws** before SQL.
11. **Validation: grant with `sourceType='debit'` throws** before SQL.
12. **Validation: debit with `amount <= 0` throws** before SQL.
13. **Validation: debit with empty `sourceId` throws** before SQL.

### Idempotency tests

14. **Idempotent retry returns the prior entry.** Grant 5, debit 1 with sourceId='s-1' (succeeds), debit 1 with sourceId='s-1' again → second call returns the *same* entry (same id), no second debit row inserted, balance still 4.
15. **Idempotent retry across requests.** Same as 14 but the second debit happens in a fresh `atomicDebit` invocation (simulates a retry from a new HTTP request).
16. **Idempotency conflict throws.** Grant 5, debit 1 with sourceId='s-1', then debit 2 with sourceId='s-1' → throws `IdempotencyConflictError(existingAmount=1, requestedAmount=2)`. Ledger unchanged.
17. **Different sourceIds stay distinct.** Grant 5, debit 1 with sourceId='s-1', debit 1 with sourceId='s-2' → both succeed, balance === 3, ledger has 3 rows.

### Concurrency tests

18. **Two parallel atomicDebit attempts on a user with 1 credit, distinct sourceIds → exactly one succeeds.** Both transactions take a synchronization barrier (a shared advisory lock at test setup) and release it simultaneously, so they hit the SELECT FOR UPDATE within a true window. Spawn via `Promise.all`. One resolves, one throws `InsufficientCreditsError`. Final balance === 0. Ledger has the original grant + exactly one debit row. **Repeat the race 50 times** in the test (loop body, not a single Promise.all of 50) to exercise the lock under repeated contention.

    - The default repo test pattern uses `createPgPool(url, { max: 1 })`. The concurrency test needs a separate pool with `max >= 4` so both transactions plus the test's barrier-release client can run in parallel. Open in `beforeAll`, close in `afterAll`.
    - Run under default isolation (READ COMMITTED) — proves the users-row lock works without SERIALIZABLE retries.

19. **Two parallel atomicDebit attempts with the SAME sourceId → exactly one inserts; the other returns the same entry.** Same race shape as 18. One transaction wins the insert; the other's idempotency SELECT, blocked behind the lock, sees the inserted row when it unblocks and returns it. Ledger has exactly one debit row. Repeat 20 times.

20. **DB-level idempotency safety net.** Bypass the application layer: directly INSERT a debit row, then INSERT a *second* debit row with the same (user_id, source_id) → the unique partial index rejects with a unique-violation error. Proves the safety net exists.

### Schema invariant tests

21. **Polarity CHECK rejects positive `amount` with `source_type='debit'`.** Direct INSERT bypassing the repo → DB rejects.
22. **Polarity CHECK rejects negative `amount` with `source_type='subscription'`.** Direct INSERT → DB rejects.
23. **`debit_has_source_chk` rejects NULL `source_id` with `source_type='debit'`.** Direct INSERT → DB rejects.

### `listEntries`

24. **Returns DESC by granted_at, default limit 100.**
25. **Type filter narrows correctly.**
26. **Includes expired entries.** Grant one expired + one unexpired → both appear in listEntries; only the unexpired counts in `balance`.

## Out of scope (deferred to future tickets)

- HTTP route exposing `balance()` (`GET /me/credits`) — auth/billing routes ticket.
- Stripe webhook handler that calls `grant()` — Stripe ticket.
- Session-start gate that calls `atomicDebit()` — session runtime ticket.
- Rollover scheduler / `'rollover'` source_type value — rollover ticket.
- Cost-tracking metering on `session_usage` — observability ticket.
- Admin "comp credit" endpoint — admin tools ticket.
- Periodic deletion of long-expired ledger rows (perf hygiene) — rollover/sweep ticket.

## Linear ticket update

The Linear ticket as originally written asked for migration 004 with a different schema (`credits_ledger` plural, `kind` enum, `amount_minor`, `balance_after_minor`). This design supersedes that. Update Linear with: "Migration 004 ships defense-in-depth invariants on the existing `credit_ledger` from migration 001 (polarity CHECK, debit-source CHECK, idempotency partial unique index). Repo + tests + spec patch on top." Linked PR will land both the migration and the repo work.
