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

-- Debit rows must NOT carry expires_at — debits represent consumption
-- and are immutable; expiry is a grant-side concept. Without this CHECK,
-- a future caller could insert a debit row with expires_at and make the
-- balance SUM non-monotonic (the row's contribution would disappear from
-- balance after expiry, effectively refunding the user).
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_debit_no_expiry_chk
  CHECK (source_type <> 'debit' OR expires_at IS NULL);

-- Idempotent debit: a retry of the same logical operation collides on
-- (user_id, credit_type, source_id) within source_type='debit' and is a
-- no-op. The credit_type column is part of the key so a sourceId that
-- somehow drives both a 'session' and 'world_gen' debit (e.g., a future
-- session-runtime debit that bills a session AND its world-gen-on-demand
-- usage with the same id) doesn't collide. The application's
-- atomicDebit() detects the collision pre-INSERT under the users-row
-- lock; this index is the DB-level safety net.
--
-- NULLS NOT DISTINCT: defense-in-depth — the credit_ledger_debit_has_source_chk
-- already prevents NULL source_id on debits, but if anyone weakens that
-- CHECK in the future, NULL handling here would silently regress to the
-- default (NULLs are distinct), and idempotency would break for whatever
-- path produced NULLs. Requires Postgres 15+; we run 16.
CREATE UNIQUE INDEX uniq_credit_ledger_debit_idempotency
  ON credit_ledger (user_id, credit_type, source_id)
  NULLS NOT DISTINCT
  WHERE source_type = 'debit';

-- Revenue ledgers must NOT cascade-delete. The base table from migration
-- 001 used ON DELETE CASCADE, which is wrong for a financial table —
-- a hard-delete of a user (admin error, GDPR erasure path) would silently
-- erase every purchase, refund, and debit, breaking Stripe reconciliation
-- and audit. Replace with ON DELETE RESTRICT. GDPR erasure becomes a
-- soft-delete / pseudonymize flow (out of scope here; tracked separately).
ALTER TABLE credit_ledger
  DROP CONSTRAINT credit_ledger_user_id_fkey;
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
```

### Schema decisions

- **Two credit kinds (`session` + `world_gen`), not fungible.** Product-shape reason: subscription tiers and packs market concretely ("8 sessions + 2 worlds/month"), and differentiated credits prevent the pathological "user spends all monthly budget regenerating worlds, never plays" path. Rule of thumb captured in spec patch: new monetized features bundle into session credits unless the feature is consumed independently of a session AND its cadence justifies separation.
- **`amount` is an integer count, not money minor units.** A credit is one session or one world gen — fractional credits are not expressible.
- **Balance is computed via `SUM(amount)`, not stored as a snapshot column.** A snapshot column would denormalize the same fact and risk drift if a migration ever rewrites historical rows. Balance queries scan the `(user_id, credit_type, expires_at)` index for the equality prefix and filter on `expires_at` in-heap; the disjunction `expires_at IS NULL OR expires_at > now()` does not produce a clean range scan, but at expected per-user row counts (low tens) the filter cost is negligible. Out of scope for MYT-40, in scope for the rollover/sweep ticket: a periodic deletion of long-expired rows to keep the per-user scan bounded.
- **`expires_at` is kept**, even though MYT-40 itself never uses it. Spec §3's rollover toggle (no-rollover vs rollover-with-cap) is built on this column. Dropping it forecloses §3.
- **`source_type` is a category, not a polarity.** Sign of `amount` says debit/credit; `source_type` says where the entry originated. The string `'debit'` doubles as both an origin tag and a polarity tag, which is a small wart — acknowledged, not migrated. Migration 004's polarity CHECK enforces consistency.
- **Refund vs clawback semantics.** A `'refund'` row is a *positive* grant — the user got their credits back after a Stripe charge reversal or a goodwill grant. The polarity CHECK enforces `'refund'` rows have positive amounts. A *clawback* (admin removes wrongly-granted credits, charge dispute, fraud reversal) uses `source_type='debit'` with `source_id` pointing to the original grant being clawed back — the debit semantics still hold (negative amount, source_id traceability, idempotent). This means migration 004's polarity CHECK does NOT need to be relaxed for any future refund/clawback path; both semantics fit cleanly into the existing types.
- **`source_id` shape contract**: for `source_type='debit'` the `source_id` is the session id being charged AND functions as the per-user idempotency key (it is NOT a globally-unique key — only unique within `(user_id, credit_type)` for debits). It is server-controlled — derived from sessionId today; if any future caller derives sourceId from a client-supplied `Idempotency-Key` header, the error mapping must be revisited (see Errors). For `'purchase'`, the `purchases.id`. For `'subscription'`, the `user_subscriptions.id`. For `'trial'`/`'gift'`, may be `NULL` (admin operations). Migration 004's `credit_ledger_debit_has_source_chk` enforces non-null for debits.
- **`source_id` is `UUID`-typed.** Constrains future debit sources (per-turn metering, world-gen invocation, batch jobs) to UUID-keyed entities. All foreseeable sources are UUIDv7 entities (sessions, purchases, subscriptions). If a non-UUID-keyed source ever appears, a follow-up migration changes the column type. Acceptable.
- **Idempotency keys must be unique within `(user_id, credit_type)` across all time — discipline, not just generator guarantee.** UUIDv7 sessionIds will never *collide* (the generator's time-ordering guarantees uniqueness), but the load-bearing property here is that the *application code* never *reuses* a sourceId for two different debits. A buggy or malicious caller can hand-craft a reused UUID; our defense is the polarity-and-amount idempotency check (returns prior row, throws on amount mismatch). Future debit sources MUST also use never-reused identifiers AND callsites must never reuse one. A debit retry that succeeds-as-no-op more than ~24 hours after the original is suspicious and should be logged for investigation (not enforced — too many legitimate edge cases like archive replays — but worth observability).
- **`ON DELETE RESTRICT`** on the FK to `users`. A revenue ledger is never CASCADE-deleted. User-deletion paths (GDPR erasure, account closure) become soft-delete + pseudonymize flows that retain ledger rows. Migration 004 fixes the inherited-from-001 CASCADE.

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
-- SET LOCAL must follow BEGIN — it's transaction-scoped. If reordered
-- to before BEGIN, the timeout becomes session-wide and survives the
-- transaction, which would silently affect subsequent queries on the
-- same connection. The repo implementation must keep this ordering.
--
-- TWO timeouts, not one:
--  - lock_timeout (1s): caps how long FOR UPDATE waits for a lock.
--    Fires SQLSTATE 55P03 (lock_not_available). Bounded contention.
--  - statement_timeout (5s): caps total work after lock acquisition,
--    including the SUM, idempotency SELECT, and INSERT. Fires
--    SQLSTATE 57014 (query_canceled). Insurance against autovacuum
--    stalls or replica blips on the actual queries.
-- Single statement_timeout would conflate the two failure modes —
-- a slow autovacuum on the unique index would surface as a debit
-- failure even with no lock contention.
SET LOCAL lock_timeout = '1s';        -- DEBIT_LOCK_TIMEOUT_MS
SET LOCAL statement_timeout = '5s';   -- DEBIT_STATEMENT_TIMEOUT_MS

-- Always locks exactly one row, whether or not credit_ledger has entries.
SELECT id FROM users WHERE id = $userId FOR UPDATE;

-- Idempotency check: if a debit with this (user_id, credit_type, source_id)
-- already exists, return it without further work. The credit_type filter
-- is intentional — same sourceId across credit_types is allowed by the
-- partial unique index design (e.g., a session that bills both a session
-- credit and a world_gen credit using the same sourceId is two distinct
-- debit rows, not a collision).
SELECT * FROM credit_ledger
  WHERE user_id = $userId
    AND credit_type = $type
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
- The idempotency SELECT runs *under* the lock, so a retry blocked behind a first-attempt's lock will see the inserted row when it unblocks. (This depends on READ COMMITTED's per-statement snapshot — under REPEATABLE READ the second tx's snapshot would predate the first commit and the SELECT would miss. Do not change isolation level without revisiting this.) The DB-level `uniq_credit_ledger_debit_idempotency` unique index is the safety net for any future caller that bypasses this function.
- `SET LOCAL lock_timeout = '1s'` + `SET LOCAL statement_timeout = '5s'` (both sourced from `DEBIT_LOCK_TIMEOUT_MS` / `DEBIT_STATEMENT_TIMEOUT_MS` constants; both overridable via the repo factory's optional config for tests). Two distinct failure modes, two distinct caps: the lock_timeout bounds contention queues, the statement_timeout bounds genuinely-stuck queries (autovacuum stall, replica issue). Both manifest as `pg` errors with distinguishable SQLSTATEs (55P03 for lock, 57014 for statement). `atomicDebit` catches both and rethrows as a typed `DebitTimeoutError` (the caller doesn't need to know which timeout fired — both indicate "the debit couldn't complete in time, retry is appropriate"). HTTP layer maps to 503 Service Unavailable with a jittered Retry-After hint (jitter in the HTTP layer ticket).
- Runs under default isolation (READ COMMITTED). No SERIALIZABLE retry logic needed.

### Grant takes the same lock — defense-in-depth for the future clawback path

`grant()` also acquires the `users`-row lock. Today, with migration 004's polarity CHECK in place, a `grant()` insert *cannot* be a negative row (the CHECK rejects `source_type IN ('purchase', 'subscription', 'gift', 'trial', 'refund')` with `amount < 0`), so a lock-free grant cannot drive balance negative under the current constraint set. The lock is therefore not load-bearing for correctness *today*. It IS load-bearing the moment any future code path sidesteps the polarity CHECK (e.g., a clawback that uses `source_type='debit'` from outside `atomicDebit`, or a migration that loosens polarity to support a new negative-grant kind):

```sql
BEGIN;
SET LOCAL statement_timeout = '2s';
SELECT id FROM users WHERE id = $userId FOR UPDATE;
INSERT INTO credit_ledger (...) VALUES (...);
COMMIT;
```

Why: the SUM-after-lock argument that makes `atomicDebit` correct depends on every concurrent writer for that user being serialized through the same lock. Today `grant()` only inserts positive amounts, so a lock-free grant cannot drive balance negative — but as soon as a future code path inserts a negative grant (`'refund'` clawback, admin "remove credit" tool), a lock-free grant racing a debit can produce negative balance. The cost is one extra row lock per grant — Stripe webhooks are rare and rate-limited, so this is free. Cheaper than re-auditing every callsite when refunds land.

**Invariant statement (load-bearing):** any operation that reads balance for a decision OR writes a ledger row that could decrease available balance MUST acquire the `users`-row lock. The `balance()` display reader is the only exception — it never makes a decision; callers MUST NOT use its return to gate `atomicDebit`. Any future debit path (admin clawback, expired-credit sweep) must follow the same lock discipline; the DB-level invariants in migration 004 are the safety net if it doesn't.

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

export class DebitTimeoutError extends Error {
  readonly code = 'DEBIT_TIMEOUT'
  constructor(readonly userId: string) {
    super(`Debit timed out waiting for users-row lock for user=${userId}`)
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

  **Treat `balance()` as display-only.** ANY decision-with-side-effects path — gating session start, gating world-gen, deciding to grant a refund, deciding to expire — MUST go through `atomicDebit` (or a future analogous transactional call) that holds the users-row lock. A caller that does `if (await balance(u, 'session') > 0) { /* allow */ }` reintroduces a TOCTOU race; let `atomicDebit` throw `InsufficientCreditsError` and translate to a 402 instead.

  **Do not use `balance()` for retention or sweep logic.** The expiry filter `expires_at > now()` shifts as time advances; two consecutive calls a millisecond apart can disagree across a row's expiry boundary. That's fine for display; not fine for "delete rows where balance contribution is zero." The future expiry-sweep ticket reads `expires_at` directly.

- **`grant(input)`**: validates `amount > 0` and `sourceType !== 'debit'` at the application layer (DB CHECK is the safety net), opens a transaction with `statement_timeout = '2s'`, takes the users-row lock, inserts. Returns the new entry. **Every non-success path issues a `ROLLBACK` before releasing the client.**

- **`atomicDebit(input)`**: validates `amount > 0` and `sourceId` non-empty, opens a transaction, sets `statement_timeout = '2s'`, takes the users-row lock, runs the idempotency check (returns the prior row if `(user_id, credit_type, source_id)` matches, or throws `IdempotencyConflictError` on amount mismatch), runs the balance check, inserts the debit row OR throws `InsufficientCreditsError`. Catches `pg` errors with SQLSTATE `57014` (`query_canceled` from the statement timeout) and rethrows as `DebitTimeoutError`. **Every non-success path — `InsufficientCreditsError`, `IdempotencyConflictError`, `DebitTimeoutError`, validation errors thrown after `BEGIN`, any unexpected `pg` error — issues a `ROLLBACK` before releasing the client to the pool**, in the `finally` block. A pooled client returned without rollback would poison the next checkout.

- **`listEntries(userId, opts)`**: ordered `DESC` by `(granted_at, id)`. Multiple rows inserted in a single transaction share a `granted_at` (it resolves to `transaction_timestamp()`); the `id` tiebreaker provides a stable, deterministic order across them. The order does NOT necessarily reflect intra-transaction insertion order (UUIDv7 ms-bucket ties use random tail bits) — that's fine for audit display but should not be assumed by callers. `limit` accepts an optional number; omit (or pass `null`) to disable. Default 100. Optional credit-type filter. Returns ALL entries including expired ones — this is an audit view, not a balance view.

`grant()` and `listEntries()` are technically beyond the ticket's literal scope ("balance + atomicDebit"), but every test needs to put credits in, the next ticket (Stripe webhooks) needs `grant()`, and `listEntries` is trivial + audit-useful. Worth including.

## Wiring

- Add `credits: createCreditsRepo(pool)` to `backend/src/repo/index.ts`.
- Verify `credit_ledger` is in `_helpers/reset-data.ts` table list (it should be from migration 001 scaffold).

## Runtime invariants

- **Isolation level assertion at first use.** The atomic-debit correctness argument depends on READ COMMITTED's per-statement snapshot (see line citing isolation in the locking strategy). A future contributor flipping the pool's default isolation to REPEATABLE READ would silently break idempotency-under-retry. `createCreditsRepo` runs `SHOW transaction_isolation` once on first `atomicDebit` invocation per pool and throws if the result is not `'read committed'`. Cheap, agent-legible defense — the failure mode is otherwise invisible until it produces wrong charges in production.

## Caller obligations

The repo enforces correctness for what it owns; certain invariants depend on callers honoring contracts that are not (and in some cases cannot be) enforced at the repo or DB layer:

1. **`grant()` is NOT idempotent at the repo layer.** A duplicate call WILL double-grant. Caller must dedupe at a layer above:
   - **Stripe webhook handler**: must check `stripe_events.event_id` UNIQUE table before invoking `grant()`. The Stripe ticket owns this. Until that ticket lands, `grant()` MUST NOT be exposed to any externally-triggered path.
   - **Subscription rollover scheduler**: must use a per-period idempotency key (e.g., a `(user_id, billing_period_start)` UNIQUE row in a sibling `rollover_runs` table) before invoking `grant()`. The rollover ticket owns this.
   - **Admin "comp credit" endpoint**: must check the admin-action audit log before invoking. The admin tools ticket owns this.
2. **`atomicDebit` callers must use never-reused `sourceId`s per `(user_id, credit_type)`.** UUIDv7 sessionIds satisfy this naturally. A caller that hand-crafts a sourceId or reuses one breaks the idempotency model.
3. **No caller may use `balance()` to gate a billable action.** Use `atomicDebit` and let it throw `InsufficientCreditsError`. (Repeated from the method docs because it's the most common foot-gun.)
4. **No write to `credit_ledger` may happen outside `repo.credits.*`.** Direct INSERTs from migrations, admin scripts, or future repo namespaces bypass the lock discipline. The DB-level CHECKs and the partial unique index are the safety net for accidental violations, but the discipline is the primary enforcement.

## Errors

- `InsufficientCreditsError` (custom subclass) — thrown by `atomicDebit`. Carries `userId`, `creditType`, `available`, `requested`. HTTP layer maps to **402 Payment Required** per spec §2.4.
- `IdempotencyConflictError` (custom subclass) — thrown by `atomicDebit` when the same `(user_id, credit_type, source_id)` is reused with a different `amount`. HTTP layer maps to **409 Conflict** (Stripe / GitHub / AWS convention for idempotency-key reuse with mismatched payload). **Logged at `error` level** — today, sourceId is always server-controlled (the sessionId), so an `IdempotencyConflictError` always indicates an internal bug (replay or amount-changed-mid-flight) and deserves an alert. The 409 status is the right *shape* for the response (the request is in conflict with state), but the log severity reflects "this should never happen." If a future caller derives sourceId from a client-supplied `Idempotency-Key` header, downgrade to `warn` since legitimate client mistakes become possible.
- `DebitTimeoutError` (custom subclass) — thrown by `atomicDebit` when either `lock_timeout` (SQLSTATE 55P03 — lock contention) or `statement_timeout` (SQLSTATE 57014 — query stall after lock) fires. The class is intentionally one type for both: from the caller's perspective both mean "the debit couldn't complete, retry is appropriate." HTTP layer maps to **503 Service Unavailable** with a short jittered `Retry-After` (e.g., 1s + random 0-500ms). Lock contention spikes show up as a clean retry signal in dashboards instead of opaque 500s.
- Validation errors (`amount <= 0`, `grant with sourceType='debit'`, missing/empty `sourceId`) — throw plain `Error` at the application layer before any SQL runs. Programmer errors; should never reach production callers.
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

**Race mechanism:** the goal is to land both racer transactions at the `SELECT id FROM users ... FOR UPDATE` line within a tight window so the lock contention is real. Spawn both via `Promise.all` from the test harness. **Repeat each race in a loop of 100 iterations** (not a single `Promise.all` of 200 calls — the loop preserves visibility into which iteration failed). Iteration count + concurrent execution is what makes these tests reliable; an advisory-lock barrier is intentionally NOT used because `pg_advisory_xact_lock` is exclusive (would serialize the racers and defeat the test) and the shared variant adds complexity without improving signal at this iteration count.

**Test pool:** the default repo test pattern uses `createPgPool(url, { max: 1 })`. The concurrency tests need a separate pool with `max >= 4` for the racer connections + the test orchestrator. Open in `beforeAll`, close in `afterAll`.

**Throughput floor:** assert each 100-iteration race completes in under 10 seconds. A regression that introduces accidental serial waits (e.g., a future contributor hoists a connection acquire outside the transaction) gets caught by the timing assertion, not just the correctness one.

18. **Two parallel atomicDebit attempts on a user with 1 credit, distinct sourceIds → exactly one succeeds.** One resolves, one throws `InsufficientCreditsError`. Final balance === 0. Ledger has the original grant + exactly one debit row. Run under default isolation (READ COMMITTED) — proves the users-row lock works without SERIALIZABLE retries. Repeat 100 times.

18b. **Empty-ledger race.** No grants at all. Two parallel atomicDebit attempts → both throw `InsufficientCreditsError` (each reports `available=0, requested=1`). Ledger remains empty. **This is the test that actually validates the spec §2 patch** — it is the case that fails under the buggy `FOR UPDATE on credit_ledger rows` recipe and must succeed under the users-row anchor. Repeat 100 times.

18c. **Buggy-recipe regression demonstrator.** A separate, intentionally-staged test that reproduces the spec §2 bug to lock in the regression boundary. Implement `atomicDebitBUGGY()` in the test file (NOT exported; mirrors the buggy recipe verbatim — `FOR UPDATE` on `credit_ledger` rows for the user instead of on the `users` row). Race two parallel calls to it on a user with 1 credit → expect MORE than one debit row to land (the bug). Marked with a comment block citing the bug, the fix, and "DO NOT copy this pattern into production." Educational artifact; runs under the same test suite so future contributors see the bug fail-out concretely.

19. **Two parallel atomicDebit attempts with the SAME sourceId → exactly one inserts; the other returns the same entry.** Same race shape as 18. One transaction wins the insert; the other's idempotency SELECT, blocked behind the lock, sees the inserted row when it unblocks and returns it. Ledger has exactly one debit row. Repeat 50 times.

19b. **Idempotency cross-credit-type isolation.** Same sourceId used for one `'session'` debit and one `'world_gen'` debit (sequential, not racing). Both succeed; ledger has two distinct debit rows. Demonstrates the unique partial index keys on `(user_id, credit_type, source_id)`, not just `(user_id, source_id)`.

20. **DB-level idempotency safety net.** Bypass the application layer: directly INSERT a debit row, then INSERT a *second* debit row with the same `(user_id, credit_type, source_id)` → the unique partial index rejects with a unique-violation error. Proves the safety net catches a future caller that bypasses the lock discipline.

20b. **Lock-timeout error mapping.** Open a third dedicated connection (NOT the test pool's general clients), `BEGIN`, `SELECT id FROM users WHERE id=$1 FOR UPDATE` to take the lock, then `pg_sleep(3)`. The holder MUST NOT set `lock_timeout` or `statement_timeout` on its own connection — otherwise it times itself out before the test can race against it. Concurrently, call `atomicDebit` from the main test pool. After ~1 second the second call throws `DebitTimeoutError` (lock_timeout fired with SQLSTATE 55P03). Verifies the catch-and-rethrow path.

   **Use a fresh `userId` per iteration of this test** (UUIDv7 makes this trivial). A leaked holder pins the users-row lock for that user; if the test reused a userId, a leak would cascade across iterations. With per-iteration userIds, a leak self-isolates.

   **Cleanup discipline:** the holder connection must be released or `ROLLBACK`ed in `afterEach` even on test failure. Wrap the holder in `try/finally` AND register an `afterEach` belt-and-suspenders `ROLLBACK` + release. Additionally, the suite's `afterAll` runs `SELECT count(*) FROM pg_locks WHERE locktype='tuple'` and asserts zero — catches leaked holders escaping per-test cleanup.

20c. **Statement-timeout error mapping (post-lock work stall).** Use a fresh userId, grant 1 credit. Mock or otherwise stage a long-running `pg_sleep(6)` between lock acquisition and the SUM/INSERT (e.g., a `BEFORE INSERT` test trigger that calls `pg_sleep(6)`, dropped in `afterAll`). Call `atomicDebit` → after ~5 seconds throws `DebitTimeoutError` (statement_timeout fired with SQLSTATE 57014). Verifies that statement_timeout coverage of post-lock work also surfaces as the typed error.

### Schema invariant tests

21. **Polarity CHECK rejects positive `amount` with `source_type='debit'`.** Direct INSERT bypassing the repo → DB rejects.
22. **Polarity CHECK rejects negative `amount` with `source_type='subscription'`.** Direct INSERT → DB rejects.
23. **`debit_has_source_chk` rejects NULL `source_id` with `source_type='debit'`.** Direct INSERT → DB rejects.
23b. **FK ON DELETE RESTRICT rejects user deletion when ledger rows exist.** Insert a user, grant 5 credits, attempt `DELETE FROM users WHERE id = $userId` → rejected with foreign_key_violation. Verifies the migration 004 change.
23c. **Debit rows cannot carry expires_at.** Direct INSERT of a debit row with non-null `expires_at` → DB rejects via `credit_ledger_debit_no_expiry_chk`. Verifies the immutability invariant.

### `listEntries`

24. **Returns DESC by granted_at, default limit 100.**
25. **Type filter narrows correctly.**
26. **Includes expired entries.** Grant one expired + one unexpired → both appear in listEntries; only the unexpired counts in `balance`.

## Out of scope (deferred to future tickets)

- HTTP route exposing `balance()` (`GET /me/credits`) — auth/billing routes ticket.
- Stripe webhook handler that calls `grant()` — Stripe ticket. **Note:** `grant()` is NOT idempotent at the repo layer — it does not enforce uniqueness on `(user_id, source_type, source_id)` (that constraint is debit-only by design, since grants legitimately come in pairs for subscription tiers that grant both `'session'` and `'world_gen'` credits with the same source event). Webhook idempotency is the Stripe ticket's responsibility via the `stripe_events` table — the handler MUST check `stripe_events` for the event id before calling `grant()`. A duplicate webhook delivery that bypasses this check WILL double-grant.
- Session-start gate that calls `atomicDebit()` — session runtime ticket.
- Rollover scheduler / `'rollover'` source_type value — rollover ticket.
- FIFO-by-expiry consumption ordering ("subscription credits drain before pack credits") asserted by parent §10 — current `atomicDebit` SUMs all unexpired credits and inserts one negative row, which is correct for balance math but loses per-row attribution. Not needed today (no expiry across credit types yet); revisit when subscription rollover ticket lands.
- Refund / clawback method (negative `grant()` or a separate `clawback()` API) — refund ticket. Today `grant()` validates `amount > 0`; the eventual refund path will need either a relaxed `grant()` or a sibling method that respects the same lock discipline.
- GDPR erasure / soft-delete + pseudonymize flow — privacy ticket. Made necessary by the migration 004 FK change (CASCADE → RESTRICT). Until that ticket lands, hard-deleting a user with ledger rows is rejected; admin paths must use a status flag (`users.suspended_at` or similar) until proper erasure ships.
- Cost-tracking metering on `session_usage` — observability ticket.
- Admin "comp credit" endpoint — admin tools ticket.
- Periodic deletion of long-expired ledger rows (perf hygiene) — rollover/sweep ticket. Sizing target: trigger when a per-user expired-row count exceeds ~500 to keep the balance-query in-heap filter bounded. **Hard prerequisite of the subscription-rollover ticket**, not generic hygiene — rollover starts producing per-user row growth on the order of (months × tiers × credit_types × pack purchases), which is when the in-heap filter cost becomes load-bearing. The rollover ticket must not ship without this in place.

## Linear ticket update

The Linear ticket as originally written asked for migration 004 with a different schema (`credits_ledger` plural, `kind` enum, `amount_minor`, `balance_after_minor`). This design supersedes that. Update Linear with: "Migration 004 ships defense-in-depth invariants on the existing `credit_ledger` from migration 001 (polarity CHECK, debit-source CHECK, idempotency partial unique index keyed on `(user_id, credit_type, source_id)`, FK ON DELETE CASCADE → RESTRICT). Migration is additive — no data backfill, no destructive DDL against existing rows. Repo + tests + spec patch on top." Linked PR will land both the migration and the repo work.
