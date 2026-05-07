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
