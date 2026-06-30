-- 030_world_color_identity.sql — MYT-87
-- Per-world dither identity: the two-stop gradient a world's card renders with
-- on the campaign hub. Plain nullable TEXT — null means not-yet-generated, which
-- the frontend renders as the neutral ghost band. The WorldColor enum is enforced
-- at the app/contract layer + the backfill, NOT a DB CHECK, to avoid pinning the
-- enum in two places (revisit if a CHECK is wanted). The migration runner wraps
-- each file in BEGIN/COMMIT. Lands pre-launch against an empty/near-empty table,
-- so the column adds are effectively free.
ALTER TABLE worlds ADD COLUMN color_from TEXT;
ALTER TABLE worlds ADD COLUMN color_to   TEXT;
