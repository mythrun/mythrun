-- Migration 007 — re-create purchases + user_subscriptions with the lookup_key shape.
--
-- MYT-41 migration 006 dropped both tables (empty, FK-correct order, pre-drop
-- ASSERT). MYT-42 re-creates them with the new shape: lookup_key TEXT replaces
-- the legacy session_pack_size INTEGER on purchases; tier_lookup_key TEXT
-- replaces the legacy tier_id REFERENCES subscription_tiers(id) on
-- user_subscriptions (no FK; the closed enum is enforced at write-time by the
-- webhook handler against backend/src/billing/lookup-keys.ts).

-- purchases: à-la-carte purchase records. The (stripe_payment_intent_id, lookup_key)
-- composite UNIQUE replaces a per-row UNIQUE on stripe_payment_intent_id alone:
-- a multi-line cart (e.g., 3× sku_session + 1× sku_world) shares one PaymentIntent
-- across multiple purchases rows, so per-row UNIQUE on PI alone would 23505 on the
-- second insert. The composite tolerates multi-line carts AND blocks duplicate
-- inserts of the same (PI, lookup_key) pair.
CREATE TABLE purchases (
  id                          UUID        PRIMARY KEY,
  user_id                     UUID        NOT NULL REFERENCES users(id),
  stripe_payment_intent_id    TEXT        NOT NULL,
  lookup_key                  TEXT        NOT NULL,
  quantity                    INTEGER     NOT NULL CHECK (quantity > 0),
  amount_cents                INTEGER     NOT NULL,
  currency                    TEXT        NOT NULL DEFAULT 'usd',
  status                      TEXT        NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','refunded')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (stripe_payment_intent_id, lookup_key)
);
CREATE INDEX idx_purchases_user ON purchases(user_id);

CREATE TABLE user_subscriptions (
  id                          UUID        PRIMARY KEY,
  user_id                     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier_lookup_key             TEXT        NOT NULL,
  stripe_subscription_id      TEXT        NOT NULL UNIQUE,
  -- Stripe sends the full enum: incomplete, incomplete_expired, trialing, active,
  -- past_due, canceled, unpaid, paused. Mythrun cares about all of them; we
  -- relax the earlier 4-value CHECK to admit
  -- incomplete/incomplete_expired/trialing/paused so §5.4.1's SCA-pending path
  -- (status='incomplete') doesn't violate the constraint, and so an operator
  -- Dashboard config that produces a 'paused' subscription (e.g., a Stripe-side
  -- trial ending without a payment method, per Carthage C1 round 7) doesn't
  -- crash the upsert and force ~3 days of Stripe redelivery.
  status                      TEXT        NOT NULL CHECK (status IN (
                                            'active','past_due','canceled','unpaid',
                                            'incomplete','incomplete_expired','trialing','paused'
                                          )),
  current_period_start        TIMESTAMPTZ NOT NULL,
  current_period_end          TIMESTAMPTZ NOT NULL,
  cancel_at_period_end        BOOLEAN     NOT NULL DEFAULT false,
  cancel_at                   TIMESTAMPTZ NULL,           -- Stripe's cancel_at field (timestamp), nullable
  cancellation_details        JSONB       NULL,           -- Stripe's cancellation_details on .deleted, nullable
  -- Used by upsertFromStripe to reject stale-event ordering: an UPDATE on
  -- conflict reads WHERE excluded.stripe_event_created_at > row's value (strict), so a
  -- late stale event can't overwrite a fresh row.
  stripe_event_created_at     TIMESTAMPTZ NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (current_period_end > current_period_start)
);
CREATE INDEX idx_user_subscriptions_user ON user_subscriptions(user_id);

-- billing_history: the unified audit feed for /api/billing/history. Per
-- Decision 4 of round-2 review, the refund-resolution role moves to explicit
-- FK columns on credit_ledger (added below); billing_history.related_id_stripe
-- is dropped — Chimera I7 / Kraken I3 round 2 flagged it as a dead column
-- whose population rules contradicted between the schema and the prose.
-- For à-la-carte: kind='purchase', source_id_stripe = payment_intent.
-- For subscription invoice: kind='invoice', source_id_stripe = invoice_id.
-- For refund: kind='refund', source_id_stripe = refund_id (re_*).
-- The three Stripe ID prefixes used today (pi_*, in_*, re_*) are disjoint.
-- A CHECK constraint enforces the prefix per kind for defense-in-depth.
CREATE TABLE billing_history (
  id                          UUID        PRIMARY KEY,
  user_id                     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                        TEXT        NOT NULL CHECK (kind IN ('purchase','invoice','refund')),
  -- Per Petra I2 / Persepolis C4 round 8: UNIQUE is COMPOSITE on (kind,
  -- source_id_stripe) to match the handlers' ON CONFLICT (kind,
  -- source_id_stripe) clauses (§5.4.2 subscription_update, §5.4.6
  -- pending_update_applied). Earlier rounds had a single-column UNIQUE on
  -- source_id_stripe alone, which caused a 42P10 invalid_column_reference at
  -- runtime when ON CONFLICT named both columns. The prefix-by-kind CHECK
  -- below remains as defense-in-depth: Stripe's pi_*/in_*/re_* prefixes are
  -- disjoint, so single-column UNIQUE WOULD be enforceable in practice — the
  -- composite makes the contract explicit at the schema level.
  source_id_stripe            TEXT        NOT NULL,
  -- Per Carthage C1 round 8: stripe_payment_intent_id is the canonical
  -- DB-side resolution column for refund subscription routing. The earlier
  -- design relied on stripe.invoicePayments.list({ payment: ... }) to walk
  -- PI → invoice_id at refund-prefetch time; the API requires `invoice` as
  -- the filter, NOT `payment`, so PI → Invoice is not a single-call lookup
  -- via that resource. Storing the PI on the kind='invoice' rows lets the
  -- refund handler resolve via SELECT id FROM billing_history WHERE
  -- stripe_payment_intent_id = $1 AND kind='invoice'. NULL for kind='purchase'
  -- (purchases.stripe_payment_intent_id holds it) and kind='refund' (a refund
  -- has no PI of its own; it has refund.payment_intent which points at the
  -- ORIGINAL invoice's PI, already resolved before this row is written).
  stripe_payment_intent_id    TEXT        NULL,
  lookup_key                  TEXT        NULL,           -- nullable: multi-line à-la-carte rows leave it NULL; subscription invoices fill it
  amount_cents                INTEGER     NOT NULL,       -- positive for purchase/invoice, negative for refund
  currency                    TEXT        NOT NULL DEFAULT 'usd',
  status                      TEXT        NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','refunded')),
  expires_at                  TIMESTAMPTZ NULL,           -- mirrors the originating credit_ledger.expires_at; NULL for à-la-carte and refund
  occurred_at                 TIMESTAMPTZ NOT NULL,       -- Stripe's event timestamp (full precision)
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, source_id_stripe),
  CHECK (
    (kind = 'purchase' AND source_id_stripe LIKE 'pi_%')
    OR (kind = 'invoice'  AND source_id_stripe LIKE 'in_%')
    OR (kind = 'refund'   AND source_id_stripe LIKE 're_%')
  )
);
-- Refund subscription-routing index: kind='invoice' rows store the PI;
-- refund handler resolves PI → invoice_id via this partial index.
CREATE INDEX idx_billing_history_invoice_pi
  ON billing_history(stripe_payment_intent_id)
  WHERE kind = 'invoice' AND stripe_payment_intent_id IS NOT NULL;
CREATE INDEX idx_billing_history_user_occurred ON billing_history(user_id, occurred_at DESC, id DESC);

-- credit_ledger refund-resolution FKs (Decision 4 of round-2 review).
-- Grants link back to either a purchases row (à-la-carte) or a billing_history
-- row (subscription invoice). The CHECK enforces "exactly one is non-null per
-- non-debit, non-trial grant" — the refund handler queries via FK to find
-- the originating grant rows. ON DELETE RESTRICT prevents an orphaned grant
-- if a parent row is ever hard-deleted (we don't today, but the constraint
-- enforces invariant against future cleanup paths).
ALTER TABLE credit_ledger
  ADD COLUMN source_purchase_id        UUID NULL REFERENCES purchases(id) ON DELETE RESTRICT,
  ADD COLUMN source_billing_history_id UUID NULL REFERENCES billing_history(id) ON DELETE RESTRICT,
  ADD CONSTRAINT credit_ledger_source_link_chk CHECK (
    -- Per Petra C3 / Persepolis C1 round 6: per-source_type CASE enforces the
    -- correct FK shape at write time. The earlier OR-shaped predicate was
    -- non-restrictive — it admitted (e.g.) source_type='trial' rows with a
    -- spurious source_purchase_id, and source_type='subscription' rows
    -- pointing at the wrong FK column. Restating the rule per source_type
    -- closes those holes AND forecloses on a future 'refund' grant landing
    -- as a fully-orphaned row (refund-goodwill grants link to billing_history).
    CASE source_type
      WHEN 'debit'        THEN source_purchase_id IS NULL AND source_billing_history_id IS NULL
      WHEN 'trial'        THEN source_purchase_id IS NULL AND source_billing_history_id IS NULL
      WHEN 'gift'         THEN source_purchase_id IS NULL AND source_billing_history_id IS NULL
      WHEN 'refund'       THEN source_purchase_id IS NULL AND source_billing_history_id IS NOT NULL
      WHEN 'purchase'     THEN source_purchase_id IS NOT NULL AND source_billing_history_id IS NULL
      WHEN 'subscription' THEN source_purchase_id IS NULL AND source_billing_history_id IS NOT NULL
      ELSE FALSE  -- reject unknown source_types at the DB layer; forces schema discipline
    END );
CREATE INDEX idx_credit_ledger_source_purchase
  ON credit_ledger(source_purchase_id) WHERE source_purchase_id IS NOT NULL;
CREATE INDEX idx_credit_ledger_source_billing_history
  ON credit_ledger(source_billing_history_id) WHERE source_billing_history_id IS NOT NULL;

-- Post-create assertion (current_schema() not hard-coded 'public', per the
-- migration 005 fix).
DO $$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN ('purchases', 'user_subscriptions', 'billing_history')
    GROUP BY 1 = 1
    HAVING count(*) = 3
  ), 'migration 007 did not create all three tables';
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'credit_ledger'
      AND column_name IN ('source_purchase_id', 'source_billing_history_id')
    GROUP BY 1 = 1
    HAVING count(*) = 2
  ), 'migration 007 did not add credit_ledger FK columns';
END $$;
