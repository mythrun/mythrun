-- backend/migrations/013_seed_dev_users.sql
--
-- Per myth-40uh. Seeds the five dev users the dev tool's identity
-- switcher ships (dev-user-1 .. dev-user-5) with usernames, display
-- names, and 5 world_gen credits each. Idempotent — safe to re-run.
--
-- Why: prior to this, the dev tool's first call to a route requiring
-- onboarding (POST /api/campaigns, /api/dev/credits/grant, etc.) would
-- 403 with username_required because no row existed for the active dev
-- sub. MYT-52's T13 retrofit added a self-bootstrap in main.ts as a
-- defense, but having to register-then-grant on every fresh-DB load was
-- friction the user explicitly pushed back on.
--
-- Test-side handling: the resetData() helper's reseedSystemRows is
-- updated in the same change-set to re-INSERT these rows after the
-- TRUNCATE, so the dev-user-* rows survive across the test reset.
-- Tests that DELETE FROM users WHERE cognito_sub != 'system:mythrun'
-- will still transiently nuke the dev users for their own test scope —
-- the dev-tool main.ts self-bootstrap remains as the safety net for
-- those windows. The production exposure of these rows is zero (the
-- bypass-auth plugin is the only entry point that recognizes the
-- 'dev-user-*' cognito_sub values, and it's gated behind
-- AUTH_MODE=bypass which is dev/test only via six-layer defense).
--
-- The users table's email + auth_provider columns were dropped in
-- migration 005 (minimal-claims identity model). Cognito_sub + username +
-- display_name + free_trial_used are the load-bearing fields here.
--
-- Credits are deliberately NOT pre-seeded. credit_ledger.user_id has an
-- ON DELETE RESTRICT FK, and many tests rely on the
-- `DELETE FROM users WHERE cognito_sub != 'system:mythrun'` pattern —
-- pre-seeding credits would FK-violate those deletes. The dev tool's
-- /api/dev/credits/grant endpoint is the canonical path to grant credits
-- as needed (and the dev-tool's main.ts self-bootstrap auto-grants on
-- first load if balance is empty).

-- Five dev users — UUIDv7-shaped for readability + B-tree locality.
INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used)
VALUES
  ('019700e0-0000-7000-8000-00000000d001', 'dev-user-1', 'Dev User 1', 'devuser1', true),
  ('019700e0-0000-7000-8000-00000000d002', 'dev-user-2', 'Dev User 2', 'devuser2', true),
  ('019700e0-0000-7000-8000-00000000d003', 'dev-user-3', 'Dev User 3', 'devuser3', true),
  ('019700e0-0000-7000-8000-00000000d004', 'dev-user-4', 'Dev User 4', 'devuser4', true),
  ('019700e0-0000-7000-8000-00000000d005', 'dev-user-5', 'Dev User 5', 'devuser5', true)
ON CONFLICT (cognito_sub) DO NOTHING;
