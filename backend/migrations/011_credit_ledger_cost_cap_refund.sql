-- Adds 'cost_cap_refund' to the credit_ledger source_type whitelist + the
-- credit_ledger_source_link_chk CASE. Required for MYT-51's cost-cap
-- circuit-breaker (per the spec's D11): when world-gen burns past the
-- cap, the worker refunds the user's debited credit and marks the world
-- failed. The refund row has source_type='cost_cap_refund' with both
-- FKs NULL (no upstream billing event drove it — internal mechanism).
--
-- Polarity (migration 004): cost_cap_refund.amount > 0; the polarity
-- check `(source_type = 'debit') = (amount < 0)` passes because both
-- sides are false. No change to migration 004 needed.

-- Column-level whitelist (was set in migration 001).
ALTER TABLE credit_ledger
  DROP CONSTRAINT credit_ledger_source_type_check;
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_source_type_check
  CHECK (source_type IN (
    'purchase', 'subscription', 'gift', 'trial', 'refund', 'debit',
    'cost_cap_refund'
  ));

-- Table-level FK-shape CASE (was set in migration 007).
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
      ELSE FALSE
    END );
