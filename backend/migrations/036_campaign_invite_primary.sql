-- backend/migrations/036_campaign_invite_primary.sql
-- myth-y5c4q: make the "primary" invite a first-class, DB-enforced concept.
--
-- Before this, "primary" was DERIVED in the repo (the oldest active invite,
-- listForCampaign's i===0), and the client's ensurePrimaryInvite was a
-- list-then-create read-modify-write. Two concurrent calls (React StrictMode's
-- dev double-mount, or two owner tabs) both saw no primary and both POSTed,
-- minting two live invite codes on an access-control surface. The fix is a
-- server-side atomic get-or-create backed by a hard DB guarantee: a real
-- is_primary column + a PARTIAL UNIQUE INDEX enforcing at most one primary
-- invite per campaign.

-- 1. The column. Defaults false so every existing (and future non-primary) row
--    is a non-primary invite until explicitly designated.
ALTER TABLE campaign_invites
  ADD COLUMN is_primary BOOLEAN NOT NULL DEFAULT false;

-- 2. Backfill / dedupe: designate the OLDEST ACTIVE invite per campaign as the
--    primary (matching the pre-migration derived semantics — listForCampaign's
--    created_at ASC, i===0). DISTINCT ON picks exactly one row per campaign, so
--    this is safe on ANY data: a campaign with N live invites (e.g. Brindlemarsh
--    has 2) collapses to a single primary — the oldest — and the rest stay
--    is_primary=false. A campaign whose invites are all expired gets no primary
--    (correct: no active primary to point at). id ASC is the deterministic
--    tiebreak for equal created_at (UUIDv7 ids are themselves time-ordered).
UPDATE campaign_invites SET is_primary = true
WHERE id IN (
  SELECT DISTINCT ON (campaign_id) id
    FROM campaign_invites
   WHERE expires_at IS NULL OR expires_at > now()
   ORDER BY campaign_id, created_at ASC, id ASC
);

-- 3. The hard guarantee: at most one is_primary=true row per campaign. The
--    backfill above already satisfies it (one per campaign), and the repo
--    maintains the invariant is_primary=true ⟺ the one active primary (revoke
--    clears is_primary, so an is_primary=true row is never expired — the index
--    predicate needs no non-IMMUTABLE now() clause). Any code path that tries to
--    mint a second primary fails with 23505 at the DB layer, not just under the
--    app's campaign-row lock.
CREATE UNIQUE INDEX idx_campaign_invites_one_primary
  ON campaign_invites (campaign_id) WHERE is_primary;
