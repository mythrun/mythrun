-- Migration 006 — drop legacy billing-config tables and their dependents.
--
-- MYT-41 moves the tier and pack credit-allocation contract into a
-- checked-in TS file (backend/src/billing/lookup-keys.ts). Stripe stays
-- the source of truth for prices; lookup_key is the indirection that
-- lets backend code reference SKUs without coupling to Stripe Price IDs.
--
-- Drop order matters because migration 001 created the FK
--   user_subscriptions.tier_id -> subscription_tiers(id) (ON DELETE NO ACTION)
-- A naive `DROP TABLE subscription_tiers` would fail with SQLSTATE 2BP01
-- ("cannot drop table because other objects depend on it"), aborting
-- migration 006 inside the runner's transaction wrapper.
--
-- `purchases` has no FK into the config tables but is still dropped here
-- because MYT-42 recreates it with a new shape (lookup_key TEXT instead
-- of session_pack_size INTEGER).
--
-- Drop order:
--   1. user_subscriptions (FK depends on subscription_tiers)
--   2. purchases (no FK, but recreated by MYT-42)
--   3. session_packs
--   4. subscription_tiers

-- Pre-drop emptiness check. Pre-merge verification ran ~hours/days ago;
-- a row could land between merge and deploy. The migration runs inside
-- the runner's BEGIN/COMMIT, so a non-empty assertion fires-and-aborts
-- before any destructive operation runs. The four expected counts are 0.
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM user_subscriptions) = 0,
    'user_subscriptions is non-empty; refusing to drop. Inspect rows and decide migration strategy.';
  ASSERT (SELECT count(*) FROM purchases) = 0,
    'purchases is non-empty; refusing to drop. Inspect rows and decide migration strategy.';
  ASSERT (SELECT count(*) FROM session_packs) = 0,
    'session_packs is non-empty; refusing to drop. Inspect rows and decide migration strategy.';
  ASSERT (SELECT count(*) FROM subscription_tiers) = 0,
    'subscription_tiers is non-empty; refusing to drop. Inspect rows and decide migration strategy.';
END $$;

-- Drops in FK-correct order.
DROP TABLE IF EXISTS user_subscriptions;
DROP TABLE IF EXISTS purchases;
DROP TABLE IF EXISTS session_packs;
DROP TABLE IF EXISTS subscription_tiers;

-- Post-drop assertion. current_schema() (not hard-coded 'public') keeps
-- the wiki schema extractor happy per the migration 005 fix.
DO $$ BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN (
        'session_packs',
        'subscription_tiers',
        'user_subscriptions',
        'purchases'
      )
  ), 'one or more billing-config tables were not dropped';
END $$;
