-- 008_billing_metering.sql
-- MYT-43: per-session cost metering (data plane), trial mutual-exclusion,
-- demo-world scaffolding.
--
-- Spec: docs/superpowers/specs/2026-05-08-myt-43-billing-metering-design.md
-- Plan: docs/superpowers/plans/2026-05-09-myt-43-billing-metering.md

-- 1. session_usage: drop the abandoned token-budget column.
-- Token-budget enforcement (spec §6) is replaced by cost-cap +
-- FT-context-cap + ST narrative wrap. Greenfield repo with no production
-- data; no migration cruft to live with.
ALTER TABLE session_usage DROP COLUMN budget_limit_tokens;

-- 2. session_usage: split input-side token classes into separate columns
-- so analytics doesn't lose the cache-vs-uncached breakdown.
ALTER TABLE session_usage ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_usage ADD COLUMN cache_read_tokens  INTEGER NOT NULL DEFAULT 0;

-- 3. session_usage: pin one-row-per-session contract.
-- recordUsage uses ON CONFLICT (session_id) DO UPDATE; this index makes
-- that work and prevents accidental dup rows.
CREATE UNIQUE INDEX idx_session_usage_one_per_session
  ON session_usage (session_id);

-- 4. worlds: add is_demo flag with at-most-one-demo enforcement.
-- Trial-mode sessions fork from the demo world. Multiple historical demo
-- rows with is_demo=false are fine (retired demos).
ALTER TABLE worlds ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX idx_worlds_one_demo ON worlds (is_demo) WHERE is_demo = true;

-- 5. Seed: system users row.
-- Owns platform-seeded content (demo world today). Has no Cognito identity;
-- the cognito_sub format 'system:mythrun' cannot collide with a real
-- Cognito-issued sub. The suspended_at sentinel ensures the row can never
-- authenticate even if a future bug routed a JWT to its sub.
--
-- Column list matches the post-migration-005 users shape (email,
-- avatar_url, auth_provider were dropped in migration 005).
INSERT INTO users (
  id, cognito_sub, display_name, username,
  free_trial_used, suspended_at
)
VALUES (
  '019700e0-0000-7000-8000-000000000001'::uuid,
  'system:mythrun',
  'Mythrun System',
  'system',
  true,                                          -- system can't claim a trial
  '1970-01-01 00:00:00+00'::timestamptz          -- sentinel: permanently suspended
);

-- 6. Seed: placeholder demo world.
-- Real narrative content is a separate authoring task; this row exists
-- so the trial flow has something to fork from once Session Runtime ships.
INSERT INTO worlds (
  id, created_by, name, concept, status, language,
  is_public, is_demo
)
VALUES (
  '019700e0-0000-7000-8000-000000000002'::uuid,
  '019700e0-0000-7000-8000-000000000001'::uuid,
  'Demo Adventure',
  'Trial-mode demo world. Narrative content authored separately.',
  'complete',
  'en',
  false,                                          -- demo is fork-source only
  true
);
