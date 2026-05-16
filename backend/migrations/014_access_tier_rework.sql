-- backend/migrations/014_access_tier_rework.sql
-- myth-exac: rework access_level on facts from (public/private/secret) to
-- (known/discoverable/secret); add the same enum to entities; add the
-- dev-mode bypass flag to worlds.
--
-- Done in a single transaction (the migration runner wraps each file in
-- BEGIN/COMMIT). The DROP-then-ADD on facts_access_level_check is
-- non-concurrent — assumes no live writes during migrate (true for
-- production, and our test runner is single-threaded).

-- 1. Drop the existing facts CHECK; rename old enum values; re-add CHECK.
ALTER TABLE facts DROP CONSTRAINT facts_access_level_check;

UPDATE facts SET access_level = 'known' WHERE access_level = 'public';
UPDATE facts SET access_level = 'discoverable' WHERE access_level = 'private';
-- 'secret' is unchanged.

ALTER TABLE facts ADD CONSTRAINT facts_access_level_check
  CHECK (access_level IN ('known', 'discoverable', 'secret'));

-- 2. New column on entities. Default 'known' so any existing rows
--    (none in production yet, but defensive for dev fixtures) are
--    treated as visible by default.
ALTER TABLE entities ADD COLUMN access_level TEXT NOT NULL DEFAULT 'known'
  CHECK (access_level IN ('known', 'discoverable', 'secret'));

-- 3. Covering index for the snapshot endpoint's primary filter:
--    WHERE world_id = $1 AND access_level = ANY($2).
CREATE INDEX idx_entities_world_access ON entities(world_id, access_level);

-- 4. Dev-mode bypass flag. Defaults false; production code paths never
--    set this (gated at the create route by AUTH_MODE=bypass + dev/test
--    NODE_ENV). See myth-exac spec § "Dev-mode access tier bypass".
ALTER TABLE worlds ADD COLUMN dev_bypass_access_filter BOOLEAN NOT NULL DEFAULT false;
