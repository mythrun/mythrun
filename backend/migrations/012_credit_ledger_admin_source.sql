-- Adds 'admin' to the credit_ledger source_type whitelist + the
-- credit_ledger_source_link_chk CASE. Required for MYT-51's dev-only
-- /api/dev/credits/grant route (per spec D13): force-grant rows are
-- stamped source_type='admin' to keep them distinct from purchase /
-- gift / refund grants in audit + reporting. Both FKs NULL — same
-- shape as gift/trial/cost_cap_refund (no upstream billing event).
--
-- Polarity (migration 004): admin grants are positive amounts; the
-- polarity check `(source_type = 'debit') = (amount < 0)` passes
-- (both sides false). No change to migration 004 needed.
--
-- Production exposure: the route registers ONLY when
-- AUTH_MODE='bypass', which six-layer plugin defense keeps out of any
-- AWS-managed runtime. The schema change itself is benign — the value
-- is enumerable in admin tooling later if we want a human-issue path.

ALTER TABLE credit_ledger
  DROP CONSTRAINT credit_ledger_source_type_check;
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_source_type_check
  CHECK (source_type IN (
    'purchase', 'subscription', 'gift', 'trial', 'refund', 'debit',
    'cost_cap_refund', 'admin'
  ));

ALTER TABLE credit_ledger
  DROP CONSTRAINT credit_ledger_source_link_chk;
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_source_link_chk CHECK (
    CASE source_type
      WHEN 'debit'           THEN source_purchase_id IS NULL AND source_billing_history_id IS NULL
      WHEN 'trial'           THEN source_purchase_id IS NULL AND source_billing_history_id IS NULL
      WHEN 'gift'            THEN source_purchase_id IS NULL AND source_billing_history_id IS NULL
      WHEN 'refund'          THEN source_purchase_id IS NULL AND source_billing_history_id IS NOT NULL
      WHEN 'purchase'        THEN source_purchase_id IS NOT NULL AND source_billing_history_id IS NULL
      WHEN 'subscription'    THEN source_purchase_id IS NULL AND source_billing_history_id IS NOT NULL
      WHEN 'cost_cap_refund' THEN source_purchase_id IS NULL AND source_billing_history_id IS NULL
      WHEN 'admin'           THEN source_purchase_id IS NULL AND source_billing_history_id IS NULL
      ELSE FALSE
    END );
