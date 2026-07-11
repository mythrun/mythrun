-- backend/migrations/033_starting_level.sql
-- MYT-90: party-wide starting level (1–5) + persisted character confirmation.
ALTER TABLE campaigns
  ADD COLUMN starting_level SMALLINT
  CHECK (starting_level IS NULL OR starting_level BETWEEN 1 AND 5);

ALTER TABLE character_concepts
  ADD COLUMN confirmed_at TIMESTAMPTZ;
