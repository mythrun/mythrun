-- 005_drop_profile_columns_users.sql
-- Mythrun's identity model is minimal-claims: we store cognito_sub,
-- username, and display_name. Email / avatar_url / auth_provider were
-- carved out of OAuth claims by the original migration 001 but are
-- not product-load-bearing — Cognito is the authentication layer, the
-- user picks their identity surface (username + display_name). Drop
-- the three claim-derived columns here. Display_name is RETAINED for
-- social-recognition UX (member lists, campaign chrome) per UX spec
-- §3-§4. Future profile fields (avatar upload, bio, etc.) ship
-- post-launch as user-uploadable.

ALTER TABLE users
  DROP COLUMN email,
  DROP COLUMN avatar_url,
  DROP COLUMN auth_provider;

-- The original UNIQUE on users.username was case-sensitive (default for
-- TEXT columns). That allowed Admin / admin / ADMIN to register as three
-- distinct users — which lets an attacker squat a moderator-impersonation
-- name even if the lowercase form is in the deny list. Replace with a
-- case-insensitive UNIQUE on LOWER(username). The display preserves the
-- user's chosen casing.

ALTER TABLE users DROP CONSTRAINT users_username_key;

CREATE UNIQUE INDEX users_username_lower_key ON users (LOWER(username));

-- Post-migration assertion: confirm the named index exists and no
-- orphaned columns remain. Check by indexname rather than text-matching
-- indexdef (Postgres lowercases function names in pg_get_indexdef output,
-- so a LIKE '%LOWER(username)%' pattern would not match the stored text
-- 'lower(username)').
DO $$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'users'
      AND indexname = 'users_username_lower_key'
  ), 'users_username_lower_key was not created';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name IN ('email', 'avatar_url', 'auth_provider')
  ), 'profile columns email/avatar_url/auth_provider were not dropped';
END $$;
