-- 027_fact_supersede.sql — MYT-74a §3
-- Append-only fact log: a correction APPENDS a new fact and points the old
-- one's superseded_by at it (content is never edited). Live canon =
-- superseded_by IS NULL. ON DELETE SET NULL is deliberate: entities→facts is
-- ON DELETE CASCADE, and a world-regen wipe deleting an entity whose superseded
-- fact is pointed-to by a live fact would otherwise FK-abort the cascade under
-- the bare NO ACTION default.
-- Plus sessions.reconciled_at: the end-of-session reconcile completion marker
-- (the conditional-update idempotency gate; tri-state with ended_at).
ALTER TABLE facts
  ADD COLUMN superseded_by UUID REFERENCES facts(id) ON DELETE SET NULL,
  ADD COLUMN superseded_at TIMESTAMPTZ;

CREATE INDEX idx_facts_live_by_entity
  ON facts (entity_id, access_level)
  WHERE superseded_by IS NULL;

ALTER TABLE sessions
  ADD COLUMN reconciled_at TIMESTAMPTZ;
